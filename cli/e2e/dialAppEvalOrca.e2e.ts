/**
 * Tier B of the dial eval for Orca (docs/plans/2026-11-22-dial-eval-orca-design.md, "Tier B"), its safety cases first
 * ("Never the real Orca"), before any scenario runs: every session here runs inside the real Orca, whose `orca` is on
 * this worker's PATH and whose names are in its environment. So the daemon's Orca CLI is the fake inside its root, every
 * Orca agent runs on a terminal-host stand-in of its own (harness/orcaHost.ts), and what is started for one has none of
 * this worker's Orca, tmux or terminal values. Then each main scenario of the catalog for Orca that runs in tier B, on
 * the real daemon and devices process, through the tier B driver (harness/appEvalDriver.ts) and Orca's steps
 * (harness/appEvalOrca.ts): Claude Code and Codex in Orca's panes, the fake Orca's layout and focus, and Orca's plugin's
 * own loop.
 *
 * macOS and Linux; the stand-in's cases where cc is installed. The real Orca, its CLI, its state and this worker's
 * terminal are never touched, and the network guard runs in this process and in every process of each daemon.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { scenariosFor } from '../src/testing/dialAppEval/catalog.js'
import { loadBaseline, SKIP_RATCHET_ENV, tierBVerdict } from '../src/testing/dialAppEval/grade.js'
import { collect, runScenario, uncaughtProbes, writeResults, type ScenarioRun } from '../src/testing/dialAppEval/runner.js'
import { HELD_MAKER, type Platform, type Scenario, type SessionDef } from '../src/testing/dialAppEval/types.js'
import { inside, orcaCliInside, TierBDriver } from './harness/appEvalDriver.js'
import { madeUpSession as session, OrcaAgent, orcaHints, orcaSteps, RUNNER, startedWith, STREAM_OPEN, where, WHERE }
  from './harness/appEvalOrca.js'
import { IsolatedDaemon } from './harness/daemon.js'
import { IN_ORCA } from './harness/inOrca.js'
import { ORCA_HOST_NAME, orcaHostCc, running } from './harness/orcaHost.js'

const WIN32 = process.platform === 'win32'
const HOST = process.platform as Platform
const SCENARIOS = WIN32 ? [] : scenariosFor('b', HOST).filter((s) => s.app === 'orca' && !s.heldOut)

/** Claude Code in its own pane, Codex beside it, and Claude Code in a pane another program made. */
const SESSIONS = [session('a'), session('b', { engine: 'codex', split: 1 }), session('h', { held: true, tab: 1 })]
const SAFETY: Scenario = { id: 'SAFETY', app: 'orca', title: "Orca's safety cases", dims: ['D8'], platforms: [HOST], tiers: ['b'],
  heldOut: false, sessions: SESSIONS, steps: [], checks: [], probes: [] }
/** Its hooks' hints at its first launch (the plan's Decision 4): its terminal's handle, and on macOS Orca's bundle id. */
const hints = (s: SessionDef): Record<string, string> => orcaHints(s, 0, HOST)

/** [fields] of [pid], as `ps` says them. */
const ps = (pid: number, ...fields: string[]): string =>
  execFileSync('/bin/ps', [...fields.flatMap((field) => ['-o', `${field}=`]), '-p', String(pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim()
/** Not a terminal, as `ps` says it on macOS and Linux. */
const NO_TTY = ['??', '?']

/** Whether a command is Orca's CLI, by either of the fake's names, running `<group> <verb>`. */
const ranOrca = (argv: readonly string[], group: string, verb: string): boolean =>
  ['orca', 'orca-ide'].includes(argv[0] ?? '') && argv[1] === group && argv[2] === verb

describe.skipIf(WIN32)('the dial eval, tier B: Orca', () => {
  let driver: TierBDriver
  const runs: ScenarioRun[] = []
  beforeAll(() => { driver = new TierBDriver({ orca: orcaSteps }) })
  /** What a scenario's run proves beside its checks, read from its world as it stopped. */
  const ALSO: Partial<Record<string, () => void>> = {
    // The devices read Orca's layout from the fake: they ran its `terminal list`.
    O1: () => {
      expect(driver.seen().commands.filter((c) => ranOrca(c.argv, 'terminal', 'list'))).not.toEqual([])
    },
    // With no plugin in Orca, no loop of it ran and the devices opened no dial stream.
    O13: () => {
      expect(driver.lastWorld().children.filter((child) => child.spawnargs.some((arg) => arg.endsWith('pluginDial.ts')))).toEqual([])
      expect((driver.seen().logs ?? []).filter(({ line }) => line === STREAM_OPEN)).toEqual([])
    },
  }
  afterAll(async () => {
    if (process.env.DIAL_EVAL_OUT) writeResults(process.env.DIAL_EVAL_OUT, 'orca', collect(runs))
    // It throws naming each attempt off this machine not asserted on yet, the last daemon's as it closed among them.
    await driver?.close()
  })

  // First, before any daemon: each start below fails before its own.
  it("a start with orca or orca-ide resolved outside the daemon's root throws before the daemon starts", async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dial-eval-orca-'))
    const create = IsolatedDaemon.create.bind(IsolatedDaemon)
    const started = vi.spyOn(IsolatedDaemon.prototype, 'start')
    try {
      for (const name of ['orca', 'orca-ide']) {
        // A real Orca's CLI first on the daemon's PATH, as this worker's is on its own: one that refuses, should it run.
        rmSync(join(outside, 'orca'), { force: true })
        rmSync(join(outside, 'orca-ide'), { force: true })
        writeFileSync(join(outside, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
        vi.spyOn(IsolatedDaemon, 'create').mockImplementationOnce(async (options) => {
          const d = await create(options)
          d.env.PATH = `${outside}:${d.env.PATH}`
          return d
        })
        await expect(driver.start({ ...SAFETY, fresh: true }, HOST)).rejects.toThrow("the daemon's Orca CLI is not inside its root")
        await driver.stop()
      }
      expect(started).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(!orcaHostCc)("a process run for an Orca agent has none of this worker's Orca, tmux or terminal values", async () => {
    for (const [name, value] of Object.entries(RUNNER)) vi.stubEnv(name, value)
    try {
      // The daemon made with this worker's values in its environment.
      await driver.start({ ...SAFETY, fresh: true }, HOST)
      const { d, children } = driver.lastWorld()
      for (const s of SESSIONS) {
        const agent = await OrcaAgent.start(d, children, s, hints(s))
        // Run as its hooks are, under its engine's environment: Claude Code's InOrca's, Codex's CodexOutside's.
        const ran = await agent.run('/usr/bin/env', [])
        expect(ran.code, ran.stderr).toBe(0)
        const env = Object.fromEntries(ran.stdout.split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
        // By name alone: a real run's values are its secrets.
        expect(Object.keys(env).filter((name) => WHERE.test(name) && env[name] === process.env[name])).toEqual([])
        expect(where(env)).toEqual({ ...where(d.env), ...IN_ORCA, ORCA_AGENT_SESSION_ID: `eval-orca-${s.key}`, ...hints(s) })
        // Its runner, every hook's caller, as it was started: under the daemon's environment, its host's.
        const runner = startedWith(agent.pid).map((entry) => entry.slice(0, entry.indexOf('='))).filter((name) => WHERE.test(name))
        expect(runner.sort()).toEqual(Object.keys(where(d.env)).sort())
        await agent.close()
      }
    } finally {
      await driver.stop()
      vi.unstubAllEnvs()
    }
    expect(driver.networkReached()).toEqual([])
  })

  it.skipIf(!orcaHostCc)("an Orca agent's hooks run on its stand-in's pty under Orca's host's name, eval-terminal for a held pane, never on this worker's terminal", async () => {
    const own = ps(process.pid, 'tty')
    await driver.start(SAFETY, HOST)
    try {
      const { d, children } = driver.lastWorld()
      for (const s of SESSIONS) {
        const agent = await OrcaAgent.start(d, children, s, hints(s))
        await agent.hook('start')
        await agent.hook('turn-start')
        if (s.engine !== 'codex') await agent.hook('needs-input')
        await agent.hook('turn-stop')
        // Its runner, every hook's caller: on a pty its host made, under the host's name.
        const [ppid, tty] = ps(agent.pid, 'ppid', 'tty').split(/\s+/)
        expect(basename(ps(Number(ppid), 'comm'))).toBe(s.held ? HELD_MAKER : ORCA_HOST_NAME)
        expect(NO_TTY).not.toContain(tty)
        expect(tty).not.toBe(own)
        // What it runs is its runner's child, on that pty, as each hook is.
        const ran = await agent.run('/bin/sh', ['-c', 'exec /bin/ps -o ppid= -o tty= -p $$'])
        expect(ran.stdout.trim().split(/\s+/)).toEqual([String(agent.pid), tty])
        // It leaves as its engine does, and its stand-in with it.
        await agent.hook('end')
        expect(running(agent.pid)).toBe(false)
      }
    } finally {
      await driver.stop()
    }
    expect(driver.networkReached()).toEqual([])
  })

  it.for(SCENARIOS)('$id: $title', async (scenario) => {
    const began = Date.now()
    const run = await runScenario(driver, scenario, HOST)
    // Kept before any assertion, so a scenario that fails one is still in the results and the baseline's verdict.
    runs.push(run)
    expect(run.error).toBeUndefined()
    console.log(`[dial eval] ${scenario.id}: ${Date.now() - began} ms`)
    const { d } = driver.lastWorld()
    for (const path of [d.env.HOME, d.env.HARNESS_OPEN_BIN]) expect(inside(d.root, path), path).toBe(true)
    expect(() => orcaCliInside(d.env, d.root, process.platform)).not.toThrow()
    ALSO[scenario.id]?.()
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
