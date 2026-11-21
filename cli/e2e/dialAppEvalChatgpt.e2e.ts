/**
 * Tier B of the dial eval for the ChatGPT app (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier B"): each main
 * scenario of the catalog that runs in tier B, on the real daemon and devices process, through the tier B driver
 * (harness/appEvalDriver.ts) and the ChatGPT app's steps (harness/appEvalChatgpt.ts). X3 is macOS's alone.
 *
 * macOS and Linux. Every daemon has a throwaway home, its open, its home and the apps' stores checked inside its root
 * before it starts, the harness's recording `open` (HARNESS_OPEN_BIN) and the fake backend only. The Codex home is a
 * fixture in that home (src/testing/codexAppFixture.ts), the ChatGPT app a fake in its root, and its own Codex CLI a fake
 * that notes each queue call: the real ChatGPT app, `~/.codex` and this computer's daemon are never touched. The network
 * guard runs in this process and in every process of each daemon: a connection to anything but this machine fails the
 * scenario, by host and port.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scenariosFor } from '../src/testing/dialAppEval/catalog.js'
import { loadBaseline, tierBVerdict } from '../src/testing/dialAppEval/grade.js'
import { collect, runScenario, uncaughtProbes, writeResults, type ScenarioRun } from '../src/testing/dialAppEval/runner.js'
import type { Platform } from '../src/testing/dialAppEval/types.js'
import { chatgptSteps } from './harness/appEvalChatgpt.js'
import { TierBDriver } from './harness/appEvalDriver.js'

const WIN32 = process.platform === 'win32'
const HOST = process.platform as Platform
const SCENARIOS = WIN32 ? [] : scenariosFor('b', HOST).filter((s) => s.app === 'chatgpt' && !s.heldOut)

describe.skipIf(WIN32)('the dial eval, tier B: the ChatGPT app', () => {
  let driver: TierBDriver
  const runs: ScenarioRun[] = []
  beforeAll(() => { driver = new TierBDriver({ chatgpt: chatgptSteps }) })
  afterAll(async () => {
    await driver?.close()
    if (process.env.DIAL_EVAL_OUT) writeResults(process.env.DIAL_EVAL_OUT, 'chatgpt', collect(runs))
  })

  it.for(SCENARIOS)('$id: $title', async (scenario) => {
    const began = Date.now()
    const run = await runScenario(driver, scenario, HOST)
    console.log(`[dial eval] ${scenario.id}: ${Date.now() - began} ms`)
    expect(driver.networkReached()).toEqual([])
    runs.push(run)
    expect(run.wrongSends).toEqual([])
    expect(uncaughtProbes(run)).toEqual([])
  })

  it("matches this platform's baseline", () => {
    const baseline = loadBaseline()
    expect(baseline).not.toBeNull()
    const verdict = tierBVerdict(collect(runs), baseline!, HOST)
    expect(verdict.ok, verdict.message).toBe(true)
  })
})
