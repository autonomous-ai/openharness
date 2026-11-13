import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HermesReader, readHermesMessages } from './reader.js'
import type { LiveEvent } from '../../lib/normalize.js'
import { builtinSqlite, closeSqliteHandles, type DatabaseLike } from '../../lib/sqliteBuiltin.js'
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import { enableOffThreadSqlite, resetOffThreadSqlite } from '../../lib/sqliteThread.js'
import { KIB, MIB, pageReads, withinBudget } from '../../testing/storePages.js'

// The real reads, with a seam to make one of them go unanswered, as a busy store or the read threads' deadline does.
vi.mock('../../lib/sqliteRead.js', async (real) => {
  const actual = await real<typeof import('../../lib/sqliteRead.js')>()
  return { ...actual, sqliteReadAll: vi.fn(actual.sqliteReadAll) }
})

/** Polls until the store has been read [more] times since [from]: the read that seeds a reader, and a poll after it. */
async function readsPast(from: number, more = 2): Promise<void> {
  await vi.waitFor(() => expect(vi.mocked(sqliteReadAll).mock.calls.length).toBeGreaterThanOrEqual(from + more), { timeout: 5_000, interval: 10 })
}

const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const d = hasSqlite ? describe : describe.skip

const SID = '20260727_162325_e25264' // the real Hermes id shape: YYYYMMDD_HHMMSS_<hex>
const CALL = 'call_ba1647ad979d0290'

function run(db: string, sql: string): void {
  execFileSync('sqlite3', [db, sql], { stdio: ['ignore', 'ignore', 'inherit'] })
}
function q(v: string | null): string {
  return v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`
}
function insert(
  db: string,
  row: { id: number; role: string; content?: string; toolCallId?: string; toolCalls?: string; toolName?: string; finishReason?: string; reasoning?: string },
): void {
  run(db,
    `INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, finish_reason, reasoning, timestamp) VALUES (` +
    `${row.id}, '${SID}', '${row.role}', ${q(row.content ?? '')}, ${q(row.toolCallId ?? null)}, ${q(row.toolCalls ?? null)}, ` +
    `${q(row.toolName ?? null)}, ${q(row.finishReason ?? null)}, ${q(row.reasoning ?? null)}, ${row.id});`)
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

d('HermesReader (sqlite3 CLI)', () => {
  let dir = ''
  let db = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-reader-'))
    db = join(dir, 'state.db')
    run(db,
      'CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT,' +
      ' tool_calls TEXT, tool_name TEXT, finish_reason TEXT, reasoning TEXT, timestamp REAL);')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads rows in id order with the columns the normalizer needs', async () => {
    insert(db, { id: 1, role: 'user', content: 'hi' })
    insert(db, { id: 2, role: 'assistant', content: 'hello', finishReason: 'stop' })
    const rows = await readHermesMessages(db, SID)
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant'])
    expect(rows[1]).toMatchObject({ id: 2, content: 'hello', finishReason: 'stop' })
  })

  it('rejects a session id that is not the Hermes shape (no injection surface)', async () => {
    expect(await readHermesMessages(db, "x'; DROP TABLE messages;--")).toEqual([])
  })

  it("reads an editor's (ACP) session, whose id is a uuid", async () => {
    const acp = '3f2a9c1e-8b4d-4e6f-9a1b-2c3d4e5f6a7b'
    run(db, `INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (1, '${acp}', 'user', 'hi', 1)`)
    run(db, `INSERT INTO messages (id, session_id, role, content, finish_reason, timestamp) VALUES (2, '${acp}', 'assistant', 'hello', 'stop', 2)`)
    expect((await readHermesMessages(db, acp)).map((r) => r.role)).toEqual(['user', 'assistant'])
    // Uuid-shaped with a tail is not an id: refused, rows or not.
    run(db, `INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (3, '${acp}-0', 'user', 'x', 3)`)
    expect(await readHermesMessages(db, `${acp}-0`)).toEqual([])
  })

  it("reads a Hermes 0.23 unified-runtime session, whose id is local-<sha256>", async () => {
    const local = `local-${'0123456789abcdef'.repeat(4)}`
    run(db, `INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (1, '${local}', 'user', 'hi', 1)`)
    expect((await readHermesMessages(db, local)).map((r) => r.role)).toEqual(['user'])
    // local_identity() is a lowercase sha256 hexdigest: a shorter, longer or uppercase one is no id.
    for (const id of [local.slice(0, -1), `${local}0`, local.toUpperCase(), `local-${'g'.repeat(64)}`]) {
      expect(await readHermesMessages(db, id)).toEqual([])
    }
  })

  it('hydrates silently, then streams a new turn incrementally', async () => {
    insert(db, { id: 1, role: 'user', content: 'old' })
    insert(db, { id: 2, role: 'assistant', content: 'done', finishReason: 'stop' })

    const events: LiveEvent[] = []
    const reader = new HermesReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 30 })
    await reader.start()
    expect(events).toHaveLength(0)      // hydrate = no replay
    expect(reader.turnOpen).toBe(false) // last row was a terminal assistant

    insert(db, { id: 3, role: 'user', content: 'who won?' })
    insert(db, { id: 4, role: 'assistant', finishReason: 'tool_calls', toolCalls: `[{"id":"${CALL}","type":"function","function":{"name":"terminal","arguments":"{\\"command\\":\\"ls\\"}"}}]` })
    await wait(120)
    expect(reader.turnOpen).toBe(true)  // still calling a tool

    insert(db, { id: 5, role: 'tool', toolName: 'terminal', toolCallId: CALL, content: '{"output": "a.txt", "exit_code": 0, "error": null}' })
    insert(db, { id: 6, role: 'assistant', content: 'Spain', finishReason: 'stop' })
    await wait(150)
    reader.stop()

    const types = events.map((e) => e.type)
    expect(types).toEqual(['turn_started', 'tool_start', 'tool_end', 'text_delta', 'turn_ended'])
    expect(events[0]).toMatchObject({ payload: { userMessage: 'who won?' } })
    expect(events[2]).toMatchObject({ payload: { tool: 'Bash', output: 'a.txt', isError: false } })
    expect(reader.turnOpen).toBe(false)
  })

  it('reports a mid-turn attach as an open turn', async () => {
    insert(db, { id: 1, role: 'user', content: 'working on it' })
    const reader = new HermesReader({ dbPath: db, sessionId: SID, onEvents: () => {}, pollMs: 1_000 })
    await reader.start()
    expect(reader.turnOpen).toBe(true)
    reader.stop()
  })

  // #4065: a first read the store did not answer left the cursor at 0, and the next poll emitted the whole session as new.
  it('reads the session in full again after a first read the store did not answer, and emits only what is new', async () => {
    insert(db, { id: 1, role: 'user', content: 'an old prompt' })
    insert(db, { id: 2, role: 'assistant', content: 'an old answer', finishReason: 'stop' })
    vi.mocked(sqliteReadAll).mockResolvedValueOnce({ ok: false, reason: 'transient' })
    const events: LiveEvent[] = []
    const reader = new HermesReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 20 })
    try {
      await reader.start()
      await readsPast(vi.mocked(sqliteReadAll).mock.calls.length)
      expect(events).toEqual([])
      insert(db, { id: 3, role: 'user', content: 'a new prompt' })
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 5_000, interval: 10 })
    } finally {
      reader.stop()
    }
    expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'a new prompt' } }])
  })
})

// #4188: a session past 32 MiB was read in one query, refused for its size on every poll: it never seeded and its
// history never loaded. Only the read threads enforce a reply limit, so they are on. The store is built with the
// binding: the sqlite3 CLI cannot take megabytes on a command line.
const withBuiltin = builtinSqlite() ? describe : describe.skip

withBuiltin('HermesReader pages by bytes', () => {
  let dir = ''
  let db = ''
  let w: DatabaseLike
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-pages-'))
    db = join(dir, 'state.db')
    w = new (builtinSqlite()!)(db, { readOnly: false })
    // As Hermes' store is: in the older journal mode a reader in the middle of a large page would fail the writer's
    // next commit with `database is locked`, now and then.
    w.exec('PRAGMA journal_mode = WAL')
    w.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT,'
      + ' tool_calls TEXT, tool_name TEXT, finish_reason TEXT, reasoning TEXT, timestamp REAL)')
    vi.mocked(sqliteReadAll).mockClear()
    enableOffThreadSqlite()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await resetOffThreadSqlite()
    closeSqliteHandles()
    w.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const put = (id: number, role: string, content: string | null, finish: string | null = null): void => {
    w.prepare('INSERT INTO messages (id, session_id, role, content, finish_reason, timestamp) VALUES (?, ?, ?, ?, ?, ?)').all(id, SID, role, content, finish, id)
  }
  /** Turn i: prompt 2i + 1, and a finished answer of `bytes`, 2i + 2. */
  const turn = (i: number, bytes: number): void => { put(2 * i + 1, 'user', `q${i}`); put(2 * i + 2, 'assistant', 'x'.repeat(bytes), 'stop') }
  const listen = (): { events: LiveEvent[]; reader: HermesReader } => {
    const events: LiveEvent[] = []
    return { events, reader: new HermesReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 20 }) }
  }

  it('reads a session larger than the row cap whole, a page at a time, and a reader seeds from it', async () => {
    for (let i = 0; i < 80; i++) turn(i, 500 * KIB) // 39 MiB
    const rows = await readHermesMessages(db, SID)
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 160 }, (_, n) => n + 1))
    expect(rows[159]).toMatchObject({ role: 'assistant', finishReason: 'stop' })
    expect(rows[159].content).toHaveLength(500 * KIB)
    const reads = await pageReads(vi.mocked(sqliteReadAll))
    expect(reads.length).toBeGreaterThan(9)
    expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
    expect((await readHermesMessages(db, SID, 157)).map((row) => row.id)).toEqual([158, 159, 160])
    // A reader seeds from it in silence and streams only what comes after. On the base it never seeds.
    const { events, reader } = listen()
    try {
      await reader.start()
      expect([events, reader.turnOpen]).toEqual([[], false])
      put(900, 'user', 'a new prompt')
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 })
    } finally { reader.stop() }
    expect(JSON.stringify(events)).toContain('a new prompt')
    expect(JSON.stringify(events)).not.toContain('q0')
  })

  // A tool call's row has no content: a NULL size must count 0, or one such row would be a page.
  it('pages rows with no content by count', async () => {
    for (let n = 1; n <= 600; n++) put(n, 'assistant', null)
    const rows = await readHermesMessages(db, SID)
    expect(rows).toHaveLength(600)
    expect(rows.every((row) => row.content === '')).toBe(true)
    expect((await pageReads(vi.mocked(sqliteReadAll))).map((read) => read.rows.length)).toEqual([500, 100])
  })

  it('leaves out a row over the row cap, says so once, and reads on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    put(1, 'user', 'q'); put(2, 'assistant', 'z'.repeat(33 * MIB), 'stop'); put(3, 'user', 'next')
    for (let n = 0; n < 2; n++) expect((await readHermesMessages(db, SID)).map((row) => row.id)).toEqual([1, 3])
    // A reader whose cursor stays before it does not stick: what comes after still arrives.
    const { events, reader } = listen()
    try {
      await reader.start()
      put(900, 'user', 'a new prompt')
      await vi.waitFor(() => expect(JSON.stringify(events)).toContain('a new prompt'), { timeout: 10_000, interval: 10 })
    } finally { reader.stop() }
    expect(error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('too big')))
      .toEqual(['[hermes] 20260727 id 2 unreadable · too big'])
  })

  // #4065: a seed from the first page alone would emit the rest as new on the next poll.
  it('reads nothing when a later page fails, and seeds from the next whole read, replaying nothing', async () => {
    for (let i = 0; i < 12; i++) turn(i, 500 * KIB) // two pages
    const actual = await vi.importActual<typeof import('../../lib/sqliteRead.js')>('../../lib/sqliteRead.js')
    const fail = (): void => { vi.mocked(sqliteReadAll).mockImplementationOnce(actual.sqliteReadAll).mockResolvedValueOnce({ ok: false, reason: 'transient' }) }
    fail()
    expect(await readHermesMessages(db, SID)).toEqual([])
    fail()
    const { events, reader } = listen()
    try {
      await reader.start()
      await readsPast(vi.mocked(sqliteReadAll).mock.calls.length, 3)
      expect(events).toEqual([])
      put(900, 'user', 'a new prompt')
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 })
    } finally { reader.stop() }
    expect(JSON.stringify(events)).toContain('a new prompt')
    expect(JSON.stringify(events)).not.toContain('q0')
  })
})
