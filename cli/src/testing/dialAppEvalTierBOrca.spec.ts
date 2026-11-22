import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { daemonEnvironment } from './daemonEnvironment.js'
import { NET_GUARD_FILE_ENV, netGuardEnv, readNetGuard } from './dialAppEval/netGuard.js'
import { orcaPaneHandle, type Delivery, type Scenario, type Seen, type SessionDef, type SessionKey } from './dialAppEval/types.js'

// The dial eval's tier B Orca harness, the parts that need no daemon (docs/plans/2026-11-22-dial-eval-orca-design.md,
// "Never the real Orca"). It is outside tsconfig's rootDir (src), so it is loaded untyped, as dialAppEvalTierB.spec.ts
// loads the harness.
/** What OrcaAgent.start reads of a daemon: its root, its environment and its projects folder. */
type AgentDaemon = { root: string; projectsDir: string; env: NodeJS.ProcessEnv }
const orca = await import('../../e2e/harness/appEvalOrca.js' as string) as {
  orcaEngine(d: AgentDaemon, children: ChildProcess[], s: SessionDef, hints: Record<string, string>): { readonly env: NodeJS.ProcessEnv }
  orcaHints(s: SessionDef, launch: number, platform: NodeJS.Platform, tmux?: Record<string, string>): Record<string, string>
  OrcaAgent: {
    start(d: AgentDaemon, children: ChildProcess[], s: SessionDef, hints: Record<string, string>): Promise<{
      readonly pid: number; hook(event: 'start'): Promise<void>; close(): Promise<void>
    }>
  }
  startedWith(pid: number): string[]
  RUNNER: Readonly<Record<string, string>>
  WHERE: RegExp
  where(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  madeUpSession(key: string, more?: Partial<SessionDef>): SessionDef
  orcaSteps: {
    hook(world: unknown, step: { kind: 'hook'; session: SessionKey; event: 'start' }): Promise<void>
    quit(world: unknown, step: { kind: 'quit'; app: 'orca' }): Promise<void>
    relaunch(world: unknown, step: { kind: 'relaunch'; app: 'orca' }): Promise<void>
  }
  startOrcaPlugin(d: { root: string; env: NodeJS.ProcessEnv }, children: ChildProcess[]): { stop(): Promise<number | null> }
}
const { orcaHostCc } = await import('../../e2e/harness/orcaHost.js' as string) as { orcaHostCc: string | null }
const inOrca = await import('../../e2e/harness/inOrca.js' as string) as { IN_ORCA: Record<string, string> }
const plugin = await import('../../e2e/harness/pluginLoop.js' as string) as {
  pluginLoopEnv(d: { env: NodeJS.ProcessEnv }): NodeJS.ProcessEnv
  startPluginLoop(d: { root: string; env: NodeJS.ProcessEnv }, children: ChildProcess[]): { stop(): Promise<number | null> }
}
const { until } = await import('../../e2e/harness/daemon.js' as string) as {
  until<T>(what: string, probe: () => T | null | undefined | false, ms: number, every: number): Promise<T>
}
/** A run the fake Orca noted (harness/fakeOrca.ts log): the name it was run by and its arguments, its exit, its time. */
type OrcaRun = { argv: string[]; ok: boolean; at: number }
const driver = await import('../../e2e/harness/appEvalDriver.js' as string) as {
  orcaDeliveries(runs: readonly OrcaRun[], ownerOf: (handle: string, at: number) => SessionKey | undefined): Delivery[]
  orcaCommands(runs: readonly OrcaRun[], projects: readonly string[]): Seen['commands']
  orcaAccounts(scenario: Pick<Scenario, 'sessions'>): SessionKey[]
  orcaAccountHome(root: string, key: SessionKey): string
}

const { RUNNER, WHERE, where, madeUpSession: session } = orca
/** The names of [env] that hold this worker's value: by name alone, as a real run's values are its secrets. */
const workers = (env: NodeJS.ProcessEnv): string[] =>
  Object.keys(env).filter((name) => WHERE.test(name) && process.env[name] !== undefined && env[name] === process.env[name])
/** The other names, whose value in [env] is not [daemon]'s: by name alone. */
const notDaemons = (env: NodeJS.ProcessEnv, daemon: NodeJS.ProcessEnv): string[] =>
  [...new Set([...Object.keys(env), ...Object.keys(daemon)])].filter((name) => !WHERE.test(name) && env[name] !== daemon[name])

let dir = ''
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe("tier B's Orca agents' environment", () => {
  it("the hooks of Claude Code and Codex in Orca get none of this worker's ORCA_*, TMUX*, TERM_PROGRAM or __CFBundleIdentifier values, only the daemon's and the session's own", () => {
    for (const [name, value] of Object.entries(RUNNER)) vi.stubEnv(name, value)
    dir = mkdtempSync(join(tmpdir(), 'tier-b-orca-env-'))
    const root = realpathSync(dir)
    // The daemon's, made from this worker's as the harness makes it (harness/daemon.ts), its own tmux folder among them.
    const d: AgentDaemon = { root, projectsDir: join(root, 'projects'), env: daemonEnvironment(process.env, {
      HOME: join(root, 'home'), PATH: `${join(root, 'bin')}:/usr/bin:/bin`, TMUX_TMPDIR: root, CODEX_HOME: join(root, 'codex'),
    }) }
    const own = { ORCA_TERMINAL_HANDLE: 'term_00000000-0000-4000-8d00-000000000061', __CFBundleIdentifier: 'com.stablyai.orca' }
    // Claude Code in the person's tmux in an Orca pane: tmux hands its own names on.
    const cases: Array<[SessionDef, Record<string, string>]> = [
      [session('a'), own],
      [session('t', { tmux: true }), { ...own, TMUX: `${root}/default,4242,0`, TMUX_PANE: '%3' }],
      [session('c', { engine: 'codex' }), own],
    ]
    for (const [s, hints] of cases) {
      // What its every hook runs under: its engine's.
      const env = orca.orcaEngine(d, [], s, hints).env
      expect(workers(env)).toEqual([])
      expect(where(env)).toEqual({ ...where(d.env), ...inOrca.IN_ORCA, ORCA_AGENT_SESSION_ID: `eval-orca-${s.key}`, ...hints })
      expect(notDaemons(env, d.env)).toEqual([])
    }
  })
})

describe.skipIf(!orcaHostCc)("tier B's Orca agent whose hooks name no handle", () => {
  it('a session whose hooks name no handle runs its hooks on its stand-in with no ORCA_TERMINAL_HANDLE', async () => {
    for (const [name, value] of Object.entries(RUNNER)) vi.stubEnv(name, value)
    dir = mkdtempSync(join(tmpdir(), 'tier-b-orca-agent-'))
    const root = realpathSync(dir)
    const home = join(root, 'home')
    const said = join(root, 'hook.txt')
    // Claude Code's settings as the daemon installs them: its start hook notes its environment, then its parent and tty.
    mkdirSync(join(home, '.claude'), { recursive: true })
    const command = `{ /usr/bin/env; echo; /bin/ps -o ppid= -o tty= -p $$; } > '${said}' # notify.mjs`
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } }))
    const d: AgentDaemon = { root, projectsDir: join(root, 'projects'),
      env: daemonEnvironment(process.env, { HOME: home, PATH: '/usr/bin:/bin', CLAUDE_PROJECTS_DIR: join(root, 'claude-projects') }) }
    const s = session('b', { tab: 1, handle: 'none' })
    const children: ChildProcess[] = []
    try {
      const agent = await orca.OrcaAgent.start(d, children, s, orca.orcaHints(s, 0, process.platform))
      await agent.hook('start')
      const [env, where] = readFileSync(said, 'utf8').split('\n\n')
      const names = Object.fromEntries(env!.split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
      expect(names).not.toHaveProperty('ORCA_TERMINAL_HANDLE')
      expect(names.ORCA_AGENT_SESSION_ID).toBe('eval-orca-b')
      expect(workers(names)).toEqual([])
      // Its runner, the stand-in's child on its pty, ran the hook.
      const [ppid, tty] = where!.trim().split(/\s+/)
      expect(Number(ppid)).toBe(agent.pid)
      expect(['??', '?']).not.toContain(tty)
      await agent.close()
    } finally {
      for (const child of children) child.kill('SIGKILL')
    }
  })
})

describe.skipIf(!orcaHostCc)("tier B's Orca relaunch", () => {
  it("a session first started after Orca's relaunch opens its pane on that relaunch's handle, as one it ran at its quit does", async () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-orca-relaunch-'))
    const root = realpathSync(dir)
    const home = join(root, 'home')
    const codexHome = join(root, 'codex')
    mkdirSync(home)
    mkdirSync(codexHome)
    // Codex's start hook as the daemon installs it, doing nothing here: Codex runs no hook as it ends.
    writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true # notify.mjs' }] }] } }))
    const sessions = [session('a', { engine: 'codex' }), session('b', { engine: 'codex', tab: 1 })]
    const opened: Array<[SessionKey, string | null]> = []
    const children: ChildProcess[] = []
    const world = {
      d: { root, projectsDir: join(root, 'projects'), env: daemonEnvironment(process.env, { HOME: home, PATH: '/usr/bin:/bin', CODEX_HOME: codexHome }) },
      children, platform: process.platform, orca: { listing: () => {}, endWatch: () => {} },
      scenario: { id: 'T', app: 'orca', sessions, steps: [], checks: [], probes: [] },
      session: (key: SessionKey) => sessions.find((s) => s.key === key)!,
      orcaPane: (key: SessionKey, handle: string | null) => { opened.push([key, handle]) },
    }
    try {
      await orca.orcaSteps.hook(world, { kind: 'hook', session: 'a', event: 'start' })
      await orca.orcaSteps.quit(world, { kind: 'quit', app: 'orca' })
      await orca.orcaSteps.relaunch(world, { kind: 'relaunch', app: 'orca' })
      await orca.orcaSteps.hook(world, { kind: 'hook', session: 'b', event: 'start' })
      const [a, b] = sessions as [SessionDef, SessionDef]
      expect(opened).toEqual([['a', orcaPaneHandle(a, 0)], ['a', null], ['a', orcaPaneHandle(a, 1)], ['b', orcaPaneHandle(b, 1)]])
    } finally {
      for (const child of children) child.kill('SIGKILL')
    }
  })
})

describe.skipIf(process.platform === 'win32')("tier B's Orca agent in the person's tmux", () => {
  it('an agent whose start fails leaves no tmux session behind, so a reused daemon starts it again', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-orca-tmux-'))
    const root = realpathSync(dir)
    const said = join(root, 'tmux.txt')
    const socket = join(root, 'tmux', 'default')
    // The kill goes through the tmux on the daemon's tmux PATH: here one that notes its arguments.
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${said}'\n`, { mode: 0o755 })
    const env = { PATH: `${join(root, 'bin')}:/usr/bin:/bin` }
    // Outside the catalog's folders: OrcaAgent.start refuses it once its tmux session is made.
    const s = session('t', { tmux: true, cwd: '/tmp/eval-outside' })
    const children: ChildProcess[] = []
    const world = {
      d: { root, env, tmux: { socket, env, run: async (verb: string) => (verb === 'new-session' ? '%7' : `${socket},4242,$3`) } },
      children, platform: process.platform, orca: { endWatch: () => {} },
      scenario: { id: 'T', app: 'orca', sessions: [s], steps: [], checks: [], probes: [] },
      session: () => s, folder: () => root,
    }
    try {
      await expect(orca.orcaSteps.hook(world, { kind: 'hook', session: 't', event: 'start' })).rejects.toThrow('is not a catalog folder')
      expect(readFileSync(said, 'utf8')).toBe(`-S ${socket} -f /dev/null kill-session -t eval-t\n`)
    } finally {
      for (const child of children) child.kill('SIGKILL')
    }
  })
})

describe("tier B's Orca accounts", () => {
  it("the daemon's Orca lists a home for each Orca Codex agent with one of its own, inside the daemon's root, and nothing else", () => {
    const sessions: SessionDef[] = [
      session('a'), session('b', { engine: 'codex', codexHome: 'own' }), session('c', { engine: 'codex' }),
      { ...session('d', { engine: 'codex', codexHome: 'own' }), app: 'vscode' }, session('e', { engine: 'codex', codexHome: 'own' }),
    ]
    // Claude Code, a Codex in the daemon's own home, and another app's Codex are no Orca account's.
    expect(driver.orcaAccounts({ sessions })).toEqual(['b', 'e'])
    expect(relative('/tmp/eval-root', driver.orcaAccountHome('/tmp/eval-root', 'b')).startsWith('..')).toBe(false)
    expect(driver.orcaAccountHome('/tmp/eval-root', 'b')).not.toBe(driver.orcaAccountHome('/tmp/eval-root', 'e'))
  })
})

describe("tier B's fake Orca's runs", () => {
  const A = 'term_00000000-0000-4000-8d00-000000000061'
  const B = 'term_00000000-0000-4000-8d00-000000000062'
  /** `orca terminal send` as the devices run it (cable/hosts/orca.ts), by the name the fake was run by. */
  const send = (name: string, handle: string, text: string, at: number, ok = true): OrcaRun =>
    ({ argv: [name, 'terminal', 'send', '--terminal', handle, `--text=${text}`, '--enter', '--wait-submit', '5', '--json'], ok, at })

  it("the fake's send runs are typed deliveries to the session whose handle they name, at their times, and to none for another handle", () => {
    // a's pane is A until 3000, when it closes; B is no session's own pane.
    const ownerOf = (handle: string, at: number): SessionKey | undefined => (handle === A && at < 3_000 ? 'a' : undefined)
    const runs: OrcaRun[] = [
      { argv: ['orca', 'terminal', 'list', '--json', '--include-visual-layouts'], ok: true, at: 900 },
      send('orca', A, 'Eval words for alpha.', 1_000),
      { argv: ['orca', 'terminal', 'switch', '--terminal', A, '--json'], ok: true, at: 1_500 },
      send('orca-ide', B, 'Eval words for bravo.', 2_000),
      // Orca refused it: no words were typed.
      send('orca', A, 'Eval refused.', 2_500, false),
      send('orca', A, 'Eval words after the close.', 3_500),
    ]
    expect(driver.orcaDeliveries(runs, ownerOf)).toEqual([
      { at: 1_000, path: 'typed', target: 'a', text: 'Eval words for alpha.' },
      { at: 2_000, path: 'typed', target: null, text: 'Eval words for bravo.' },
      { at: 3_500, path: 'typed', target: null, text: 'Eval words after the close.' },
    ])
  })

  it('its runs become commands as the daemon ran them, a projects folder written as /work/', () => {
    const projects = ['/tmp/eval-root/projects', '/private/tmp/eval-root/projects']
    const runs: OrcaRun[] = [
      { argv: ['orca-ide', 'terminal', '--help'], ok: true, at: 100 },
      { argv: ['orca', 'worktree', 'activate', '--worktree', 'id:eval-repo::/work/eval-w2', '--json'], ok: true, at: 200 },
      { argv: ['orca', 'terminal', 'switch', '--terminal', A, '--json'], ok: false, at: 300 },
      { argv: ['orca', 'terminal', 'create', '--cwd', '/private/tmp/eval-root/projects/eval-w1'], ok: true, at: 400 },
    ]
    expect(driver.orcaCommands(runs, projects)).toEqual([
      { at: 100, argv: ['orca-ide', 'terminal', '--help'], ok: true },
      { at: 200, argv: ['orca', 'worktree', 'activate', '--worktree', 'id:eval-repo::/work/eval-w2', '--json'], ok: true },
      { at: 300, argv: ['orca', 'terminal', 'switch', '--terminal', A, '--json'], ok: false },
      { at: 400, argv: ['orca', 'terminal', 'create', '--cwd', '/work/eval-w1'], ok: true },
    ])
  })
})

describe.skipIf(process.platform === 'win32')("tier B's Orca plugin", () => {
  it("the plugin's environment is its home and /usr/bin:/bin alone, and its harness shim is inside the root and starts the CLI under the daemon's environment alone", async () => {
    for (const [name, value] of Object.entries(RUNNER)) vi.stubEnv(name, value)
    dir = mkdtempSync(join(tmpdir(), 'tier-b-plugin-'))
    const root = realpathSync(dir)
    const said = join(root, 'cli-env.json')
    const preload = join(root, 'cli-env.cjs')
    // Each run of the CLI notes the environment it was started with and ends, before the CLI itself does anything.
    writeFileSync(preload, "require('node:fs').writeFileSync(process.env.EVAL_CLI_ENV, JSON.stringify(process.env)); process.exit(0)\n")
    const home = join(root, 'home')
    mkdirSync(home)
    const d = { root, env: daemonEnvironment(process.env, { HOME: home, PATH: '/usr/bin:/bin', NODE_OPTIONS: `--require ${preload}`, EVAL_CLI_ENV: said }) }
    const children: ChildProcess[] = []
    const loop = plugin.startPluginLoop(d, children)
    try {
      // The loop asks `harness device orca link` at once: through the shim, the one launcher it can find.
      const cli = await until('the plugin to run the CLI through its shim', () => existsSync(said) && JSON.parse(readFileSync(said, 'utf8')) as NodeJS.ProcessEnv, 30_000, 50)
      // Read once it runs: a process read before its exec has its parent's. Its names first: a leak's values are secrets.
      const started = orca.startedWith(children[0]!.pid!).sort()
      expect(started.map((entry) => entry.slice(0, entry.indexOf('=')))).toEqual(['HOME', 'PATH'])
      expect(started).toEqual([`HOME=${home}`, 'PATH=/usr/bin:/bin'])
      expect(plugin.pluginLoopEnv(d)).toEqual({ HOME: home, PATH: '/usr/bin:/bin' })
      const shim = realpathSync(join(home, '.local', 'bin', 'harness'))
      expect(relative(root, shim).startsWith('..')).toBe(false)
      expect(workers(cli)).toEqual([])
      expect(where(cli)).toEqual(where(d.env))
      // macOS's CoreFoundation sets this one in every Node it loads in, from the account's settings, under `env -i` too.
      expect(notDaemons(cli, d.env).filter((name) => name !== '__CF_USER_TEXT_ENCODING')).toEqual([])
    } finally {
      await loop.stop()
      for (const child of children) child.kill('SIGKILL')
    }
  })

  it("the plugin the eval starts runs under the daemon's network guard, its environment its home, /usr/bin:/bin and the guard alone", async () => {
    for (const [name, value] of Object.entries(RUNNER)) vi.stubEnv(name, value)
    dir = mkdtempSync(join(tmpdir(), 'tier-b-plugin-'))
    const root = realpathSync(dir)
    const said = join(root, 'cli-env.json')
    const preload = join(root, 'cli-env.cjs')
    // The CLI notes that it ran and ends, before it does anything; the plugin's own Node, with no EVAL_CLI_ENV, goes on.
    writeFileSync(preload, "if (process.env.EVAL_CLI_ENV) { require('node:fs').writeFileSync(process.env.EVAL_CLI_ENV, '{}'); process.exit(0) }\n")
    const home = join(root, 'home')
    mkdirSync(home)
    const guard = join(root, 'net-guard.jsonl')
    // The daemon's environment as the eval makes it (harness/appEvalDriver.ts openRig): the guard ahead of its preloads.
    const d = { root, env: daemonEnvironment(process.env, { HOME: home, PATH: '/usr/bin:/bin', EVAL_CLI_ENV: said, ...netGuardEnv(guard, `--require ${preload}`) }) }
    const children: ChildProcess[] = []
    const loop = orca.startOrcaPlugin(d, children)
    try {
      await until('the plugin to run the CLI through its shim', () => existsSync(said), 30_000, 50)
      const pid = children[0]!.pid!
      expect(readNetGuard(guard).loaded).toContainEqual({ pid, process: 'node' })
      // Its names first: a leak's values are secrets.
      const started = orca.startedWith(pid)
      expect(started.map((entry) => entry.slice(0, entry.indexOf('='))).sort()).toEqual(['HOME', NET_GUARD_FILE_ENV, 'NODE_OPTIONS', 'PATH'].sort())
      expect(started).toEqual(expect.arrayContaining([`HOME=${home}`, `${NET_GUARD_FILE_ENV}=${guard}`, 'PATH=/usr/bin:/bin']))
      // macOS's ps splits a value at its spaces: the guard's preload is its first word.
      expect(started.find((entry) => entry.startsWith('NODE_OPTIONS='))?.split(' ')[0]).toBe(`NODE_OPTIONS=${netGuardEnv(guard).NODE_OPTIONS}`)
    } finally {
      await loop.stop()
      for (const child of children) child.kill('SIGKILL')
    }
  })
})
