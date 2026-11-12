import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KIB, MIB, pageReads, withinBudget } from '../testing/storePages.js'
import { builtinSqlite, closeSqliteHandles, overrideBuiltinSqlite, type DatabaseLike } from './sqliteBuiltin.js'
import { MAX_ROW_BYTES, PAGE_BYTES, PAGE_ROWS, oversizeRow, readStorePage, readStorePages, utf8Bytes, type StorePage } from './sqlitePage.js'
import { sqliteReadAll, type SqliteRow } from './sqliteRead.js'
import { enableOffThreadSqlite, resetOffThreadSqlite } from './sqliteThread.js'

// The real reads, seen, with a seam to make one of them go unanswered, as the engine specs have.
vi.mock('./sqliteRead.js', async (real) => {
  const actual = await real<typeof import('./sqliteRead.js')>()
  return { ...actual, sqliteReadAll: vi.fn(actual.sqliteReadAll) }
})

const LIMIT = MAX_ROW_BYTES + PAGE_ROWS * 70 // page_n, page_more, page_big, seq, body: 30 letters and 5 × 8
const seqs = (rows: SqliteRow[]): unknown[] => rows.map((row) => row.seq)
const hasSqlite = (() => { try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()
const cli = hasSqlite ? it : it.skip

// Only the read threads enforce a reply limit, so they are on (#4188: a read refused for its size was refused on
// every poll). The store is built with the binding: the sqlite3 CLI cannot take megabytes on a command line.
const withBuiltin = builtinSqlite() ? describe : describe.skip

withBuiltin('a store page bounded by bytes', () => {
  let dir = ''
  let db = ''
  let w: DatabaseLike
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-page-'))
    db = join(dir, 'store.db')
    w = new (builtinSqlite()!)(db, { readOnly: false })
    // As the engines' stores are: in the older journal mode a reader in the middle of a large page would fail the
    // writer's next commit with `database is locked`, now and then.
    w.exec('PRAGMA journal_mode = WAL')
    w.exec(`CREATE TABLE ev (session_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT, PRIMARY KEY (session_id, seq));
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX part_message_id_id_idx ON part (message_id, id);`)
    vi.mocked(sqliteReadAll).mockClear()
    enableOffThreadSqlite()
  })
  afterEach(async () => {
    overrideBuiltinSqlite(undefined)
    await resetOffThreadSqlite()
    closeSqliteHandles()
    w.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const put = (session: string, seq: number, body: string | null): void => { w.prepare('INSERT INTO ev VALUES (?, ?, ?)').all(session, seq, body) }
  const events = (session: string): StorePage => ({ table: 'ev', where: 't.session_id = ?', params: [session],
    key: [{ as: 'seq', sql: 't.seq' }], columns: [{ as: 'body', sql: 't.body' }] })
  const units: StorePage = { table: 'message', where: 't.session_id = ?', params: ['s'],
    key: [{ as: 'mtc', sql: 't.time_created' }, { as: 'mid', sql: 't.id' }], columns: [{ as: 'mdata', sql: 't.data' }],
    parts: { table: 'part', on: 'p.message_id = t.id', order: ['ptc', 'pid'],
      columns: [{ as: 'ptc', sql: 'p.time_created' }, { as: 'pid', sql: 'p.id' }, { as: 'pdata', sql: 'p.data' }] } }

  it('reads a table whole across pages, in key order, each within its budget', async () => {
    for (let i = 0; i < 30; i++) { put('w1', i, 'x'.repeat(500 * KIB)); put('other', i, 'OTHER') }
    expect(utf8Bytes('t.body')).toBe('octet_length(t.body)')
    const read = await readStorePages(db, events('w1'))
    expect(read.ok && seqs(read.rows)).toEqual(Array.from({ length: 30 }, (_, i) => i))
    expect(read.ok && read.rows.some((row) => row.body === 'OTHER')).toBe(false)
    const reads = await pageReads(vi.mocked(sqliteReadAll))
    expect(reads.map((seen) => seen.rows.length)).toEqual([8, 8, 8, 6])
    expect(reads.every((seen) => seen.ok && seen.maxBuffer === LIMIT && seen.bytes <= LIMIT && withinBudget(seen))).toBe(true)
    expect(await readStorePage(db, events('w1'), null)).toMatchObject({ ok: true, full: true, last: [7] })
    const tail = await readStorePage(db, events('w1'), [23])
    expect(tail).toMatchObject({ ok: true, full: false, last: [29] })
    expect(tail.ok && seqs(tail.rows)).toEqual([24, 25, 26, 27, 28, 29])
  })

  it('reads a row over the page budget alone, and returns one over the row cap as its key and nothing else', async () => {
    put('w1', 0, 'a'); put('w1', 1, 'b'.repeat(6 * MIB)); put('w1', 2, 'c'.repeat(33 * MIB)); put('w1', 3, 'tail')
    const read = await readStorePages(db, events('w1'))
    expect(read.ok && read.rows.map((row) => [row.seq, Number(row.page_big), typeof row.body === 'string' ? row.body.length : row.body]))
      .toEqual([[0, 0, 1], [1, 0, 6 * MIB], [2, 1, null], [3, 0, 4]])
    const reads = await pageReads(vi.mocked(sqliteReadAll))
    expect(reads.map((seen) => seen.rows.length)).toEqual([1, 1, 1, 1])
    expect(reads[1].bytes).toBeGreaterThan(PAGE_BYTES)
    expect(reads[2].bytes).toBeLessThan(KIB)
    expect(reads.every((seen) => seen.ok && seen.bytes <= seen.maxBuffer)).toBe(true)
  })

  it('ends a page at 500 rows, ends a read on an empty page, and pages rows that weigh nothing by count', async () => {
    for (let i = 0; i < 500; i++) put('exact', i, 'e')
    for (let i = 0; i < 1201; i++) put('nulls', i, null)
    expect(await readStorePage(db, events('exact'), null)).toMatchObject({ ok: true, full: true, last: [499] })
    expect(await readStorePage(db, events('exact'), [499])).toEqual({ ok: true, rows: [], full: false, last: null })
    expect(await readStorePage(db, events('nobody'), null)).toEqual({ ok: true, rows: [], full: false, last: null })
    vi.mocked(sqliteReadAll).mockClear()
    const nulls = await readStorePages(db, events('nulls'))
    expect(nulls.ok && nulls.rows.length).toBe(1201)
    expect((await pageReads(vi.mocked(sqliteReadAll))).map((seen) => seen.rows.length)).toEqual([500, 500, 201])
  })

  it('reads a message with its parts as one unit: its data once, its parts in order, never split', async () => {
    const id = (m: number): string => `m${String(m).padStart(3, '0')}`
    const message = (mid: string, tc: number, data: string): void => { w.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').all(mid, 's', tc, data) }
    const part = (pid: string, mid: string, tc: number, data: string): void => { w.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').all(pid, mid, tc, data) }
    for (let m = 0; m < 40; m++) {
      message(id(m), 100 + (m >> 2), `{"n":${m}}`) // four messages share each time_created
      // Part ids run against time_created: only (time_created, id) orders them.
      for (let p = 0; p < 5; p++) part(`p${m}_${9 - p}`, id(m), p, m === 20 && p === 2 ? 'B'.repeat(5 * MIB) : 'x'.repeat(300 * KIB))
    }
    message('m900', 900, '{"parts":"none"}')
    message('m901', 901, '{"n":901}'); part('huge', 'm901', 0, 'H'.repeat(33 * MIB))
    message('m902', 902, '{"tail":true}')
    const read = await readStorePages(db, units)
    const got: Array<{ id: unknown; big: number; data: unknown; parts: unknown[] }> = []
    for (const row of read.ok ? read.rows : []) {
      if (Number(row.page_part) === 0) got.push({ id: row.mid, big: Number(row.page_big), data: row.mdata, parts: [] })
      else { expect(row.mdata).toBeNull(); expect(row.mid).toBe(got[got.length - 1].id); got[got.length - 1].parts.push(row.pid) }
    }
    expect(got.map((m) => m.id)).toEqual([...Array.from({ length: 40 }, (_, m) => id(m)), 'm900', 'm901', 'm902'])
    got.slice(0, 40).forEach((m, i) => expect(m).toEqual({ id: id(i), big: 0, data: `{"n":${i}}`, parts: [9, 8, 7, 6, 5].map((n) => `p${i}_${n}`) }))
    expect(got.slice(40)).toEqual([{ id: 'm900', big: 0, data: '{"parts":"none"}', parts: [] },
      { id: 'm901', big: 1, data: null, parts: [] }, { id: 'm902', big: 0, data: '{"tail":true}', parts: [] }])
    const reads = await pageReads(vi.mocked(sqliteReadAll))
    expect(reads.length).toBeGreaterThan(10)
    expect(reads.every((seen) => seen.ok && seen.bytes <= seen.maxBuffer && withinBudget(seen))).toBe(true)
    // m020 to m023 share a time_created: a cursor between them neither repeats nor skips one.
    const resumed = await readStorePages(db, units, [105, 'm021'])
    expect(resumed.ok && resumed.rows.find((row) => Number(row.page_part) === 0)?.mid).toBe('m022')
  })

  it('hands two callers of the same page the same rows, in order, unchanged', async () => {
    for (let i = 0; i < 5; i++) put('w1', i, `row-${i}`)
    const [first, second] = await Promise.all([readStorePage(db, events('w1'), null), readStorePage(db, events('w1'), null)])
    expect(first).toEqual(second)
    expect(first.ok && first.rows.map((row) => [row.page_n, row.seq, row.body])).toEqual([0, 1, 2, 3, 4].map((i) => [i + 1, i, `row-${i}`]))
  })

  it('fails whole when a later page fails', async () => {
    for (let i = 0; i < 30; i++) put('w1', i, 'x'.repeat(500 * KIB))
    const actual = await vi.importActual<typeof import('./sqliteRead.js')>('./sqliteRead.js')
    vi.mocked(sqliteReadAll).mockImplementationOnce(actual.sqliteReadAll).mockResolvedValueOnce({ ok: false, reason: 'transient' })
    expect(await readStorePages(db, events('w1'))).toEqual({ ok: false, reason: 'transient' })
  })

  // Skipped where there is no sqlite3 CLI (Linux CI, Windows), as the engine specs' CLI cases are. The escaped text is
  // small on purpose: the CLI takes 25 s to write 1 MiB of control characters as JSON, against a 5 s deadline.
  cli('reads the same pages through the sqlite3 CLI, sized in its own SQL, under six times the limit', async () => {
    const escaped = 'q"\\\n\u0001'.repeat(2000) // quotes, backslashes, newlines and a control character
    for (let i = 0; i < 12; i++) put('cli', i, 'x'.repeat(500 * KIB))
    put('cli', 12, escaped); put('cli', 13, 'tail')
    overrideBuiltinSqlite(null)
    expect(utf8Bytes('t.body')).toBe('length(CAST(t.body AS BLOB))')
    const read = await readStorePages(db, events('cli'))
    expect(read.ok && seqs(read.rows)).toEqual(Array.from({ length: 14 }, (_, i) => i))
    expect(read.ok && read.rows.slice(12).map((row) => row.body)).toEqual([escaped, 'tail'])
    const reads = await pageReads(vi.mocked(sqliteReadAll))
    expect(reads.map((seen) => seen.rows.length)).toEqual([8, 6])
    expect(reads.every((seen) => seen.ok && seen.maxBuffer === 6 * LIMIT && seen.sql.includes('length(CAST(') && !seen.sql.includes('octet_length'))).toBe(true)
  })

  it('says an oversize row once, by a short session id and its key', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    oversizeRow('hermes', '20260727_162325_e25264', 'id 7'); oversizeRow('hermes', '20260727_162325_e25264', 'id 7')
    oversizeRow('hermes', '20260727_162325_e25264', 'id 8')
    expect(said.mock.calls).toEqual([['[hermes] 20260727 id 7 unreadable · too big'], ['[hermes] 20260727 id 8 unreadable · too big']])
  })
})
