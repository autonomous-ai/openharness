import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KiloReader, readKiloMessages } from './reader.js'
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

/**
 * A first message through `harness kilo` produced no turn frames and no recap, every time:
 *
 *   [agent] c5c6227b re-attached · engine=kilo · pane=%10 · session=ses_014f
 *   [turn]  ses_014f ended
 *   [recap] DROPPED (no turn_started was ever seen for this session)
 *
 * Kilo creates its session only when the FIRST message is submitted, and the discovery plugin fires on
 * `session.created` — so the daemon ALWAYS attaches with a turn already in flight. A silent hydrate then
 * left that turn with a close and no open, and the recap was dropped for want of the opening frame.
 *
 * These run against a real SQLite file through the same `sqlite3` path the daemon uses, because the bug
 * lived in what hydrate did with the rows, not in the parsing.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const SESSION = 'ses_test01'

/** message.data / part.data are JSON TEXT columns, exactly as kilo writes them. */
function db(rows: Array<{ role: string; parts: Array<Record<string, unknown>> }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kilo-reader-'))
  dirs.push(dir)
  const path = join(dir, 'kilo.db')
  const sql: string[] = [
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);',
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);',
  ]
  const q = (v: unknown): string => `'${JSON.stringify(v).replace(/'/g, "''")}'`
  rows.forEach((row, m) => {
    sql.push(`INSERT INTO message VALUES ('msg_${m}','${SESSION}',${1000 + m},${q({ role: row.role })});`)
    row.parts.forEach((part, p) => {
      sql.push(`INSERT INTO part VALUES ('prt_${m}_${p}','msg_${m}','${SESSION}',${1000 + m * 10 + p},${q(part)});`)
    })
  })
  execFileSync('sqlite3', [path, sql.join('\n')])
  return path
}

async function attach(dbPath: string): Promise<LiveEvent[]> {
  const seen: LiveEvent[] = []
  // A very long poll interval: these assertions are about what ATTACHING emits, not about polling.
  const reader = new KiloReader({ dbPath, sessionId: SESSION, onEvents: (e) => seen.push(...e), pollMs: 600_000 })
  await reader.start()
  reader.stop()
  return seen
}

const userMsg = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] })
const working = { role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: 'thinking…' }] }
const finished = {
  role: 'assistant',
  parts: [{ type: 'text', text: 'done' }, { type: 'step-finish', reason: 'stop' }],
}

// macOS ships the sqlite3 CLI in the base system; Ubuntu (and most slim images) do not. These cases
// drive a REAL database on purpose, so skip rather than fail where the binary is genuinely absent —
// the same guard opencode/reader.spec.ts and hermes/reader.spec.ts already use.
const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const d = hasSqlite ? describe : describe.skip

d('KiloReader attaching mid-turn', () => {
  /**
   * The shape that broke a first message. The plugin posts the moment the user row lands, which is
   * BEFORE kilo has written any assistant row — so the old check ("is the tail an unfinished
   * assistant") said no turn was open, and the user id was already in `seenUser`, meaning the poll
   * could never emit the opening frame for it either. Two ways to lose the same turn.
   */
  it('opens the turn when only the user row exists yet', async () => {
    const events = await attach(db([userMsg('gia eth di')]))

    expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'gia eth di' } }])
  })

  it('opens the turn when the assistant is already working', async () => {
    const events = await attach(db([userMsg('price eth now'), working]))

    expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'price eth now' } }])
  })

  /** Re-attaching to an idle session must stay silent, or every daemon restart invents a turn. */
  it('says nothing when the last turn already finished', async () => {
    expect(await attach(db([userMsg('hi'), finished]))).toEqual([])
  })

  it('says nothing for a session with no rows at all', async () => {
    expect(await attach(db([]))).toEqual([])
  })

  /**
   * The backstop must not double-fire. Every user row present at attach is seeded into `seenUser`, so
   * the first poll that re-reads the same rows has nothing new to open.
   */
  it('does not open the same turn twice when the poll re-reads it', async () => {
    const path = db([userMsg('once'), working])
    const seen: LiveEvent[] = []
    const reader = new KiloReader({ dbPath: path, sessionId: SESSION, onEvents: (e) => seen.push(...e), pollMs: 10 })
    await reader.start()
    await new Promise((r) => setTimeout(r, 120))
    reader.stop()

    expect(seen.filter((e) => e.type === 'turn_started')).toHaveLength(1)
  })

  // #4065: a first read the store did not answer left no cursor, and the next poll emitted the whole session as new.
  it('reads the session in full again after a first read the store did not answer, and emits only what is new', async () => {
    const path = db([userMsg('an old prompt'), finished])
    vi.mocked(sqliteReadAll).mockResolvedValueOnce({ ok: false, reason: 'transient' })
    const events: LiveEvent[] = []
    const reader = new KiloReader({ dbPath: path, sessionId: SESSION, onEvents: (e) => events.push(...e), pollMs: 20 })
    try {
      await reader.start()
      await readsPast(vi.mocked(sqliteReadAll).mock.calls.length)
      expect(events).toEqual([])
      execFileSync('sqlite3', [path, `INSERT INTO message VALUES ('msg_9','${SESSION}',2000,'{"role":"user"}');`
        + `INSERT INTO part VALUES ('prt_9_0','msg_9','${SESSION}',2000,'{"type":"text","text":"a new prompt"}');`])
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 5_000, interval: 10 })
    } finally {
      reader.stop()
    }
    expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'a new prompt' } }])
  })
})

// #4188: a session past 32 MiB was read in one query, refused for its size on every poll, and never seeded. Only the
// read threads enforce a reply limit, so they are on; the store is built with the binding, as the sqlite3 CLI cannot
// take megabytes on a command line.
const withBuiltin = builtinSqlite() ? describe : describe.skip

withBuiltin('KiloReader pages by bytes', () => {
  let dir = ''
  let path = ''
  let w: DatabaseLike
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kilo-pages-'))
    path = join(dir, 'kilo.db')
    w = new (builtinSqlite()!)(path, { readOnly: false })
    // As kilo's store is: in the older journal mode a reader in the middle of a large page would fail the writer's
    // next commit with `database is locked`, now and then.
    w.exec('PRAGMA journal_mode = WAL')
    w.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);'
      + 'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);'
      + 'CREATE INDEX part_message_id_id_idx ON part (message_id, id);')
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

  /** A message and its parts in one transaction: a poll never sees the message without them. */
  const put = (mid: string, tc: number, role: string, parts: Array<Record<string, unknown>>): void => {
    w.exec('BEGIN')
    w.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').all(mid, SESSION, tc, JSON.stringify({ role }))
    parts.forEach((data, p) => w.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').all(`${mid}-p${p}`, mid, SESSION, tc * 10 + p, JSON.stringify(data)))
    w.exec('COMMIT')
  }
  const id = (n: number): string => `msg_${String(n).padStart(4, '0')}`
  const turn = (i: number, bytes: number): void => {
    put(id(2 * i), 2 * i, 'user', [{ type: 'text', text: `q${i}` }])
    put(id(2 * i + 1), 2 * i + 1, 'assistant', [{ type: 'text', text: 'x'.repeat(bytes) }, { type: 'step-finish', reason: 'stop' }])
  }
  const listen = (): { events: LiveEvent[]; reader: KiloReader } => {
    const events: LiveEvent[] = []
    return { events, reader: new KiloReader({ dbPath: path, sessionId: SESSION, onEvents: (e) => events.push(...e), pollMs: 20 }) }
  }

  it('reads a session larger than the row cap whole, a page at a time, no message split, and a reader seeds from it', async () => {
    for (let i = 0; i < 80; i++) turn(i, 500 * KIB) // 39 MiB
    // 6 MiB: over the budget. Its turn finished, or the reader would rightly open it on attach.
    put(id(160), 160, 'assistant', [...[0, 1, 2].map(() => ({ type: 'text', text: 'y'.repeat(2 * MIB) })), { type: 'step-finish', reason: 'stop' }])
    const messages = await readKiloMessages(path, SESSION)
    expect(messages.map((m) => m.id)).toEqual(Array.from({ length: 161 }, (_, n) => id(n)))
    expect(messages[159].parts.map((p) => p.type)).toEqual(['text', 'step-finish'])
    expect(messages[160].parts).toHaveLength(4)
    const reads = await pageReads(vi.mocked(sqliteReadAll))
    expect(reads.length).toBeGreaterThan(9)
    expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
    const own = reads.find((read) => read.rows.some((row) => row.mid === id(160)))!
    expect([own.units, own.rows.filter((row) => row.mdata !== null).length]).toEqual([1, 1])
    expect((await readKiloMessages(path, SESSION, { tc: 158, id: id(158) })).map((m) => m.id)).toEqual([id(159), id(160)])
    // A reader seeds from it in silence and streams only what comes after. On the base it never seeds.
    const { events, reader } = listen()
    try {
      await reader.start()
      expect(events).toEqual([])
      put(id(900), 900, 'user', [{ type: 'text', text: 'a new prompt' }])
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 })
    } finally { reader.stop() }
    expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'a new prompt' } }])
  })

  it('leaves out a message over the row cap, says so once, and reads on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    turn(0, 10); put(id(2), 2, 'assistant', [{ type: 'text', text: 'z'.repeat(33 * MIB) }]); turn(2, 10)
    for (let n = 0; n < 2; n++) expect((await readKiloMessages(path, SESSION)).map((m) => m.id)).toEqual([id(0), id(1), id(4), id(5)])
    // A reader that polls over it does not stick: what comes after still arrives.
    const { events, reader } = listen()
    try {
      await reader.start()
      put(id(900), 900, 'user', [{ type: 'text', text: 'a new prompt' }])
      await vi.waitFor(() => expect(JSON.stringify(events)).toContain('a new prompt'), { timeout: 10_000, interval: 10 })
    } finally { reader.stop() }
    expect(error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('too big')))
      .toEqual([`[kilo] ses_test id ${id(2)} unreadable · too big`])
  })

  // #4065: a seed from the first page alone would emit the rest as new on the next poll.
  it('reads nothing when a later page fails, and seeds from the next whole read, replaying nothing', async () => {
    for (let i = 0; i < 12; i++) turn(i, 500 * KIB) // two pages
    const actual = await vi.importActual<typeof import('../../lib/sqliteRead.js')>('../../lib/sqliteRead.js')
    const fail = (): void => { vi.mocked(sqliteReadAll).mockImplementationOnce(actual.sqliteReadAll).mockResolvedValueOnce({ ok: false, reason: 'transient' }) }
    fail()
    expect(await readKiloMessages(path, SESSION)).toEqual([])
    fail()
    const { events, reader } = listen()
    try {
      await reader.start()
      await readsPast(vi.mocked(sqliteReadAll).mock.calls.length, 3)
      expect(events).toEqual([])
      put(id(900), 900, 'user', [{ type: 'text', text: 'a new prompt' }])
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 })
    } finally { reader.stop() }
    expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'a new prompt' } }])
  })
})
