/**
 * Hermes discovery against real stores: fixture databases built from the schema dumped (read-only)
 * from this machine's `~/.hermes/state.db` (schema 22) and from the schema 17 the installed CLI's
 * code writes, in WAL mode, read through both of Harness's SQLite paths. No real conversation text.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { builtinSqlite, closeSqliteHandles, overrideBuiltinSqlite } from '../../sqliteRead.js'
import {
  activeProfile, argvProfile, bestContinuation, compressionTip, hermesChains, hermesHomes, hermesKind, hermesLeases,
  hermesListSql, hermesProvider, hermesRow, hermesTurnOpen, leaseHeldBy, type HermesRow, type HermesSession,
} from './hermes.js'
import { LIST_LIMIT, ownerRecord, readSql, type SqlRead } from './opencode.js'
import { scanMemo } from './support.js'
import type { ProcessView, RunningProcess, ScanContext } from './types.js'

const Database = builtinSqlite()!
type Db = InstanceType<typeof Database>

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ext-hermes-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  closeSqliteHandles()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** `sessions` as Hermes's schema 17 creates it (`hermes_state.py`, v0.18.0). */
const V17_SESSION_COLUMNS = `id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, session_key TEXT, chat_id TEXT,
  chat_type TEXT, thread_id TEXT, model TEXT, model_config TEXT, system_prompt TEXT, parent_session_id TEXT,
  started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0,
  cwd TEXT, git_branch TEXT, git_repo_root TEXT, billing_provider TEXT, billing_base_url TEXT, billing_mode TEXT,
  estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT, cost_source TEXT, pricing_version TEXT, title TEXT,
  api_call_count INTEGER DEFAULT 0, handoff_state TEXT, handoff_platform TEXT, handoff_error TEXT,
  compression_failure_cooldown_until REAL, compression_failure_error TEXT, rewind_count INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0`
const V17_MESSAGE_COLUMNS = `id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL,
  token_count INTEGER, finish_reason TEXT, reasoning TEXT, reasoning_content TEXT, reasoning_details TEXT,
  codex_reasoning_items TEXT, codex_message_items TEXT, platform_message_id TEXT, observed INTEGER DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0`
const TAIL = `
CREATE TABLE compression_locks (session_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL);
CREATE INDEX idx_sessions_source ON sessions(source);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
CREATE UNIQUE INDEX idx_sessions_title_unique ON sessions(title) WHERE title IS NOT NULL;`
const V17 = `CREATE TABLE sessions (${V17_SESSION_COLUMNS}, FOREIGN KEY (parent_session_id) REFERENCES sessions(id));
CREATE TABLE messages (${V17_MESSAGE_COLUMNS});${TAIL}`
/** Schema 22 as measured on this machine: the columns newer Hermes versions appended. */
const V22 = `CREATE TABLE sessions (${V17_SESSION_COLUMNS}, "display_name" TEXT, "origin_json" TEXT,
  "expiry_finalized" INTEGER DEFAULT 0, "compression_fallback_streak" INTEGER NOT NULL DEFAULT 0, "profile_name" TEXT,
  FOREIGN KEY (parent_session_id) REFERENCES sessions(id));
CREATE TABLE messages (${V17_MESSAGE_COLUMNS}, "effect_disposition" TEXT, "api_content" TEXT);${TAIL}`

/** Real-shaped ids: CLI/TUI `YYYYMMDD_HHMMSS_<6 hex>` in local time, and an editor's uuid4. */
const id = (n: number, hex = 'a1b2c3'): string => `20260920_${String(n).padStart(6, '0')}_${hex}`
const ACP = '3f2a9c1e-8b4d-4e6f-9a1b-2c3d4e5f6a7b'
const S0 = 1_789_900_000 // REAL epoch seconds, as Hermes writes them

interface SessionRow {
  source?: string
  cwd?: string | null
  config?: Record<string, unknown> | string | null
  repo?: string | null
  title?: string | null
  displayName?: string | null
  parent?: string | null
  started?: number
  ended?: number | null
  endReason?: string | null
  archived?: number
}

class Store {
  readonly db: Db
  private readonly v22: boolean
  constructor(readonly path: string, schema = V22) {
    mkdirSync(join(path, '..'), { recursive: true })
    this.db = new Database(path, { readOnly: false })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(schema)
    this.v22 = schema === V22
  }

  session(sessionId: string, row: SessionRow = {}): this {
    const config = row.config === undefined ? null : typeof row.config === 'string' ? row.config : JSON.stringify(row.config)
    this.db.prepare(
      'INSERT INTO sessions (id, source, model_config, parent_session_id, started_at, ended_at, end_reason, cwd, git_repo_root, title, archived)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).all(sessionId, row.source ?? 'cli', config, row.parent ?? null, row.started ?? S0, row.ended ?? null,
      row.endReason ?? null, row.cwd === undefined ? '/work/app' : row.cwd, row.repo ?? null, row.title ?? null, row.archived ?? 0)
    if (this.v22 && row.displayName) this.db.prepare('UPDATE sessions SET display_name = ? WHERE id = ?').all(row.displayName, sessionId)
    return this
  }

  message(sessionId: string, role: string, at: number, finish: string | null = null): this {
    this.db.prepare('INSERT INTO messages (session_id, role, content, finish_reason, timestamp) VALUES (?, ?, ?, ?, ?)')
      .all(sessionId, role, role === 'user' ? 'please look at the tests' : 'ok', finish, at)
    return this
  }

  /** A person's ask and a finished answer. */
  turn(sessionId: string, at = S0 + 1): this {
    return this.message(sessionId, 'user', at).message(sessionId, 'assistant', at + 0.5, 'stop')
  }

  close(): void { this.db.close() }
}

function context(excluded: string[] = []): ScanContext {
  return scanMemo({ excluded }).context()
}

const byId = (sessions: readonly unknown[]): Map<string, HermesSession> =>
  new Map((sessions as HermesSession[]).map((s) => [s.sessionId, s]))

const READERS: Array<[string, typeof Database | null]> = [['node:sqlite', Database], ['the sqlite3 CLI', null]]

describe.each(READERS)('Hermes discovery read through %s', (_name, reader) => {
  beforeAll(() => { overrideBuiltinSqlite(reader) })
  afterAll(() => { overrideBuiltinSqlite(Database) })

  it('lists what a person started in the REPL, the terminal UI or an editor, and nothing else', async () => {
    const root = tempDir()
    const store = new Store(join(root, 'state.db'))
    store.session(id(1), { source: 'cli', cwd: '/work/repl', title: 'Repl work' }).turn(id(1), S0 + 10.25)
    // The terminal UI records no folder unless its client passed one; the repository root still says where.
    store.session(id(2), { source: 'tui', cwd: null, repo: '/work/repo' }).turn(id(2))
    store.session(id(3), { source: 'tui', cwd: null }).turn(id(3))
    store.session(ACP, { source: 'acp', cwd: null, config: { cwd: '/work/editor' }, title: 'Editor chat' }).turn(ACP)
    for (const [n, source] of [[4, 'tool'], [5, 'subagent'], [6, 'cron'], [7, 'telegram'], [8, 'api_server']] as const) {
      store.session(id(n), { source }).turn(id(n))
    }
    store.session(id(9), { archived: 1 }).turn(id(9))
    // An older delegation child still says `cli`: its marker gives it away.
    store.session(id(10), { config: { _delegate_from: id(1) } }).turn(id(10))
    store.session(id(11)) // opened and closed without a word
    store.session(id(12), { cwd: 'relative/dir', config: '{not json' }).turn(id(12))
    store.session(id(13), { cwd: join(root, 'harness-data', 'x') }).turn(id(13))
    store.session('gw-8f3a2b1c', { source: 'cli' }).turn('gw-8f3a2b1c')

    const provider = hermesProvider({ root })
    const found = byId(await provider.scan(context([join(root, 'harness-data')])))
    expect([...found.keys()].sort()).toEqual([id(1), id(2), ACP].sort())
    expect(provider.lastScan()).toEqual({ found: 3, source: 5, archived: 1, delegated: 1, empty: 1, noFolder: 2, excluded: 1, badId: 1 })
    expect(found.get(id(1))).toMatchObject({
      engine: 'hermes', cwd: '/work/repl', origin: 'terminal', title: 'Repl work', transcriptPath: null,
      mtime: Math.round((S0 + 10.75) * 1000), aliases: [],
    })
    expect(found.get(id(1))!.launchArgs).toBeUndefined()
    expect(found.get(id(2))).toMatchObject({ cwd: '/work/repo', origin: 'terminal', title: '' })
    expect(found.get(ACP)).toMatchObject({ cwd: '/work/editor', origin: 'editor', title: 'Editor chat' })
    // An editor's uuid id reads its history like any other.
    expect((await found.get(ACP)!.readHistory!()).map((e) => e.type)).toEqual(['user_message', 'text_delta', 'done'])
    store.close()
  })

  it('lists a branch on its own and hides a sub-agent child', async () => {
    const root = tempDir()
    const store = new Store(join(root, 'state.db'))
    store.session(id(1), { ended: S0 + 5, endReason: 'branched' }).turn(id(1))
    store.session(id(2), { parent: id(1), config: { _branched_from: id(1) } }).turn(id(2))
    // Hermes's older rule: the parent ended `branched` before the child began.
    store.session(id(3), { parent: id(1), started: S0 + 6 }).turn(id(3))
    // Began before the parent ended: a child of the running conversation, not a branch.
    store.session(id(4), { parent: id(1), started: S0 + 4 }).turn(id(4))
    store.session(id(5), { ended: null, endReason: 'branched' }).turn(id(5))
    store.session(id(6), { parent: id(5), started: S0 + 6 }).turn(id(6))
    store.session(id(7)).turn(id(7))
    store.session(id(8), { parent: id(7) }).turn(id(8))
    const provider = hermesProvider({ root })
    expect([...byId(await provider.scan(context())).keys()].sort()).toEqual([id(1), id(2), id(3), id(5), id(7)])
    expect(provider.lastScan()).toEqual({ found: 5, child: 3 })
    store.close()
  })

  it('lists a compressed conversation once, under its newest id, with every id it had', async () => {
    const root = tempDir()
    const store = new Store(join(root, 'state.db'))
    store.session(id(1), { title: 'Long refactor', ended: S0 + 100, endReason: 'compression', cwd: '/work/long' })
      .turn(id(1), S0 + 50)
    store.session(id(2), { parent: id(1), started: S0 + 100, ended: S0 + 200, endReason: 'compression', cwd: null, title: 'Long refactor #2' })
      .turn(id(2), S0 + 150)
    // A reaped websocket's sibling: closed, and not the one the chain follows.
    store.session(id(3), { parent: id(2), started: S0 + 200, ended: S0 + 201, endReason: 'ws_orphan_reap', cwd: null })
      .turn(id(3), S0 + 999)
    store.session(id(4), { parent: id(2), started: S0 + 200, cwd: null }).turn(id(4), S0 + 300)
    const provider = hermesProvider({ root })
    const found = byId(await provider.scan(context()))
    expect([...found.keys()]).toEqual([id(4)])
    expect(found.get(id(4))).toMatchObject({
      // The stale sibling's later message is not this conversation's.
      cwd: '/work/long', title: 'Long refactor #2', aliases: [id(1), id(2)], mtime: Math.round((S0 + 300.5) * 1000),
    })
    expect(provider.lastScan()).toEqual({ found: 1, compressed: 2, stale: 1 })
    // The history is the whole conversation, oldest first.
    const events = await found.get(id(4))!.readHistory!()
    expect(events.filter((e) => e.type === 'user_message')).toHaveLength(3)
    store.close()
  })

  it('follows a chain whose start is older than the list, and says which id it started from', async () => {
    const root = tempDir()
    const store = new Store(join(root, 'state.db'))
    store.db.exec('BEGIN')
    store.session(id(1), { ended: S0 + 1, endReason: 'compression' }).message(id(1), 'user', S0)
    for (let n = 0; n < LIST_LIMIT; n++) store.session(id(1000 + n, 'bbbbbb')).message(id(1000 + n, 'bbbbbb'), 'user', S0 + 10 + n)
    store.session(id(2), { parent: id(1), started: S0 + 1 }).message(id(2), 'user', S0 + 10_000)
    store.db.exec('COMMIT')
    const provider = hermesProvider({ root })
    const found = byId(await provider.scan(context()))
    expect(found.size).toBe(LIST_LIMIT)
    expect(found.get(id(2))).toMatchObject({ aliases: [id(1)] })
    expect(provider.lastScan()).toMatchObject({ found: LIST_LIMIT, older: 2 })
    store.close()
  })

  it('hides a conversation no id of which has a message, and times one by its start when it has none', async () => {
    const root = tempDir()
    const store = new Store(join(root, 'state.db'))
    store.session(id(1), { ended: S0 + 1, endReason: 'compression' })
    store.session(id(2), { parent: id(1) })
    store.session(id(3), { ended: S0 + 1, endReason: 'compression', started: S0 }).turn(id(3), S0 + 0.5)
    store.session(id(4), { parent: id(3), started: 0 })
    const provider = hermesProvider({ root })
    const found = byId(await provider.scan(context()))
    expect([...found.keys()]).toEqual([id(4)])
    expect(found.get(id(4))!.mtime).toBe(Math.round((S0 + 1) * 1000))
    expect(provider.lastScan()).toEqual({ found: 1, empty: 1, compressed: 2 })
    store.close()
  })

  it('reads every home, and resumes a profile\'s conversation in its profile', async () => {
    const root = tempDir()
    const main = new Store(join(root, 'state.db'))
    main.session(id(1)).turn(id(1))
    const work = new Store(join(root, 'profiles', 'work', 'state.db'))
    work.session(id(2)).turn(id(2))
    mkdirSync(join(root, 'profiles', 'fresh')) // a profile whose first session has not run
    const odd = new Store(join(root, 'profiles', 'Not_A_Profile', 'state.db'))
    odd.session(id(3)).turn(id(3))
    const named = new Store(join(root, 'profiles', 'default', 'state.db')) // never used: `-p default` is the root
    named.session(id(4)).turn(id(4))
    writeFileSync(join(root, 'profiles', 'notes.txt'), 'x')

    const provider = hermesProvider({ root })
    let found = byId(await provider.scan(context()))
    expect([...found.keys()].sort()).toEqual([id(1), id(2)])
    expect(found.get(id(1))!.launchArgs).toBeUndefined()
    expect(found.get(id(2))!.launchArgs).toEqual(['-p', 'work'])
    expect(provider.lastScan()).toEqual({ found: 2 })

    // A sticky profile sends a plain `hermes` elsewhere: the default home's sessions must say so.
    writeFileSync(join(root, 'active_profile'), 'work\n')
    found = byId(await provider.scan(context()))
    expect(found.get(id(1))!.launchArgs).toEqual(['-p', 'default'])
    expect(found.get(id(2))!.launchArgs).toEqual(['-p', 'work'])
    main.close(); work.close(); odd.close(); named.close()
  })

  it('reads the schema each store has: 17, and older', async () => {
    const root = tempDir()
    const v17 = new Store(join(root, 'state.db'), V17)
    v17.session(id(1), { title: 'Old title' }).turn(id(1))
    const old = new Store(join(root, 'profiles', 'old', 'state.db'),
      'CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL, cwd TEXT);'
      + 'CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);')
    old.db.exec(`INSERT INTO sessions VALUES ('${id(2)}', 'cli', ${S0}, '/work/old'), ('${id(3)}', 'tool', ${S0}, '/work/old')`)
    old.db.exec(`INSERT INTO messages (session_id, role, content, timestamp) VALUES ('${id(2)}', 'user', 'hi', ${S0 + 2})`)
    const bare = new Store(join(root, 'profiles', 'bare', 'state.db'),
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, cwd TEXT); INSERT INTO sessions VALUES ('${id(4)}', 'cli', '/w');`)
    const alien = new Store(join(root, 'profiles', 'alien', 'state.db'), 'CREATE TABLE things (id TEXT);')

    const provider = hermesProvider({ root })
    const found = byId(await provider.scan(context()))
    expect([...found.keys()].sort()).toEqual([id(1), id(2)])
    expect(found.get(id(1))!.title).toBe('Old title')
    expect(found.get(id(2))).toMatchObject({ cwd: '/work/old', title: '', mtime: (S0 + 2) * 1000, launchArgs: ['-p', 'old'] })
    expect(provider.lastScan()).toEqual({ found: 2, source: 1, empty: 1 })
    v17.close(); old.close(); bare.close(); alien.close()
  })

  it('reads a store once until its files change', async () => {
    const root = tempDir()
    const store = new Store(join(root, 'state.db'))
    store.session(id(1)).turn(id(1))
    const read = vi.fn(readSql)
    const provider = hermesProvider({ root, read })
    const memo = scanMemo({ excluded: [] })
    expect((await provider.scan(memo.context())).map((s) => s.sessionId)).toEqual([id(1)])
    expect(read).toHaveBeenCalledTimes(2)
    memo.prune()
    expect((await provider.scan(memo.context())).map((s) => s.sessionId)).toEqual([id(1)])
    expect(read).toHaveBeenCalledTimes(2)
    store.session(id(2)).turn(id(2))
    expect(await provider.scan(memo.context())).toHaveLength(2)
    expect(read).toHaveBeenCalledTimes(4)
    store.close()
  })

  it('says from the last message whether a turn is running, and waits out a compression', async () => {
    const root = tempDir()
    const store = new Store(join(root, 'state.db'))
    const now = S0 * 1000
    const provider = hermesProvider({ root, now: () => now })
    const busy = (sessionId: string) => provider.busy!({ pid: 1, record: ownerRecord(store.path, sessionId) })
    store.session(id(1))
    expect(await busy(id(1))).toBe(false)
    store.session(id(2)).message(id(2), 'user', S0)
    expect(await busy(id(2))).toBe(true)
    store.session(id(3)).message(id(3), 'user', S0).message(id(3), 'assistant', S0 + 1, 'tool_calls')
    expect(await busy(id(3))).toBe(true)
    store.message(id(3), 'tool', S0 + 2)
    expect(await busy(id(3))).toBe(true)
    store.message(id(3), 'assistant', S0 + 3, 'stop')
    expect(await busy(id(3))).toBe(false)
    store.session(id(4)).message(id(4), 'assistant', S0)
    expect(await busy(id(4))).toBe(true)
    store.session(id(5)).message(id(5), 'session_meta', S0)
    expect(await busy(id(5))).toBeNull()

    store.db.prepare('INSERT INTO compression_locks VALUES (?, ?, ?, ?)').all(id(3), 'pid:1', S0 - 1, S0 + 60)
    expect(await busy(id(3))).toBe(true)
    store.db.prepare('UPDATE compression_locks SET expires_at = ? WHERE session_id = ?').all(S0 - 1, id(3))
    expect(await busy(id(3))).toBe(false)

    // A store too old for compression locks still has a tail.
    const old = new Store(join(root, 'old.db'), 'CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, finish_reason TEXT, timestamp REAL);')
    old.db.exec(`INSERT INTO messages (session_id, role, timestamp) VALUES ('${id(6)}', 'user', 1)`)
    expect(await provider.busy!({ pid: 1, record: ownerRecord(old.path, id(6)) })).toBe(true)

    expect(await provider.busy!({ pid: 1, record: 'nothing' })).toBeNull()
    expect(await provider.busy!({ pid: 1, record: ownerRecord(join(root, 'gone.db'), id(1)) })).toBeNull()
    store.close(); old.close()
  })
})

describe('a Hermes store that cannot be read right now', () => {
  it('keeps each home\'s last list when it fails, and throws only when every home fails', async () => {
    const root = tempDir()
    const main = new Store(join(root, 'state.db'))
    main.session(id(1)).turn(id(1))
    const work = new Store(join(root, 'profiles', 'work', 'state.db'))
    work.session(id(2)).turn(id(2))
    const broken = new Set<string>()
    const read: SqlRead = async (dbPath, sql, params) => (broken.has(dbPath)
      ? { ok: false, reason: 'transient', error: new Error('database is locked') }
      : readSql(dbPath, sql, params))
    const provider = hermesProvider({ root, read })
    const memo = scanMemo({ excluded: [] })
    expect((await provider.scan(memo.context())).map((s) => s.sessionId).sort()).toEqual([id(1), id(2)])

    // The default home locks and changes: its last list stands in, the profile still answers.
    broken.add(main.path)
    main.session(id(3)).turn(id(3))
    work.session(id(4)).turn(id(4))
    expect((await provider.scan(memo.context())).map((s) => s.sessionId).sort()).toEqual([id(1), id(2), id(4)])

    // Every home failing is the store failing: the scan throws and discovery keeps its own last list.
    broken.add(work.path)
    work.session(id(5)).turn(id(5))
    await expect(provider.scan(memo.context())).rejects.toThrow('state.db not readable: database is locked')

    // A home that never read cleanly has nothing to stand in.
    const fresh = hermesProvider({ root, read: async (dbPath, sql, params) => (dbPath === main.path ? { ok: false, reason: 'transient' } : readSql(dbPath, sql, params)) })
    broken.clear()
    expect((await fresh.scan(context())).map((s) => s.sessionId).sort()).toEqual([id(2), id(4), id(5)])
    main.close(); work.close()
  })

  it('finds nothing with no store, no SQLite reader, or a reader that goes missing', async () => {
    const root = tempDir()
    expect(await hermesProvider({ root }).scan(context())).toEqual([])
    const store = new Store(join(root, 'state.db'))
    store.session(id(1)).turn(id(1))
    const read = vi.fn(readSql)
    const none = hermesProvider({ root, read, available: () => false })
    expect(await none.scan(context())).toEqual([])
    expect(none.lastScan()).toEqual({})
    expect(read).not.toHaveBeenCalled()
    expect(await hermesProvider({ root, read: async () => ({ ok: false, reason: 'missing' }) }).scan(context())).toEqual([])
    let calls = 0
    const vanishing: SqlRead = async (dbPath, sql, params) => (++calls === 1 ? readSql(dbPath, sql, params) : { ok: false, reason: 'missing' })
    expect(await hermesProvider({ root, read: vanishing }).scan(context())).toEqual([])
    store.close()
  })

  it('fails on a store that is not a database', async () => {
    const root = tempDir()
    writeFileSync(join(root, 'state.db'), 'not a database at all '.repeat(100))
    await expect(hermesProvider({ root }).scan(context())).rejects.toThrow(/^state\.db not readable: /)
  })

  it('answers unknowable when a busy read fails partway', async () => {
    const root = tempDir()
    const store = new Store(join(root, 'state.db'))
    store.session(id(1)).message(id(1), 'user', S0)
    const failAt = (n: number): SqlRead => {
      let calls = 0
      return async (dbPath, sql, params) => (++calls === n ? { ok: false, reason: 'transient' } : readSql(dbPath, sql, params))
    }
    const record = ownerRecord(store.path, id(1))
    expect(await hermesProvider({ root, read: failAt(2) }).busy!({ pid: 1, record })).toBeNull()
    expect(await hermesProvider({ root, read: failAt(3) }).busy!({ pid: 1, record })).toBeNull()
    expect(await hermesProvider({ root, read: failAt(99) }).busy!({ pid: 1, record })).toBe(true)
    store.close()
  })
})

describe('Hermes owners', () => {
  const HERMES = '/Users/me/.hermes/hermes-agent/venv/bin'
  const py = (pid: number, ppid: number, rest: string): RunningProcess =>
    ({ pid, ppid, executable: 'python3.12', args: `${HERMES}/python3 ${HERMES}/hermes${rest ? ` ${rest}` : ''}` })
  const proc = (pid: number, ppid: number, args: string): RunningProcess => ({ pid, ppid, executable: args.split(' ')[0], args })
  const view = (rows: RunningProcess[], dead: number[] = []): ProcessView => ({
    list: async () => rows,
    openFiles: async () => new Map(),
    openFilesOf: async () => new Map(),
    alive: (pid) => !dead.includes(pid),
  })

  function homes(): { root: string; main: Store; work: Store } {
    const root = tempDir()
    const main = new Store(join(root, 'state.db'))
    main.session(id(1)).turn(id(1))
    main.session(id(2), { ended: S0 + 5, endReason: 'compression' }).turn(id(2))
    main.session(id(3), { parent: id(2), started: S0 + 5 }).turn(id(3), S0 + 6)
    const work = new Store(join(root, 'profiles', 'work', 'state.db'))
    work.session(id(4)).turn(id(4))
    return { root, main, work }
  }

  it('claims from the id a Hermes process was resumed with, in the home it runs in, at its chain\'s tip', async () => {
    const { root, main, work } = homes()
    const claims = await hermesProvider({ root }).owners!(view([
      proc(1, 0, 'launchd'),
      py(100, 1, `--resume ${id(1)}`),
      // Resumed from a compressed id: Hermes carries on at the tip, and so does the claim.
      py(101, 1, `-r ${id(2)}`),
      py(102, 1, `-p work --resume=${id(4)}`),
      // Found by looking when no profile is named.
      py(103, 1, `-r ${id(4)}`),
      // Not Hermes, whatever its arguments say: a Node that lives under ~/.hermes.
      proc(104, 1, `/Users/me/.hermes/node/bin/node test.js -r ${id(9)}`),
      py(105, 1, '--tui'),
      py(106, 1, `-r not-an-id`),
      // An id no store has yet is still what it holds.
      py(107, 1, `-p default -r ${id(8)}`),
    ]))
    // Arguments name the session a process started on, not necessarily the one it has now.
    expect(claims).toEqual([
      { sessionId: id(1), pid: 100, record: ownerRecord(main.path, id(1)), fromArgs: true },
      { sessionId: id(3), pid: 101, record: ownerRecord(main.path, id(3)), fromArgs: true },
      { sessionId: id(4), pid: 102, record: ownerRecord(work.path, id(4)), fromArgs: true },
      { sessionId: id(8), pid: 107, record: ownerRecord(main.path, id(8)), fromArgs: true },
    ])
    main.close(); work.close()
  })

  it('asks the sticky profile first for a plain `hermes`, even one with no store yet', async () => {
    const { root, main, work } = homes()
    writeFileSync(join(root, 'active_profile'), 'work')
    const claims = await hermesProvider({ root }).owners!(view([py(100, 0, `-r ${id(4)}`), py(101, 0, `-r ${id(1)}`)]))
    expect(claims.map((c) => [c.sessionId, c.record])).toEqual([
      [id(4), ownerRecord(work.path, id(4))], [id(1), ownerRecord(main.path, id(1))],
    ])
    writeFileSync(join(root, 'active_profile'), 'gone')
    const orphan = await hermesProvider({ root }).owners!(view([py(100, 0, `-r ${id(7)}`), py(101, 0, `-r ${id(4)}`)]))
    expect(orphan.map((c) => c.record)).toEqual([
      ownerRecord(join(root, 'profiles', 'gone', 'state.db'), id(7)), ownerRecord(work.path, id(4)),
    ])
    main.close(); work.close()
  })

  it('reads the active-session leases, and owns a terminal UI\'s through its `hermes`', async () => {
    const { root, main, work } = homes()
    mkdirSync(join(root, 'runtime'))
    writeFileSync(join(root, 'runtime', 'active_sessions.json'), JSON.stringify({ entries: [
      { lease_id: 'a', session_id: id(1), surface: 'cli', pid: 200 },
      // hermes --tui (201) → node UI (202) → python gateway (203), which holds the lease.
      { lease_id: 'b', session_id: id(2), surface: 'tui', pid: 203, metadata: { live_session_id: 'abcd1234' } },
      { lease_id: 'c', session_id: 'agent:main:telegram:dm:42', surface: 'gateway:telegram', pid: 204 },
      { lease_id: 'd', session_id: id(5), surface: 'cli', pid: 205 }, // dead
      { lease_id: 'e', session_id: id(6), surface: 'cli', pid: 206 }, // a reused pid: not Hermes
      { lease_id: 'f', session_id: id(7), surface: 'cli', pid: '207' },
      { lease_id: 'g', session_id: id(7), surface: 'cli', pid: -1 },
      { lease_id: 'h', session_id: id(7), surface: 'cli', pid: 1.5 },
      'garbage',
    ] }))
    mkdirSync(join(root, 'profiles', 'work', 'runtime'))
    // An older Hermes wrote the list bare.
    writeFileSync(join(root, 'profiles', 'work', 'runtime', 'active_sessions.json'), JSON.stringify([
      { session_id: id(4), surface: 'cli', pid: 300 },
    ]))
    const claims = await hermesProvider({ root }).owners!(view([
      py(200, 1, ''),
      py(201, 1, '--tui'),
      proc(202, 201, 'node /Users/me/.hermes/hermes-agent/ui-tui/dist/entry.js'),
      proc(203, 202, 'python3 -m tui_gateway.entry'),
      proc(204, 1, 'python3 -m gateway.run'),
      proc(206, 1, 'vim notes.txt'),
      py(300, 1, '-p work'),
      // Also named in another process's arguments: the lease is exact, and wins.
      py(400, 1, `-r ${id(1)}`),
    ], [205]))
    expect(claims).toEqual([
      { sessionId: id(1), pid: 200, record: ownerRecord(main.path, id(1)) },
      { sessionId: id(3), pid: 201, record: ownerRecord(main.path, id(3)) },
      { sessionId: id(4), pid: 300, record: ownerRecord(work.path, id(4)) },
    ])
    main.close(); work.close()
  })

  it('checks a lease against the start of the process now under its pid', async () => {
    const { root, main, work } = homes()
    const T = 1_790_000_000_000
    mkdirSync(join(root, 'runtime'))
    writeFileSync(join(root, 'runtime', 'active_sessions.json'), JSON.stringify({ entries: [
      // Its REPL: psutil's create_time (float seconds) against ps's whole second.
      { session_id: id(1), surface: 'cli', pid: 200, process_start_time: T / 1000 + 0.731 },
      // A Hermes crashed and left this; its pid now belongs to a tool another live Hermes runs, and
      // the walk up would have handed that Hermes a claim it could be stopped on.
      { session_id: id(4), surface: 'cli', pid: 601, process_start_time: T / 1000 },
      // No start recorded (Hermes without psutil): the pid is all there is.
      { session_id: id(3), surface: 'cli', pid: 700, process_start_time: null },
      // Alive but not in the process list: nothing to check, and no Hermes to own it.
      { session_id: id(8), surface: 'cli', pid: 800, process_start_time: T / 1000 },
    ] }))
    const at = (row: RunningProcess, started?: number): RunningProcess => (started === undefined ? row : { ...row, started })
    const claims = await hermesProvider({ root }).owners!(view([
      at(py(200, 1, ''), T),
      at(py(600, 1, ''), T - 86_400_000),
      at(proc(601, 600, 'python3 tool.py'), T + 3_600_000),
      at(py(700, 1, ''), T),
    ]))
    expect(claims).toEqual([
      { sessionId: id(1), pid: 200, record: ownerRecord(main.path, id(1)) },
      { sessionId: id(3), pid: 700, record: ownerRecord(main.path, id(3)) },
    ])
    main.close(); work.close()
  })

  it('never offers to stop what serves another client', async () => {
    const { root, main, work } = homes()
    mkdirSync(join(root, 'runtime'))
    writeFileSync(join(root, 'runtime', 'active_sessions.json'), JSON.stringify({ entries: [
      { session_id: id(1), surface: 'tui', pid: 503 },
    ] }))
    const claims = await hermesProvider({ root }).owners!(view([
      // The dashboard runs a terminal chat in a pty: it has a terminal, and is still the desktop app's.
      py(500, 1, 'dashboard --port 9119'),
      proc(502, 500, 'node /Users/me/.hermes/hermes-agent/ui-tui/dist/entry.js'),
      proc(503, 502, 'python3 -m tui_gateway.entry'),
      py(600, 500, `--tui --resume ${id(4)} -p work`),
      // A Hermes agent that started another from its shell: the outer one is not a server.
      py(700, 1, ''),
      proc(701, 700, 'zsh -c hermes'),
      py(702, 701, `-r ${id(2)}`),
      py(800, 1, `-m some/model gateway run -r ${id(8)}`),
    ]))
    expect(claims).toEqual([
      { sessionId: id(1), pid: 500, record: ownerRecord(main.path, id(1)), app: true },
      { sessionId: id(4), pid: 600, record: ownerRecord(work.path, id(4)), app: true, fromArgs: true },
      { sessionId: id(3), pid: 702, record: ownerRecord(main.path, id(3)), fromArgs: true },
      { sessionId: id(8), pid: 800, record: ownerRecord(main.path, id(8)), app: true, fromArgs: true },
    ])
    main.close(); work.close()
  })
})

describe('Hermes pieces', () => {
  const row = (over: Partial<HermesRow>): HermesRow => ({
    id: id(1), source: 'cli', parent: null, started: S0, ended: null, endReason: null, cwd: null, configCwd: null, repo: null,
    title: '', displayName: '', branched: false, parentEnd: null, parentEnded: null, lastMsg: null, ...over,
  })

  it('reads the profile a process names the way Hermes does', () => {
    expect(argvProfile('hermes -p work')).toBe('work')
    expect(argvProfile('hermes --profile work -p other')).toBe('work')
    expect(argvProfile('hermes --profile=work')).toBe('work')
    expect(argvProfile('hermes -p default')).toBe('default')
    expect(argvProfile('hermes -p Bad_Name')).toBeNull()
    expect(argvProfile('hermes --profile=')).toBeNull()
    expect(argvProfile('hermes -p')).toBeNull()
    expect(argvProfile('hermes -m -p -p work')).toBe('work')
    expect(argvProfile('hermes -c -p work')).toBe('work')
    expect(argvProfile('hermes -c mychat -p work')).toBe('work')
    expect(argvProfile('hermes -c')).toBeNull()
    expect(argvProfile('hermes -- -p work')).toBeNull()
    expect(argvProfile('hermes -r 20260920_101500_a1b2c3')).toBeNull()
  })

  it('tells a conversation\'s start from its continuation and from a sub-agent\'s child', () => {
    expect(hermesKind(row({}))).toBe('head')
    expect(hermesKind(row({ parent: 'p', branched: true }))).toBe('head')
    expect(hermesKind(row({ parent: 'p', parentEnd: 'branched', parentEnded: S0 - 1 }))).toBe('head')
    expect(hermesKind(row({ parent: 'p', parentEnd: 'branched', parentEnded: S0 + 1 }))).toBe('child')
    expect(hermesKind(row({ parent: 'p', parentEnd: 'branched', parentEnded: null }))).toBe('child')
    expect(hermesKind(row({ parent: 'p', parentEnd: 'branched', parentEnded: S0, started: null }))).toBe('child')
    expect(hermesKind(row({ parent: 'p', parentEnd: 'compression' }))).toBe('continuation')
    expect(hermesKind(row({ parent: 'p' }))).toBe('child')
  })

  it('follows the continuation Hermes follows', () => {
    const compressed = row({ id: 'a', endReason: 'compression', ended: S0 })
    const open = row({ id: 'b' })
    const closed = row({ id: 'c', ended: S0, lastMsg: S0 + 99 })
    expect(bestContinuation([closed, open, compressed]).id).toBe('a')
    expect(bestContinuation([closed, open]).id).toBe('b')
    expect(bestContinuation([row({ id: 'd', lastMsg: S0 + 1 }), row({ id: 'e', lastMsg: S0 + 2 })]).id).toBe('e')
    expect(bestContinuation([row({ id: 'f', lastMsg: S0 + 5, started: S0 + 1 }), row({ id: 'g', lastMsg: S0 + 5, started: S0 + 2 })]).id).toBe('g')
    expect(bestContinuation([row({ id: 'h', lastMsg: S0 + 5, started: null }), row({ id: 'i', lastMsg: S0 + 5, started: S0 })]).id).toBe('i')
    expect(bestContinuation([row({ id: 'j', lastMsg: S0 + 5, started: S0 }), row({ id: 'k', lastMsg: S0 + 5, started: null })]).id).toBe('j')
    expect(bestContinuation([row({ id: 'o', started: null }), row({ id: 'p', started: null })]).id).toBe('p')
    expect(bestContinuation([row({ id: 'm' }), row({ id: 'l' }), row({ id: 'n' })]).id).toBe('n')
    expect(bestContinuation([row({ id: 'n' }), row({ id: 'm' }), row({ id: 'l' })]).id).toBe('n')
  })

  it('never loops on a chain that points at itself', () => {
    const counts = {}
    const chains = hermesChains([
      row({ id: 'a', parent: 'a', parentEnd: 'compression' }),
      row({ id: 'b', parent: 'c', parentEnd: 'compression' }),
      row({ id: 'c', parent: 'b', parentEnd: 'compression' }),
    ], counts)
    expect(chains).toEqual([])
    expect(counts).toEqual({ stale: 3 })
  })

  it('reads a row from either SQLite path', () => {
    expect(hermesRow({ id: 'x', source: 'cli', started: 1.5, branched: 0, parent: '', last_msg: 'NaN' }))
      .toMatchObject({ id: 'x', started: 1.5, branched: true, parent: null, lastMsg: null, title: '', displayName: '' })
    expect(hermesRow({ id: 'x', branched: null }).branched).toBe(false)
  })

  it('matches a lease to its process by start, within ps\'s whole second', () => {
    const lease = { sessionId: id(1), pid: 5, started: 1_000_000 }
    const row = (started?: number): RunningProcess => ({ pid: 5, ppid: 1, executable: 'hermes', args: 'hermes', ...(started === undefined ? {} : { started }) })
    expect(leaseHeldBy(lease, row(999_000))).toBe(true)
    expect(leaseHeldBy(lease, row(1_002_000))).toBe(true)
    expect(leaseHeldBy(lease, row(997_999))).toBe(false)
    expect(leaseHeldBy(lease, row(1_002_001))).toBe(false)
    expect(leaseHeldBy(lease, row())).toBe(true)
    expect(leaseHeldBy(lease, undefined)).toBe(true)
    expect(leaseHeldBy({ sessionId: id(1), pid: 5 }, row(1))).toBe(true)
  })

  it('reads a lease\'s start in milliseconds, and only a real one', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'runtime'))
    writeFileSync(join(dir, 'runtime', 'active_sessions.json'), JSON.stringify({ entries: [
      { session_id: id(1), surface: 'cli', pid: 1, process_start_time: 1_790_000_000.5 },
      { session_id: id(2), surface: 'cli', pid: 2, process_start_time: 0 },
      { session_id: id(3), surface: 'cli', pid: 3, process_start_time: '1790000000' },
    ] }))
    expect(await hermesLeases(dir)).toEqual([
      { sessionId: id(1), pid: 1, started: 1_790_000_000_500 },
      { sessionId: id(2), pid: 2 },
      { sessionId: id(3), pid: 3 },
    ])
  })

  it('reads leases only from what Hermes writes', async () => {
    const dir = tempDir()
    expect(await hermesLeases(dir)).toEqual([])
    mkdirSync(join(dir, 'runtime'))
    writeFileSync(join(dir, 'runtime', 'active_sessions.json'), '{"entries": "nope"}')
    expect(await hermesLeases(dir)).toEqual([])
    writeFileSync(join(dir, 'runtime', 'active_sessions.json'), '{half')
    expect(await hermesLeases(dir)).toEqual([])
  })

  it('lists homes with the sticky profile ahead, and keeps it under the cap', async () => {
    const root = tempDir()
    for (let n = 0; n < 70; n++) mkdirSync(join(root, 'profiles', `p${String(n).padStart(2, '0')}`), { recursive: true })
    mkdirSync(join(root, 'elsewhere'))
    symlinkSync(join(root, 'elsewhere'), join(root, 'profiles', 'linked'))
    const all = await hermesHomes(root, null)
    expect(all).toHaveLength(65)
    expect(all[0]).toEqual({ home: root, dbPath: join(root, 'state.db'), profile: null })
    expect(all[1].profile).toBe('linked')
    const sticky = await hermesHomes(root, 'p69')
    expect(sticky.map((home) => home.profile).slice(0, 3)).toEqual([null, 'p69', 'linked'])
    expect(sticky).toHaveLength(65)
    expect((await hermesHomes(root, 'missing')).map((home) => home.profile).slice(0, 2)).toEqual([null, 'linked'])
  })

  it('reads the sticky profile, and ignores one Hermes would not use', async () => {
    const root = tempDir()
    expect(await activeProfile(root)).toBeNull()
    for (const [content, expected] of [['work\n', 'work'], ['default', null], ['Bad Name', null], ['', null]] as const) {
      writeFileSync(join(root, 'active_profile'), content)
      expect(await activeProfile(root)).toBe(expected)
    }
  })

  it('follows a chain to its tip, and stops where the store cannot say', async () => {
    const root = tempDir()
    const store = new Store(join(root, 'state.db'))
    store.session(id(1), { endReason: 'compression', ended: S0 }).session(id(2), { parent: id(1), endReason: 'compression', ended: S0 + 1 })
    store.session(id(3), { parent: id(2) })
    // A branch and a delegation off a compressed parent are not its continuation.
    store.session(id(4), { endReason: 'compression', ended: S0 }).session(id(5), { parent: id(4), config: { _branched_from: id(4) } })
    store.session(id(6), { parent: id(4), config: { _delegate_from: id(4) } }).session(id(7), { parent: id(4), source: 'tool' })
    expect(await compressionTip(readSql, store.path, id(1))).toBe(id(3))
    expect(await compressionTip(readSql, store.path, id(3))).toBe(id(3))
    expect(await compressionTip(readSql, store.path, id(4))).toBe(id(4))
    expect(await compressionTip(async () => ({ ok: false, reason: 'transient' }), store.path, id(1))).toBe(id(1))
    // A loop in the store ends where it started.
    const looping: SqlRead = async (_db, _sql, params) => ({ ok: true, via: 'builtin', rows: [{ id: params?.[0] === 'a' ? 'b' : 'a' }] })
    expect(await compressionTip(looping, store.path, 'a')).toBe('b')
    store.close()
  })

  it('builds no list without the columns that name a session', () => {
    expect(hermesListSql(new Set(['id']), new Set())).toBeNull()
    expect(hermesTurnOpen([])).toBe(false)
    expect(hermesTurnOpen([{ role: 'assistant', finish_reason: 5 }])).toBe(true)
  })
})
