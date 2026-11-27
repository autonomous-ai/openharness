import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DevinReader, readDevinMessages } from './reader.js'
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import { builtinSqlite, closeSqliteHandles, type DatabaseLike } from '../../lib/sqliteBuiltin.js'
import { enableOffThreadSqlite, resetOffThreadSqlite } from '../../lib/sqliteThread.js'
import type { LiveEvent } from '../../lib/normalize.js'
import { KIB, MIB, pageReads, withinBudget } from '../../testing/storePages.js'

// The real reads, with a seam to make one of them go unanswered, as a busy store or the read threads' deadline does.
vi.mock('../../lib/sqliteRead.js', async (real) => {
  const actual = await real<typeof import('../../lib/sqliteRead.js')>()
  return { ...actual, sqliteReadAll: vi.fn(actual.sqliteReadAll) }
})

/**
 * Integration test for the turn-close path, driven through a real `sqlite3` DB and a real log file —
 * because the failure mode being guarded is precisely the one where NO new row and NO Stop hook arrive.
 */
const AGENT_ERROR = "2026-07-28T06:38:22.096212Z  WARN chisel_core::translator: ACP: agent error (Internal):"
  + " Permission denied: Permission denied: We're currently facing high demand for this model."
  + " Please try again later. (trace ID: acb60788b786ddfb16a00ddb3d83b053)"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function sql(db: string, statement: string): void {
  execFileSync('sqlite3', [db, statement])
}

interface Fixture { db: string; home: string; log: string; sessionId: string }

function fixture(sessionId = 'tested-crabapple'): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-devin-reader-'))
  dirs.push(dir)
  const db = join(dir, 'sessions.db')
  sql(db, `CREATE TABLE message_nodes (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
    parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT);`)

  const home = join(dir, 'devin')
  mkdirSync(join(home, 'session_locks'), { recursive: true })
  mkdirSync(join(home, 'logs'), { recursive: true })
  writeFileSync(join(home, 'session_locks', `${sessionId}.lock`), '39022')
  const log = join(home, 'logs', 'devin_20260728-133808_39022.log')
  writeFileSync(log, '')
  return { db, home, log, sessionId }
}

let node = 0
function insert(f: Fixture, message: Record<string, unknown>): void {
  const json = JSON.stringify(message).replace(/'/g, "''")
  sql(f.db, `INSERT INTO message_nodes (session_id, node_id, chat_message, created_at)
    VALUES ('${f.sessionId}', ${node++}, '${json}', 0);`)
}

const userRow = (id: string, text: string, at = '2026-07-28T06:38:21.000000Z') =>
  ({ message_id: id, role: 'user', content: text, metadata: { created_at: at } })

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// macOS ships the sqlite3 CLI in the base system; Ubuntu (and most slim images) do not. These cases
// drive a REAL database on purpose, so skip rather than fail where the binary is genuinely absent —
// the same guard opencode/reader.spec.ts and hermes/reader.spec.ts already use.
const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const d = hasSqlite ? describe : describe.skip

d('DevinReader turn close', () => {
  it('deduplicates the repeated rows Devin writes per inference', async () => {
    const f = fixture()
    const user = userRow('m-user', 'hi')
    insert(f, user)
    insert(f, user) // Devin re-persists the whole chain on the next inference
    insert(f, { message_id: 'm-asst', role: 'assistant', content: 'hello', metadata: { finish_reason: 'stop' } })
    insert(f, { message_id: 'm-sys', role: 'system', content: 'You are Devin' })

    const messages = await readDevinMessages(f.db, f.sessionId)
    expect(messages.map((m) => m.messageId)).toEqual(['m-user', 'm-asst'])
  })

  it('closes a turn that dies mid-flight, with no new row and no Stop hook', async () => {
    const f = fixture()
    const aborted: string[] = []
    const reader = new DevinReader({
      dbPath: f.db, devinHome: f.home, sessionId: f.sessionId, pollMs: 30,
      onEvents: () => {},
      onTurnAborted: (message) => aborted.push(message),
    })
    await reader.start()

    insert(f, userRow('m-1', 'gia btc moi nhat di'))
    await wait(150)
    expect(reader.turnOpen).toBe(true) // the user row opened the turn

    appendFileSync(f.log, AGENT_ERROR + '\n') // provider failure — Devin writes nothing else, ever
    await wait(150)
    reader.stop()

    expect(aborted).toEqual([
      "Permission denied: We're currently facing high demand for this model. Please try again later.",
    ])
    expect(reader.turnOpen).toBe(false)
  })

  it('heals a turn that was already stuck when it attached', async () => {
    const f = fixture()
    insert(f, userRow('m-1', 'gia btc moi nhat di'))
    appendFileSync(f.log, AGENT_ERROR + '\n') // failed before the daemon (re)started

    const aborted: string[] = []
    const reader = new DevinReader({
      dbPath: f.db, devinHome: f.home, sessionId: f.sessionId, pollMs: 30,
      onEvents: () => {},
      onTurnAborted: (message) => aborted.push(message),
    })
    await reader.start()
    reader.stop()

    expect(aborted).toHaveLength(1)
    expect(reader.turnOpen).toBe(false)
  })

  it('leaves a healthy in-flight turn alone when the log only holds an older failure', async () => {
    const f = fixture()
    appendFileSync(f.log, AGENT_ERROR + '\n') // 06:38:22 — BEFORE this turn's prompt
    insert(f, userRow('m-1', 'a fresh prompt', '2026-07-28T07:00:00.000000Z'))

    const aborted: string[] = []
    const reader = new DevinReader({
      dbPath: f.db, devinHome: f.home, sessionId: f.sessionId, pollMs: 30,
      onEvents: () => {},
      onTurnAborted: (message) => aborted.push(message),
    })
    await reader.start()
    await wait(120)
    reader.stop()

    expect(aborted).toEqual([])
    expect(reader.turnOpen).toBe(true) // still running — must not be force-closed
  })

  // #4065: a first read the store did not answer left the cursor at 0, and the next poll emitted the whole session as new.
  it('reads the session in full again after a first read the store did not answer, and emits only what is new', async () => {
    const f = fixture()
    insert(f, userRow('m-1', 'an old prompt'))
    insert(f, { message_id: 'm-2', role: 'assistant', content: 'an old answer', metadata: { finish_reason: 'stop' } })
    vi.mocked(sqliteReadAll).mockResolvedValueOnce({ ok: false, reason: 'transient' })
    const events: LiveEvent[] = []
    const reader = new DevinReader({
      dbPath: f.db, devinHome: f.home, sessionId: f.sessionId, pollMs: 20, onEvents: (e) => events.push(...e),
    })
    try {
      await reader.start()
      const reads = vi.mocked(sqliteReadAll).mock.calls.length
      // The read that seeds it, and a poll after it.
      await vi.waitFor(() => expect(vi.mocked(sqliteReadAll).mock.calls.length).toBeGreaterThanOrEqual(reads + 2), { timeout: 5_000, interval: 10 })
      expect(events).toEqual([])
      insert(f, userRow('m-3', 'a new prompt'))
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 5_000, interval: 10 })
    } finally {
      reader.stop()
    }
    expect(JSON.stringify(events)).toContain('a new prompt')
    expect(JSON.stringify(events)).not.toContain('old')
  })
})

// #4188: a session past the read's 32 MiB was refused on every poll, so it never seeded and its history never loaded.
// Only the read threads enforce a reply limit, so they are on; the store is built with the binding, as the sqlite3
// CLI cannot take megabytes on a command line.
const withBuiltin = builtinSqlite() ? describe : describe.skip

withBuiltin('DevinReader pages by bytes', () => {
  const SESSION = 'tested-crabapple'
  let dir = ''
  let db = ''
  let home = ''
  let w: DatabaseLike
  let nodes = 0
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adapter-devin-pages-'))
    db = join(dir, 'sessions.db')
    home = join(dir, 'devin')
    mkdirSync(join(home, 'session_locks'), { recursive: true })
    mkdirSync(join(home, 'logs'), { recursive: true })
    writeFileSync(join(home, 'session_locks', `${SESSION}.lock`), '39022')
    writeFileSync(join(home, 'logs', 'devin_20260728-133808_39022.log'), '')
    w = new (builtinSqlite()!)(db, { readOnly: false })
    // As Devin's store is: in the older journal mode a reader in the middle of a large page would fail the writer's
    // next commit with `database is locked`, now and then.
    w.exec('PRAGMA journal_mode = WAL')
    w.exec(`CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
      parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT)`)
    nodes = 0
    vi.mocked(sqliteReadAll).mockClear()
    enableOffThreadSqlite()
  })
  afterEach(async () => {
    await resetOffThreadSqlite()
    closeSqliteHandles()
    w.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const put = (message: Record<string, unknown>): void => {
    w.prepare('INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, 0)').all(SESSION, nodes++, JSON.stringify(message))
  }
  const at = { created_at: '2026-07-28T06:38:21.000000Z' }
  const turn = (i: number, bytes: number): void => {
    put({ message_id: `u-${i}`, role: 'user', content: `q${i}`, metadata: at })
    put({ message_id: `a-${i}`, role: 'assistant', content: 'x'.repeat(bytes), metadata: { ...at, finish_reason: 'stop' } })
  }
  const listen = (): { events: LiveEvent[]; reader: DevinReader } => {
    const events: LiveEvent[] = []
    return { events, reader: new DevinReader({ dbPath: db, devinHome: home, sessionId: SESSION, pollMs: 20, onEvents: (e) => events.push(...e) }) }
  }

  it('reads a session larger than the row cap whole, deduped across its pages, no system row read out, and a reader seeds from it', async () => {
    put({ message_id: 's-0', role: 'system', content: `SYSTEM-PROMPT ${'s'.repeat(MIB)}` })
    for (let i = 0; i < 80; i++) turn(i, 500 * KIB) // 39 MiB
    put({ message_id: 'u-0', role: 'user', content: 'q0', metadata: at }) // Devin wrote the chain again: pages away from the first
    put({ message_id: 's-0', role: 'system', content: `SYSTEM-PROMPT ${'s'.repeat(MIB)}` })
    const rows = await readDevinMessages(db, SESSION)
    expect(rows.map((row) => row.messageId)).toEqual(Array.from({ length: 80 }, (_, i) => [`u-${i}`, `a-${i}`]).flat())
    expect(rows[0].rowId).toBe(2)
    expect(rows[159].content).toHaveLength(500 * KIB)
    const reads = await pageReads(vi.mocked(sqliteReadAll))
    expect(reads.length).toBeGreaterThan(9)
    expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
    expect(reads.some((read) => read.rows.some((row) => String(row.content ?? '').includes('SYSTEM-PROMPT')))).toBe(false)
    expect((await readDevinMessages(db, SESSION, 159)).map((row) => row.messageId)).toEqual(['u-79', 'a-79', 'u-0'])
    // A reader seeds from it in silence and streams only what comes after. On the base it never seeds.
    const { events, reader } = listen()
    try {
      await reader.start()
      expect(events).toEqual([])
      put({ message_id: 'u-new', role: 'user', content: 'a new prompt', metadata: at })
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 })
    } finally { reader.stop() }
    expect(JSON.stringify(events)).toContain('a new prompt')
    expect(JSON.stringify(events)).not.toContain('q0')
  })

  it('leaves out a row over the row cap, says so once, and reads on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    put({ message_id: 'u-0', role: 'user', content: 'q', metadata: at })
    put({ message_id: 'a-0', role: 'assistant', content: 'z'.repeat(33 * MIB), metadata: { ...at, finish_reason: 'stop' } })
    put({ message_id: 'u-1', role: 'user', content: 'next', metadata: at })
    for (let n = 0; n < 2; n++) expect((await readDevinMessages(db, SESSION)).map((row) => row.messageId)).toEqual(['u-0', 'u-1'])
    // A reader that polls over it does not stick: what comes after still arrives.
    const { events, reader } = listen()
    try {
      await reader.start()
      put({ message_id: 'u-new', role: 'user', content: 'a new prompt', metadata: at })
      await vi.waitFor(() => expect(JSON.stringify(events)).toContain('a new prompt'), { timeout: 10_000, interval: 10 })
    } finally { reader.stop() }
    expect(error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('too big')))
      .toEqual(['[devin] tested-c id 2 unreadable · too big'])
  })

  // #4065: a seed from the first page alone would emit the rest as new on the next poll.
  it('reads nothing when a later page fails, and seeds from the next whole read, replaying nothing', async () => {
    for (let i = 0; i < 12; i++) turn(i, 500 * KIB) // two pages
    const actual = await vi.importActual<typeof import('../../lib/sqliteRead.js')>('../../lib/sqliteRead.js')
    const fail = (): void => { vi.mocked(sqliteReadAll).mockImplementationOnce(actual.sqliteReadAll).mockResolvedValueOnce({ ok: false, reason: 'transient' }) }
    fail()
    expect(await readDevinMessages(db, SESSION)).toEqual([])
    fail()
    const { events, reader } = listen()
    try {
      await reader.start()
      const from = vi.mocked(sqliteReadAll).mock.calls.length
      await vi.waitFor(() => expect(vi.mocked(sqliteReadAll).mock.calls.length).toBeGreaterThanOrEqual(from + 3), { timeout: 10_000, interval: 10 })
      expect(events).toEqual([])
      put({ message_id: 'u-new', role: 'user', content: 'a new prompt', metadata: at })
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 })
    } finally { reader.stop() }
    expect(JSON.stringify(events)).toContain('a new prompt')
    expect(JSON.stringify(events)).not.toContain('q0')
  })
})
