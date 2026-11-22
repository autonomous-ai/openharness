/**
 * Tier B of the dial eval for Orca (docs/plans/2026-11-22-dial-eval-orca-design.md, "Tier B"), its safety cases first
 * ("Never the real Orca"), before any scenario runs: every session here runs inside the real Orca, whose `orca` is on
 * this worker's PATH and whose names are in its environment. So the daemon's Orca CLI is the fake inside its root, every
 * Orca agent runs on a terminal-host stand-in of its own (harness/orcaHost.ts), and what is started for one has none of
 * this worker's Orca, tmux or terminal values.
 *
 * macOS and Linux; the stand-in's cases where cc is installed. The real Orca, its CLI, its state and this worker's
 * terminal are never touched, and the network guard runs in this process and in every process of each daemon.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { HELD_MAKER, orcaTerminalHandle, type Platform, type Scenario, type SessionDef } from '../src/testing/dialAppEval/types.js'
import { TierBDriver } from './harness/appEvalDriver.js'
import { OrcaAgent, orcaEnv } from './harness/appEvalOrca.js'
import { IsolatedDaemon } from './harness/daemon.js'
import { ORCA_HOST_NAME, orcaHostCc } from './harness/orcaHost.js'

const WIN32 = process.platform === 'win32'
const HOST = process.platform as Platform

/** An Orca session of the safety cases, made up as the catalog's are. */
const session = (key: string, more: Partial<SessionDef> = {}): SessionDef => ({
  key, app: 'orca', id: `00000000-0000-4000-8c00-${Buffer.from(key).toString('hex').padStart(12, '0')}`, title: `Eval ${key}`,
  cwd: '/work/eval-w1', ageMs: 0, worktree: 'w1', tab: 0, ...more,
})
/** Claude Code in its own pane, Codex beside it, and Claude Code in a pane another program made. */
const SESSIONS = [session('a'), session('b', { engine: 'codex', split: 1 }), session('h', { held: true, tab: 1 })]
const SAFETY: Scenario = { id: 'SAFETY', app: 'orca', title: "Orca's safety cases", dims: ['D8'], platforms: [HOST], tiers: ['b'],
  heldOut: false, sessions: SESSIONS, steps: [], checks: [], probes: [] }
/** Its hooks' hints (the plan's Decision 4): its terminal's handle, and on macOS Orca's bundle id. */
const hints = (s: SessionDef): Record<string, string> => ({
  ORCA_TERMINAL_HANDLE: orcaTerminalHandle(s.key), ...(HOST === 'darwin' ? { __CFBundleIdentifier: 'com.stablyai.orca' } : {}),
})

/** This worker's own names, as a run inside Orca, in a tmux pane of its terminal, has them: made up. */
const RUNNER: Readonly<Record<string, string>> = {
  ORCA_TERMINAL_HANDLE: 'term_00000000-0000-4000-8e00-0000000000e1', ORCA_AGENT_SESSION_ID: 'runner-orca-session',
  ORCA_PAIRING_CODE: 'runner-pairing', ORCA_WORKTREE_ID: 'runner-repo::/work/runner', TMUX: '/tmp/runner-tmux/default,4141,0',
  TMUX_PANE: '%41', TERM_PROGRAM: 'runner-terminal', __CFBundleIdentifier: 'com.example.runner',
}
/** The names whose values say where a process runs: Orca's, tmux's and the terminal's. */
const WHERE = /^(ORCA_|TMUX|TERM_PROGRAM|__CFBundleIdentifier$)/
const where = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([name]) => WHERE.test(name)))

/** [fields] of [pid], as `ps` says them. */
const ps = (pid: number, ...fields: string[]): string =>
  execFileSync('/bin/ps', [...fields.flatMap((field) => ['-o', `${field}=`]), '-p', String(pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim()
/** Not a terminal, as `ps` says it on macOS and Linux. */
const NO_TTY = ['??', '?']
const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(WIN32)('the dial eval, tier B: Orca', () => {
  let driver: TierBDriver
  beforeAll(() => { driver = new TierBDriver({}) })
  // It throws naming each attempt off this machine not asserted on yet, the last daemon's as it closed among them.
  afterAll(async () => { await driver?.close() })

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
        const ran = await agent.run('/usr/bin/env', [])
        expect(ran.code, ran.stderr).toBe(0)
        const env = Object.fromEntries(ran.stdout.split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
        // By name alone: a real run's values are its secrets.
        expect(Object.keys(env).filter((name) => WHERE.test(name) && env[name] === process.env[name])).toEqual([])
        expect(where(env)).toEqual(where(orcaEnv(d, s, hints(s))))
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
})
