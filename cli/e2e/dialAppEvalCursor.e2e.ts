/**
 * Tier B of the dial eval for Cursor (docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md, "Tier B"): each main
 * scenario of the catalog for Cursor that runs in tier B, on the real daemon and devices process, through the tier B
 * driver (harness/appEvalDriver.ts) and the editors' steps (harness/appEvalEditor.ts): Claude Code and cursor-agent in
 * terminals under fake Cursors, Cursor's own agent and the Claude Code panel under it (harness/cursorOutside.ts), and
 * Harness's extension's own loop over each fake window.
 *
 * macOS and Linux. Every daemon has a throwaway home; its open, its home, the apps' stores and VS Code's and Cursor's
 * CLIs are checked inside its root before it starts, and it reaches the fake backend only. The real Cursor, VS Code,
 * cursor-agent, their CLIs, `/usr/bin/open`, `~/.cursor`, `~/.vscode`, `~/.claude`, `~/.codex` and this computer's daemon
 * are never touched. The network guard runs in this process and in every process of each daemon: a connection to
 * anything but this machine fails the scenario, by host and port.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_BUNDLES } from '../src/cable/hosts/hostDetect.js'
import { scenariosFor } from '../src/testing/dialAppEval/catalog.js'
import { loadBaseline, SKIP_RATCHET_ENV, tierBVerdict } from '../src/testing/dialAppEval/grade.js'
import { collect, runScenario, uncaughtProbes, writeResults, type ScenarioRun } from '../src/testing/dialAppEval/runner.js'
import type { Platform, Scenario } from '../src/testing/dialAppEval/types.js'
import { inside, TierBDriver } from './harness/appEvalDriver.js'
import { cursorSteps } from './harness/appEvalEditor.js'

const WIN32 = process.platform === 'win32'
const HOST = process.platform as Platform
const SCENARIOS = WIN32 ? [] : scenariosFor('b', HOST).filter((s) => s.app === 'cursor' && !s.heldOut)

describe.skipIf(WIN32)('the dial eval, tier B: Cursor', () => {
  let driver: TierBDriver
  const runs: ScenarioRun[] = []
  // U2's VS Code session runs on the same editors' steps, under its own fake editor.
  beforeAll(() => { driver = new TierBDriver({ cursor: cursorSteps }) })
  /** What a scenario's run proves beside its checks, read from its world as it stopped. */
  const ALSO: Partial<Record<string, (scenario: Scenario) => void>> = {
    // A tap on Cursor's own agent opens its folder by the platform's command: macOS's `open -b` on Cursor's bundle, Linux's
    // Cursor CLI, the folder the catalog's.
    U6: (u6) => {
      const folder = u6.sessions.find((s) => s.key === 'c')!.folders![0]!
      const { commands } = driver.seen()
      expect(commands.map((c) => c.argv)).toContainEqual(HOST === 'darwin' ? ['open', '-b', APP_BUNDLES.cursor, folder] : ['cursor', folder])
    },
  }
  afterAll(async () => {
    if (process.env.DIAL_EVAL_OUT) writeResults(process.env.DIAL_EVAL_OUT, 'cursor', collect(runs))
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
    ALSO[scenario.id]?.(scenario)
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
