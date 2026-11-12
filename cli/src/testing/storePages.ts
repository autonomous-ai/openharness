/**
 * What a paging spec sees of the store reads (lib/sqlitePage.ts, #4188): each page read a spied `sqliteReadAll` made,
 * what its reply weighs as the read threads weigh it, and whether it kept to the page budget.
 */
import { PAGE_BYTES } from '../lib/sqlitePage.js'
import type { SqliteReadOptions, SqliteReadResult, SqliteRow } from '../lib/sqliteRead.js'

export const KIB = 1024
export const MIB = 1024 * KIB

/** What rows weigh, as the read threads count a reply (lib/sqliteThread.ts): for each value its column's name, and a
 *  text's UTF-8 bytes, a blob's length, 8 for anything else. */
export function replyBytes(rows: readonly SqliteRow[]): number {
  let bytes = 0
  for (const row of rows) {
    for (const column in row) {
      const value = row[column]
      bytes += column.length + (typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 8)
    }
  }
  return bytes
}

export interface PageSeen { sql: string; maxBuffer: number; ok: boolean; rows: SqliteRow[]; units: number; bytes: number }

/** The page reads a spied `sqliteReadAll` made, in order: the calls whose SQL begins `WITH sized AS (`. `rows` is
 *  `[]` and `ok` false for one that was not answered; `units` is how many different `page_n` its rows carry. */
export async function pageReads(spy: { mock: { calls: unknown[][]; results: Array<{ value: unknown }> } }): Promise<PageSeen[]> {
  const reads: PageSeen[] = []
  for (const [at, [, sql, , options]] of spy.mock.calls.entries()) {
    if (typeof sql !== 'string' || !sql.startsWith('WITH sized AS (')) continue
    const read = await (spy.mock.results[at].value as Promise<SqliteReadResult>)
    const rows = read.ok ? read.rows : []
    // NaN for a page read with no limit: it then fails every bound a spec checks.
    reads.push({ sql, maxBuffer: Number((options as SqliteReadOptions | undefined)?.maxBuffer), ok: read.ok, rows,
      units: new Set(rows.map((row) => row.page_n)).size, bytes: replyBytes(rows) })
  }
  return reads
}

/** A page kept to the budget: PAGE_BYTES and 256 bytes of names and numbers a row, or it holds one unit. */
export const withinBudget = (read: PageSeen): boolean => read.units <= 1 || read.bytes <= PAGE_BYTES + read.rows.length * 256
