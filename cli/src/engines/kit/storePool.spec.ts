/** Real private SQLite pools and controlled native races. No owner daemon, engine or home. */
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({
  failures: new Map<string, string>(),
  afterQuery: undefined as undefined | ((path: string) => void | Promise<void>),
  afterStat: undefined as undefined | ((path: string) => void),
  result: undefined as undefined | import('../../lib/sqliteRead.js').SqliteReadResult,
  now: undefined as number | undefined,
  queries: [] as Array<{ path: string; options: import('../../lib/sqliteRead.js').SqliteReadOptions }>,
}))
vi.mock('node:child_process', async original => ({ ...await original<object>(),
  execFile: () => { throw new Error('Native identity tests must not launch a host binary') },
}))
vi.mock('../inProcess.js', () => ({ loadEngine: () => { throw new Error('Session control must remain eager') } }))
vi.mock('node:perf_hooks', async original => {
  const actual = await original<typeof import('node:perf_hooks')>()
  return { ...actual, performance: { now: () => control.now ?? actual.performance.now() } }
})
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs,
    stat: async (path: string) => {
      const code = control.failures.get(`stat:${path}`)
      if (code) throw Object.assign(new Error('controlled inspection failure'), { code })
      const answer = await fs.stat(path)
      control.afterStat?.(path)
      return answer
    },
    opendir: async (...args: Parameters<typeof fs.opendir>) => {
      const code = control.failures.get(`opendir:${args[0]}`)
      if (code) throw Object.assign(new Error('controlled listing failure'), { code })
      return fs.opendir(...args)
    },
  }
})
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, statSync: (...args: Parameters<typeof fs.statSync>) => {
    const code = control.failures.get(`statSync:${args[0]}`)
    if (code) throw Object.assign(new Error('controlled verification failure'), { code })
    return fs.statSync(...args)
  } }
})
vi.mock('../../lib/sqliteRead.js', async original => {
  const sqlite = await original<typeof import('../../lib/sqliteRead.js')>()
  return { ...sqlite, sqliteReadAll: async (...args: Parameters<typeof sqlite.sqliteReadAll>) => {
    control.queries.push({ path: args[0], options: args[3] ?? {} })
    const answer = control.result ?? await sqlite.sqliteReadAll(...args)
    await control.afterQuery?.(args[0])
    return answer
  } }
})

let root: string, home: string
let pool: typeof import('./storePool.js').readStorePool
let repair: typeof import('../../lib/sessionRepair.js').findLiveSession
let declared: import('./storeHomes.js').StoreHomes
let Database: {
  new(path: string): { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): void }; close(): void }
}
const id = '20261009_120000_aaaa', other = '20261009_120001_bbbb'
const query = { sql: 'SELECT id FROM sessions WHERE cwd = ? LIMIT 2', params: ['/fixture/work'], maxRows: 2, maxBuffer: 4096 }
function store(dir: string, ids: string[] = [id]): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'state.db')
  const db = new Database(path)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, started_at REAL)')
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)')
  for (const value of ids) insert.run(value, 'cli', '/fixture/work', Date.parse('2026-10-09T12:00:00Z') / 1000)
  db.close()
  return path
}
function update(path: string, sql: string): void {
  const db = new Database(path)
  db.exec(sql)
  db.close()
}
const read = () => pool(declared, home, query)
const find = () => repair('hermes', '/fixture/work', Date.parse('2026-10-09T11:59:00Z'))
const held = (work: Promise<unknown>) => expect(work).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hermes-store-pool-')))
  home = join(root, 'hermes')
  for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECTS_DIR',
    'CODEX_HOME', 'CURSOR_HOME', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR', 'COPILOT_HOME', 'GROK_HOME', 'AGY_HOME',
    'AGY_CONFIG_DIR', 'PI_HOME', 'MUSE_HOME', 'COMMANDCODE_HOME', 'AMP_SESSIONS_DIR', 'OPENCODE_DATA_DIR',
    'KILO_DATA_DIR', 'DEVIN_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) vi.stubEnv(name, join(root, name))
  vi.stubEnv('HERMES_HOME', home)
  vi.resetModules()
  Database = (process.getBuiltinModule('node:sqlite') as { DatabaseSync: typeof Database }).DatabaseSync
  pool = (await import('./storePool.js')).readStorePool
  repair = (await import('../../lib/sessionRepair.js')).findLiveSession
  declared = (await import('../hermes/contract.js')).HERMES_HOMES
})
afterEach(async () => {
  ;(await import('../../lib/sqliteBuiltin.js')).closeSqliteHandles()
  control.failures.clear(); control.afterQuery = undefined; control.afterStat = undefined
  control.result = undefined; control.now = undefined; control.queries = []
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it('finds a newly created profile despite a warm optional home cache', async () => {
  store(home, [])
  const { listStoreHomes } = await import('./storeHomes.js')
  expect(await listStoreHomes(declared, home)).toEqual([home])
  const profile = join(home, 'profiles', 'new')
  store(profile)
  expect(await find()).toEqual({ sessionId: id, hermesHome: profile })
  expect(await listStoreHomes(declared, home)).toEqual([home])
})

it('counts every row, including two matches inside a single store beside a unique profile', async () => {
  store(home, [id, other]); store(join(home, 'profiles', 'work'))
  expect(await find()).toBeNull()
  expect(await read()).toHaveLength(3)
})

it('proves empty homes without creating stores or loading an optional engine', async () => {
  expect(await read()).toEqual([])
  mkdirSync(join(home, 'profiles', 'unwritten'), { recursive: true })
  expect(await find()).toBeNull()
  expect(control.queries).toEqual([])
})

it.each(['default', 'earlier', 'later'])('holds an unreadable %s store beside a unique healthy claim, then recovers', async where => {
  const good = join(home, 'profiles', 'middle')
  store(good)
  const bad = where === 'default' ? home : join(home, 'profiles', where === 'earlier' ? 'a' : 'z')
  mkdirSync(bad, { recursive: true }); writeFileSync(join(bad, 'state.db'), 'not sqlite')
  await held(find())
  rmSync(join(bad, 'state.db')); store(bad, [])
  expect(await find()).toEqual({ sessionId: id, hermesHome: good })
})

it.each(['stat', 'opendir'])('cannot accept the default answer with incomplete %s evidence', async operation => {
  store(home)
  const target = join(home, 'profiles')
  control.failures.set(`${operation}:${target}`, 'EACCES')
  await held(find())
  control.failures.clear()
  expect(await find()).toEqual({ sessionId: id, hermesHome: home })
})

it('bounds streamed profile entries rather than truncating an allocated directory listing', async () => {
  store(home)
  for (let i = 0; i < 65; i++) mkdirSync(join(home, 'profiles', String(i)), { recursive: true })
  await expect(find()).rejects.toThrow('entry limit')
  expect(control.queries).toHaveLength(0)
  rmSync(join(home, 'profiles', '64'), { recursive: true })
  expect(await find()).toEqual({ sessionId: id, hermesHome: home })
})

it('deduplicates aliases to one physical store but retains all path evidence', async () => {
  const profile = join(home, 'profiles', 'a')
  store(profile)
  symlinkSync(profile, join(home, 'profiles', 'alias'), 'dir')
  expect(await find()).toEqual({ sessionId: id, hermesHome: profile })
  expect(control.queries).toHaveLength(1)
  control.afterQuery = () => { rmSync(join(home, 'profiles', 'alias')); control.afterQuery = undefined }
  await held(find())
})

it.each(['store', 'profile', 'wal', 'journal'])('holds a new %s appearing while another store is queried', async change => {
  store(home)
  const unwritten = join(home, 'profiles', 'unwritten')
  mkdirSync(unwritten, { recursive: true })
  control.afterQuery = () => {
    control.afterQuery = undefined
    if (change === 'store') store(unwritten)
    else if (change === 'profile') store(join(home, 'profiles', 'new'))
    else writeFileSync(join(home, `state.db-${change}`), 'pending native journal')
  }
  await held(find())
})

it.each(['selected', 'negative'])('holds a changed %s query while a later store is read', async kind => {
  const first = store(home, kind === 'selected' ? [id] : [])
  const last = store(join(home, 'profiles', 'last'), kind === 'selected' ? [] : [id])
  control.afterQuery = path => {
    if (path !== last) return
    control.afterQuery = undefined
    update(first, kind === 'selected' ? 'DELETE FROM sessions' : `INSERT INTO sessions VALUES ('${other}', 'cli', '/fixture/work', 1791547200)`)
  }
  await held(find())
})

it('holds a replaced database even when the old open handle still answers', async () => {
  const path = store(home)
  control.afterQuery = () => {
    control.afterQuery = undefined
    renameSync(path, join(home, 'old.db')); store(home, [other])
  }
  await held(find())
  expect(await find()).toEqual({ sessionId: other, hermesHome: home })
})

it('fences profile disappearance and replacement during enumeration', async () => {
  store(home)
  const profile = join(home, 'profiles', 'unwritten')
  mkdirSync(profile, { recursive: true })
  control.afterStat = path => {
    if (path !== profile) return
    control.afterStat = undefined
    rmSync(profile, { recursive: true })
  }
  await held(find())
})

it.each(['state.db', 'state.db-wal', 'state.db-journal'])('holds nonregular native %s without asking SQLite', async name => {
  store(join(home, 'profiles', 'good'))
  mkdirSync(join(home, name))
  await held(find())
  expect(control.queries).toEqual([])
})

it('holds an orphan journal instead of treating its missing database as empty', async () => {
  mkdirSync(home)
  writeFileSync(join(home, 'state.db-wal'), 'orphan')
  await held(find())
})

it.each(['missing', 'transient'] as const)('keeps unavailable SQLite %s distinct from a known empty pool', async reason => {
  store(home)
  control.result = { ok: false, reason }
  await held(find())
  control.result = undefined
  expect(await find()).toEqual({ sessionId: id, hermesHome: home })
})

it('holds malformed ids and unexpectedly unbounded query results', async () => {
  store(home)
  for (const value of [null, 42, '../escape', 'x'.repeat(10_000)]) {
    control.result = { ok: true, rows: [{ id: value }], via: 'builtin' }
    await held(find())
  }
  control.result = { ok: true, rows: [{ id }, { id }, { id }], via: 'builtin' }
  await expect(find()).rejects.toThrow('row limit')
})

it('shares one deadline across stores and passes the remaining budget to SQLite', async () => {
  store(home); store(join(home, 'profiles', 'later'), [])
  control.now = 0
  control.afterQuery = () => { control.now = 2_001 }
  await expect(find()).rejects.toThrow('deadline')
  expect(control.queries).toHaveLength(1)
  expect(control.queries[0].options).toEqual({ busyTimeoutMs: 250, cliTimeoutMs: 2000, maxBuffer: 4096 })
})

it('holds a failed final inspection even after a successful SQL query', async () => {
  const path = store(home)
  control.afterQuery = () => { control.failures.set(`statSync:${path}`, 'EACCES') }
  await held(find())
})
