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
import { loadBaseline, SKIP_RATCHET_ENV, tierBVerdict } from '../src/testing/dialAppEval/grade.js'
import { collect, runScenario, uncaughtProbes, writeResults, type ScenarioRun } from '../src/testing/dialAppEval/runner.js'
import type { Platform } from '../src/testing/dialAppEval/types.js'
import { chatgptSteps } from './harness/appEvalChatgpt.js'
import { TierBDriver } from './harness/appEvalDriver.js'

const WIN32 = process.platform === 'win32'
const DARWIN = process.platform === 'darwin'
const HOST = process.platform as Platform
const SCENARIOS = WIN32 ? [] : scenariosFor('b', HOST).filter((s) => s.app === 'chatgpt' && !s.heldOut)

describe.skipIf(WIN32)('the dial eval, tier B: the ChatGPT app', () => {
  let driver: TierBDriver
  const runs: ScenarioRun[] = []
  beforeAll(() => { driver = new TierBDriver({ chatgpt: chatgptSteps }) })
  afterAll(async () => {
    if (process.env.DIAL_EVAL_OUT) writeResults(process.env.DIAL_EVAL_OUT, 'chatgpt', collect(runs))
    // It throws naming each attempt off this machine not asserted on yet, the last daemon's as it closed among them.
    await driver?.close()
  })

  /** The thread reports the devices had from the watch, each by what they made of it: on a daemon of its own, the
   *  scenario's alone. */
  const threadLines = (): string[] => driver.lastWorld().d.log().split('\n').filter((line) => line.includes('[device] thread ·'))

  it("the fake ChatGPT app's window shows the thread its link opened, and Harness Device reads its title", async () => {
    await runScenario(driver, { ...SCENARIOS.find((s) => s.id === 'X4')!, fresh: true }, HOST)
    expect(threadLines()).not.toEqual([])
  })

  it.runIf(DARWIN)('with no Accessibility (X3) no title comes, though a link opened a thread', async () => {
    await runScenario(driver, { ...SCENARIOS.find((s) => s.id === 'X3')!, fresh: true }, HOST)
    expect(threadLines()).toEqual([])
  })

  it.for(SCENARIOS)('$id: $title', async (scenario) => {
    const began = Date.now()
    const run = await runScenario(driver, scenario, HOST)
    // Kept before any assertion, so a scenario that fails one is still in the results and the baseline's verdict.
    runs.push(run)
    expect(run.error).toBeUndefined()
    console.log(`[dial eval] ${scenario.id}: ${Date.now() - began} ms`)
    expect(driver.networkReached()).toEqual([])
    expect(run.wrongSends).toEqual([])
    expect(uncaughtProbes(run)).toEqual([])
  })

  // The eval command judges the ratchet itself, over every file's results (run.ts).
  it.skipIf(process.env[SKIP_RATCHET_ENV] === '1')("matches this platform's baseline", () => {
    const baseline = loadBaseline()
    expect(baseline).not.toBeNull()
    const verdict = tierBVerdict(collect(runs), baseline!, HOST)
    expect(verdict.ok, verdict.message).toBe(true)
  })
})
