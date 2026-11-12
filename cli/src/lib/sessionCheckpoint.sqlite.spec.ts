import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { KIB, MIB, pageReads, withinBudget } from '../testing/storePages.js'
import type { RegisteredSession } from './registry.js'
import { builtinSqlite, closeSqliteHandles, type DatabaseLike } from './sqliteBuiltin.js'
import { sqliteReadAll } from './sqliteRead.js'
import { enableOffThreadSqlite, resetOffThreadSqlite } from './sqliteThread.js'

// The real reads, seen: a conversation table is read in pages (#4188). vi.resetModules() keeps this mock, and with it
// the read path it was built on: the read threads and handles are switched and closed on this file's own imports.
vi.mock('./sqliteRead.js', async (real) => {
  const actual = await real<typeof import('./sqliteRead.js')>()
  return { ...actual, sqliteReadAll: vi.fn(actual.sqliteReadAll) }
})

let root: string
const databases: Array<{ close(): void }> = []
beforeEach(() => {
  vi.resetModules()
  vi.mocked(sqliteReadAll).mockClear()
  root = mkdtempSync(join(tmpdir(), 'harness-checkpoint-wal-'))
  for (const key of ['OPENCODE_DATA_DIR', 'KILO_DATA_DIR', 'HERMES_HOME', 'DEVIN_HOME']) vi.stubEnv(key, root)
})
afterEach(async () => {
  await resetOffThreadSqlite()
  closeSqliteHandles()
  for (const database of databases.splice(0)) database.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it.each(['opencode', 'kilo', 'hermes', 'devin'] as const)('backs up only the selected %s conversation while its real database has a live WAL', async engine => {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as any
  const path = join(root, engine === 'opencode' ? 'opencode.db' : engine === 'kilo' ? 'kilo.db' : engine === 'hermes' ? 'state.db' : 'sessions.db')
  const database = new DatabaseSync(path)
  databases.push(database)
  database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
  if (engine === 'opencode' || engine === 'kilo') {
    database.exec(`CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, body TEXT);
      INSERT INTO session VALUES ('wanted'), ('other'); INSERT INTO message VALUES ('m1', 'wanted', 'history in WAL'), ('m2', 'other', 'unrelated private text');
      INSERT INTO part VALUES ('p1', 'm1', 'wanted attachment'), ('p2', 'm2', 'unrelated private text');`)
  } else {
    const table = engine === 'hermes' ? 'messages' : 'message_nodes'
    database.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE ${table} (id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
      INSERT INTO sessions VALUES ('wanted'), ('other'); INSERT INTO ${table} VALUES ('m1', 'wanted', 'history in WAL'), ('m2', 'other', 'unrelated private text');`)
  }
  expect(readdirSync(root)).toContain(`${path.split('/').at(-1)}-wal`)
  const { SessionCheckpointStore } = await import('./sessionCheckpoint.js')
  const directory = join(root, 'backups')
  mkdirSync(directory, { mode: 0o700 })
  await new SessionCheckpointStore(directory).save({ agentId: 'fixture', sessionId: 'wanted', engine, hermesHome: root } as RegisteredSession)
  const manifest = JSON.parse(readFileSync(join(directory, readdirSync(directory).find(f => f.endsWith('.json'))!), 'utf8'))
  const backup = readFileSync(join(directory, manifest.file), 'utf8')
  expect(backup).toContain('history in WAL')
  expect(backup).not.toContain('unrelated private text')
  expect(database.prepare(`SELECT count(*) AS n FROM ${engine === 'opencode' || engine === 'kilo' ? 'session' : 'sessions'}`).get().n).toBe(2)
})

it('backs up an OpenCode 2 conversation from its v2 tables, and a v1 one from the same file as before', async () => {
  // OpenCode 2.0.24 writes `session_v2` / `session_message` and leaves the v1 tables holding only older chats. Read
  // there, a v2 chat was "not found" and its harness could never be closed (2026-10-14).
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as any
  const database = new DatabaseSync(join(root, 'opencode.db'))
  databases.push(database)
  database.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, body TEXT);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    INSERT INTO session VALUES ('older'); INSERT INTO message VALUES ('m0', 'older', 'a v1 chat'); INSERT INTO part VALUES ('p0', 'm0', 'v1 part');
    INSERT INTO session_v2 VALUES ('wanted'), ('other');
    INSERT INTO session_message VALUES ('s1', 'wanted', 'history in v2'), ('s2', 'other', 'unrelated private text');`)
  const { SessionCheckpointStore, SessionCheckpointError } = await import('./sessionCheckpoint.js')
  const directory = join(root, 'backups')
  mkdirSync(directory, { mode: 0o700 })
  const store = new SessionCheckpointStore(directory)
  const backup = async (sessionId: string) => {
    await store.save({ agentId: sessionId, sessionId, engine: 'opencode' } as RegisteredSession)
    const manifest = readdirSync(directory).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(directory, f), 'utf8'))).find(m => m.sessionId === sessionId)
    return JSON.parse(readFileSync(join(directory, manifest.file), 'utf8'))
  }
  const v2 = await backup('wanted')
  expect(Object.keys(v2.tables)).toEqual(['session_v2', 'session_message'])
  expect(JSON.stringify(v2)).toContain('history in v2')
  expect(JSON.stringify(v2)).not.toContain('unrelated private text')
  const v1 = await backup('older')
  expect(Object.keys(v1.tables)).toEqual(['session', 'message', 'part'])
  expect(JSON.stringify(v1)).toContain('v1 part')
  // In neither: nothing to keep, so the session stays open.
  await expect(store.save({ agentId: 'gone', sessionId: 'gone', engine: 'opencode' } as RegisteredSession)).rejects.toBeInstanceOf(SessionCheckpointError)
})

// Only the read threads enforce a reply limit. The stores are built with the binding: the sqlite3 CLI cannot take
// megabytes on a command line.
const withBuiltin = builtinSqlite() ? describe : describe.skip

withBuiltin('a conversation larger than the row cap', () => {
  // Read whole, a session over 32 MiB could not be checkpointed, so it could not be closed (#4188).
  let directory = ''
  beforeEach(() => {
    directory = join(root, 'backups')
    mkdirSync(directory, { mode: 0o700 })
  })
  /** A new store in WAL, as the engines' stores are: a reader in the middle of a large page must not lock the writer. */
  const writer = (path: string): DatabaseLike => {
    mkdirSync(dirname(path), { recursive: true })
    const database = new (builtinSqlite()!)(path, { readOnly: false })
    databases.push(database)
    database.exec('PRAGMA journal_mode = WAL')
    return database
  }
  const files = { opencode: 'opencode.db', kilo: 'kilo.db', hermes: 'state.db', devin: 'sessions.db' } as const
  const table = { opencode: 'part', kilo: 'part', hermes: 'messages', devin: 'message_nodes' } as const
  /** The file's schema for this engine; `bodies` are the rows of 'wanted' in its conversation table (for opencode and
   *  kilo, parts of message 'm1'), beside one row of 'other'. */
  const conversation = (engine: keyof typeof files, bodies: string[]): void => {
    const database = writer(join(root, files[engine]))
    if (engine === 'opencode' || engine === 'kilo') {
      database.exec(`CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, body TEXT);
        INSERT INTO session VALUES ('wanted'), ('other'); INSERT INTO message VALUES ('m1', 'wanted', 'history'), ('m2', 'other', 'unrelated private text');
        INSERT INTO part VALUES ('p-other', 'm2', 'unrelated private text');`)
    } else {
      database.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE ${table[engine]} (id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
        INSERT INTO sessions VALUES ('wanted'), ('other'); INSERT INTO ${table[engine]} VALUES ('m-other', 'other', 'unrelated private text');`)
    }
    const insert = database.prepare(`INSERT INTO ${table[engine]} VALUES (?, ?, ?)`)
    bodies.forEach((body, i) => insert.all(`w${String(i).padStart(2, '0')}`, engine === 'opencode' || engine === 'kilo' ? 'm1' : 'wanted', body))
  }
  const savedOf = (directory: string): { tables: Record<string, Array<Record<string, unknown>>> } => {
    const manifest = JSON.parse(readFileSync(join(directory, readdirSync(directory).find(f => f.endsWith('.json'))!), 'utf8'))
    return JSON.parse(readFileSync(join(directory, manifest.file), 'utf8'))
  }

  it.each(['opencode', 'kilo', 'hermes', 'devin'] as const)('backs up a %s conversation larger than the row cap, row for row', async engine => {
    conversation(engine, Array.from({ length: 80 }, () => 'x'.repeat(500 * KIB)))
    enableOffThreadSqlite()
    const { SessionCheckpointStore } = await import('./sessionCheckpoint.js')
    await new SessionCheckpointStore(directory).save({ agentId: 'fixture', sessionId: 'wanted', engine, hermesHome: root } as RegisteredSession)
    const saved = savedOf(directory)
    expect(saved.tables[table[engine]]).toHaveLength(80)
    expect(saved.tables[table[engine]].map((row) => Object.keys(row))).toEqual(Array.from({ length: 80 }, () => ['id', engine === 'opencode' || engine === 'kilo' ? 'message_id' : 'session_id', 'body']))
    expect(JSON.stringify(saved)).not.toContain('unrelated private text')
    const reads = await pageReads(vi.mocked(sqliteReadAll))
    expect(reads.length).toBeGreaterThan(9)
    expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
  })

  it('fails on a row over the row cap instead of dropping it', async () => {
    // The read threads stay off: today this row is read and saved here.
    conversation('hermes', ['before', 'x'.repeat(33 * MIB), 'after'])
    const { SessionCheckpointStore, SessionCheckpointError } = await import('./sessionCheckpoint.js')
    await expect(new SessionCheckpointStore(directory).save({ agentId: 'fixture', sessionId: 'wanted', engine: 'hermes', hermesHome: root } as RegisteredSession))
      .rejects.toBeInstanceOf(SessionCheckpointError)
    expect(readdirSync(directory)).toEqual([])
  })

  it('backs up an OpenClaw conversation larger than the row cap, a compressed row as hex and sized as hex', async () => {
    const database = writer(join(root, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'))
    const fixture = (name: string): string => readFileSync(join(import.meta.dirname, '..', 'engines', 'openclaw', '__fixtures__', `${name}.sql`), 'utf8')
    database.exec(fixture('schema'))
    database.exec(fixture('plain'))
    const window = String((database.prepare("SELECT current_session_id AS id FROM session_nodes WHERE session_key = 'agent:main:plain'").all()[0] as { id: string }).id)
    const plain = database.prepare('INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)')
    for (let seq = 8; seq < 88; seq++) plain.all(window, seq, 'x'.repeat(500 * KIB), seq)
    // Compressed rows the checkpoint never inflates, so random bytes stand for them.
    const compressed = database.prepare(`INSERT INTO transcript_events (session_id, seq, created_at, event_zstd, event_utf8_bytes, navigation_json)
      SELECT session_id, ?, created_at, randomblob(?), ?, navigation_json FROM transcript_events WHERE session_id = ? AND seq = 5`)
    for (let seq = 100; seq < 104; seq++) compressed.all(seq, 1.5 * MIB, 4 * MIB, window)
    enableOffThreadSqlite()
    const { SessionCheckpointStore } = await import('./sessionCheckpoint.js')
    await new SessionCheckpointStore(directory).save({ agentId: 'fixture', sessionId: 'agent:main:plain', engine: 'openclaw', openclawStateDir: root } as RegisteredSession)
    const saved = savedOf(directory)
    const events = saved.tables.transcript_events
    expect(events.map((row) => row.seq)).toEqual([...Array.from({ length: 88 }, (_, i) => i), 100, 101, 102, 103])
    expect(events.slice(-4).map((row) => String(row.event_zstd_hex).length)).toEqual([3 * MIB, 3 * MIB, 3 * MIB, 3 * MIB])
    expect(events.some((row) => 'event_zstd' in row || 'page_n' in row)).toBe(false)
    expect(saved.tables.session_nodes).toHaveLength(1)
    const reads = await pageReads(vi.mocked(sqliteReadAll))
    // Two of the compressed rows are 6 MiB as hex: sized by the blob they would share a page.
    expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
  })
})
