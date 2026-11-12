/**
 * A page of a store's conversation rows, bounded by bytes as well as rows: the one way every reader of an engine's
 * SQLite store (OpenClaw, OpenCode, Kilo, Hermes, Devin) and the session checkpoint reads its rows.
 *
 * #4188: the core reads a store on its read threads (sqliteThread.ts), which refuse a reply past the read's
 * `maxBuffer` as `transient`, and a reader asks a `transient` read again on the next poll. So a read refused for its
 * size was refused on every poll, for good: OpenCode, Kilo, Hermes and Devin read a whole session in one query
 * against 32 MiB, and a session past it never seeded and its history never loaded. Here a page holds at most
 * PAGE_ROWS rows, taken while their sizes add up to PAGE_BYTES (the first always, so the cursor always moves), and its
 * reply limit is derived from those same bounds, so no page is refused for its size. A row past MAX_ROW_BYTES comes
 * back as its key and `page_big`, with no payload: a reader steps past it, the checkpoint fails.
 *
 * One statement sizes the rows, cuts the page and reads it, from one snapshot. Measured on a throwaway store
 * (2026-11-12, SQLite 3.49, rows of 256 KiB):
 *  - sizing 500 rows with `octet_length` reads no payload: 0.16 ms. `length(CAST(x AS BLOB))` reads every row:
 *    19.9 ms. The `sqlite3` CLI may be older than `octet_length` (3.43), so it gets the second.
 *  - a 4 MiB page with no `ORDER BY` on its payload rows: 1.7 ms, as the same rows read plainly. With it: 11.3 ms, the
 *    sort copies the payload. The rows are put in order here instead.
 *  - a 46 MiB OpenCode session: one unpaged read 74 to 78 ms, 13 pages ordered here 119 to 128 ms (ordered in SQL,
 *    181 to 188 ms). A 20,000-row Hermes session: one read 70 ms, 40 pages 84 to 92 ms.
 *  - the `sqlite3` CLI writes its rows as JSON, where a control character becomes `\u00XX`: six bytes for one.
 */
import { sid } from './log.js'
import { builtinSqlite } from './sqliteBuiltin.js'
import { sqliteReadAll, type SqliteParam, type SqliteReadResult, type SqliteRow } from './sqliteRead.js'

/** A page's budget: the rows it keeps add up to at most this, unless its first row alone is larger. */
export const PAGE_BYTES = 4 * 1024 * 1024
/** A row past this is never read. The whole-read limit before #4188, so no row shown then is dropped (OpenCode rows
 *  of 7.5 MB are on record, sqliteRead.ts). */
export const MAX_ROW_BYTES = 32 * 1024 * 1024
/** Rows a page sizes at most: sizing 500 costs 0.16 ms, and their names and numbers stay small next to PAGE_BYTES. */
export const PAGE_ROWS = 500
/** The CLI's JSON writes a control character as `\u00XX`: a reply up to six times the rows' own bytes. */
const CLI_ESCAPE = 6

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
export function utf8Bytes(sql: string): string {
  return builtinSqlite() ? `octet_length(${sql})` : `length(CAST(${sql} AS BLOB))`
}

const quoted = (as: string): string => `"${as.replace(/"/g, '""')}"`
const sizeOf = (columns: PageColumn[]): string => columns.map((column) => `coalesce(${utf8Bytes(column.sql)}, 0)`).join(' + ')

/**
 * The page's statement, and the bytes a row's names and numbers can add to its reply: each name a row carries, and 8
 * for each value, as the read threads count a number or a NULL.
 */
function statement(page: StorePage, cursor: boolean): { sql: string; fixed: number } {
  const { table, key, columns, parts } = page
  const names = ['page_n', 'page_more', 'page_big', ...(parts ? ['page_part'] : []),
    ...[...key, ...columns, ...(parts?.columns ?? [])].map((column) => column.as)]
  const fixed = names.reduce((sum, name) => sum + name.length + 8, 0)
  const keys = key.map((column) => column.sql)
  const ks = key.map((_, i) => `k${i}`).join(', ')
  // A part row repeats the key and carries every name; the unit's own data is returned once, on its own row.
  const size = parts
    ? `(${page.size ?? sizeOf([...key, ...columns])}) + coalesce((SELECT sum(${fixed} + ${sizeOf([...key, ...parts.columns])}) FROM ${parts.table} p WHERE ${parts.on}), 0)`
    : page.size ?? sizeOf([...key, ...columns])
  const more = `(k.scanned = ${PAGE_ROWS} OR k.held < k.scanned)`
  // The rows are sized without their payloads, and only those kept are joined back for theirs, by rowid: the key is
  // unique only inside the scope. CROSS JOIN keeps SQLite's loop order, so no other row's payload is read. A NULL size
  // counts 0: a NULL running total would keep one row a page. A row over the cap counts its whole size, so it sits
  // alone on its page, as any row over the budget does.
  let sql = `WITH sized AS (
  SELECT t.rowid AS rid, ${keys.map((sql, i) => `${sql} AS k${i}`).join(', ')}, coalesce(${size}, 0) AS size
  FROM ${table} t
  WHERE (${page.where})${cursor ? ` AND (${keys.join(', ')}) > (${keys.map(() => '?').join(', ')})` : ''}
  ORDER BY ${keys.join(', ')} LIMIT ${PAGE_ROWS}
), run AS (
  SELECT rid, size, sum(size) OVER (ORDER BY ${ks} ROWS UNBOUNDED PRECEDING) AS total,
    row_number() OVER (ORDER BY ${ks}) AS n, count(*) OVER () AS scanned
  FROM sized
), kept AS (
  SELECT rid, size, n, scanned, count(*) OVER () AS held FROM run WHERE n = 1 OR total <= ${PAGE_BYTES}
)
SELECT k.n AS page_n, ${more} AS page_more, k.size > ${MAX_ROW_BYTES} AS page_big${parts ? ', 0 AS page_part' : ''},
  ${[...key.map((column) => `${column.sql} AS ${quoted(column.as)}`),
    ...columns.map((column) => `CASE WHEN k.size > ${MAX_ROW_BYTES} THEN NULL ELSE (${column.sql}) END AS ${quoted(column.as)}`),
    ...(parts?.columns ?? []).map((column) => `NULL AS ${quoted(column.as)}`)].join(', ')}
FROM kept k CROSS JOIN ${table} t ON t.rowid = k.rid`
  if (parts) {
    sql += `
UNION ALL
SELECT k.n, ${more}, 0, 1, ${[...keys, ...columns.map(() => 'NULL'), ...parts.columns.map((column) => column.sql)].join(', ')}
FROM kept k CROSS JOIN ${table} t ON t.rowid = k.rid CROSS JOIN ${parts.table} p ON ${parts.on}
WHERE k.size <= ${MAX_ROW_BYTES}`
  }
  return { sql, fixed }
}

/** SQLite's own order for a column's values: NULL first, numbers by value, text by its UTF-8 bytes (BINARY). */
function compare(a: unknown, b: unknown): number {
  const rank = (value: unknown): number => value === null || value === undefined ? 0 : typeof value === 'number' ? 1 : 2
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  if (rank(a) === 0) return 0
  if (rank(a) === 1) return (a as number) - (b as number)
  return Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)))
}

/** The columns that put a page's rows in order: by unit, then a unit's own row before its parts, in their order. */
const orderOf = (page: StorePage): string[] => page.parts ? ['page_n', 'page_part', ...page.parts.order] : ['page_n']

/** One page after `after` (the key of the last row read; null from the start). */
export async function readStorePage(db: string, page: StorePage, after: SqliteParam[] | null): Promise<StorePageRead> {
  const { sql, fixed } = statement(page, after !== null)
  // A page's payload is at most the budget, or its one row up to the cap; past the cap, none. Each row adds at most
  // its names and numbers. The CLI's JSON escaping can multiply the whole.
  const maxBuffer = (Math.max(PAGE_BYTES, MAX_ROW_BYTES) + PAGE_ROWS * fixed) * (builtinSqlite() ? 1 : CLI_ESCAPE)
  const read = await sqliteReadAll(db, sql, [...page.params, ...(after ?? [])], { maxBuffer })
  if (!read.ok) return read
  // Ordered on a copy: the read threads hand one answer, the same array, to every caller that asked the same page.
  const order = orderOf(page)
  const rows = [...read.rows].sort((a, b) => {
    for (const column of order) {
      const by = compare(a[column], b[column])
      if (by) return by
    }
    return 0
  })
  const last = rows.at(-1)
  return { ok: true, rows, full: last ? Boolean(Number(last.page_more)) : false,
    last: last ? page.key.map((column) => last[column.as] as SqliteParam) : null }
}

/** Every page from `after` until one is not full. A page that fails is the answer: no rows. */
export async function readStorePages(db: string, page: StorePage, after: SqliteParam[] | null = null): Promise<{ ok: true; rows: SqliteRow[] } | Unanswered> {
  const rows: SqliteRow[] = []
  for (let cursor = after; ;) {
    const read = await readStorePage(db, page, cursor)
    // Never the pages already read: a partial seed brings back the #4065 replay.
    if (!read.ok) return read
    for (const row of read.rows) rows.push(row)
    if (!read.full) return { ok: true, rows }
    cursor = read.last
  }
}

/** Rows already said, by engine, session and key; forgotten all at once past this, as OpenClaw's `unreadable()` does. */
const MAX_SAID = 1_000
const said = new Set<string>()

/** Says once that a row was stepped past for its size. */
export function oversizeRow(engine: string, sessionId: string, key: string): void {
  const id = JSON.stringify([engine, sessionId, key])
  if (said.has(id)) return
  if (said.size >= MAX_SAID) said.clear()
  said.add(id)
  console.error(`[${engine}] ${sid(sessionId)} ${key} unreadable · too big`)
}
