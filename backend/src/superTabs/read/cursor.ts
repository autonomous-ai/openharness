import { RETENTION_MS } from '../parts/index.js'

/** The longest a transaction lives (15 s, store.ts) plus the clock drift budget between backend processes (spec ruling 3). */
export const OVERLAP_MS = 30_000
/** A cursor this close to tombstone retention reloads, so a purge running a little early never hides a removal. */
const RETENTION_MARGIN_MS = 3_600_000

/** Made when a read starts, before any query: the next read asks for every change committed after `readStart − overlap`. */
export function cursorFor(readStart: number, epoch: number): string {
  return Buffer.from(JSON.stringify({ v: 2, t: readStart - OVERLAP_MS, e: epoch })).toString('base64url')
}

/** Where to read changes from, or a reload: the cursor is unreadable, from another epoch, or older than tombstones. */
export function readCursor(cursor: string, epoch: number, now: number): { since: number } | { reload: true } {
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) } catch { return { reload: true } }
  const { v, t, e } = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>
  if (v !== 2 || !Number.isSafeInteger(t) || e !== epoch) return { reload: true }
  if ((t as number) < now - RETENTION_MS + RETENTION_MARGIN_MS) return { reload: true }
  return { since: t as number }
}
