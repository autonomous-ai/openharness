/**
 * Tier B of the dial eval for VS Code (docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md, "Tier B"): each main
 * scenario of the catalog for VS Code that runs in tier B, on the real daemon and devices process, through the tier B
 * driver (harness/appEvalDriver.ts) and the editors' steps (harness/appEvalEditor.ts): Claude Code and Codex in terminals
 * under fake VS Codes, Claude Code in its panel, and Harness's extension's own loop over each fake window. V11 is macOS's
 * alone.
 *
 * macOS and Linux. Every daemon has a throwaway home; its open, its home, the apps' stores and VS Code's and Cursor's
 * CLIs are checked inside its root before it starts, and it reaches the fake backend only. The real VS Code and Cursor,
 * their CLIs, `/usr/bin/open`, `~/.vscode`, `~/.cursor`, `~/.claude`, `~/.codex` and this computer's daemon are never
 * touched. The network guard runs in this process and in every process of each daemon: a connection to anything but this
 * machine fails the scenario, by host and port.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { scenariosFor } from '../src/testing/dialAppEval/catalog.js'
import { loadBaseline, SKIP_RATCHET_ENV, tierBVerdict } from '../src/testing/dialAppEval/grade.js'
import { collect, runScenario, uncaughtProbes, writeResults, type ScenarioRun } from '../src/testing/dialAppEval/runner.js'
import type { Platform, Scenario } from '../src/testing/dialAppEval/types.js'
import { inside, TierBDriver } from './harness/appEvalDriver.js'
import { vscodeSteps } from './harness/appEvalEditor.js'
import { IsolatedDaemon } from './harness/daemon.js'

const WIN32 = process.platform === 'win32'
const HOST = process.platform as Platform
const SCENARIOS = WIN32 ? [] : scenariosFor('b', HOST).filter((s) => s.app === 'vscode' && !s.heldOut)
const named = (id: string): Scenario => SCENARIOS.find((s) => s.id === id)!

describe.skipIf(WIN32)('the dial eval, tier B: VS Code', () => {
  let driver: TierBDriver
  const runs: ScenarioRun[] = []
  beforeAll(() => { driver = new TierBDriver({ vscode: vscodeSteps }) })
  afterAll(async () => {
    if (process.env.DIAL_EVAL_OUT) writeResults(process.env.DIAL_EVAL_OUT, 'vscode', collect(runs))
    // It throws naming each attempt off this machine not asserted on yet, the last daemon's as it closed among them.
    await driver?.close()
  })

  it("the daemon's home, its open, VS Code's and Cursor's CLIs are inside its root, and a start with either CLI outside it throws before the daemon starts", async () => {
    const v6 = named('V6')
    await driver.start(v6, HOST)
    try {
      const { d } = driver.lastWorld()
      for (const path of [d.env.HOME, d.env.HARNESS_OPEN_BIN, d.env.HARNESS_VSCODE_BIN, d.env.HARNESS_CURSOR_BIN]) {
        expect(inside(d.root, path), path).toBe(true)
      }
    } finally {
      await driver.stop()
    }
    const outside = mkdtempSync(join(tmpdir(), 'dial-eval-cli-'))
    const create = IsolatedDaemon.create.bind(IsolatedDaemon)
    const started = vi.spyOn(IsolatedDaemon.prototype, 'start')
    try {
      for (const [name, variable] of [['VS Code', 'HARNESS_VSCODE_BIN'], ['Cursor', 'HARNESS_CURSOR_BIN']] as const) {
        // The daemon made as the driver makes it, its CLI then moved outside its root.
        vi.spyOn(IsolatedDaemon, 'create').mockImplementationOnce(async (options) => {
          const d = await create(options)
          d.env[variable] = join(outside, 'bin')
          return d
        })
        await expect(driver.start({ ...v6, fresh: true }, HOST)).rejects.toThrow(`the daemon's ${name} CLI is not inside its root`)
        await driver.stop()
      }
      expect(started).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("a window's lines name shells by their sessions' keys, never a pid", async () => {
    const v5 = named('V5')
    const run = await runScenario(driver, v5, HOST)
    expect(run.error).toBeUndefined()
    const { streams = [] } = driver.seen()
    expect(new Set(streams.map((s) => s.window))).toEqual(new Set(['eval-w1-1', 'eval-w2-1']))
    const shells = streams.flatMap(({ line }) => [line.show, line.pid, line.active, ...Array.isArray(line.terminals) ? line.terminals : []])
      .filter((shell) => shell !== undefined && shell !== null)
    expect(shells).not.toEqual([])
    const keys = [...v5.sessions.map((s) => s.key), 'other']
    expect(shells.filter((shell) => typeof shell !== 'string' || !keys.includes(shell))).toEqual([])
  })

  it("a Codex with its own home writes its rollout outside the daemon's CODEX_HOME", async () => {
    const v9 = named('V9')
    const run = await runScenario(driver, v9, HOST)
    expect(run.error).toBeUndefined()
    const { d } = driver.lastWorld()
    const { id } = v9.sessions.find((s) => s.key === 'b')!
    const rollouts = readdirSync(d.root, { recursive: true }).map(String).filter((name) => name.endsWith(`-${id}.jsonl`))
      .map((name) => join(d.root, name))
    expect(rollouts).not.toEqual([])
    expect(rollouts.filter((path) => inside(d.env.CODEX_HOME!, path))).toEqual([])
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
