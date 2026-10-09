/**
 * How the core admits a Hermes session and learns its home, recorded from main before Hermes's admission and home
 * probe left the core's static imports (docs/design/2026-10-08-other-engines-out-of-core.md, (o6)). Through the
 * core's own entries:
 *
 * - the hook server: a Hermes hook is answered at once and settled off the HTTP path, by the `source` of its
 *   session's row in whichever home's store holds it: a pane's own session is registered (with its home, when that
 *   is not the default), a delegated one ignored, and one no store has yet registered after a bounded wait;
 * - discovery (`probeTerminalAgents`): the home a live Hermes process names in its environment, and nothing for
 *   any other engine's.
 *
 * Every home is under a throwaway root named through the environment, pinned whatever the host sets; the process
 * table and each process's environment are given, `TZ` is UTC, and no path's length matters. Results name the root
 * `<root>`. `RECORD_OTHER_ENGINES_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter
 * how Hermes's sessions are admitted or homed, and say so in that change.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const GOLDEN = fileURLToPath(new URL('./__fixtures__/other-admission.golden.json', import.meta.url))
const RECORD = process.env.RECORD_OTHER_ENGINES_GOLDEN === '1'
const START = 'Thu Oct  8 10:00:00 2026'

// The process table and each process's environment, as the host would report them.
const host = vi.hoisted(() => ({ rows: null as unknown[] | null, envs: new Map<number, Record<string, string> | null>() }))
vi.mock('../lib/tmux.js', async (real) => ({
  ...await real<object>(),
  processRows: vi.fn(async () => host.rows),
  enrichProcessRows: vi.fn(async (rows: unknown[]) => rows),
}))
vi.mock('../lib/processEnv.js', async (real) => ({
  ...await real<object>(),
  readProcessEnv: vi.fn(async (identity: { pid: number }) => host.envs.get(identity.pid) ?? null),
}))

let root = ''
let golden: Record<string, unknown> = {}
const recorded: Record<string, unknown> = {}
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null).split(root).join('<root>'))
function check(key: string, value: unknown): void {
  const result = normalize(value)
  recorded[key] = result
  if (!RECORD) {
    if (key === 'admission') {
      // Preserve the former artifact, including its unsafe first-home answer. Complete native
      // pools deliberately hold this case and explain unreadable evidence; healthy answers stay unchanged.
      const label = 'one in both homes: the default asked first'
      const before = golden[key] as unknown[][], after = result as unknown[][]
      expect(before.filter(row => row[0] === label)).toEqual([[label, 200, { pending: true },
        [{ sessionId: '20261008_100002_dddddd', engine: 'hermes', hermesHome: null }],
        ['[hooks] 20261008 SessionStart · engine=hermes · isNew=true · after a source check']]])
      expect(after.filter(row => row[0] === label)).toEqual([[label, 200, { pending: true }, [],
        ['[hooks] 20261008 SessionStart held · Hermes session source is ambiguous across homes; keeping the current conversation.']]])
      const unreadable = 'one whose candidate store cannot be read'
      const held = '[hooks] 20261008 SessionStart held · Hermes session source is unavailable; keeping the current conversation.'
      expect(before.filter(row => row[0] === unreadable)).toEqual([[unreadable, 200, { pending: true }, [], [held]]])
      expect(after.filter(row => row[0] === unreadable)).toEqual([[unreadable, 200, { pending: true }, [],
        [held + ' Conversation identity is held: a native store query is unavailable.']]])
      const healthy = (row: unknown[]) => row[0] !== label && row[0] !== unreadable
      expect(after.filter(healthy)).toEqual(before.filter(healthy))
    } else expect({ key, result }).toEqual({ key, result: golden[key] })
  }
}

const saved: Record<string, string | undefined> = {}
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
type Modules = {
  registry: typeof import('../lib/registry.js')
  hookServer: typeof import('../hookServer.js')
  hookAuth: typeof import('../lib/hookAuth.js')
  discovery: typeof import('../lib/terminalAgentDiscovery.js')
}
let m: Modules
const home = (...parts: string[]) => join(root, 'home', ...parts)

beforeAll(async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  root = realpathSync(mkdtempSync(join(tmpdir(), 'other-admission-golden-')))
  const env: Record<string, string | undefined> = {
    HOME: home(), ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'), HERMES_HOME: home('.hermes'),
    CLAUDE_PROJECTS_DIR: home('.claude', 'projects'), CODEX_HOME: home('.codex'), CLAUDE_CONFIG_DIR: undefined, TZ: 'UTC',
  }
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
  for (const dir of ['data', 'runtime', join('home', '.claude', 'projects'), join('home', '.codex')]) mkdirSync(join(root, dir), { recursive: true })
  vi.resetModules()
  m = {
    registry: await import('../lib/registry.js'),
    hookServer: await import('../hookServer.js'),
    hookAuth: await import('../lib/hookAuth.js'),
    discovery: await import('../lib/terminalAgentDiscovery.js'),
  }
  m.registry.registry.load()
  golden = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>
})

afterAll(() => {
  Object.defineProperty(process, 'platform', platform)
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  if (root) rmSync(root, { recursive: true, force: true })
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(recorded, null, 1) + '\n')
})

describe('how the core admits a Hermes session and learns its home', () => {
  it('admits a Hermes hook by its session\'s source, in whichever home\'s store holds it', async () => {
    const { DatabaseSync } = (process as unknown as { getBuiltinModule(name: string): unknown }).getBuiltinModule('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void }
    }
    const store = (dir: string, rows: Array<[string, string]>) => {
      mkdirSync(dir, { recursive: true })
      const db = new DatabaseSync(join(dir, 'state.db'))
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, started_at REAL);
        ${rows.map(([id, source]) => `INSERT INTO sessions VALUES ('${id}', '${source}', '/work/h', 0);`).join('\n')}`)
      db.close()
    }
    // The default home, a profile with a store, and one without: a profile is a home once a session has run in it.
    store(home('.hermes'), [['20261008_100000_aaaaaa', 'cli'], ['20261008_100001_bbbbbb', 'tool'], ['20261008_100002_dddddd', 'cli']])
    store(home('.hermes', 'profiles', 'work'), [['20261008_100003_cccccc', 'tui'], ['20261008_100004_eeeeee', ''], ['20261008_100002_dddddd', 'tool'], ['20261008_100005_ffffff', 'delegate']])
    mkdirSync(home('.hermes', 'profiles', 'empty'), { recursive: true })
    writeFileSync(home('.hermes', 'profiles', 'empty', 'config.yaml'), '')

    const registered: unknown[] = []
    const logs: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
    let server: Server | null = null
    try {
      const started = await m.hookServer.startHookServer(0, {
        onRegistered: (entry) => { registered.push({ sessionId: entry.sessionId, engine: entry.engine, hermesHome: entry.hermesHome ?? null }) },
        onSessionEnd: () => {},
      })
      server = started.server
      const headers = { 'content-type': 'application/json', 'x-harness-hook-token': m.hookAuth.readHookCredential(join(root, 'data'))! }
      const results: unknown[] = []
      const cases = [
        ['the default home\'s CLI session', '20261008_100000_aaaaaa'],
        ['a session one delegated to', '20261008_100001_bbbbbb'],
        ['a profile\'s TUI session', '20261008_100003_cccccc'],
        ['a profile\'s session with no source', '20261008_100004_eeeeee'],
        ['a profile\'s delegated session', '20261008_100005_ffffff'],
        ['one in both homes: the default asked first', '20261008_100002_dddddd'],
        ['an editor\'s session, whose id is a uuid', '0b6f4f2e-6c1a-4c55-9a51-000000000001'],
        ['one no store holds yet', '20261008_100009_999999'],
        ['one whose candidate store cannot be read', '20261008_100010_aaaaaa'],
      ] as const
      let pane = 0
      for (const [label, sessionId] of cases) {
        if (label === 'one whose candidate store cannot be read') {
          // Added only after the existing cases; preserve their former inputs and outcomes.
          // Invalid SQLite bytes are unreadable on every host, including privileged CI users.
          mkdirSync(home('.hermes', 'profiles', 'unreadable'), { recursive: true })
          writeFileSync(home('.hermes', 'profiles', 'unreadable', 'state.db'), 'not a SQLite database')
          const { forgetStoreHomes } = await import('./kit/storeHomes.js')
          const { HERMES_HOMES } = await import('./hermes/contract.js')
          forgetStoreHomes(HERMES_HOMES)
        }
        const tmuxPane = `%${++pane}`
        m.registry.registry.openProcessAgent({ engine: 'hermes', tmuxPane, cwd: '/work/h', processIdentity: { pid: 20_000 + pane, startMarker: START, executable: 'python3' } })
        registered.length = 0
        logs.length = 0
        const response = await fetch(`http://127.0.0.1:${started.port}/api/hook/session-start`, {
          method: 'POST', headers, body: JSON.stringify({ engine: 'hermes', tmuxPane, sessionId, cwd: '/work/h', hookEvent: 'SessionStart' }),
        })
        const answer = await response.json()
        // Settled off the HTTP path: verified, rejected, or explicitly held without a registry write.
        const deadline = Date.now() + 10_000
        while (!registered.length && !logs.some((line) => line.includes('ignored') || line.includes(' held ·')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
        results.push([label, response.status, answer, [...registered], logs.filter((line) => line.startsWith('[hooks]'))])
      }
      check('admission', results)
    } finally {
      log.mockRestore()
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    }
  }, 120_000)

  it('reads a Hermes process\'s home off its environment, and nothing for another engine\'s', async () => {
    const row = (pid: number, parentPid: number, executable: string, args = executable) => ({ pid, parentPid, executable, args, startMarker: START })
    const panes = [
      ['a profile', { HERMES_HOME: home('.hermes', 'profiles', 'work') }],
      ['the default', { HERMES_HOME: home('.hermes') }],
      ['the default, with a trailing slash', { HERMES_HOME: `${home('.hermes')}/` }],
      ['a relative path', { HERMES_HOME: 'profiles/work' }],
      ['a path with a control character', { HERMES_HOME: `${home('.hermes')}\u0007x` }],
      ['none', {}],
      ['an environment that could not be read', null],
    ] as const
    host.rows = []
    host.envs.clear()
    const roots: Array<{ runtime: { backend: 'tmux'; paneId: string }; rootPid: number; cwd: string }> = []
    panes.forEach(([, processEnv], i) => {
      const shell = 100 + i * 10
      host.rows!.push(row(shell, 1, 'zsh'), row(shell + 1, shell, 'python3', '/opt/hermes-agent/hermes'))
      host.envs.set(shell + 1, processEnv as Record<string, string> | null)
      roots.push({ runtime: { backend: 'tmux', paneId: `%${50 + i}` }, rootPid: shell, cwd: '/work/h' })
    })
    // Another engine's process, under a Hermes variable it does not read.
    host.rows.push(row(900, 1, 'zsh'), row(901, 900, 'claude'))
    host.envs.set(901, { HERMES_HOME: home('.hermes', 'profiles', 'work') })
    roots.push({ runtime: { backend: 'tmux', paneId: '%90' }, rootPid: 900, cwd: '/work/h' })
    const backend = { name: 'tmux', instanceId: 'tmux', inventory: async () => ({ state: 'available', roots }) }
    const probe = await m.discovery.probeTerminalAgents([backend as never], ['tmux'], 999_999)
    const byPane = new Map(probe.agents.map((agent) => [agent.primaryRuntimeKey, agent]))
    check('home probe', [...panes.map(([label], i) => [label, `%${50 + i}`] as const), ['claude', '%90'] as const].map(([label, paneId]) => {
      const agent = [...byPane.values()].find((one) => one.runtimes.some((runtime) => runtime.paneId === paneId))
      return [label, agent ? { engine: agent.engine, hermesHome: agent.hermesHome === undefined ? 'undefined' : agent.hermesHome } : 'no agent']
    }))
  }, 60_000)

  it('has a recorded outcome for every case, and no other', () => {
    if (RECORD) return
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(golden).sort())
  })
})
