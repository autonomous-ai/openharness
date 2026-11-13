# Store readers page by bytes Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3** (wave by wave; each task commits its failing
> test, then the code). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every read of conversation rows from an engine's SQLite store (OpenClaw, OpenCode 1 and 2, Kilo, Hermes,
Devin, and the session checkpoint) is a page bounded by bytes as well as rows, under a reply limit derived from that
bound, so no read is refused for its size and no reader sticks on a row or a page (#4188).

**Architecture:** One helper, `cli/src/lib/sqlitePage.ts`, builds and runs a byte-bounded page from a short
declaration (table, scope, key, columns): one SQL statement sizes up to 500 rows without reading their payloads, keeps
the rows that fit 4 MiB (the first always), and joins back for the payloads of those rows alone. Each reader declares
its page and loops it; the callers of the readers do not change. A row over 32 MiB comes back as its key and a flag:
a reader steps past it and says so once, the checkpoint fails.

**Tech Stack:** TypeScript (`cli/src/lib`, `cli/src/engines`), SQL through `sqliteReadAll` (`node:sqlite` on the
caller's thread or the core's read threads, or the `sqlite3` CLI), vitest.

**Spec:** [docs/plans/2026-11-12-reader-pages-design.md](2026-11-12-reader-pages-design.md). Read it with this plan,
and `AGENTS.md`, `cli/AGENTS.md`. The spec is the authority, its "(my call)" decisions and its "Constraints from the
builder check" included.

## Global Constraints

- One set of constants, in `cli/src/lib/sqlitePage.ts` and nowhere else: `PAGE_BYTES = 4 * 1024 * 1024` (the spec's
  `B`), `MAX_ROW_BYTES = 32 * 1024 * 1024` (`R`), `PAGE_ROWS = 500` (`N`, for every store). The four
  `MAX_BUFFER = 32 * 1024 * 1024` in the engine readers, and OpenClaw's `PAGE` and `MAX_PAGE_BYTES`, are removed.
- One paging rule: a conversation read is `readStorePage` or `readStorePages`. No reader writes its own `LIMIT`,
  size sum or reply limit.
- A row (a message with its parts, for OpenCode 1 and Kilo) over `PAGE_BYTES` is read alone on its page. One over
  `MAX_ROW_BYTES` is never read: a reader leaves it out and says one line,
  `[<engine>] <short session id> seq|id <key> unreadable · too big`; the checkpoint fails with its existing error.
  No stub in the transcript.
- A load that fails on any page returns what it returns today for a store that did not answer (`null`, then `[]` or
  `transient`), never the pages already read.
- No row content, path or whole session id in a log line, error or measure. No new metric.
- Callers do not change: `core/transcripts/history.ts`, `core/transcripts/lastTurn.ts`, `lib/databaseHistory.ts`,
  `lib/sessionSearch/externals/*`, `lib/agentTokenUsage.ts`, every `inProcess.ts`. No file under `cli/src/core`,
  `cli/src/services` or `cli/src/harnessd` changes.
- The SQL runs wherever a read runs today. With the binding (any Node the package allows, `>= 22.15`, SQLite 3.46 or
  later) a size is `octet_length(x)`. On the `sqlite3` CLI fallback (which needs 3.33 for `-json`; window functions
  are 3.25) it is `length(CAST(x AS BLOB))`, and the reply limit is 6 times the binding's: the CLI writes its rows as
  JSON, where a control character becomes `\u00XX`. The CLI's own speed is not this change's (the spec's non-goals):
  see "Known limit" in the self-review.
- Platforms: macOS, Linux, Windows. TypeScript and SQL only: no native code, dependency, switch or setting.
- Tests build throwaway stores in a temporary folder. Never a real engine store, the real daemon, or a fixed sleep.
- Comments say why, with the measurement (the table below) or the incident (#4188, #4065, #4066).
- Commands run from `cli/` on Node 24 (CI's is 24.22.2; Node 23.11 has no fts5, which the OpenClaw fixtures need).
  This worktree has no `cli/node_modules`: `npm ci` once.

Measured for this plan on a throwaway store (2026-11-12, this Mac, SQLite 3.49, rows of 256 KiB; a prototype of the
statement in Task 1). They decide the statement's shape, and belong in its comments:

| What | Result |
|---|---|
| Sizing 500 rows with `octet_length(col)` | 0.16 ms: it reads no payload |
| Sizing 500 rows with `length(CAST(col AS BLOB))` | 19.9 ms: it reads every row |
| A 4 MiB page, no `ORDER BY` on the payload rows | 1.7 ms (the same 16 rows read plainly: 1.6 ms) |
| The same page with `ORDER BY` | 11.3 ms: the sort copies the payload |
| A 46 MiB OpenCode 1 session, one unpaged read | 74 to 78 ms (a 58 MiB reply) |
| The same session in 13 pages, ordered in JS | 119 to 128 ms (ordered in SQL: 181 to 188 ms) |
| A 20,000-row Hermes session, one read against 40 pages | 70 ms against 84 to 92 ms |
| The `sqlite3` CLI (3.51) writing one text as JSON: 4 MiB of letters | 19 ms |
| The same CLI: 64 KiB, 256 KiB, 1 MiB of control characters | 0.1 s, 1.6 s, 25 s: four times the text, sixteen times the time |
| The same CLI: 256 KiB of `"` | 41 s |

## Review Focus

Inputs the spec implies and its own test list does not name, most likely first. Each is pinned by a test in the task
that owns the code.

1. **Row after row with no payload** (Hermes `content` NULL on a tool call, OpenClaw's hidden rows). A NULL size
   must count as 0: a NULL running total would keep one row a page. Expected: such rows page by count. Tasks 1, 6.
2. **Two units with the same leading key on either side of a page cut** (OpenCode messages of one millisecond,
   OpenCode 2 rows sharing `time_created`). Expected: none read twice, none skipped. Tasks 1, 4.
3. **The same page asked for twice at once** (a poll and a history load: the read threads hand both the same rows).
   Expected: neither changes the rows or their order for the other. Task 1.
4. **Exactly 500 rows left, or none.** Expected: one more, empty, page ends the read. Task 1.
5. **Text that grows when the CLI escapes it** (quotes and control characters in a tool's output). Expected: the
   limit never refuses such a page on the `sqlite3` CLI path. Task 1 pins the limit (six times) and a page with
   escaped text; it cannot pin megabytes of it, which the CLI itself does not write inside its deadline (below).

## Files

| File | What changes | Task |
|---|---|---|
| `cli/src/lib/sqlitePage.ts` (new), `sqlitePage.spec.ts` (new), `cli/src/testing/storePages.ts` (new) | the paging rule, its constants, the once-only line, the spec helper | 1 |
| `cli/scripts/benchmark-store-pages.ts` (new) | the before and after numbers | 2 |
| `cli/src/engines/openclaw/reader.ts`, `reader.spec.ts`, `contract.ts`, `contract.spec.ts` | events, ids and the borrowed header page by bytes; `event_utf8_bytes` | 3 |
| `cli/src/engines/opencode/reader.ts`, `reader.spec.ts` | OpenCode 2 rows and OpenCode 1 messages page by bytes | 4 |
| `cli/src/engines/kilo/reader.ts`, `reader.spec.ts` | messages page by bytes | 5 |
| `cli/src/engines/hermes/reader.ts`, `reader.spec.ts` | messages page by bytes | 6 |
| `cli/src/engines/devin/reader.ts`, `reader.spec.ts` | message nodes page by bytes | 7 |
| `cli/src/lib/sessionCheckpoint.ts`, `sessionCheckpoint.spec.ts`, `sessionCheckpoint.sqlite.spec.ts` | conversation tables read in pages | 8 |

## Waves

A wave's tasks depend on nothing in the same wave and share no file, tests included.

| Wave | Tasks |
|---|---|
| 1 | 1 The paging rule · 2 Benchmark script |
| 2 | 3 OpenClaw · 4 OpenCode · 5 Kilo · 6 Hermes · 7 Devin · 8 Session checkpoint |
| 3 | 9 Gates |

The Verification section at the end is run after wave 3, on the final head.

## Test conventions (Tasks 1 and 3 to 8)

- A paging spec turns the read threads on: only that path enforces a reply limit. `enableOffThreadSqlite()` in
  `beforeEach`, and in `afterEach` `await resetOffThreadSqlite(); closeSqliteHandles()`, then close the writer and
  remove the folder (`rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })`).
- It builds its store with the binding (`new (builtinSqlite()!)(path, { readOnly: false })`, rows through
  `db.prepare(sql).all(...values)`), in a `describe` guarded by `builtinSqlite() ? describe : describe.skip`. The
  `sqlite3` CLI the older cases use is not on Linux CI and cannot take megabytes on a command line.
- The store is in WAL, as the engines' stores are: `PRAGMA journal_mode = WAL` on the writer before its first row.
  The writer has no busy timeout, and in the older journal mode a reader in the middle of a large page would fail
  its commit with `database is locked`, now and then.
- It sees the reads through the spy the engine specs already have (`vi.mock('../../lib/sqliteRead.js', …)` with
  `sqliteReadAll: vi.fn(actual.sqliteReadAll)`; `sqlitePage.ts` imports the same module, so its reads are seen),
  cleared in `beforeEach` (`vi.mocked(sqliteReadAll).mockClear()`), and reads them with Task 1's helper:

```ts
import { KIB, MIB, pageReads, withinBudget } from '../../testing/storePages.js' // '../testing/…' from src/lib
const reads = await pageReads(vi.mocked(sqliteReadAll))
expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
```

- "Red" below means against the base (`origin/main`), where no statement is a page and a read over 32 MiB is refused.

---

### Task 1: The paging rule

**Depends on:** nothing. **Effort:** xhigh.
**Fails first:** every case of `sqlitePage.spec.ts` (the module is not there).

**Files:**
- Create: `cli/src/lib/sqlitePage.ts`, `cli/src/lib/sqlitePage.spec.ts`, `cli/src/testing/storePages.ts`

**Interfaces (produces):**

```ts
// cli/src/lib/sqlitePage.ts
export const PAGE_BYTES = 4 * 1024 * 1024
export const MAX_ROW_BYTES = 32 * 1024 * 1024
export const PAGE_ROWS = 500

/** One value a row returns: `sql` on the page's table `t` (a part's, on `p`), under the name `as`. */
export interface PageColumn { as: string; sql: string }

export interface StorePage {
  /** The table whose rows are paged. The statement calls it `t`; it must be a rowid table. */
  table: string
  /** Which of its rows, as SQL with its `?` bound from `params`: the scope, never the cursor. */
  where: string
  params: SqliteParam[]
  /** The cursor, in order: unique within the scope, a number or a short id. Returned on every row. */
  key: PageColumn[]
  /** What else a row returns. NULL, every one, on a row over MAX_ROW_BYTES. */
  columns: PageColumn[]
  /** A row's size in bytes, as SQL on `t`, when it is not the bytes of its key and columns. */
  size?: string
  /** A row's child rows, read with it as one unit (a message's parts): `on` joins `p` to `t`; `order` names the
   *  part columns that order them. */
  parts?: { table: string; on: string; order: string[]; columns: PageColumn[] }
}

type Unanswered = Extract<SqliteReadResult, { ok: false }>
export type StorePageRead = { ok: true; rows: SqliteRow[]; full: boolean; last: SqliteParam[] | null } | Unanswered

/** The byte length of a text or blob as SQL: `octet_length(sql)` with the binding, `length(CAST(sql AS BLOB))` on the CLI. */
export function utf8Bytes(sql: string): string
/** One page after `after` (the key of the last row read; null from the start). */
export function readStorePage(db: string, page: StorePage, after: SqliteParam[] | null): Promise<StorePageRead>
/** Every page from `after` until one is not full. A page that fails is the answer: no rows. */
export function readStorePages(db: string, page: StorePage, after?: SqliteParam[] | null): Promise<{ ok: true; rows: SqliteRow[] } | Unanswered>
/** Says once that a row was stepped past for its size. */
export function oversizeRow(engine: string, sessionId: string, key: string): void
```

```ts
// cli/src/testing/storePages.ts
export const KIB = 1024
export const MIB = 1024 * KIB
/** What rows weigh, as the read threads count a reply (lib/sqliteThread.ts): for each value its column's name, and a
 *  text's UTF-8 bytes, a blob's length, 8 for anything else. */
export function replyBytes(rows: readonly SqliteRow[]): number
export interface PageSeen { sql: string; maxBuffer: number; ok: boolean; rows: SqliteRow[]; units: number; bytes: number }
/** The page reads a spied `sqliteReadAll` made, in order: the calls whose SQL begins `WITH sized AS (`. `rows` is
 *  `[]` and `ok` false for one that was not answered; `units` is how many different `page_n` its rows carry. */
export function pageReads(spy: { mock: { calls: unknown[][]; results: Array<{ value: unknown }> } }): Promise<PageSeen[]>
/** A page kept to the budget: PAGE_BYTES and 256 bytes of names and numbers a row, or it holds one unit. */
export const withinBudget = (read: PageSeen): boolean => read.units <= 1 || read.bytes <= PAGE_BYTES + read.rows.length * 256
```

**The statement** (the signature and tests do not determine it). `{…}` are the declaration's parts; a key column `i`
is `k{i}` inside. Every `as` is written as a quoted identifier (`"…"`, a `"` doubled). Its text begins
`WITH sized AS (`.

```sql
WITH sized AS (
  SELECT t.rowid AS rid, {key[i].sql} AS k{i}…, coalesce({size}, 0) AS size
  FROM {table} t
  WHERE ({where}) [AND ({key[0].sql}, …) > (?, …)]          -- the cursor: only when `after` is not null
  ORDER BY {key[0].sql}, … LIMIT 500
), run AS (
  SELECT rid, size, sum(size) OVER (ORDER BY k0, … ROWS UNBOUNDED PRECEDING) AS total,
    row_number() OVER (ORDER BY k0, …) AS n, count(*) OVER () AS scanned
  FROM sized
), kept AS (
  SELECT rid, size, n, scanned, count(*) OVER () AS held FROM run WHERE n = 1 OR total <= 4194304
)
SELECT k.n AS page_n, (k.scanned = 500 OR k.held < k.scanned) AS page_more, k.size > 33554432 AS page_big,
  {key[i].sql} AS {key[i].as}…, CASE WHEN k.size > 33554432 THEN NULL ELSE ({column.sql}) END AS {column.as}…
FROM kept k CROSS JOIN {table} t ON t.rowid = k.rid
```

With `parts`, the first SELECT also returns `0 AS page_part` (after `page_big`) and `NULL AS {part.as}` for each part
column, and the statement goes on:

```sql
UNION ALL
SELECT k.n, (k.scanned = 500 OR k.held < k.scanned), 0, 1, {key[i].sql}…, NULL… /* one per column */, {part.sql}…
FROM kept k CROSS JOIN {table} t ON t.rowid = k.rid CROSS JOIN {parts.table} p ON {parts.on}
WHERE k.size <= 33554432
```

Rules, each with its reason for the comment:

- `{size}` is `page.size`, or the sum of `coalesce(utf8Bytes(c.sql), 0)` over the key and the columns. With `parts`
  it adds `coalesce((SELECT sum({fixed} + <the same sum over the key and the part columns>) FROM {parts.table} p
  WHERE {parts.on}), 0)`: a part row repeats the key and carries its own names, and the message's data is returned
  once, on its own row.
- `{fixed}` is the sum of `name.length + 8` over the names a row carries: `page_n`, `page_more`, `page_big`,
  `page_part` when there are parts, every key, column and part column `as`.
- The reply limit passed as `maxBuffer` is `(max(PAGE_BYTES, MAX_ROW_BYTES) + PAGE_ROWS * fixed) * (binding ? 1 : 6)`,
  `binding` being `builtinSqlite() !== null`, the test `sqliteReadAll` and `utf8Bytes` use too. No `busyTimeoutMs`
  or `timeoutMs` is passed: the defaults are the readers' own.
- Parameters are `[...page.params, ...(after ?? [])]`.
- The join back is by `rowid`: the key is unique only inside the scope. `CROSS JOIN` keeps SQLite's loop order, so
  only kept rows have their payload read.
- No `ORDER BY` on the payload rows (measured above). The helper orders a copy of the rows itself: by `page_n`,
  then `page_part`, then each `parts.order` column (NULL first, numbers by value, text by its UTF-8 bytes with
  `Buffer.compare`, as SQLite's default collation). It never changes the rows or the array a read returned: the read
  threads hand one answer to every caller that asked the same.
- `full` is the last row's `page_more`, false for no rows. `last` is the last row's key values, null for no rows.
- A row over the cap counts its whole size in the running total, so it sits alone on its page, as any row over the
  budget does.
- A size is bytes in the store's own encoding. These stores are UTF-8 (OpenClaw writes `event_utf8_bytes` only when
  its store is); the bound is not claimed for a UTF-16 store.
- `oversizeRow` writes `console.error(`[${engine}] ${sid(sessionId)} ${key} unreadable · too big`)` (`sid` from
  `lib/log.ts`) once per engine, session and key; it remembers 1,000 and forgets them all past that, as OpenClaw's
  `unreadable()` does.

- [ ] **Step 1: Write the failing spec**, `cli/src/lib/sqlitePage.spec.ts`. Spy on `./sqliteRead.js` as the engine
  specs do. One store per test, the read threads on, as in Test conventions:

```ts
w.exec(`CREATE TABLE ev (session_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT, PRIMARY KEY (session_id, seq));
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX part_message_id_id_idx ON part (message_id, id);`)
const put = (session: string, seq: number, body: string | null): void => { w.prepare('INSERT INTO ev VALUES (?, ?, ?)').all(session, seq, body) }
const events = (session: string): StorePage => ({ table: 'ev', where: 't.session_id = ?', params: [session],
  key: [{ as: 'seq', sql: 't.seq' }], columns: [{ as: 'body', sql: 't.body' }] })
const units: StorePage = { table: 'message', where: 't.session_id = ?', params: ['s'],
  key: [{ as: 'mtc', sql: 't.time_created' }, { as: 'mid', sql: 't.id' }], columns: [{ as: 'mdata', sql: 't.data' }],
  parts: { table: 'part', on: 'p.message_id = t.id', order: ['ptc', 'pid'],
    columns: [{ as: 'ptc', sql: 'p.time_created' }, { as: 'pid', sql: 'p.id' }, { as: 'pdata', sql: 'p.data' }] } }
const LIMIT = MAX_ROW_BYTES + PAGE_ROWS * 70 // page_n, page_more, page_big, seq, body: 30 letters and 5 × 8
const seqs = (rows: SqliteRow[]): unknown[] => rows.map((row) => row.seq)
const hasSqlite = (() => { try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()
const cli = hasSqlite ? it : it.skip

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
  overrideBuiltinSqlite(null) // afterEach: overrideBuiltinSqlite(undefined)
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
```

- [ ] **Step 2:** `npx vitest run src/lib/sqlitePage.spec.ts` → FAIL (`./sqlitePage.js` and
  `../testing/storePages.js` do not exist). Commit: `CLI store readers: a page bounded by bytes (red)`.
- [ ] **Step 3:** Write `cli/src/testing/storePages.ts` and `cli/src/lib/sqlitePage.ts` to the Interfaces, the
  statement and the rules above. Its file comment says what #4188 was (a read refused for its size is refused on every
  poll) and carries the measurements.
- [ ] **Step 4:** `npx vitest run src/lib/sqlitePage.spec.ts src/lib/sqliteThread.spec.ts src/lib/sqliteRead.spec.ts`
  → PASS. `npm run typecheck` → no errors. Commit: `CLI store readers: a page bounded by bytes`.

### Task 2: Benchmark script

**Depends on:** nothing (it calls only what the base already exports). **Effort:** medium.

**Files:**
- Create: `cli/scripts/benchmark-store-pages.ts`

**Test that fails first:** none: a measurement script, not product code. Its red is its own output on the base tree
(Verification, check 1): the OpenCode session is `refused` on the read threads, and the largest OpenClaw reply is
over `4 MiB`.

**Interfaces (produces):** `node --import tsx scripts/benchmark-store-pages.ts [--src <the cli/src of a tree>] [output.json]`.
`--src` defaults to this tree's `src`; every module and fixture is loaded from it by dynamic import, so the same
script measures the base. It follows `scripts/benchmark-stopped-catalog.ts` (synthetic data, a `mkdtempSync` folder
removed in `finally`, never a real store, no daemon).

- [ ] **Step 1: Write the script.** It:
  1. Builds, under one `mkdtempSync(join(tmpdir(), 'harness-store-pages-'))` folder, with the real binding:
     - an OpenClaw store from `engines/openclaw/__fixtures__/schema.sql` and `plain.sql`, then 4,000 plain rows
       appended to `agent:main:plain`'s window, seq 8 to 4007, each also in `session_transcript_active_events`
       (`active_position = 1000 + seq`): `{"type":"message","id":"b-<seq>","message":{"role":"user","content":…}}`,
       content of 2 MiB on every 100th row and 2 KiB on the others (about 88 MiB);
     - an OpenCode 1 store: the `message` and `part` tables and the indexes
       `message_session_time_created_id_idx (session_id, time_created, id)` and `part_message_id_id_idx (message_id, id)`
       as recorded in `lib/sessionSearch/externals/opencode.spec.ts`; session `ses_bench0001` with 2,000 messages
       (data of 600 bytes), 10 parts of 2 KiB each, one part of message 700 being 6 MiB (about 46 MiB; 58 MiB as one
       unpaged reply), and an empty `session_message` table, as a 1.x store has.
  2. Measures `readOpenclawHistory(db, 'agent:main:plain')` and `readOpencodeMessages(db, 'ses_bench0001')`, each
     - on the caller's thread, through a `DatabaseSync` subclass given to `overrideBuiltinSqlite` whose statements
       count every `all()` and weigh its rows as `lib/sqliteThread.ts` does: `reads`, `largestReplyBytes`, the
       events or messages returned, the median of 5 timed runs after one untimed;
     - on the read threads (`enableOffThreadSqlite()`, the override off): `read` with the count returned, or
       `refused` (OpenClaw throws; OpenCode returns no message), and the median of 5.
  3. Prints one line a store and path, and writes the same as JSON to `output.json` when given, with
     `process.version`, the SQLite version, `process.platform` and `process.arch`. Ends with
     `resetOffThreadSqlite()` and `closeSqliteHandles()`.
- [ ] **Step 2:** `node --import tsx scripts/benchmark-store-pages.ts` → on this tree at wave 1: OpenClaw `read`,
  4,005 events, its largest reply about 11 MiB; OpenCode `refused` on the read threads and 2,000 messages in one
  reply of about 58 MiB on the caller's thread. Commit: `CLI: a benchmark for the store readers' pages`.

### Task 3: OpenClaw

**Depends on:** Task 1. **Effort:** xhigh.
**Fails first:** the `pages by bytes` cases of `reader.spec.ts`, and the `event_utf8_bytes` line of `contract.spec.ts`.

**Files:**
- Modify: `cli/src/engines/openclaw/reader.ts`, `cli/src/engines/openclaw/contract.ts` (`OPENCLAW_COLUMNS`)
- Test: `cli/src/engines/openclaw/reader.spec.ts`, `cli/src/engines/openclaw/contract.spec.ts`

**Interfaces:**
- Consumes: `readStorePage`, `readStorePages`, `utf8Bytes`, `StorePage` (Task 1).
- Produces: nothing new. `readOpenclawHistory`, `readOpenclawSince`, `OpenclawReader` keep their signatures and what
  they return.

**What changes** (`reader.ts`; the first line is `contract.ts`):
- `OPENCLAW_COLUMNS.transcript_events` gains `'event_utf8_bytes'` (a store without it is `unsupported`).
- `HIDDEN_SQL` names its columns on `t` (`t.navigation_custom_type`, `t.navigation_json`). `rowsSql`, `LIVE_SQL`,
  `ACTIVE_SQL`, `IDS_SQL`, `NEWEST_HEADER_SQL`, `PAGE`, `MAX_PAGE_BYTES` go. In their place:

```ts
const eventsPage = (where: string, params: SqliteParam[]): StorePage => ({
  table: 'transcript_events', where, params, key: [{ as: 'seq', sql: 't.seq' }],
  columns: [{ as: 'hidden', sql: HIDDEN_SQL },
    { as: 'event_json', sql: `CASE WHEN ${HIDDEN_SQL} THEN NULL ELSE t.event_json END` },
    { as: 'event_zstd', sql: `CASE WHEN ${HIDDEN_SQL} THEN NULL ELSE t.event_zstd END` }],
  // A plain row weighs its text. A compressed one weighs what it inflates to, never less than its blob: the store's
  // CHECK bounds both at 4 MiB, and nothing ties event_utf8_bytes to a plain row's length.
  size: `CASE WHEN ${HIDDEN_SQL} THEN 0 ELSE coalesce(${utf8Bytes('t.event_json')}, max(coalesce(t.event_utf8_bytes, 0), length(t.event_zstd))) END`,
})
const LIVE = 't.session_id = ?'
const ACTIVE = 't.session_id = ? AND (t.seq = 0 OR EXISTS (SELECT 1 FROM session_transcript_active_events a WHERE a.session_id = t.session_id AND a.event_seq = t.seq))'
const idsPage = (windowId: string): StorePage => ({
  table: 'transcript_events', where: 't.session_id = ?', params: [windowId], key: [{ as: 'seq', sql: 't.seq' }],
  columns: [{ as: 'id', sql: "CASE WHEN json_valid(t.event_json) THEN json_extract(t.event_json, '$.id') WHEN json_valid(t.navigation_json) THEN json_extract(t.navigation_json, '$.navigation.id') END" }],
  // An id is part of one of these two texts: their length bounds it without parsing either twice.
  size: `coalesce(${utf8Bytes('t.event_json')}, 0) + coalesce(${utf8Bytes('t.navigation_json')}, 0)`,
})
const NEWEST_WINDOW_SQL = 'SELECT w.session_id AS window_id FROM session_windows w JOIN transcript_events e ON e.session_id = w.session_id AND e.seq = 0 ORDER BY w.updated_at DESC LIMIT 1'
```

- A page read fails as `query` does: `missing` before reading when this Node has no `node:sqlite` or zstd; otherwise
  `checked.delete(db)` and `OpenclawReadError('transient', errorCode(error))`.
- `query` passes no `maxBuffer`: `NODE_SQL`, `LAST_SEQ_SQL`, `PREVIOUS_SQL`, `COLUMNS_SQL`, `SCHEMA_SQL`,
  `COOKIE_SQL` and `NEWEST_WINDOW_SQL` return ids and numbers, and read under `sqliteReadAll`'s own default.
- `readPage(db, key, windowId, afterSeq, where)` reads `eventsPage(where, [windowId])` after `[afterSeq]`:
  `lastSeq` is the page's `last[0]` (null for no rows), `full` the page's. `readActive`, `readOpenclawSince` and
  `readLive` keep their loops, with `ACTIVE` and `LIVE`.
- `decode` first: a row whose `page_big` is set is `unreadable(key, windowId, seq, 'too big')` and null.
  `MAX_EVENT_BYTES` stays the inflate cap; its comment says it is the store's bound on a compressed row only, and
  that OpenClaw writes an event over 4 MiB as plain `event_json` with no bound.
- `history` collects a later window's ids with `readStorePages(db, idsPage(windowId))`.
- The borrowed header: the newest window's id with `NEWEST_WINDOW_SQL`, then
  `eventsPage('t.session_id = ? AND t.seq = 0', [windowId])` from the start; its row goes through `decode`, so a
  header over the cap is said once and not borrowed.

- [ ] **Step 1: Write the failing tests.** In `contract.spec.ts`, beside the `navigation_json` line:
  `expect(OPENCLAW_COLUMNS.transcript_events).toContain('event_utf8_bytes')`. In `reader.spec.ts`: add the
  `sqliteRead.js` spy (as `hermes/reader.spec.ts` has it; the file's `vi.restoreAllMocks()` restores `vi.spyOn` spies
  only, so the spy keeps reading for real) and a `describe('pages by bytes', …)` with the read threads on, using the
  file's `store`, `reader`, `windowOf`, `one`, `seqs`, `ids`:

```ts
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
```

- [ ] **Step 2:** `npx vitest run src/engines/openclaw/reader.spec.ts src/engines/openclaw/contract.spec.ts` → the
  new cases FAIL: no page reads (today's read is one 500-row page), seq 9 and the 33 MiB header are read, the column
  is not in the contract. Commit: `CLI OpenClaw reader: pages by bytes (red)`.
- [ ] **Step 3:** Implement "What changes". Fix the file comment where it speaks of the page.
- [ ] **Step 4:** `npx vitest run src/engines/openclaw src/core/transcripts/openclaw.spec.ts src/lib/agentTokenUsage.spec.ts src/lib/sessionSearch/externals/openclaw.spec.ts`
  → PASS, the older cases unchanged (the quiet-store case still counts at most 4 statements a read).
  `grep -n "MAX_PAGE_BYTES\|PAGE \* \|rowsSql" src/engines/openclaw/reader.ts` → nothing.
  Commit: `CLI OpenClaw reader: pages by bytes`.

### Task 4: OpenCode

**Depends on:** Task 1. **Effort:** xhigh.
**Fails first:** the two `OpencodeReader pages by bytes` blocks of `reader.spec.ts`.

**Files:**
- Modify: `cli/src/engines/opencode/reader.ts` (`readV2Messages`, `readLegacyMessages`, `MAX_BUFFER`)
- Test: `cli/src/engines/opencode/reader.spec.ts`

**Interfaces:**
- Consumes: `readStorePages`, `oversizeRow`, `StorePage` (Task 1).
- Produces: nothing new. `readOpencodeMessages` and `OpencodeReader` keep their signatures and results.

**What changes:**
- `readV2Messages` reads every page of

```ts
{ table: 'session_message', where: `t.session_id = ? AND t.type IN (${types})`, params: [sessionId],
  key: [{ as: 'mtc', sql: 't.time_created' }, { as: 'mseq', sql: 't.seq' }],
  columns: [{ as: 'mid', sql: 't.id' }, { as: 'mtype', sql: 't.type' }, { as: 'mdata', sql: 't.data' }] }
```

  after `[afterTimeCreated, afterSeq]` when `afterTimeCreated` is given, from the start otherwise. A row whose
  `page_big` is set is `oversizeRow('opencode', sessionId, `seq ${row.mseq}`)` and left out.
- `readLegacyMessages` reads every page of

```ts
{ table: 'message', where: 't.session_id = ?', params: [sessionId],
  key: [{ as: 'mtc', sql: 't.time_created' }, { as: 'mid', sql: 't.id' }], columns: [{ as: 'mdata', sql: 't.data' }],
  parts: { table: 'part', on: 'p.message_id = t.id', order: ['ptc', 'pid'],
    columns: [{ as: 'ptc', sql: 'p.time_created' }, { as: 'pid', sql: 'p.id' }, { as: 'pdata', sql: 'p.data' }] } }
```

  after `[Math.trunc(after.tc), after.id]` when today's `bounded` holds. A message's own row comes first and
  carries `mdata`; its part rows carry `mid`, `pid`, `pdata`, so today's grouping loop stands. A message whose
  `page_big` is set is `oversizeRow('opencode', sessionId, `id ${mid}`)` and left out.
- A failed read keeps today's handling: `missing` throws `OpencodeSqliteMissing`; in `readV2Messages`
  `/no such table/` is `[]`; anything else is `null`. `MAX_BUFFER` goes.

- [ ] **Step 1: Write the failing tests** in `reader.spec.ts`: two guarded `describe`s, the read threads on.

```ts
// 'OpencodeReader pages by bytes (OpenCode 1)': a 1.x store, whose session_message table is there and empty.
w.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);'
  + 'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);'
  + 'CREATE INDEX part_message_id_id_idx ON part (message_id, id);'
  + 'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);')
/** A message and its parts in one transaction: a poll never sees the message without them. */
const put = (mid: string, tc: number, role: string, parts: Array<Record<string, unknown>>): void => {
  w.exec('BEGIN')
  w.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').all(mid, SID, tc, JSON.stringify({ role }))
  parts.forEach((data, p) => w.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').all(`${mid}-p${p}`, mid, SID, tc * 10 + p, JSON.stringify(data)))
  w.exec('COMMIT')
}
const id = (n: number): string => `m${String(n).padStart(4, '0')}`
/** Turn i: a prompt, and a finished answer of `bytes`. */
const turn = (i: number, bytes: number): void => {
  put(id(2 * i), 2 * i, 'user', [{ type: 'text', text: `q${i}` }])
  put(id(2 * i + 1), 2 * i + 1, 'assistant', [{ type: 'text', text: 'x'.repeat(bytes) }, { type: 'step-finish', reason: 'stop' }])
}
const listen = (): { events: LiveEvent[]; reader: OpencodeReader } => {
  const events: LiveEvent[] = []
  return { events, reader: new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 20 }) }
}

it('reads a session larger than the row cap whole, a page at a time, and a reader seeds from it', async () => {
  for (let i = 0; i < 80; i++) turn(i, 500 * KIB) // 39 MiB
  const messages = await readOpencodeMessages(db, SID)
  expect(messages.map((m) => m.id)).toEqual(Array.from({ length: 160 }, (_, n) => id(n)))
  expect(messages[159].parts.map((p) => p.type)).toEqual(['text', 'step-finish'])
  expect(String(messages[159].parts[0].data.text)).toHaveLength(500 * KIB)
  const reads = await pageReads(vi.mocked(sqliteReadAll))
  expect(reads.length).toBeGreaterThan(9)
  expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
  expect((await readOpencodeMessages(db, SID, { tc: 157, id: id(157) })).map((m) => m.id)).toEqual([id(158), id(159)])
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

it('never splits a message from its parts, and reads its data once', async () => {
  turn(0, 10)
  put(id(2), 2, 'assistant', [0, 1, 2].map(() => ({ type: 'text', text: 'y'.repeat(2 * MIB) }))) // 6 MiB: over the budget
  turn(2, 10)
  const messages = await readOpencodeMessages(db, SID)
  expect(messages.map((m) => [m.id, m.parts.length])).toEqual([[id(0), 1], [id(1), 2], [id(2), 3], [id(4), 1], [id(5), 2]])
  const reads = await pageReads(vi.mocked(sqliteReadAll))
  const own = reads.find((read) => read.rows.some((row) => row.mid === id(2)))!
  expect(own.units).toBe(1)
  expect(own.rows.filter((row) => row.mdata !== null)).toHaveLength(1)
})

it('leaves out a message over the row cap, says so once, and reads on', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  turn(0, 10); put(id(2), 2, 'assistant', [{ type: 'text', text: 'z'.repeat(33 * MIB) }]); turn(2, 10)
  for (let n = 0; n < 2; n++) expect((await readOpencodeMessages(db, SID)).map((m) => m.id)).toEqual([id(0), id(1), id(4), id(5)])
  // A reader that polls over it does not stick: what comes after still arrives.
  const { events, reader } = listen()
  try {
    await reader.start()
    put(id(900), 900, 'user', [{ type: 'text', text: 'a new prompt' }])
    await vi.waitFor(() => expect(JSON.stringify(events)).toContain('a new prompt'), { timeout: 10_000, interval: 10 })
  } finally { reader.stop() }
  expect(error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('too big')))
    .toEqual([`[opencode] ses_test id ${id(2)} unreadable · too big`])
})

// #4065: a seed from the first pages alone would emit the rest as new on the next poll.
it('reads nothing when a later page fails, and seeds from the next whole read, replaying nothing', async () => {
  for (let i = 0; i < 12; i++) turn(i, 500 * KIB) // two pages
  const actual = await vi.importActual<typeof import('../../lib/sqliteRead.js')>('../../lib/sqliteRead.js')
  // The v2 read (no rows), the first page, then a second page the store does not answer.
  const fail = (): void => { vi.mocked(sqliteReadAll).mockImplementationOnce(actual.sqliteReadAll).mockImplementationOnce(actual.sqliteReadAll).mockResolvedValueOnce({ ok: false, reason: 'transient' }) }
  fail()
  expect(await readOpencodeMessages(db, SID)).toEqual([])
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
```

```ts
// 'OpencodeReader pages by bytes (OpenCode 2)': the store has session_message alone.
w.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)')
// Rows share a time_created in pairs: the seq orders them, and a page may end between the two.
const row = (seq: number, type: string, data: Record<string, unknown>): void => {
  w.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').all(`msg_${String(seq).padStart(4, '0')}`, SID, type, seq, seq >> 1, seq >> 1, JSON.stringify(data))
}
const answer = (bytes: number): Record<string, unknown> => ({ content: [{ type: 'text', text: 'x'.repeat(bytes) }], finish: 'stop', time: { created: 1 } })

it('reads an OpenCode 2 session larger than the row cap whole, in time_created then seq order', async () => {
  for (let i = 0; i < 80; i++) {
    row(3 * i + 1, 'user', { text: `q${i}`, time: { created: 1 }, files: [], agents: [] })
    row(3 * i + 2, 'assistant', answer(500 * KIB)); row(3 * i + 3, 'idle', { outcome: 'succeeded', time: { created: 1 } })
  }
  const messages = await readOpencodeMessages(db, SID)
  expect(messages.map((m) => m.seq)).toEqual(Array.from({ length: 240 }, (_, n) => n + 1))
  const reads = await pageReads(vi.mocked(sqliteReadAll))
  expect(reads.length).toBeGreaterThan(9)
  expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
  expect((await readOpencodeMessages(db, SID, { tc: 118, id: 'msg_0237', seq: 237 })).map((m) => m.seq)).toEqual([238, 239, 240])
})

it('leaves out an OpenCode 2 row over the row cap, says so once, and reads on', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  row(1, 'user', { text: 'q', time: { created: 1 }, files: [], agents: [] }); row(2, 'assistant', answer(33 * MIB))
  row(3, 'user', { text: 'next', time: { created: 1 }, files: [], agents: [] })
  for (let n = 0; n < 2; n++) expect((await readOpencodeMessages(db, SID)).map((m) => m.seq)).toEqual([1, 3])
  const events: LiveEvent[] = []
  const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 20 })
  try {
    await reader.start()
    row(4, 'user', { text: 'a new prompt', time: { created: 1 }, files: [], agents: [] })
    await vi.waitFor(() => expect(JSON.stringify(events)).toContain('a new prompt'), { timeout: 10_000, interval: 10 })
  } finally { reader.stop() }
  expect(error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('too big')))
    .toEqual(['[opencode] ses_test seq 2 unreadable · too big'])
})
```

- [ ] **Step 2:** `npx vitest run src/engines/opencode/reader.spec.ts` → the new cases FAIL (a session over 32 MiB
  reads as `[]`, the reader never seeds, no page reads). Commit: `CLI OpenCode reader: pages by bytes (red)`.
- [ ] **Step 3:** Implement "What changes".
- [ ] **Step 4:** `npx vitest run src/engines/opencode src/lib/sessionSearch/externals/opencode.spec.ts` → PASS, the
  older cases unchanged. Commit: `CLI OpenCode reader: pages by bytes`.

### Task 5: Kilo

**Depends on:** Task 1. **Effort:** high.
**Fails first:** the `KiloReader pages by bytes` block of `reader.spec.ts`.

**Files:**
- Modify: `cli/src/engines/kilo/reader.ts` (`loadKiloMessages`, `MAX_BUFFER`)
- Test: `cli/src/engines/kilo/reader.spec.ts`

**Interfaces:**
- Consumes: `readStorePages`, `oversizeRow`, `StorePage` (Task 1).
- Produces: nothing new. `readKiloMessages` and `KiloReader` keep their signatures and results.

**What changes:** `loadKiloMessages` reads every page of

```ts
{ table: 'message', where: 't.session_id = ?', params: [sessionId],
  key: [{ as: 'mtc', sql: 't.time_created' }, { as: 'mid', sql: 't.id' }], columns: [{ as: 'mdata', sql: 't.data' }],
  parts: { table: 'part', on: 'p.message_id = t.id', order: ['ptc', 'pid'],
    columns: [{ as: 'ptc', sql: 'p.time_created' }, { as: 'pid', sql: 'p.id' }, { as: 'pdata', sql: 'p.data' }] } }
```

after `[Math.trunc(after.tc), after.id]` when today's `bounded` holds. A message's own row comes first and carries
`mdata`; its part rows carry `mid`, `pid`, `pdata`, so today's grouping loop stands. A message whose `page_big` is
set is `oversizeRow('kilo', sessionId, `id ${mid}`)` and left out. A failed read: `missing` throws
`KiloSqliteMissing`, anything else is `null`. `MAX_BUFFER` goes.

- [ ] **Step 1: Write the failing tests** in `reader.spec.ts`: a guarded
  `describe('KiloReader pages by bytes', …)`, the read threads on, importing `readKiloMessages` too. The store's
  file is `path` here: `db` is this file's own CLI builder.

```ts
w.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);'
  + 'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);'
  + 'CREATE INDEX part_message_id_id_idx ON part (message_id, id);')
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
  put(id(160), 160, 'assistant', [0, 1, 2].map(() => ({ type: 'text', text: 'y'.repeat(2 * MIB) }))) // 6 MiB: over the budget
  const messages = await readKiloMessages(path, SESSION)
  expect(messages.map((m) => m.id)).toEqual(Array.from({ length: 161 }, (_, n) => id(n)))
  expect(messages[159].parts.map((p) => p.type)).toEqual(['text', 'step-finish'])
  expect(messages[160].parts).toHaveLength(3)
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
```

- [ ] **Step 2:** `npx vitest run src/engines/kilo/reader.spec.ts` → the new cases FAIL (`[]`, never seeds, no page
  reads). Commit: `CLI Kilo reader: pages by bytes (red)`.
- [ ] **Step 3:** Implement "What changes".
- [ ] **Step 4:** `npx vitest run src/engines/kilo` → PASS, the older cases unchanged. Commit:
  `CLI Kilo reader: pages by bytes`.

### Task 6: Hermes

**Depends on:** Task 1. **Effort:** high.
**Fails first:** the `HermesReader pages by bytes` block of `reader.spec.ts`.

**Files:**
- Modify: `cli/src/engines/hermes/reader.ts` (`loadHermesMessages`, `COLUMNS`, `MAX_BUFFER`)
- Test: `cli/src/engines/hermes/reader.spec.ts`

**Interfaces:**
- Consumes: `readStorePages`, `oversizeRow`, `StorePage` (Task 1).
- Produces: nothing new. `readHermesMessages` and `HermesReader` keep their signatures and results.

**What changes:** `loadHermesMessages` reads every page of

```ts
{ table: 'messages', where: 't.session_id = ?', params: [sessionId], key: [{ as: 'id', sql: 't.id' }],
  columns: ['role', 'content', 'tool_call_id', 'tool_calls', 'tool_name', 'finish_reason', 'reasoning'].map((name) => ({ as: name, sql: `t.${name}` })) }
```

after `[Math.trunc(afterId)]` when today's `bounded` holds. The columns are bare, so a size reads no payload; the
SQL `coalesce(content, '')` goes, since the mapping already reads a `content` that is not text as `''`. A row whose
`page_big` is set is `oversizeRow('hermes', sessionId, `id ${row.id}`)` and left out. A failed read: `missing`
throws `HermesSqliteMissing`, anything else is `null`. `COLUMNS` and `MAX_BUFFER` go.

- [ ] **Step 1: Write the failing tests** in `reader.spec.ts`: a guarded
  `describe('HermesReader pages by bytes', …)`, the read threads on.

```ts
w.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT,'
  + ' tool_calls TEXT, tool_name TEXT, finish_reason TEXT, reasoning TEXT, timestamp REAL)')
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
```

- [ ] **Step 2:** `npx vitest run src/engines/hermes/reader.spec.ts` → the new cases FAIL (`[]`, never seeds, no page
  reads). Commit: `CLI Hermes reader: pages by bytes (red)`.
- [ ] **Step 3:** Implement "What changes".
- [ ] **Step 4:** `npx vitest run src/engines/hermes src/lib/sessionSearch/externals/hermes.spec.ts` → PASS, the
  older cases unchanged. Commit: `CLI Hermes reader: pages by bytes`.

### Task 7: Devin

**Depends on:** Task 1. **Effort:** high.
**Fails first:** the `DevinReader pages by bytes` block of `reader.spec.ts`.

**Files:**
- Modify: `cli/src/engines/devin/reader.ts` (`loadDevinMessages`, `COLUMNS`, `MAX_BUFFER`)
- Test: `cli/src/engines/devin/reader.spec.ts`

**Interfaces:**
- Consumes: `readStorePages`, `oversizeRow`, `utf8Bytes`, `StorePage` (Task 1).
- Produces: nothing new. `readDevinMessages` and `DevinReader` keep their signatures and results.

**What changes:** `loadDevinMessages` reads every page of

```ts
// The role is read off the rows a page keeps, not in its scope: there it would parse every row the page sizes.
const shown = (sql: string): string => `CASE WHEN json_extract(t.chat_message, '$.role') <> 'system' THEN ${sql} END`
{ table: 'message_nodes', where: 't.session_id = ?', params: [sessionId], key: [{ as: 'row_id', sql: 't.row_id' }],
  columns: [/* today's eight extracts, on t.chat_message, each under its name and through shown(): message_id,
               role, content (with its coalesce), thinking, tool_calls, tool_call_id, finish_reason, created_at */],
  size: utf8Bytes('t.chat_message') }
```

after `[Math.trunc(afterRowId)]` when today's `bounded` holds. A system row, or one with no role, comes back with
every column NULL, and today's `if (!messageId …) continue` drops it; the `seen` set already spans the pages of one
call. A row is sized by its whole `chat_message`: the columns are disjoint parts of it. A row whose `page_big` is
set is `oversizeRow('devin', sessionId, `id ${row.row_id}`)` and left out. A failed read: `missing` throws
`DevinSqliteMissing`, anything else is `null`. `COLUMNS` and `MAX_BUFFER` go.

- [ ] **Step 1: Write the failing tests** in `reader.spec.ts`: a guarded
  `describe('DevinReader pages by bytes', …)`, the read threads on. `home` is made as the file's `fixture()` makes it (its
  `session_locks/<session>.lock` and its empty log included).

```ts
w.exec(`CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
  parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT)`)
const SESSION = 'tested-crabapple'
let nodes = 0
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
```

- [ ] **Step 2:** `npx vitest run src/engines/devin/reader.spec.ts` → the new cases FAIL (`[]`, never seeds, no page
  reads). Commit: `CLI Devin reader: pages by bytes (red)`.
- [ ] **Step 3:** Implement "What changes".
- [ ] **Step 4:** `npx vitest run src/engines/devin src/lib/sessionSearch/externals/devin.spec.ts` → PASS, the older
  cases unchanged. Commit: `CLI Devin reader: pages by bytes`.

### Task 8: Session checkpoint

**Depends on:** Task 1. **Effort:** xhigh.
**Fails first:** the three new cases of `sessionCheckpoint.sqlite.spec.ts`, and the rewritten export case of
`sessionCheckpoint.spec.ts`.

**Files:**
- Modify: `cli/src/lib/sessionCheckpoint.ts` (`databaseHistory`)
- Test: `cli/src/lib/sessionCheckpoint.sqlite.spec.ts`, `cli/src/lib/sessionCheckpoint.spec.ts`

**Interfaces:**
- Consumes: `readStorePages`, `utf8Bytes`, `StorePage`, `PageColumn` (Task 1).
- Produces: nothing new. `SessionCheckpointStore.save` keeps its signature, its error and the checkpoint's shape.

**What changes in `databaseHistory`:**
- A selection says whether it is a conversation table. Paged: `message`, `part`, `session_message`, `messages`,
  `message_nodes`, `transcript_events`. Single reads, as today: `session`, `sessions`, `session_v2`,
  `session_nodes`, `session_windows`, and the first-selection "exactly one row" check.
- A paged table is read so:
  1. `SELECT name, pk FROM pragma_table_xinfo(?) WHERE hidden <> 1 ORDER BY cid` with `[table]`: the columns
     `SELECT *` returns. Unanswered or no rows: the existing `SessionCheckpointError`.
  2. Its key is the columns whose `pk > 0`, in `pk` order; with none, `rowid` (`{ as: 'rowid', sql: 't.rowid' }`).
  3. Its page: `{ table, where, params: [s.sessionId], key, columns }`, each column
     `{ as: name, sql: 't."name"' }` (a `"` in a name doubled), the key's own columns left out of `columns`. The
     existing `where` strings stand as they are: their bare column names are the table's.
  4. `readStorePages(database, page)`. Unanswered, or any row whose `page_big` is set: the existing
     `SessionCheckpointError('Could not read the saved conversation. The session has not been closed.')`.
  5. The table's saved rows are, for each row read, an object of exactly the selected names in their order (so no
     `page_` name, and no `rowid` the table does not declare).
- OpenClaw's `transcript_events` selects `OPENCLAW_COLUMNS.transcript_events`, `event_zstd` as
  `{ as: 'event_zstd_hex', sql: 'hex(t.event_zstd)' }`, and gives the page its size: the sum over those columns of
  `coalesce(utf8Bytes('t.<column>'), 0)`, with `2 * coalesce(length(t.event_zstd), 0)` for `event_zstd` (hex is
  twice the blob; sizing `hex(…)` itself would read every blob).

- [ ] **Step 1: Write the failing tests.** In `sessionCheckpoint.sqlite.spec.ts` add the `sqliteRead.js` spy
  (`vi.mock('./sqliteRead.js', …)` as the engine specs have it; after `vi.resetModules()` a test reads the spy with
  `await import('./sqliteRead.js')`), and `await (await import('./sqliteThread.js')).resetOffThreadSqlite()` first in
  its `afterEach`. `directory` is `join(root, 'backups')`, made with mode `0o700` as the older cases make it:

```ts
const savedOf = (directory: string): { tables: Record<string, Array<Record<string, unknown>>> } => {
  const manifest = JSON.parse(readFileSync(join(directory, readdirSync(directory).find(f => f.endsWith('.json'))!), 'utf8'))
  return JSON.parse(readFileSync(join(directory, manifest.file), 'utf8'))
}
const table = { opencode: 'part', kilo: 'part', hermes: 'messages', devin: 'message_nodes' } as const
it.each(['opencode', 'kilo', 'hermes', 'devin'] as const)('backs up a %s conversation larger than the row cap, row for row', async engine => {
  // The file's schema for this engine, and in table[engine] 80 rows of 500 KiB for 'wanted' (for opencode and kilo:
  // 80 parts of message 'm1') beside one row for 'other' whose body is 'unrelated private text'.
  const { enableOffThreadSqlite } = await import('./sqliteThread.js')
  enableOffThreadSqlite()
  const { SessionCheckpointStore } = await import('./sessionCheckpoint.js')
  await new SessionCheckpointStore(directory).save({ agentId: 'fixture', sessionId: 'wanted', engine, hermesHome: root } as RegisteredSession)
  const saved = savedOf(directory)
  expect(saved.tables[table[engine]]).toHaveLength(80)
  expect(saved.tables[table[engine]].map((row) => Object.keys(row))).toEqual(Array.from({ length: 80 }, () => ['id', engine === 'opencode' || engine === 'kilo' ? 'message_id' : 'session_id', 'body']))
  expect(JSON.stringify(saved)).not.toContain('unrelated private text')
  const { sqliteReadAll } = await import('./sqliteRead.js')
  const reads = await pageReads(vi.mocked(sqliteReadAll))
  expect(reads.length).toBeGreaterThan(9)
  expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
})

it('fails on a row over the row cap instead of dropping it', async () => {
  // hermes; 'wanted' holds three messages, the second with a body of 33 MiB. The read threads stay off: today this
  // row is read and saved here.
  const { SessionCheckpointStore, SessionCheckpointError } = await import('./sessionCheckpoint.js')
  await expect(new SessionCheckpointStore(directory).save({ agentId: 'fixture', sessionId: 'wanted', engine: 'hermes', hermesHome: root } as RegisteredSession))
    .rejects.toBeInstanceOf(SessionCheckpointError)
  expect(readdirSync(directory)).toEqual([])
})

it('backs up an OpenClaw conversation larger than the row cap, a compressed row as hex and sized as hex', async () => {
  // <root>/agents/main/agent/openclaw-agent.sqlite from engines/openclaw/__fixtures__/schema.sql and plain.sql.
  // Appended to the key's window: seq 8 to 87, plain rows of 500 KiB (INSERT … (session_id, seq, event_json, created_at));
  // seq 100 to 103, compressed rows of 1.5 MiB of random bytes, which the checkpoint never inflates:
  //   INSERT INTO transcript_events (session_id, seq, created_at, event_zstd, event_utf8_bytes, navigation_json)
  //   SELECT session_id, ?, created_at, ?, ?, navigation_json FROM transcript_events WHERE session_id = ? AND seq = 5
  const { enableOffThreadSqlite } = await import('./sqliteThread.js')
  enableOffThreadSqlite()
  const { SessionCheckpointStore } = await import('./sessionCheckpoint.js')
  await new SessionCheckpointStore(directory).save({ agentId: 'fixture', sessionId: 'agent:main:plain', engine: 'openclaw', openclawStateDir: root } as RegisteredSession)
  const saved = savedOf(directory)
  const events = saved.tables.transcript_events
  expect(events.map((row) => row.seq)).toEqual([...Array.from({ length: 88 }, (_, i) => i), 100, 101, 102, 103])
  expect(events.slice(-4).map((row) => String(row.event_zstd_hex).length)).toEqual([3 * MIB, 3 * MIB, 3 * MIB, 3 * MIB])
  expect(events.some((row) => 'event_zstd' in row || 'page_n' in row)).toBe(false)
  expect(saved.tables.session_nodes).toHaveLength(1)
  const { sqliteReadAll } = await import('./sqliteRead.js')
  const reads = await pageReads(vi.mocked(sqliteReadAll))
  // Two of the compressed rows are 6 MiB as hex: sized by the blob they would share a page.
  expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
})
```

  In `sessionCheckpoint.spec.ts`, rewrite `exports %s through read-only SQLite, keeping the shared database intact`
  (it pinned one `SELECT *` a table, which this task replaces). Its mock answers by statement:

```ts
const sql = vi.mocked(sqliteReadAll).mockReset().mockImplementation(async (_db, query) => ({ ok: true, via: 'builtin', rows:
  query.includes('pragma_table_xinfo') ? [{ name: 'id', pk: 1 }, { name: 'message', pk: 0 }]
    : query.startsWith('WITH sized AS (') ? [{ page_n: 1, page_more: 0, page_big: 0, id: 'conversation', message: 'Stored in WAL' }]
      : [{ id: 'conversation', message: 'Stored in WAL' }] }))
await store.save(row)
const saved = JSON.parse(await readFile(join(directory, (await manifest()).file), 'utf8'))
expect(JSON.stringify(saved)).toContain('Stored in WAL')
expect(JSON.stringify(saved)).not.toContain('page_')
// OpenCode's two probes stay first and as they are. After them: the one-row table by SELECT *, each conversation
// table by its columns, then its pages; every read but the pragma's is of this conversation.
const calls = sql.mock.calls.slice(engine === 'opencode' ? 2 : 0).map(([, query, params]) => [query.split(' ').slice(0, 3).join(' '), params])
const paged = [['SELECT name, pk', [expect.any(String)]], ['WITH sized AS', ['conversation']]]
expect(calls).toEqual([['SELECT * FROM', ['conversation']], ...paged, ...(engine === 'kilo' ? paged : [])])
```

  (Kilo reads `message` and `part`. For `opencode` the mock's `session_v2` probe answers a row, so the session is
  read from `session_v2` and `session_message`: one paged table, as Hermes and Devin have.)

- [ ] **Step 2:** `npx vitest run src/lib/sessionCheckpoint.sqlite.spec.ts src/lib/sessionCheckpoint.spec.ts` → the
  new and rewritten cases FAIL (`Could not read` for 39 MiB, the 33 MiB row saved, no page reads). Commit:
  `CLI session checkpoint: conversation tables in pages (red)`.
- [ ] **Step 3:** Implement "What changes".
- [ ] **Step 4:** the same command → PASS, with the file's two older real-store cases unchanged (their tables key on
  `id`). `npx vitest run src/lib/closeAgentService.spec.ts src/lib/purgeAgentService.spec.ts` → PASS. Commit:
  `CLI session checkpoint: conversation tables in pages`.

### Task 9: Gates

**Depends on:** Tasks 1 to 8. **Effort:** medium. **Files:** none (a fix goes back to the task that owns the file).
**Test that fails first:** none: it runs the others.

- [ ] `npm run typecheck` → no errors.
- [ ] `npx vitest run src/lib/sqlitePage.spec.ts src/lib/sqliteRead.spec.ts src/lib/sqliteThread.spec.ts src/lib/sessionCheckpoint.spec.ts src/lib/sessionCheckpoint.sqlite.spec.ts src/lib/closeAgentService.spec.ts src/lib/purgeAgentService.spec.ts src/lib/agentTokenUsage.spec.ts src/lib/sessionSearch/externals src/engines/openclaw src/engines/opencode src/engines/kilo src/engines/hermes src/engines/devin src/engines/otherTranscripts.golden.spec.ts src/core/transcripts src/architecture.spec.ts src/leanEntry.spec.ts`
  → PASS on Node 24, on this Mac. `otherTranscripts.golden.spec.ts` passes with no recorded outcome changed: it
  runs every one of these engines' conversations through the core, live, history and last turn.
- [ ] `grep -rn "MAX_BUFFER\|MAX_PAGE_BYTES" src/engines/openclaw/reader.ts src/engines/opencode/reader.ts src/engines/kilo/reader.ts src/engines/hermes/reader.ts src/engines/devin/reader.ts`
  → nothing. `grep -rln "4 \* 1024 \* 1024\|32 \* 1024 \* 1024" src/lib/sqlitePage.ts src/engines/*/reader.ts`
  → `src/lib/sqlitePage.ts` and `src/engines/openclaw/reader.ts` (the inflate cap) alone.
- [ ] From the repository root: `python3 scripts/local-checks.py --list $(git diff --name-only origin/main...HEAD)`
  → `{}`. Anything else names a local check this plan did not expect: run it and record it.
- [ ] The pull request names the platforms (macOS, Linux, Windows), the red then green commit of each task, and the
  numbers of Verification check 1.

## Verification

Run on the final head, after Task 9.

**1. Before and after numbers** (the spec's "Numbers before and after"; `cli/AGENTS.md` rule 8).

- Where: this Mac, Node 24 first on `PATH`. No daemon, port, account or network. Both stores are synthetic, built
  by the script under a fresh `mkdtempSync` folder it removes; nothing is read from `~/.openclaw`, an OpenCode data
  folder, or any store an engine wrote.
- Run, from the repository root:

```bash
SCRATCH=$(mktemp -d)
BASE=$(git merge-base HEAD origin/main)
mkdir "$SCRATCH/base" && git archive "$BASE" cli/src cli/package.json | tar -x -C "$SCRATCH/base"
ln -s "$PWD/cli/node_modules" "$SCRATCH/base/cli/node_modules"
(cd cli && node --import tsx scripts/benchmark-store-pages.ts --src "$SCRATCH/base/cli/src" "$SCRATCH/before.json")
(cd cli && node --import tsx scripts/benchmark-store-pages.ts "$SCRATCH/after.json")
```

- What a person should see:

| Store | Path | Before (base) | After (head) |
|---|---|---|---|
| OpenClaw window, 4,005 events, about 88 MiB | caller's thread | largest reply about 11 MiB (a 500-row page) | largest reply at most 4 MiB and 64 KiB |
| | read threads | `read`, 4,005 events | `read`, 4,005 events |
| OpenCode 1 session, 2,000 messages, about 46 MiB | caller's thread | 2,000 messages in one reply of about 58 MiB | 2,000 messages; largest reply about 6.1 MiB (the message with the 6 MiB part, alone), every other at most 4 MiB and 64 KiB |
| | read threads | `refused`, 0 messages | `read`, 2,000 messages |

  The times are recorded, not gated. For scale, the prototype read the OpenCode-shaped session in 74 to 78 ms
  unpaged and 119 to 128 ms paged. Stop and report, rather than record, if the head run says `refused`, a reply over
  32 MiB and 64 KiB, a count that differs from the base's, or a time over three times the base's on the caller's
  thread.
- Evidence for the pull request: both JSON files' numbers as one table, with the Node and SQLite versions the script
  prints. Then `rm -rf "$SCRATCH"`.

**2. Local checks PR CI does not run:** none. No file under `cli/src/core`, `cli/src/services` or
`cli/src/harnessd` changes, so `npm run test:core` and `test:harnessd` have nothing new to cover, and
`scripts/local-checks.py --list` over this plan's files prints `{}` (checked 2026-11-12; Task 9 checks it again on
the real diff).

**3. End to end through a daemon:** none. No user-facing flow changes: the readers return what they returned, to
callers that do not change. The limit that caused #4188 lives in the read threads, which the specs turn on
themselves; the golden spec runs each engine's conversation through the core; and the end-to-end suite's fake
engines (Claude Code, Codex) keep no store.

**4. Platforms:** Linux by PR CI (`ci/required`); macOS by Task 9 on this Mac. Windows is not run for these files by
any automatic check (open question 2).

## Self-review

- **Spec coverage.** The paging rule, constants, reply limit, CLI allowance (Task 1). OpenClaw: events, `full`,
  the row over the cap through `unreadable()`, ids, the header, the other queries' limit, `event_utf8_bytes`, the
  comments (Task 3). OpenCode 2 by `(time_created, seq)` and OpenCode 1 by whole messages (Task 4), Kilo (5), Hermes
  by `id` (6), Devin by `row_id` with its dedupe across pages (7). The checkpoint, failing on a row over the cap,
  every column counted and hex at twice the blob (8). No partial loads (Tasks 1, 4 to 7). Each spec is red on the
  base. Numbers (Task 2, Verification 1).
- **Ruled where the spec left it to the builder:**
  1. One statement a page, with window functions: every SQLite a read can meet has them (the CLI path already needs
     3.33), and one statement sizes and reads from one snapshot, so the bound is exact.
  2. `octet_length` with the binding, `length(CAST(x AS BLOB))` on the CLI, by measurement (0.16 ms against 19.9 ms
     for 500 rows). On the CLI path a sized row is therefore read twice: slower on a session of very large rows, on
     a path the package's own Node floor never takes.
  3. `N` is 500 for every store, the ids pages and the checkpoint included: one count, and sizing 500 rows costs
     0.16 ms.
  4. The fixed allowance is the names a row carries plus 8 bytes a value, times 500; the CLI's limit is 6 times
     the whole.
  5. Rows are ordered in JS, not SQL (11.3 ms against 1.7 ms a page).
  6. A row over the cap counts its whole size, so it ends its page like any row over the budget.
  7. OpenClaw's size is the spec's, read with its constraint: a plain row by its text; a compressed row by
     `event_utf8_bytes`, never less than its blob.
  8. OpenClaw's small queries read under `sqliteReadAll`'s default limit (32 MiB), not a new constant: they return
     ids and numbers. The borrowed header is two reads (the newest window's id, then its header as an events page).
  9. The line's key: `seq <n>` for OpenClaw and OpenCode 2, `id <message id>` for OpenCode 1 and Kilo, `id <id>` for
     Hermes, `id <row_id>` for Devin.
  10. The checkpoint's key is the table's declared primary key (`rowid` when it has none), read with its columns
      from `pragma_table_xinfo`, so `SELECT *` keeps meaning every column of whatever version of the store.
  11. The benchmark is a script in `cli/scripts`, as the other benchmarks are.
- **Follows from the spec, worth knowing:**
  - The rule is one for every path. A process that reads on its own thread (search, handoff) had no limit, so it
    read a row over 32 MiB; it now steps past it, as the core does.
  - OpenClaw's checkpoint rows gain `event_utf8_bytes`: the checkpoint saves the columns the reader reads.
  - A Devin system row and a Hermes `content` are filtered and defaulted where they were, with the same result, but
    no longer in the scope's SQL.
- **Known limit, found while planning.** On the `sqlite3` CLI fallback a row can still stop a reader: the CLI writes
  escaped text as JSON slowly (measured above: control characters in time that grows with the square of their
  count, 25 s for 1 MiB; 41 s for 256 KiB of quotes, the one size measured), so a row holding a few hundred KiB of
  them passes the 5 s deadline on every poll, before this change and after it. Paging does not cure it, and the spec
  keeps the CLI path's behavior out of scope; it is `sqliteRead.ts`'s own recorded reason for the binding. The path
  is taken only when a daemon's Node has no `node:sqlite`, which the package's Node floor (22.15) always has.
- **Open questions** (neither blocks the build; the plan's default is stated):
  1. The numbers are taken on this Mac. Should they also be taken on the lamp's ARM64 Linux box, and if so which
     box and how is it reached? Default: this Mac only; the reply sizes do not depend on the machine.
  2. Windows: the spec says CI runs the unit suites on all three platforms, but PR CI is Linux and the Windows
     workflow runs a fixed list that has none of these specs. Run the new specs once on the Windows test machine, or
     accept Linux and macOS for a change with no process, path or native code? Default: Linux and macOS.
