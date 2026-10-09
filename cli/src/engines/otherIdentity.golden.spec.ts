/**
 * Where the core finds the twelve other engines' conversations, recorded from main before their layouts, homes
 * and finders left the core's static imports (docs/design/2026-10-08-other-engines-out-of-core.md, (o6)). Through
 * the core's own entries:
 *
 * - the registry: the transcript a hook's session is bound to (`register`, derived from each layout when the hook
 *   names none), which transcripts it accepts (`validTranscriptPath`) and which engines keep one;
 * - binding a process that names its session on its command line, and Copilot's `/resume` (`createBinding`);
 * - repair: the session a live process is running, found by its folder, its store or its lock (`findLiveSession`),
 *   and a resumed Pi conversation (`findResumedTranscript`);
 * - Cursor's homes, and the hook command that names them.
 *
 * Every home is under a throwaway root named through the environment, which is pinned whatever the host sets;
 * file times are set, the clock and `process.platform` pinned, `TZ` is UTC, and no path's length matters. Results
 * name the root `<root>`. Agy's Linux descriptor lookup reads controlled /proc entries, never host processes.
 *
 * `RECORD_OTHER_ENGINES_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter where these
 * engines' conversations are found, and say so in that change.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentEngine } from './types.js'

vi.mock('../lib/bootId.js', async (original) => ({ ...await original<object>(), currentBootId: () => 'linux:11111111-1111-4111-8111-111111111111' }))

const descriptors = vi.hoisted(() => new Map<string, string[]>())
vi.mock('fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs,
    realpath: (name: string) => fs.realpath(name.startsWith('/work/') ? join(root, 'workspaces', name.slice(6)) : name),
    // Keep a streamed descriptor listing private as well as the former readdir path.
    opendir: async (path: string, ...args: unknown[]) => /^\/proc\/\d+\/fd$/.test(String(path))
      ? { async *[Symbol.asyncIterator]() {
        for (const [index] of (descriptors.get(String(path)) ?? []).entries()) yield { name: String(index) }
      } }
      : Reflect.apply(fs.opendir, fs, [path, ...args]),
    readdir: async (path: string, ...args: unknown[]) => /^\/proc\/\d+\/fd$/.test(String(path))
      ? (descriptors.get(String(path)) ?? []).map((_, index) => String(index))
      : Reflect.apply(fs.readdir, fs, [path, ...args]),
    readlink: async (path: string, ...args: unknown[]) => {
      const match = /^(\/proc\/\d+\/fd)\/(\d+)$/.exec(String(path))
      return match ? descriptors.get(match[1]!)?.[Number(match[2])] ?? '' : Reflect.apply(fs.readlink, fs, [path, ...args])
    },
  }
})
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  const mapped = (name: string) => name.startsWith('/work/') ? join(root, 'workspaces', name.slice(6)) : name
  return { ...fs, realpathSync: (name: string) => fs.realpathSync(mapped(name)), statSync: (name: string) => fs.statSync(mapped(name)) }
})

const GOLDEN = fileURLToPath(new URL('./__fixtures__/other-identity.golden.json', import.meta.url))
const RECORD = process.env.RECORD_OTHER_ENGINES_GOLDEN === '1'
const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const T0 = NOW - 60 * 60_000
const UUID = (n: number) => `0b6f4f2e-6c1a-4c55-9a51-${String(n).padStart(12, '0')}`
const ENGINES = ['claude', 'codex', 'cursor', 'opencode', 'pi', 'hermes', 'commandcode', 'devin', 'muse', 'amp', 'kilo', 'grok', 'agy', 'copilot', 'terminal'] as const

let root = ''
let golden: Record<string, unknown> = {}
const recorded: Record<string, unknown> = {}
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null).split(root).join('<root>'))
function check(key: string, value: unknown): void {
  const result = normalize(value)
  recorded[key] = result
  if (!RECORD) expect({ key, result }).toEqual({ key, result: golden[key] })
}
const writtenFiles: string[] = []
let fileTime = T0
/** A file, written, whose modification time is the next tick of a fixed clock: a scan's newest-first order is set. */
function file(path: string, text = ''): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  writtenFiles.push(path)
  fileTime += 1000
  utimesSync(path, fileTime / 1000, fileTime / 1000)
  return path
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const saved: Record<string, string | undefined> = {}
type Modules = {
  registry: typeof import('../lib/registry.js')
  repair: typeof import('../lib/sessionRepair.js')
  bind: typeof import('../core/agents/bind.js')
  notify: typeof import('./kit/notifyHooks.js')
  home: typeof import('./cursor/home.js')
  hermes: typeof import('./hermes/contract.js')
  cursorDiscovery: typeof import('../core/engines/cursorDiscovery.js')
}
let m: Modules

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'other-identity-golden-')))
  for (const cwd of ['r', 'other']) mkdirSync(join(root, 'workspaces', cwd), { recursive: true })
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  const home = join(root, 'home')
  const env: Record<string, string | undefined> = {
    HOME: home, XDG_CONFIG_HOME: undefined, XDG_DATA_HOME: undefined, ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
    CLAUDE_PROJECTS_DIR: join(home, '.claude', 'projects'), CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: undefined,
    AGY_HOME: join(home, '.gemini', 'antigravity-cli'), AGY_CONFIG_DIR: undefined, COPILOT_HOME: join(home, '.copilot'),
    GROK_HOME: join(home, '.grok'), CURSOR_HOME: join(home, '.cursor'), CURSOR_DATA_DIR: undefined, CURSOR_CONFIG_DIR: undefined,
    COMMANDCODE_HOME: join(home, '.commandcode'), MUSE_HOME: join(home, '.muse'), PI_HOME: join(home, '.pi'), HERMES_HOME: join(home, '.hermes'),
    AMP_SESSIONS_DIR: join(root, 'data', 'amp-sessions'), OPENCODE_DATA_DIR: join(home, '.local', 'share', 'opencode'),
    KILO_DATA_DIR: join(home, '.local', 'share', 'kilo'), DEVIN_HOME: join(home, '.local', 'share', 'devin', 'cli'), TZ: 'UTC',
  }
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
  for (const dir of ['data', 'runtime', join('home', '.claude', 'projects'), join('home', '.codex')]) mkdirSync(join(root, dir), { recursive: true })
  vi.resetModules()
  m = {
    registry: await import('../lib/registry.js'),
    repair: await import('../lib/sessionRepair.js'),
    bind: await import('../core/agents/bind.js'),
    notify: await import('./kit/notifyHooks.js'),
    home: await import('./cursor/home.js'),
    hermes: await import('./hermes/contract.js'),
    cursorDiscovery: await import('../core/engines/cursorDiscovery.js'),
  }
  m.registry.registry.load()
  golden = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>
})

afterAll(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', platform)
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  if (root) rmSync(root, { recursive: true, force: true })
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(recorded, null, 1) + '\n')
})

const home = (...parts: string[]) => join(root, 'home', ...parts)
let pane = 0
/** A hook's session, registered as the registry takes it: its process opened on a pane first. */
function register(engine: AgentEngine, input: { sessionId: string; cwd?: string; transcriptPath?: string }) {
  const tmuxPane = `%${++pane}`
  const processIdentity = { pid: 10_000 + pane, startMarker: `Mon Oct  8 10:00:${String(pane % 60).padStart(2, '0')} 2026`, executable: engine }
  m.registry.registry.openProcessAgent({ engine, tmuxPane, cwd: input.cwd ?? null, processIdentity })
  const result = m.registry.registry.register({ engine, tmuxPane, processIdentity, ...input })
  return result && { transcriptPath: result.entry.transcriptPath, cwd: result.entry.cwd, sessionId: result.entry.sessionId }
}

describe('where the core finds the other engines\' conversations', () => {
  it('distinguishes Hermes history ids from ids admitted by a terminal hook', () => {
    const ids = ['20261008_110000_a1b2', '20261008_110000_ABCDEF', '20261008_110000_0123456789abcdef',
      '20261008_110000_abc', '20261008_110000_0123456789abcdef0', '20261008_110000_ghijkl', UUID(1), UUID(1).toUpperCase(),
      '', '../escape', '20261008_110000_a1b2.jsonl', ' 20261008_110000_a1b2', '20261008_110000_a1b2\n']
    check('Hermes id rules', ids.map(id => [id, m.hermes.HERMES_HISTORY_ID_RE.test(id), m.hermes.HERMES_SOURCE.id.test(id)]))
  })

  it('derives each layout\'s transcript for a hook that names none, and takes one it names only in its own folder', () => {
    const cwds = ['/work/My Project', '/work/camelCaseRepo', '/work/über-ünïcødé', '/', '/work/a/../b']
    const results: unknown[] = []
    for (const engine of ['commandcode', 'grok', 'agy', 'copilot', 'cursor', 'pi', 'muse', 'amp'] as const) {
      for (const [i, cwd] of cwds.entries()) {
        for (const sessionId of [UUID(i + 1), 'not-a-uuid', '../escape', 'with space']) {
          results.push([engine, cwd, sessionId, register(engine, { sessionId, cwd })])
        }
      }
      // A transcript the hook names: inside each engine's folder, and outside it.
      const inside: Record<string, string> = {
        commandcode: home('.commandcode', 'projects', 'work-x', `${UUID(90)}.jsonl`),
        grok: home('.grok', 'sessions', encodeURIComponent('/work/x'), UUID(90), 'updates.jsonl'),
        agy: home('.gemini', 'antigravity-cli', 'brain', UUID(90), '.system_generated', 'logs', 'transcript_full.jsonl'),
        copilot: home('.copilot', 'session-state', UUID(90), 'events.jsonl'),
        cursor: home('.cursor', 'projects', 'work-x', 'agent-transcripts', UUID(90), `${UUID(90)}.jsonl`),
        pi: home('.pi', 'agent', 'sessions', '--work-x--', `2026_${UUID(90)}.jsonl`),
        muse: home('.muse', 'sessions', '2026', '10', '08', UUID(90), 'session.jsonl'),
        amp: join(root, 'data', 'amp-sessions', `T-${UUID(90)}.jsonl`),
      }
      file(inside[engine]!, '{}\n')
      const outside = file(join(root, 'elsewhere', `${engine}.jsonl`), '{}\n')
      results.push([engine, 'named inside', register(engine, { sessionId: UUID(90), cwd: '/work/x', transcriptPath: inside[engine] })])
      results.push([engine, 'named outside', register(engine, { sessionId: UUID(91), cwd: '/work/x', transcriptPath: outside })])
    }
    check('register', results)
  }, 120_000)

  it('accepts a transcript only in its engine\'s folders, and says which engines keep one', () => {
    const paths = [
      home('.commandcode', 'projects', 'p', `${UUID(1)}.jsonl`),
      home('.grok', 'sessions', 'x', UUID(1), 'updates.jsonl'),
      home('.gemini', 'antigravity-cli', 'brain', UUID(1), '.system_generated', 'logs', 'transcript_full.jsonl'),
      home('.copilot', 'session-state', UUID(1), 'events.jsonl'),
      home('.cursor', 'projects', 'p', 'agent-transcripts', UUID(1), `${UUID(1)}.jsonl`),
      home('.cursor', 'projects', 'p', 'agent-transcripts', UUID(1), `${UUID(2)}.jsonl`),
      home('.cursor', 'projects', 'p', 'transcripts', UUID(1), `${UUID(1)}.jsonl`),
      home('.pi', 'agent', 'sessions', 'p', 'x.jsonl'),
      home('.muse', 'sessions', 's.jsonl'),
      join(root, 'data', 'amp-sessions', 'T-1.jsonl'),
    ].map((path) => file(path, '{}\n'))
    const missing = home('.copilot', 'session-state', UUID(5), 'events.jsonl')
    mkdirSync(join(missing, '..'), { recursive: true })
    check('valid transcripts', ENGINES.map((engine) => [engine, m.registry.engineKeepsTranscriptFile(engine),
      [...paths, missing].map((path) => m.registry.validTranscriptPath(engine, path)),
      m.registry.validTranscriptPath(engine, missing, undefined, true)]))
  })

  it('names Cursor\'s homes as its environment does, and the hook command with them', () => {
    const variants: NodeJS.ProcessEnv[] = [{}, { CURSOR_DATA_DIR: '/data/cursor' }, { CURSOR_CONFIG_DIR: '/config/cursor' }, { XDG_CONFIG_HOME: '/xdg' },
      { CURSOR_CONFIG_DIR: '  ', XDG_CONFIG_HOME: '  /xdg2 ', CURSOR_DATA_DIR: ' ' }]
    check('cursor homes', variants.map((vars) => [vars, m.home.cursorConfigDir(vars), m.home.cursorDataDir(vars)]))
    check('hook command', m.notify.command(19473, 'cursor').split(m.notify.HOOK_SCRIPT).join('<script>').split(process.execPath).join('<node>'))
  })

  it('binds a process that names its session, and follows Copilot\'s /resume', async () => {
    file(home('.cursor', 'projects', 'p', 'agent-transcripts', UUID(31), `${UUID(31)}.jsonl`), '{}\n')
    file(home('.grok', 'sessions', encodeURIComponent('/work/g'), UUID(32), 'updates.jsonl'), '{}\n')
    file(home('.gemini', 'antigravity-cli', 'brain', UUID(33), '.system_generated', 'logs', 'transcript_full.jsonl'), '{}\n')
    file(home('.copilot', 'session-state', UUID(34), 'events.jsonl'), '{}\n')
    file(home('.copilot', 'session-state', UUID(34), 'inuse.4242.lock'))
    file(home('.copilot', 'session-state', UUID(35), 'inuse.4242.lock'))
    file(home('.grok', 'sessions', 'hashed-group', '.cwd'), ' /work/g \n')
    file(home('.grok', 'sessions', 'hashed-group', UUID(36), 'updates.jsonl'), '{}\n')
    file(home('.copilot', 'session-state', UUID(35), 'events.jsonl'), '{}\n')
    const registered: unknown[] = []
    const agents = new Map<string, Record<string, unknown>>()
    const binding = m.bind.createBinding({
      registry: {
        inheritName: () => {}, unbindSession: () => true, byAgent: (id: string) => agents.get(id),
        byProcess: (engine: string) => agents.get(engine), has: () => false, bySession: () => undefined,
        register: (input: unknown) => { registered.push(input); return null },
      } as never,
      mirror: { inheritSummary: () => {} }, forgetSession: () => {}, clients: { send: () => {} }, attachSession: async () => true,
      announceSession: () => {}, stoppedAgents: { save: () => {}, finishResume: () => {}, get: () => null } as never, syncRecapPool: () => {},
      teams: { forget: () => {} } as never, input: { forget: () => {} } as never, deviceInput: { forget: () => {} } as never,
      homes: { copilot: home('.copilot'), grok: home('.grok'), agy: home('.gemini', 'antigravity-cli') },
    })
    const observed = (engine: string, over: Record<string, unknown>) => ({
      engine, cwd: '/work/g', runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux:%1',
      processIdentity: { pid: 4242, startMarker: 'Mon Oct  8 10:00:00 2026', executable: engine }, ...over,
    })
    const results: unknown[] = []
    const ids: Record<string, string[]> = { cursor: [UUID(31), UUID(39)], grok: [UUID(32), UUID(36), UUID(39)], agy: [UUID(33), UUID(39)], copilot: [UUID(34), UUID(39)] }
    for (const [engine, sessions] of Object.entries(ids)) {
      for (const resumeSessionId of sessions) {
        agents.clear(); agents.set(engine, { agentId: `agent-${engine}`, engine, sessionId: '', registeredAt: 0 })
        registered.length = 0
        await binding.bindObservedAgent(observed(engine, { resumeSessionId }) as never)
        results.push([engine, resumeSessionId, [...registered]])
      }
    }
    agents.clear(); agents.set('copilot', { agentId: 'agent-copilot', engine: 'copilot', sessionId: UUID(34), registeredAt: 0 })
    registered.length = 0
    await binding.bindObservedAgent(observed('copilot', {}) as never)
    results.push(['copilot /resume', [...registered]])
    check('bind', results)
  }, 60_000)

  it('repairs a live process\'s session: by folder, by store, by its lock, and a resumed Pi conversation', async () => {
    const since = T0
    // Resolver/binding fixtures model older conversations; repair gets a fresh corpus below.
    for (const path of writtenFiles) utimesSync(path, (T0 - 60_000) / 1000, (T0 - 60_000) / 1000)
    // Pi, Command Code and Amp name the folder on their first line; Muse its workspace, once a run has opened.
    file(home('.pi', 'agent', 'sessions', '--work-r--', `2026_${UUID(41)}.jsonl`), `${JSON.stringify({ type: 'session', id: UUID(41), cwd: '/work/r' })}\n`)
    file(home('.commandcode', 'projects', 'work-r', `${UUID(42)}.jsonl`), `${JSON.stringify({ cwd: '/work/r', sessionId: UUID(42) })}\n`)
    file(join(root, 'data', 'amp-sessions', `T-${UUID(43)}.jsonl`), `${JSON.stringify({ t: 'session', threadId: `T-${UUID(43)}`, cwd: '/work/r' })}\n`)
    const museRun = [JSON.stringify({ payload: { kind: 'session', record: { workspace_root: '/work/r' } } }), JSON.stringify({ payload: { kind: 'run', event: { kind: 'started' } } })]
    file(home('.muse', 'sessions', '2026', '10', '08', UUID(44), 'session.jsonl'), `${museRun.join('\n')}\n`)
    file(home('.muse', 'sessions', '2026', '10', '08', UUID(45), 'session.jsonl'), `${museRun[0]}\n`)
    file(home('.grok', 'sessions', encodeURIComponent('/work/r'), UUID(46), 'updates.jsonl'), '{}\n')
    file(home('.copilot', 'session-state', UUID(47), 'events.jsonl'), `${JSON.stringify({ type: 'session.start', data: { context: { cwd: '/work/r' } } })}\n`)
    file(home('.copilot', 'session-state', UUID(48), 'inuse.5151.lock'))
    // Hermes: a store per home, the default and a profile's.
    const { DatabaseSync } = (process as unknown as { getBuiltinModule(name: string): unknown }).getBuiltinModule('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void }
    }
    // Both claim /work/both, which is ambiguous; each has one of its own.
    for (const [store, id, cwd] of [[home('.hermes', 'state.db'), '20261008_110000_a1b2', '/work/r'], [home('.hermes', 'profiles', 'work', 'state.db'), '20261008_110500_c3d4', '/work/p']] as const) {
      mkdirSync(join(store, '..'), { recursive: true })
      const db = new DatabaseSync(store)
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, started_at REAL, source TEXT);
        INSERT INTO sessions VALUES ('${id}', '${cwd}', ${(since + 120_000) / 1000}, 'cli'), ('${id}0', '/work/both', ${(since + 120_000) / 1000}, 'cli');`)
      db.close()
    }
    const results: unknown[] = []
    for (const engine of ['pi', 'commandcode', 'amp', 'muse', 'grok', 'copilot', 'hermes', 'agy'] as const) {
      for (const opts of [undefined, { bornOnly: true }, { pid: 5151 }, { pid: 99_999_999 }]) {
        results.push([engine, opts ?? null, await m.repair.findLiveSession(engine, '/work/r', since, opts).catch((error: Error) => `threw ${error.message}`)])
      }
    }
    for (const cwd of ['/work/p', '/work/both', '/work/none']) {
      results.push(['hermes', cwd, await m.repair.findLiveSession('hermes', cwd, since).catch((error: Error) => `threw ${error.message}`)])
    }
    for (const [sessionId, cwd] of [[UUID(41), '/work/r'], [UUID(41), '/work/other'], [UUID(49), '/work/r'], ['bad id', '/work/r']] as const) {
      results.push(['pi resumed', sessionId, cwd, await m.repair.findResumedTranscript('pi', sessionId, { cwd }).catch((error: Error) => `threw ${error.message}`)])
    }
    check('repair', results)
  }, 60_000)

  it('repairs agy\'s session from controlled Linux descriptor evidence of its held lock', async () => {
    const id = UUID(50)
    file(home('.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl'), '{}\n')
    const lock = file(home('.gemini', 'antigravity-cli', 'presence', `${id}.lock`))
    const results: unknown[] = []
    descriptors.set('/proc/4242/fd', [lock])
    try {
      results.push(['held', await m.repair.findLiveSession('agy', '/work/r', T0, { pid: 4242 })])
      descriptors.delete('/proc/4242/fd')
      results.push(['let go', await m.repair.findLiveSession('agy', '/work/r', T0, { pid: 4242 })])
    } finally { descriptors.clear() }
    check('repair agy lock', results)
  }, 60_000)

  it('locates an existing and a later Cursor transcript through core discovery, and stops pending work', async () => {
    const { loadEngine } = await import('./inProcess.js')
    await loadEngine('cursor')
    const found: unknown[] = []
    const discovery = m.cursorDiscovery.createCursorDiscovery(home('.cursor'), (id, path) => { found.push([id, path]) })
    await discovery.start()
    try {
      const existing = UUID(61), later = UUID(62), removed = UUID(63)
      file(home('.cursor', 'projects', 'golden-existing', 'agent-transcripts', existing, `${existing}.jsonl`), '{}\n')
      await discovery.add(existing)
      await discovery.add(later)
      await discovery.add(removed)
      discovery.remove(removed)
      file(home('.cursor', 'projects', 'golden-later', 'agent-transcripts', later, `${later}.jsonl`), '{}\n')
      file(home('.cursor', 'projects', 'golden-removed', 'agent-transcripts', removed, `${removed}.jsonl`), '{}\n')
      await vi.waitFor(() => expect(found).toHaveLength(2), { timeout: 5000 })
      await discovery.add('../invalid')
      await discovery.stop()
      check('pending cursor transcripts', found)
    } finally { await discovery.stop() }
  })

  it('has a recorded outcome for every case, and no other', () => {
    if (RECORD) return
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(golden).sort())
  })
})
