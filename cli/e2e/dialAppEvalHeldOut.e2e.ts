/**
 * Tier B of the dial eval's held-out set (docs/plans/2026-11-21-dial-app-eval-design.md, "Held-out set"): whoever fixes a
 * failing group of the dial eval does not read this file. Each held-out scenario of the catalog that runs in tier B, on
 * the real daemon and devices process, through the tier B driver (harness/appEvalDriver.ts) and its app's steps. Scored
 * and reported apart, never in the headline score.
 *
 * The editors' held-out scenarios (docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md, "Held-out set") run on the
 * editors' steps (harness/appEvalEditor.ts), as their main ones do.
 *
 * macOS and Linux. Every daemon has a throwaway home; its open, its home, the apps' stores and VS Code's and Cursor's
 * CLIs are checked inside its root before it starts, the harness's recording `open` (HARNESS_OPEN_BIN) and the fake
 * backend only. The real Claude and ChatGPT apps, VS Code, Cursor, cursor-agent, their stores and CLIs, `/usr/bin/open`,
 * `~/.claude`, `~/.codex`, `~/.vscode`, `~/.cursor` and this computer's daemon are never touched. The network guard runs
 * in this process and in every process of each daemon: a connection to anything but this machine fails the scenario, by
 * host and port.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scenariosFor } from '../src/testing/dialAppEval/catalog.js'
import { loadBaseline, SKIP_RATCHET_ENV, tierBVerdict } from '../src/testing/dialAppEval/grade.js'
import { collect, runScenario, uncaughtProbes, writeResults, type ScenarioRun } from '../src/testing/dialAppEval/runner.js'
import type { Platform } from '../src/testing/dialAppEval/types.js'
import { chatgptSteps } from './harness/appEvalChatgpt.js'
import { claudeSteps } from './harness/appEvalClaude.js'
import { inside, orcaCliInside, TierBDriver } from './harness/appEvalDriver.js'
import { cursorSteps, vscodeSteps } from './harness/appEvalEditor.js'

const WIN32 = process.platform === 'win32'
const HOST = process.platform as Platform
const SCENARIOS = WIN32 ? [] : scenariosFor('b', HOST).filter((s) => s.heldOut)

describe.skipIf(WIN32)('the dial eval, tier B: the held-out set', () => {
  let driver: TierBDriver
  const runs: ScenarioRun[] = []
  beforeAll(() => { driver = new TierBDriver({ claude: claudeSteps, chatgpt: chatgptSteps, vscode: vscodeSteps, cursor: cursorSteps }) })
  afterAll(async () => {
    if (process.env.DIAL_EVAL_OUT) writeResults(process.env.DIAL_EVAL_OUT, 'heldOut', collect(runs))
    // It throws naming each attempt off this machine not asserted on yet, the last daemon's as it closed among them.
    await driver?.close()
  })

  it.for(SCENARIOS)('$id: $title', async (scenario) => {
    const began = Date.now()
    const run = await runScenario(driver, scenario, HOST)
    // Kept before any assertion, so a scenario that fails one is still in the results and the baseline's verdict.
    runs.push(run)
    expect(run.error).toBeUndefined()
    console.log(`[dial eval] ${scenario.id}: ${Date.now() - began} ms`)
    const { d } = driver.lastWorld()
    for (const path of [d.env.HOME, d.env.HARNESS_OPEN_BIN, d.env.HARNESS_VSCODE_BIN, d.env.HARNESS_CURSOR_BIN]) {
      expect(inside(d.root, path), path).toBe(true)
    }
    expect(() => orcaCliInside(d.env, d.root, process.platform)).not.toThrow()
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
