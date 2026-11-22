import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { daemonEnvironment } from './daemonEnvironment.js'
import type { SessionDef } from './dialAppEval/types.js'

// The dial eval's tier B Orca harness, the parts that need no daemon (docs/plans/2026-11-22-dial-eval-orca-design.md,
// "Never the real Orca"). It is outside tsconfig's rootDir (src), so it is loaded untyped, as dialAppEvalTierB.spec.ts
// loads the harness.
const orca = await import('../../e2e/harness/appEvalOrca.js' as string) as {
  orcaEnv(d: { env: NodeJS.ProcessEnv }, s: SessionDef, hints: Record<string, string>): NodeJS.ProcessEnv
  startedWith(pid: number): string[]
}
const inOrca = await import('../../e2e/harness/inOrca.js' as string) as { IN_ORCA: Record<string, string> }
const plugin = await import('../../e2e/harness/pluginLoop.js' as string) as {
  pluginLoopEnv(d: { env: NodeJS.ProcessEnv }): NodeJS.ProcessEnv
  startPluginLoop(d: { root: string; env: NodeJS.ProcessEnv }, children: ChildProcess[]): { stop(): Promise<number | null> }
}
const { until } = await import('../../e2e/harness/daemon.js' as string) as {
  until<T>(what: string, probe: () => T | null | undefined | false, ms: number, every: number): Promise<T>
}

/** This worker's own names, as a run inside Orca, in a tmux pane of its terminal, has them: made up, and none may reach
 *  what tier B starts. */
const RUNNER: Readonly<Record<string, string>> = {
  ORCA_TERMINAL_HANDLE: 'term_00000000-0000-4000-8e00-0000000000e1', ORCA_AGENT_SESSION_ID: 'runner-orca-session',
  ORCA_PAIRING_CODE: 'runner-pairing', ORCA_AGENT_SESSION_SPAWN_TOKEN: 'runner-spawn', ORCA_WORKTREE_ID: 'runner-repo::/work/runner',
  TMUX: '/tmp/runner-tmux/default,4141,0', TMUX_PANE: '%41', TERM_PROGRAM: 'runner-terminal', __CFBundleIdentifier: 'com.example.runner',
}
/** The names whose values say where a process runs: Orca's, tmux's and the terminal's. */
const WHERE = /^(ORCA_|TMUX|TERM_PROGRAM|__CFBundleIdentifier$)/
const where = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([name]) => WHERE.test(name)))
/** The names of [env] that hold this worker's value: by name alone, as a real run's values are its secrets. */
const workers = (env: NodeJS.ProcessEnv): string[] =>
  Object.keys(env).filter((name) => WHERE.test(name) && process.env[name] !== undefined && env[name] === process.env[name])
/** The other names, whose value in [env] is not [daemon]'s: by name alone. */
const notDaemons = (env: NodeJS.ProcessEnv, daemon: NodeJS.ProcessEnv): string[] =>
  [...new Set([...Object.keys(env), ...Object.keys(daemon)])].filter((name) => !WHERE.test(name) && env[name] !== daemon[name])

/** An Orca session, made up as the catalog's are. */
const session = (key: string, more: Partial<SessionDef> = {}): SessionDef => ({
  key, app: 'orca', id: `00000000-0000-4000-8c00-${Buffer.from(key).toString('hex').padStart(12, '0')}`, title: `Eval ${key}`,
  cwd: '/work/eval-w1', ageMs: 0, worktree: 'w1', tab: 0, ...more,
})

let dir = ''
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe("tier B's Orca agents' environment", () => {
  it("orcaEnv holds none of this worker's ORCA_*, TMUX*, TERM_PROGRAM or __CFBundleIdentifier values, only the daemon's and the session's own", () => {
    for (const [name, value] of Object.entries(RUNNER)) vi.stubEnv(name, value)
    // The daemon's, made from this worker's as the harness makes it (harness/daemon.ts), its own tmux folder among them.
    const d = { env: daemonEnvironment(process.env, { HOME: '/tmp/eval-root/home', PATH: '/tmp/eval-root/bin:/usr/bin:/bin', TMUX_TMPDIR: '/tmp/eval-root' }) }
    const own = { ORCA_TERMINAL_HANDLE: 'term_00000000-0000-4000-8d00-000000000061', __CFBundleIdentifier: 'com.stablyai.orca' }
    // Claude Code in the person's tmux in an Orca pane: tmux hands its own names on.
    const cases: Array<[SessionDef, Record<string, string>]> = [
      [session('a'), own],
      [session('t', { tmux: true }), { ...own, TMUX: '/tmp/eval-root/default,4242,0', TMUX_PANE: '%3' }],
    ]
    for (const [s, hints] of cases) {
      const env = orca.orcaEnv(d, s, hints)
      expect(workers(env)).toEqual([])
      expect(where(env)).toEqual({ ...where(d.env), ...inOrca.IN_ORCA, ORCA_AGENT_SESSION_ID: `eval-orca-${s.key}`, ...hints })
      expect(notDaemons(env, d.env)).toEqual([])
    }
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
})
