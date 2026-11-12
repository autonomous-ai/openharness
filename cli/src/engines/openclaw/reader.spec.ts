/**
 * The OpenClaw reader against stores built from the recorded fixtures (`__fixtures__/schema.sql` plus a scenario),
 * OpenClaw 2026.11.2. The fixtures need a Node whose SQLite has fts5 (22.23 or 24; 23.11 lacks it).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sid } from '../../lib/log.js'
import { builtinSqlite, closeSqliteHandles, overrideBuiltinSqlite, type DatabaseConstructor, type DatabaseLike } from '../../lib/sqliteBuiltin.js'
import { PAGE_BYTES } from '../../lib/sqlitePage.js'
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import { enableOffThreadSqlite, resetOffThreadSqlite } from '../../lib/sqliteThread.js'
import { KIB, MIB, pageReads, withinBudget } from '../../testing/storePages.js'
import { OpenclawReader, readOpenclawHistory, readOpenclawSince, type OpenclawEvent, type OpenclawReaderDeps } from './reader.js'

vi.mock('node:zlib', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:zlib') & { zstdDecompressSync: (data: Uint8Array) => Buffer }>()
  return { ...real, zstdDecompressSync: vi.fn(real.zstdDecompressSync) }
})
const decompress = (zlib as unknown as { zstdDecompressSync: ReturnType<typeof vi.fn> }).zstdDecompressSync
// The real reads, seen: a paging case counts its pages and weighs their replies.
vi.mock('../../lib/sqliteRead.js', async (real) => {
  const actual = await real<typeof import('../../lib/sqliteRead.js')>()
  return { ...actual, sqliteReadAll: vi.fn(actual.sqliteReadAll) }
})

const FIXTURES = join(import.meta.dirname, '__fixtures__')
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.sql`), 'utf8')

let dir = ''
const open: DatabaseLike[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'openclaw-reader-')) })
afterEach(() => {
  closeSqliteHandles()
  for (const db of open.splice(0)) db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  vi.restoreAllMocks()
  vi.useRealTimers()
  overrideBuiltinSqlite(undefined)
  decompress.mockClear()
})

/** A store from the schema and one scenario, with a writer handle the test changes it through. */
function store(scenario: string, name = 'openclaw-agent.sqlite'): { path: string; db: DatabaseLike } {
  const Database = builtinSqlite()
  if (!Database) throw new Error('these specs need node:sqlite')
  const path = join(dir, name)
  const db = new Database(path, { readOnly: false })
  open.push(db)
  db.exec(fixture('schema'))
  db.exec(fixture(scenario))
  return { path, db }
}
const one = (db: DatabaseLike, sql: string): Record<string, unknown> => db.prepare(sql).all()[0]
const windowOf = (db: DatabaseLike, key: string): string =>
  String(one(db, `SELECT current_session_id AS id FROM session_nodes WHERE session_key = '${key}'`).id)
/** Moves the rows of a window past `seq` aside, to put them back later as if OpenClaw had just written them. */
function holdBack(db: DatabaseLike, window: string, seq: number): () => void {
  db.exec(`CREATE TABLE held_events AS SELECT * FROM transcript_events WHERE session_id = '${window}' AND seq > ${seq};
    CREATE TABLE held_active AS SELECT * FROM session_transcript_active_events WHERE session_id = '${window}' AND event_seq > ${seq};
    DELETE FROM session_transcript_active_events WHERE session_id = '${window}' AND event_seq > ${seq};
    DELETE FROM transcript_events WHERE session_id = '${window}' AND seq > ${seq};`)
  return () => db.exec(`BEGIN; INSERT INTO transcript_events SELECT * FROM held_events;
    INSERT INTO session_transcript_active_events SELECT * FROM held_active; COMMIT;`)
}
const seqs = (events: OpenclawEvent[]): number[] => events.map((event) => event.seq)
const ids = (events: OpenclawEvent[]): unknown[] => events.map((event) => event.record.id)
const userTexts = (events: OpenclawEvent[]): unknown[] => events
  .filter((event) => (event.record.message as { role?: string } | undefined)?.role === 'user')
  .map((event) => (event.record.message as { content: unknown }).content)

function reader(path: string, key: string, over: Partial<OpenclawReaderDeps> = {}) {
  const events: OpenclawEvent[] = []
  const deps = {
    db: path, key, pollMs: 10,
    onEvents: vi.fn((batch: OpenclawEvent[]) => { events.push(...batch) }),
    onHydrated: vi.fn(), onStatus: vi.fn(), onFatal: vi.fn(), onRecovered: vi.fn(),
  }
  return { reader: new OpenclawReader({ ...deps, ...over }), deps, events }
}

/** The rows of `key` past `seq` in its current window, as a count by cursor reads them. */
async function since(path: string, key: string, seq: number | null): Promise<OpenclawEvent[]> {
  if (seq === null) return (await readOpenclawSince(path, key, null))?.events ?? []
  const whole = await readOpenclawSince(path, key, null)
  const read = await readOpenclawSince(path, key, { ...whole!.cursor, seq })
  return read!.events
}

describe('readOpenclawSince', () => {
  it('reads only rows past the cursor', async () => {
    const { path, db } = store('plain')
    const windowId = windowOf(db, 'agent:main:plain')
    // 4 runtime-context, 5 system prompt and 7 bootstrap context are hidden.
    const whole = await readOpenclawSince(path, 'agent:main:plain', null)
    expect(whole).toMatchObject({ whole: true, cursor: { windowId, seq: 7 } })
    expect(seqs(whole!.events)).toEqual([0, 1, 2, 3, 6])
    const after = await since(path, 'agent:main:plain', 3)
    expect(seqs(after)).toEqual([6])
    expect(after[0]).toMatchObject({ windowId, record: { type: 'message', message: { role: 'assistant', stopReason: 'stop' } } })
    expect(await readOpenclawSince(path, 'agent:main:plain', whole!.cursor)).toMatchObject({ events: [], whole: false, cursor: whole!.cursor })
    expect(await readOpenclawSince(path, 'agent:main:nobody', null)).toBeNull()
  })

  it('reads the whole conversation again when the window or its rewrite changed', async () => {
    const { path, db } = store('plain')
    const { cursor } = (await readOpenclawSince(path, 'agent:main:plain', null))!
    db.exec(`UPDATE transcript_rewrite_watermarks SET generation = 'g-next' WHERE session_id = '${cursor.windowId}'`)
    const rewritten = await readOpenclawSince(path, 'agent:main:plain', cursor)
    expect(rewritten).toMatchObject({ whole: true, cursor: { generation: 'g-next' } })
    expect(seqs(rewritten!.events)).toEqual([0, 1, 2, 3, 6])
    expect(await readOpenclawSince(path, 'agent:main:plain', { ...rewritten!.cursor, windowId: 'another' })).toMatchObject({ whole: true })
  })

  it('decompresses zstd assistant rows', async () => {
    // `plain`, not `tool`: OpenClaw compresses only large rows, and every assistant row of `tool` is plain text.
    const { path, db } = store('plain')
    const compressed = db.prepare("SELECT seq FROM transcript_events WHERE message_role = 'assistant' AND event_zstd IS NOT NULL")
      .all().map((row) => Number(row.seq))
    expect(compressed.length).toBeGreaterThan(0)
    const events = await since(path, 'agent:main:plain', -1)
    for (const seq of compressed) {
      expect(events.find((event) => event.seq === seq)?.record).toMatchObject({ type: 'message', message: { role: 'assistant' } })
    }
  })

  it('filters hidden rows before decompressing', async () => {
    const { path } = store('main-heartbeat')
    const events = await since(path, 'agent:main:main', -1)
    expect(decompress).toHaveBeenCalled()
    const real = (await vi.importActual<{ zstdDecompressSync: (data: Uint8Array) => Buffer }>('node:zlib')).zstdDecompressSync
    for (const [blob] of decompress.mock.calls) {
      expect(JSON.parse(real(blob as Uint8Array).toString('utf8')).customType).not.toBe('openclaw.system-prompt')
    }
    // A plain system-prompt row (seq 12) has no custom type in its columns: it is recognised once parsed.
    const custom = events.map((event) => event.record.customType).filter(Boolean)
    expect(custom).toEqual(['model-snapshot'])
  })

  it('skips a row that does not decompress and logs once, by a short id', async () => {
    const { path, db } = store('plain')
    db.exec("UPDATE transcript_events SET event_zstd = X'00112233' WHERE seq = 6; UPDATE transcript_events SET event_json = '{bad' WHERE seq = 2")
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(seqs(await since(path, 'agent:main:plain', -1))).toEqual([0, 1, 3])
    expect(seqs(await since(path, 'agent:main:plain', -1))).toEqual([0, 1, 3])
    const lines = error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('unreadable'))
    expect(lines).toEqual([
      expect.stringMatching(new RegExp(`^\\[openclaw\\] ${sid('agent:main:plain')} seq 2 unreadable · `)),
      expect.stringMatching(new RegExp(`^\\[openclaw\\] ${sid('agent:main:plain')} seq 6 unreadable · `)),
    ])
    // No row text and no key reaches the log.
    expect(lines.join('\n')).not.toContain('{bad')
    expect(lines.join('\n')).not.toContain('agent:main:plain')
  })
})

describe('readOpenclawHistory', () => {
  it('reads the active branch across the window chain, never the abandoned one', async () => {
    const { path } = store('rewind')
    const history = await readOpenclawHistory(path, 'agent:main:rewind')
    expect(userTexts(history)).toEqual(['Reply with exactly: first', 'Reply with exactly: third'])
    expect(new Set(ids(history)).size).toBe(history.length)
  })

  it('keeps a /reset in its window, with the turns on both sides', async () => {
    const { path } = store('reset')
    const history = await readOpenclawHistory(path, 'agent:main:reset')
    expect(userTexts(history)).toEqual(['Reply with exactly: before', 'Reply with exactly: after'])
    expect(history.map((event) => event.record.type)).toContain('reset')
  })
})

// #4066: its reads called the binding on the caller's thread, so in the core a slow store held the core's own thread
// past the master's heartbeats (#1906). They go through sqliteReadAll, which the core runs on its read threads.
it('reads on the core\'s read threads: the caller\'s loop turns while it reads', async () => {
  const { path } = store('rewind')
  enableOffThreadSqlite()
  try {
    let turned = false
    setImmediate(() => { turned = true })
    const history = await readOpenclawHistory(path, 'agent:main:rewind')
    expect(history.length).toBeGreaterThan(0)
    expect(turned).toBe(true)
  } finally {
    await resetOffThreadSqlite()
  }
})

describe('OpenclawReader', () => {
  // #4066: a poll yields between its reads, so its pane can stop it in the middle of one.
  it('tells its pane nothing once it is stopped in the middle of a read', async () => {
    const { path } = store('rewind')
    const onHydrated = vi.fn(), onEvents = vi.fn(), onStatus = vi.fn()
    const reader = new OpenclawReader({ db: path, key: 'agent:main:rewind', onHydrated, onEvents, onStatus, pollMs: 60_000 })
    const started = reader.start()
    reader.stop()
    await started
    expect(onHydrated).not.toHaveBeenCalled()
    expect(onEvents).not.toHaveBeenCalled()
    expect(onStatus).not.toHaveBeenCalled()
  })

  it('follows the key to the new window after reset', async () => {
    // `/reset` appends a reset event to the same window (the fixture), so the stream simply continues there.
    const { path, db } = store('reset')
    const windowId = windowOf(db, 'agent:main:reset')
    const release = holdBack(db, windowId, 7)
    const { reader: tail, events, deps } = reader(path, 'agent:main:reset')
    await tail.start()
    expect(deps.onHydrated).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(seqs(events)).toEqual([8, 9, 12]))
    expect(events.map((event) => event.record.type)).toEqual(['reset', 'message', 'message'])
    // A later window (rollover, fork, switch) is read from its start; rows it copied are not emitted again.
    db.exec(`INSERT INTO session_windows (session_id, session_key, previous_session_id, reason, created_at, updated_at)
        VALUES ('w2', 'agent:main:reset', '${windowId}', 'rollover', 1, 1);
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
        SELECT 'w2', seq, event_json, created_at FROM transcript_events WHERE session_id = '${windowId}' AND seq IN (1, 9);
      INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES
        ('w2', 20, '{"type":"message","id":"u-next","message":{"role":"user","content":"next"}}', 1);
      UPDATE session_nodes SET current_session_id = 'w2' WHERE session_key = 'agent:main:reset';`)
    await vi.waitFor(() => expect(seqs(events)).toEqual([8, 9, 12, 20]))
    tail.stop()
    expect(events.map((event) => event.windowId)).toEqual([windowId, windowId, windowId, 'w2'])
  })

  it('re-hydrates on a rewind and never emits the abandoned branch', async () => {
    const { path, db } = store('rewind')
    const rewound = windowOf(db, 'agent:main:rewind')
    const first = String(one(db, `SELECT previous_session_id AS id FROM session_windows WHERE session_id = '${rewound}'`).id)
    // Attached before the rewind: the key on its first window, which holds the "second" turn.
    db.exec(`UPDATE session_nodes SET current_session_id = '${first}' WHERE session_key = 'agent:main:rewind'`)
    const { reader: tail, events } = reader(path, 'agent:main:rewind')
    await tail.start()
    expect(events).toEqual([])
    db.exec(`UPDATE session_nodes SET current_session_id = '${rewound}' WHERE session_key = 'agent:main:rewind'`)
    await vi.waitFor(() => expect(userTexts(events)).toEqual(['Reply with exactly: third']))
    // The new window's own header and leaf, then the new turn; the copied rows (1-11) are not emitted again.
    expect(seqs(events)).toEqual([0, 12, 13, 15])
    expect(new Set(ids(events)).size).toBe(events.length)

    // A rewrite inside the window (a new generation) emits only the active rows it has not emitted.
    db.exec(`BEGIN;
      INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES
        ('${rewound}', 17, '{"type":"message","id":"u-kept","message":{"role":"user","content":"kept"}}', 1),
        ('${rewound}', 18, '{"type":"message","id":"u-dropped","message":{"role":"user","content":"dropped"}}', 1);
      INSERT INTO session_transcript_active_events (session_id, active_position, event_seq) VALUES ('${rewound}', 11, 17);
      UPDATE transcript_rewrite_watermarks SET generation = 'g-next' WHERE session_id = '${rewound}';
      COMMIT;`)
    await vi.waitFor(() => expect(userTexts(events)).toEqual(['Reply with exactly: third', 'kept']))
    db.exec(`INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES
      ('${rewound}', 19, '{"type":"message","id":"u-after","message":{"role":"user","content":"after"}}', 1)`)
    await vi.waitFor(() => expect(userTexts(events)).toEqual(['Reply with exactly: third', 'kept', 'after']))
    tail.stop()
  })

  it('reports a missing column as unsupported, and reads again once an upgrade changes the store', async () => {
    const { path, db } = store('plain')
    const windowId = windowOf(db, 'agent:main:plain')
    db.exec('ALTER TABLE session_nodes RENAME COLUMN label TO label_renamed')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { reader: tail, deps, events } = reader(path, 'agent:main:plain')
    await tail.start()
    expect(deps.onFatal).toHaveBeenCalledWith('unsupported')
    expect(error.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringContaining('session_nodes.label'))
    await expect(readOpenclawSince(path, 'agent:main:plain', null)).rejects.toMatchObject({ reason: 'unsupported' })
    // OpenClaw upgraded to a store the reader reads: its rows are history, and what comes after is live.
    db.exec('ALTER TABLE session_nodes RENAME COLUMN label_renamed TO label')
    await vi.waitFor(() => expect(deps.onRecovered).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(deps.onHydrated).toHaveBeenCalledTimes(1))
    expect(seqs(deps.onHydrated.mock.calls[0][0])).toEqual([0, 1, 2, 3, 6])
    db.exec(`INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES
      ('${windowId}', 8, '{"type":"message","id":"u-next","message":{"role":"user","content":"next"}}', 1)`)
    await vi.waitFor(() => expect(userTexts(events)).toEqual(['next']))
    tail.stop()
    expect(deps.onFatal).toHaveBeenCalledTimes(1)
  })

  it('a first read that failed hydrates on the first good one, never replaying the history live', async () => {
    // The store is not there yet when the reader attaches (being replaced, or locked): a transient failure.
    const { path: written, db } = store('plain', 'written.sqlite')
    const path = join(dir, 'openclaw-agent.sqlite')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { reader: tail, deps, events } = reader(path, 'agent:main:plain')
    await tail.start()
    expect(deps.onFatal).not.toHaveBeenCalled()
    db.exec(`VACUUM INTO '${path}'`)
    expect(written).not.toBe(path)
    await vi.waitFor(() => expect(deps.onHydrated).toHaveBeenCalledTimes(1))
    expect(seqs(deps.onHydrated.mock.calls[0][0])).toEqual([0, 1, 2, 3, 6])
    expect(deps.onHydrated.mock.calls[0][1]).toBe('done')
    await new Promise((resolve) => setTimeout(resolve, 50))
    tail.stop()
    expect(events).toEqual([])
  })

  it('a key that was not there yet is read live from its start', async () => {
    const { path, db } = store('plain')
    const windowId = windowOf(db, 'agent:main:plain')
    // The writer moves the key aside, as if `fresh` had not been created yet.
    db.exec(`PRAGMA foreign_keys = OFF; UPDATE session_nodes SET session_key = 'agent:main:later' WHERE session_key = 'agent:main:plain'`)
    const later = reader(path, 'agent:main:fresh')
    await later.reader.start()
    db.exec(`UPDATE session_nodes SET session_key = 'agent:main:fresh' WHERE current_session_id = '${windowId}'`)
    await vi.waitFor(() => expect(seqs(later.events)).toEqual([0, 1, 2, 3, 6]))
    later.reader.stop()
    expect(later.deps.onHydrated).not.toHaveBeenCalled()
  })

  it('hands the hydrated rows over with the status, and says nothing live about them', async () => {
    const { path, db } = store('tool')
    const windowId = windowOf(db, 'agent:main:tool')
    // Mid-run: the user row and the assistant's tool call, with no answer yet.
    holdBack(db, windowId, 6)
    db.exec("UPDATE session_nodes SET status = 'running' WHERE session_key = 'agent:main:tool'")
    const mid = reader(path, 'agent:main:tool')
    await mid.reader.start()
    mid.reader.stop()
    expect(mid.deps.onHydrated).toHaveBeenCalledTimes(1)
    expect(mid.deps.onHydrated.mock.calls[0][1]).toBe('running')
    expect(mid.deps.onEvents).not.toHaveBeenCalled()
  })

  it('reports the run status on every read that caught up, and reads on every poll while a turn is open', async () => {
    const { path, db } = store('abort')
    db.exec("UPDATE session_nodes SET status = 'running' WHERE session_key = 'agent:main:abort'")
    const { reader: tail, deps } = reader(path, 'agent:main:abort', { busy: () => true })
    await tail.start()
    expect(deps.onStatus).toHaveBeenLastCalledWith('running')
    db.exec("UPDATE session_nodes SET status = 'killed' WHERE session_key = 'agent:main:abort'")
    await vi.waitFor(() => expect(deps.onStatus).toHaveBeenCalledWith('killed'))
    // The same status again on the next read: a run killed within one poll never shows `running`.
    const killed = deps.onStatus.mock.calls.filter(([status]) => status === 'killed').length
    await vi.waitFor(() => expect(deps.onStatus.mock.calls.filter(([status]) => status === 'killed').length).toBeGreaterThan(killed))
    tail.stop()
  })

  // One bound idle pane cost the daemon's core +0.6% of a core (E2E 2026-11-10), two queries a second of it here.
  it('a quiet store costs no query: a poll reads only once its files changed, and now and then all the same', async () => {
    vi.useFakeTimers()
    const { path, db } = store('plain')
    const put = holdBack(db, windowOf(db, 'agent:main:plain'), 3)
    let queries = 0
    const Real = builtinSqlite()!
    class Counted extends (Real as unknown as new (path: string | URL, options: { readOnly: boolean }) => DatabaseLike) {
      override prepare(sql: string) { queries++; return super.prepare(sql) }
    }
    overrideBuiltinSqlite(Counted as unknown as DatabaseConstructor)
    const { reader: tail, deps, events } = reader(path, 'agent:main:plain')
    await tail.start()
    expect(deps.onHydrated).toHaveBeenCalledOnce()
    const hydrated = queries
    await vi.advanceTimersByTimeAsync(5_000)
    expect(queries, '500 polls of a store nobody wrote').toBe(hydrated)
    put()
    await vi.advanceTimersByTimeAsync(10)
    expect(seqs(events)).toEqual([6])
    const quiet = queries
    await vi.advanceTimersByTimeAsync(10_000)
    expect(queries, 'a read every 10 s whatever the files say').toBeGreaterThan(quiet)
    expect(queries - quiet).toBeLessThanOrEqual(4)
    tail.stop()
  })

  it('a row written into a quiet store reaches the stream within a poll, a second', async () => {
    vi.useFakeTimers()
    const { path, db } = store('plain')
    const put = holdBack(db, windowOf(db, 'agent:main:plain'), 3)
    const { reader: tail, events } = reader(path, 'agent:main:plain', { pollMs: undefined })
    await tail.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(events).toEqual([])
    put()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(seqs(events)).toEqual([6])
    tail.stop()
  })
})

// #4188: a page was 500 rows whatever they weighed, under a reply limit of 500 times 4 MiB, and a plain event over
// 4 MiB has no bound in the store. Only the read threads enforce a reply limit, so they are on.
const withBuiltin = builtinSqlite() ? describe : describe.skip
withBuiltin('pages by bytes', () => {
  beforeEach(() => {
    vi.mocked(sqliteReadAll).mockClear()
    enableOffThreadSqlite()
  })
  afterEach(async () => {
    await resetOffThreadSqlite()
    closeSqliteHandles()
  })

  const message = (id: string, bytes: number): string => JSON.stringify({ type: 'message', id, message: { role: 'user', content: 'x'.repeat(bytes) } })
  /** Plain rows on a window's active branch; `said` is what the row claims in event_utf8_bytes. */
  function append(db: DatabaseLike, windowId: string, rows: Array<{ seq: number; json: string; said?: number | null }>): void {
    for (const { seq, json, said = null } of rows) {
      db.prepare('INSERT INTO transcript_events (session_id, seq, event_json, created_at, event_utf8_bytes) VALUES (?, ?, ?, 1, ?)').all(windowId, seq, json, said)
      db.prepare('INSERT INTO session_transcript_active_events (session_id, active_position, event_seq) VALUES (?, ?, ?)').all(windowId, 1000 + seq, seq)
    }
  }
  const KEY = 'agent:main:plain'
  const upTo = (first: number, last: number): number[] => Array.from({ length: last - first + 1 }, (_, i) => first + i)
  /** A fixture store in WAL, as OpenClaw's own is: a read never holds up the test's writer. */
  const wal = (scenario: string): { path: string; db: DatabaseLike } => { const made = store(scenario); made.db.exec('PRAGMA journal_mode = WAL'); return made }

  it('reads a window of several page budgets whole and in order, a page at a time', async () => {
    const { path, db } = wal('plain')
    append(db, windowOf(db, KEY), upTo(8, 37).map((seq) => ({ seq, json: message(`big-${seq}`, 500 * KIB) })))
    expect(seqs(await readOpenclawHistory(path, KEY))).toEqual([0, 1, 2, 3, 6, ...upTo(8, 37)])
    const whole = await readOpenclawSince(path, KEY, null)
    expect(seqs(whole!.events)).toEqual([0, 1, 2, 3, 6, ...upTo(8, 37)])
    const after = await readOpenclawSince(path, KEY, { ...whole!.cursor, seq: 20 })
    expect(after).toMatchObject({ whole: false, cursor: { seq: 37 } })
    expect(seqs(after!.events)).toEqual(upTo(21, 37))
    const reads = await pageReads(vi.mocked(sqliteReadAll))
    expect(reads.length).toBeGreaterThan(6)
    expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
  })

  it('the live tail drains a backlog over its polls, a page at a time', async () => {
    const { path, db } = wal('plain')
    const { reader: tail, events } = reader(path, KEY)
    await tail.start()
    vi.mocked(sqliteReadAll).mockClear()
    append(db, windowOf(db, KEY), upTo(8, 19).map((seq) => ({ seq, json: message(`live-${seq}`, MIB) })))
    await vi.waitFor(() => expect(seqs(events)).toEqual(upTo(8, 19)), { timeout: 10_000 })
    tail.stop()
    const reads = (await pageReads(vi.mocked(sqliteReadAll))).filter((read) => read.rows.length)
    expect(reads.length).toBeGreaterThanOrEqual(4)
    expect(reads.every((read) => read.ok && withinBudget(read))).toBe(true)
  })

  it('steps past a row over the row cap, says so once, and reads on', async () => {
    const { path, db } = wal('plain')
    const windowId = windowOf(db, KEY)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { reader: tail, events } = reader(path, KEY)
    await tail.start()
    append(db, windowId, [{ seq: 8, json: message('before', 10) }, { seq: 9, json: message('huge', 33 * MIB) }, { seq: 10, json: message('after', 10) }])
    await vi.waitFor(() => expect(seqs(events)).toEqual([8, 10]), { timeout: 10_000 })
    append(db, windowId, [{ seq: 11, json: message('later', 10) }])
    await vi.waitFor(() => expect(seqs(events)).toEqual([8, 10, 11]), { timeout: 10_000 })
    tail.stop()
    expect(seqs(await readOpenclawHistory(path, KEY))).toEqual([0, 1, 2, 3, 6, 8, 10, 11])
    expect(seqs((await readOpenclawSince(path, KEY, null))!.events)).toEqual([0, 1, 2, 3, 6, 8, 10, 11])
    expect(error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('unreadable')))
      .toEqual([`[openclaw] ${sid(KEY)} seq 9 unreadable · too big`])
  })

  it('reads a row over the page budget alone, and sizes a plain row by its text whatever event_utf8_bytes says', async () => {
    const { path, db } = wal('plain')
    append(db, windowOf(db, KEY), [{ seq: 8, json: message('six', 6 * MIB) },
      ...upTo(9, 16).map((seq) => ({ seq, json: message(`lie-${seq}`, MIB), said: 1 })),
      { seq: 17, json: message('small', 10), said: 2_000_000_000 }])
    expect(seqs(await readOpenclawHistory(path, KEY))).toEqual([0, 1, 2, 3, 6, ...upTo(8, 17)])
    const reads = await pageReads(vi.mocked(sqliteReadAll))
    expect(reads.some((read) => read.rows.length === 1 && read.bytes > PAGE_BYTES)).toBe(true)
    expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
  })

  it('a store without event_utf8_bytes is unsupported', async () => {
    const { path, db } = wal('plain')
    db.exec('ALTER TABLE transcript_events RENAME COLUMN event_utf8_bytes TO event_utf8_bytes_renamed')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(readOpenclawSince(path, KEY, null)).rejects.toMatchObject({ reason: 'unsupported' })
    expect(error.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringContaining('transcript_events.event_utf8_bytes'))
  })

  it('borrows the newest window\'s header for a key with no rows yet, but never one over the row cap', async () => {
    const { path, db } = wal('plain')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const borrowed = vi.fn()
    const first = reader(path, 'agent:main:nobody', { onAgentHeader: borrowed })
    await first.reader.start(); first.reader.stop()
    expect(borrowed).toHaveBeenCalledWith(expect.objectContaining({ type: 'session', cwd: '/root/.openclaw/workspace' }))
    db.prepare('UPDATE transcript_events SET event_json = ? WHERE seq = 0').all(JSON.stringify({ type: 'session', cwd: 'x'.repeat(33 * MIB) }))
    const none = vi.fn()
    const second = reader(path, 'agent:main:nobody', { onAgentHeader: none })
    await second.reader.start(); second.reader.stop()
    expect(none).not.toHaveBeenCalled()
  })

  it('reads a later window\'s ids a page at a time, so its copies never come back from the window before it', async () => {
    const { path, db } = wal('rewind')
    const later = windowOf(db, 'agent:main:rewind')
    const earlier = String(one(db, `SELECT previous_session_id AS id FROM session_windows WHERE session_id = '${later}'`).id)
    const row = db.prepare('INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, 1)')
    // 600 rows off the later window's branch, then the copy: its id is past the first 500.
    for (let i = 0; i < 600; i++) row.all(later, 100 + i, message(`filler-${i}`, 10))
    row.all(later, 700, message('copied', 10))
    append(db, earlier, [{ seq: 900, json: message('copied', 10) }])
    expect(ids(await readOpenclawHistory(path, 'agent:main:rewind'))).not.toContain('copied')
    const idReads = (await pageReads(vi.mocked(sqliteReadAll))).filter((read) => read.sql.includes("'$.navigation.id'"))
    expect(idReads).toHaveLength(2)
    expect(idReads[0].rows).toHaveLength(500)
  })
})
