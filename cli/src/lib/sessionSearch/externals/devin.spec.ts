/**
 * Devin discovery against fixture stores. Devin is not installed here, so the schema is the one other
 * readers of `sessions.db` publish from real stores (devin 3000.11.x: `sessions` and `message_nodes`
 * with `UNIQUE(session_id, node_id)`), plus the older shape Harness's own reader was written against
 * (3000.2.17). WAL mode, read through both of Harness's SQLite paths. No real conversation text.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { builtinSqlite, closeSqliteHandles, overrideBuiltinSqlite } from '../../sqliteRead.js'
import { devinListSql, devinProvider, devinTurnOpen, lockPid } from './devin.js'
import { LIST_LIMIT, ownerRecord, readSql, type SqlRead } from './opencode.js'
import { scanMemo } from './support.js'
import type { ProcessView, RunningProcess, ScanContext } from './types.js'

const Database = builtinSqlite()!
type Db = InstanceType<typeof Database>

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ext-devin-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  closeSqliteHandles()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** devin 3000.11.x, as published by readers of real stores (agent-sessions' fixtures; pond#315). */
const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL, model TEXT NOT NULL,
  agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT,
  main_chain_id INTEGER, hidden INTEGER NOT NULL DEFAULT 0, workspace_dirs TEXT, metadata TEXT);
CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER,
  chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id));
CREATE TABLE tool_call_state (session_id TEXT, tool_call_id TEXT, tool_call_json TEXT, tool_call_update_json TEXT);
CREATE TABLE subagent_heads (session_id TEXT, agent_id TEXT, chain_node_id INTEGER);`

const S0 = 1_786_004_275 // integer epoch seconds, as Devin writes them
const AGENT_ERROR = (at: string) => `${at}  WARN chisel_core::translator: ACP: agent error (Internal):`
  + ' Permission denied: We are currently facing high demand for this model. Please try again later. (trace ID: 0123abcd)'

interface SessionRow { cwd?: string; title?: string | null; hidden?: number; created?: number; active?: number }

class Store {
  readonly db: Db
  private nodeId = 0
  constructor(readonly home: string, schema = SCHEMA) {
    mkdirSync(home, { recursive: true })
    this.db = new Database(join(home, 'sessions.db'), { readOnly: false })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(schema)
  }

  get path(): string { return join(this.home, 'sessions.db') }

  session(id: string, row: SessionRow = {}): this {
    this.db.prepare(
      'INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, hidden)'
      + " VALUES (?, ?, 'windsurf', 'swe-1-7', 'normal', ?, ?, ?, ?)",
    ).all(id, row.cwd ?? `/work/${id}`, row.created ?? S0, row.active ?? S0, row.title === undefined ? null : row.title, row.hidden ?? 0)
    return this
  }

  node(sessionId: string, message: Record<string, unknown> | string): this {
    const json = typeof message === 'string' ? message : JSON.stringify(message)
    this.db.prepare('INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)')
      .all(sessionId, this.nodeId++, json, S0)
    return this
  }

  /** The system prompt, a person's ask, and a finished answer, persisted the way Devin repeats them. */
  turn(sessionId: string): this {
    const system = { message_id: `${sessionId}-sys`, role: 'system', content: 'You are Devin' }
    const user = { message_id: `${sessionId}-u`, role: 'user', content: 'please fix the tests', metadata: { created_at: '2026-09-20T10:00:00Z' } }
    return this.node(sessionId, system).node(sessionId, user).node(sessionId, system).node(sessionId, user)
      .node(sessionId, { message_id: `${sessionId}-a`, role: 'assistant', content: 'Fixed.', metadata: { finish_reason: 'stop' } })
  }

  close(): void { this.db.close() }
}

function context(excluded: string[] = []): ScanContext {
  return scanMemo({ excluded }).context()
}

const READERS: Array<[string, typeof Database | null]> = [['node:sqlite', Database], ['the sqlite3 CLI', null]]

describe.each(READERS)('Devin discovery read through %s', (_name, reader) => {
  beforeAll(() => { overrideBuiltinSqlite(reader) })
  afterAll(() => { overrideBuiltinSqlite(Database) })

  it('lists the conversations a person can resume, and says why each other one is left out', async () => {
    const home = tempDir()
    const store = new Store(home)
    store.session('brisk-otter', { cwd: '/work/app', title: '  Fix the CI  ', created: S0, active: S0 + 100 }).turn('brisk-otter')
    store.session('timeless-heron', { active: 0, created: 0 }).turn('timeless-heron')
    store.session('quiet-heron', { active: 0, created: S0 + 7 }).node('quiet-heron', { message_id: 'x', role: 'tool', content: '{}' })
    store.session('hidden-otter', { hidden: 1 }).turn('hidden-otter')
    store.session('silent-crane').node('silent-crane', { message_id: 's', role: 'system', content: 'You are Devin' })
    store.session('bare-lynx')
    store.session('mangled-wren').node('mangled-wren', '{not json')
    store.session('lost-finch', { cwd: 'relative/dir' }).turn('lost-finch')
    store.session('empty-dir', { cwd: '' }).turn('empty-dir')
    store.session('recap-crane', { cwd: join(home, 'harness-data', 'summary-scratch') }).turn('recap-crane')
    store.session('Not_A_Slug').turn('Not_A_Slug')

    const provider = devinProvider({ home })
    const found = await provider.scan(context([join(home, 'harness-data')]))
    expect(found.map((s) => s.sessionId).sort()).toEqual(['brisk-otter', 'quiet-heron', 'timeless-heron'])
    expect(provider.lastScan()).toEqual({ found: 3, hidden: 1, empty: 3, noFolder: 2, excluded: 1, badId: 1 })
    expect(found.find((s) => s.sessionId === 'timeless-heron')!.mtime).toBe(0)
    const brisk = found.find((s) => s.sessionId === 'brisk-otter')!
    expect(brisk).toMatchObject({ engine: 'devin', cwd: '/work/app', origin: 'terminal', title: 'Fix the CI', mtime: (S0 + 100) * 1000, transcriptPath: null })
    expect(brisk.launchArgs).toBeUndefined()
    // No activity stamp: the start is the time.
    expect(found.find((s) => s.sessionId === 'quiet-heron')).toMatchObject({ title: '', mtime: (S0 + 7) * 1000 })
    // The repeated rows are one conversation: one ask, one answer.
    expect((await brisk.readHistory!()).filter((e) => e.type === 'user_message')).toHaveLength(1)
    store.close()
  })

  it('reads a store once until its files change', async () => {
    const home = tempDir()
    const store = new Store(home)
    store.session('brisk-otter').turn('brisk-otter')
    const read = vi.fn(readSql)
    const provider = devinProvider({ home, read })
    const memo = scanMemo({ excluded: [] })
    expect(await provider.scan(memo.context())).toHaveLength(1)
    memo.prune()
    expect(await provider.scan(memo.context())).toHaveLength(1)
    expect(read).toHaveBeenCalledTimes(2)
    store.session('blue-agustinia').turn('blue-agustinia')
    expect(await provider.scan(memo.context())).toHaveLength(2)
    expect(read).toHaveBeenCalledTimes(4)
    store.close()
  })

  it('reads an older schema by the columns it has', async () => {
    const dir = tempDir()
    // The store Harness's reader was written against: no title, no hidden flag, no activity stamp.
    const old = new Store(join(dir, 'old'), 'CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, created_at INTEGER);'
      + 'CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,'
      + ' parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT);')
    old.db.exec(`INSERT INTO sessions VALUES ('tested-crabapple', '/work/old', ${S0})`)
    old.node('tested-crabapple', { message_id: 'm', role: 'user', content: 'hi' })
    const provider = devinProvider({ home: old.home })
    expect(await provider.scan(context())).toMatchObject([{ sessionId: 'tested-crabapple', cwd: '/work/old', title: '', mtime: S0 * 1000 }])

    const bare = new Store(join(dir, 'bare'), "CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT); INSERT INTO sessions VALUES ('lone-heron', '/w');")
    const bareProvider = devinProvider({ home: bare.home })
    expect(await bareProvider.scan(context())).toEqual([])
    expect(bareProvider.lastScan()).toEqual({ found: 0, empty: 1 })

    const other = new Store(join(dir, 'other'), 'CREATE TABLE sessions (id TEXT PRIMARY KEY);')
    const otherProvider = devinProvider({ home: other.home })
    expect(await otherProvider.scan(context())).toEqual([])
    expect(otherProvider.lastScan()).toEqual({ found: 0 })

    const alien = new Store(join(dir, 'alien'), 'CREATE TABLE things (id TEXT);')
    expect(await devinProvider({ home: alien.home }).scan(context())).toEqual([])
    old.close(); bare.close(); other.close(); alien.close()
  })

  it('lists the newest 500', async () => {
    const home = tempDir()
    const store = new Store(home)
    store.db.exec('BEGIN')
    for (let n = 0; n < LIST_LIMIT + 1; n++) {
      store.session(`many-${n}`, { active: S0 + n }).node(`many-${n}`, { message_id: `m${n}`, role: 'user', content: 'x' })
    }
    store.db.exec('COMMIT')
    const provider = devinProvider({ home })
    const found = await provider.scan(context())
    expect(found).toHaveLength(LIST_LIMIT)
    expect(found.some((s) => s.sessionId === 'many-0')).toBe(false)
    expect(provider.lastScan()).toEqual({ found: LIST_LIMIT, older: 1 })
    store.close()
  })

  it('says from the tail whether a turn is running, and that a turn died when the log says so', async () => {
    const home = tempDir()
    const store = new Store(home)
    const provider = devinProvider({ home })
    const busy = (id: string) => provider.busy!({ pid: 4242, record: ownerRecord(store.path, id) })
    const asked = (id: string, at: string) => store.session(id).node(id, { message_id: `${id}-sys`, role: 'system', content: 'sys' })
      .node(id, { message_id: `${id}-u`, role: 'user', content: 'go', metadata: { created_at: at } })

    store.session('fresh-start')
    expect(await busy('fresh-start')).toBe(false)
    asked('asking-heron', '2026-09-20T10:00:00.000000Z')
    expect(await busy('asking-heron')).toBe(true)
    store.session('done-heron').turn('done-heron')
    expect(await busy('done-heron')).toBe(false)
    store.session('calling-heron').node('calling-heron', { message_id: 'c', role: 'assistant', content: '', metadata: { finish_reason: 'tool_calls' } })
    expect(await busy('calling-heron')).toBe(true)
    store.session('pending-heron').node('pending-heron', { message_id: 'p', role: 'assistant', tool_calls: [{ id: 't1', name: 'exec', arguments: '{}' }] })
    expect(await busy('pending-heron')).toBe(true)
    store.session('nocalls-heron').node('nocalls-heron', { message_id: 'n', role: 'assistant', tool_calls: [] })
    expect(await busy('nocalls-heron')).toBe(false)
    store.session('tool-heron').node('tool-heron', { message_id: 't', role: 'tool', content: '{}' })
    expect(await busy('tool-heron')).toBe(true)
    store.session('odd-heron').node('odd-heron', { message_id: 'o', role: 'developer', content: '' })
    expect(await busy('odd-heron')).toBeNull()

    // The turn died on a provider error after its ask: Devin wrote no row, only its log line.
    asked('failed-heron', '2026-09-20T10:00:00.000000Z')
    mkdirSync(join(home, 'session_locks'))
    mkdirSync(join(home, 'logs'))
    writeFileSync(join(home, 'session_locks', 'failed-heron.lock'), '4242')
    writeFileSync(join(home, 'logs', 'devin_20260920-100000_4242.log'), `${AGENT_ERROR('2026-09-20T10:00:01.000000Z')}\n`)
    expect(await busy('failed-heron')).toBe(false)
    // A failure older than the ask is an earlier turn's.
    asked('retried-heron', '2026-09-20T11:00:00.000000Z')
    writeFileSync(join(home, 'session_locks', 'retried-heron.lock'), '4242')
    expect(await busy('retried-heron')).toBe(true)

    expect(await provider.busy!({ pid: 1, record: 'no-record' })).toBeNull()
    expect(await provider.busy!({ pid: 1, record: ownerRecord(join(home, 'gone.db'), 'x-y') })).toBeNull()
    store.close()
  })
})

describe('a Devin store that cannot be read', () => {
  it('finds nothing with no store or no reader, and throws on one it cannot read', async () => {
    const home = tempDir()
    const read = vi.fn(readSql)
    expect(await devinProvider({ home, read }).scan(context())).toEqual([])
    expect(read).not.toHaveBeenCalled()
    const store = new Store(home)
    store.session('brisk-otter').turn('brisk-otter')
    const none = devinProvider({ home, read, available: () => false })
    expect(await none.scan(context())).toEqual([])
    expect(none.lastScan()).toEqual({})
    expect(read).not.toHaveBeenCalled()
    expect(await devinProvider({ home, read: async () => ({ ok: false, reason: 'missing' }) }).scan(context())).toEqual([])
    let calls = 0
    const vanishing: SqlRead = async (db, sql, params) => (++calls === 1 ? readSql(db, sql, params) : { ok: false, reason: 'missing' })
    expect(await devinProvider({ home, read: vanishing }).scan(context())).toEqual([])
    await expect(devinProvider({ home, read: async () => ({ ok: false, reason: 'transient' }) }).scan(context()))
      .rejects.toThrow('sessions.db not readable: locked')
    store.close()

    const garbage = tempDir()
    writeFileSync(join(garbage, 'sessions.db'), 'definitely not sqlite '.repeat(100))
    await expect(devinProvider({ home: garbage }).scan(context())).rejects.toThrow(/^sessions\.db not readable: /)
  })
})

describe('Devin owners', () => {
  const DEVIN = '/Users/me/.local/share/devin/cli/_versions/2026.9.1/bin/devin'
  const devin = (pid: number, rest = ''): RunningProcess => ({ pid, ppid: 1, executable: 'devin', args: `${DEVIN}${rest ? ` ${rest}` : ''}` })
  const view = (rows: RunningProcess[], dead: number[] = []): ProcessView => ({
    list: async () => rows,
    openFiles: async () => new Map(),
    openFilesOf: async () => new Map(),
    alive: (pid) => !dead.includes(pid),
  })

  it('claims a session from a live Devin holding its lock, or resumed with its id', async () => {
    const home = tempDir()
    const locks = join(home, 'session_locks')
    mkdirSync(locks, { recursive: true })
    writeFileSync(join(locks, 'brisk-otter.lock'), '101\n')
    writeFileSync(join(locks, 'json-otter.lock'), '{"pid": 102, "started": 1}')
    writeFileSync(join(locks, 'stale-otter.lock'), '103') // crashed: the pid is gone
    writeFileSync(join(locks, 'reused-otter.lock'), '104') // the pid now belongs to something else
    writeFileSync(join(locks, 'vanished-otter.lock'), '105') // not in the process list at all
    writeFileSync(join(locks, 'garbage-otter.lock'), 'held')
    writeFileSync(join(locks, 'Not_A_Slug.lock'), '101')
    writeFileSync(join(locks, 'notes.txt'), '101')
    mkdirSync(join(locks, 'folder-otter.lock'))
    writeFileSync(join(locks, 'sealed-otter.lock'), '101')
    chmodSync(join(locks, 'sealed-otter.lock'), 0o000) // unreadable: no pid to trust
    writeFileSync(join(locks, 'editor-otter.lock'), '106')
    const claims = await devinProvider({ home }).owners!(view([
      devin(101), devin(102), devin(103),
      { pid: 104, ppid: 1, executable: 'vim', args: 'vim notes' },
      devin(106, 'acp'),
      devin(107, '-r argv-otter'),
      devin(108, '--resume=brisk-otter'),
      devin(109, '-r solo'), // not a Devin id: ids are hyphenated word slugs
      { pid: 110, ppid: 1, executable: 'node', args: '/Users/me/.hermes/node/bin/node x.js -r decoy-otter' },
    ], [103]))
    const db = join(home, 'sessions.db')
    expect(claims).toEqual([
      { sessionId: 'brisk-otter', pid: 101, record: ownerRecord(db, 'brisk-otter') },
      { sessionId: 'editor-otter', pid: 106, record: ownerRecord(db, 'editor-otter'), app: true },
      { sessionId: 'json-otter', pid: 102, record: ownerRecord(db, 'json-otter') },
      // No lock says so: the id it was started on, which it may have left since.
      { sessionId: 'argv-otter', pid: 107, record: ownerRecord(db, 'argv-otter'), fromArgs: true },
    ])
  })

  it('refuses a lock written before the process now under its pid began', async () => {
    const home = tempDir()
    const locks = join(home, 'session_locks')
    mkdirSync(locks, { recursive: true })
    const now = Date.now()
    // Left by a Devin that crashed an hour ago; its pid now belongs to another Devin.
    writeFileSync(join(locks, 'crashed-otter.lock'), '201')
    utimesSync(join(locks, 'crashed-otter.lock'), (now - 3_600_000) / 1000, (now - 3_600_000) / 1000)
    // Written by the Devin running now: after its start (ps reports whole seconds, so allow one).
    writeFileSync(join(locks, 'current-otter.lock'), '202')
    utimesSync(join(locks, 'current-otter.lock'), (now - 1_000) / 1000, (now - 1_000) / 1000)
    const claims = await devinProvider({ home }).owners!(view([
      { ...devin(201), started: now - 60_000 },
      { ...devin(202), started: now },
    ]))
    expect(claims.map((c) => [c.sessionId, c.pid])).toEqual([['current-otter', 202]])
  })

  it('finds no lock folder on a machine Devin never ran on', async () => {
    expect(await devinProvider({ home: join(tempDir(), 'none') }).owners!(view([devin(1)]))).toEqual([])
  })
})

describe('Devin pieces', () => {
  it('reads a lock\'s pid', () => {
    expect(lockPid('4242\n')).toBe(4242)
    expect(lockPid('{"pid": 7}')).toBe(7)
    expect(lockPid('{"pid": "7"}')).toBeNull()
    expect(lockPid('0')).toBeNull()
    expect(lockPid('{"pid": 1.5}')).toBeNull()
    expect(lockPid('')).toBeNull()
  })

  it('reads a tail', () => {
    expect(devinTurnOpen([])).toBe(false)
    expect(devinTurnOpen([{ role: 'assistant', calls: 'not json' }])).toBe(false)
    expect(devinTurnOpen([{ role: 'assistant', calls: null, finish: 'stop' }])).toBe(false)
    expect(devinListSql(new Set(['id']), new Set())).toBeNull()
  })
})
