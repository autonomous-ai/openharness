/**
 * The message ranges the inbox and the Threads view read (inbox.ts), kept per process so a re-read of a range nothing changed in
 * reads nothing. Apps read the inbox whenever the Swarm moves, about once a second in a busy one, and most of the ranges a read
 * names have not changed since the last: in Ken's slow log of 11-04 those re-reads (the `$or` over threads and each chat's
 * unread scan) were most of the slow message ops.
 *
 * Exact, never a guess: a range is keyed by its Swarm, chat, thread, sequence bounds, row limit and fields, and by its chat's
 * reactionSeq. A range is bounded above by the chat's newest numbered row (chatTop), so a new row is outside every range kept
 * before it; an edit and a delete bump reactionSeq (messageEdits.ts), so no range kept before them is read again. Rows are the
 * stored rows, the same for every reader: each read still applies its reader's checks to them (inbox.ts readable).
 *
 * Design. Growth: at most RANGE_ENTRIES ranges and RANGE_ROWS rows, least recently used out first, each gone after
 * RANGE_TTL_MS. Concurrency: one process's Map, no lock; two reads of one range may both read it and the later one stays.
 * Scale: rows held are SCAN_FIELDS or a preview (~0.3-1 KB), so 200k rows stay under ~200 MB at worst; a pod's memory warns first.
 * Compatibility: old and new pods read the same rows; nothing is stored. Rollback: none needed. Failure: a miss reads Mongo.
 */

export interface RangeLimits { entries: number; rows: number; ttlMs: number }

export class RangeCache<T> {
  private readonly held = new Map<string, { rows: T[]; at: number }>()
  private rows = 0

  constructor(private readonly limits: RangeLimits, private readonly now: () => number = Date.now) {}

  /** The rows kept under `key`, as a new list, or undefined when none are (or they are past their time). */
  get(key: string): T[] | undefined {
    const entry = this.held.get(key)
    if (!entry) return undefined
    this.held.delete(key)
    if (this.now() - entry.at > this.limits.ttlMs) {
      this.rows -= entry.rows.length
      return undefined
    }
    this.held.set(key, entry)
    return [...entry.rows]
  }

  /** Keeps `rows` under `key`; a range larger than the whole budget is not kept. */
  set(key: string, rows: readonly T[]): void {
    const old = this.held.get(key)
    if (old) {
      this.held.delete(key)
      this.rows -= old.rows.length
    }
    if (rows.length > this.limits.rows) return
    this.held.set(key, { rows: [...rows], at: this.now() })
    this.rows += rows.length
    for (const [oldest, entry] of this.held) {
      if (this.held.size <= this.limits.entries && this.rows <= this.limits.rows) break
      this.held.delete(oldest)
      this.rows -= entry.rows.length
    }
  }

  size(): { entries: number; rows: number } {
    return { entries: this.held.size, rows: this.rows }
  }

  clear(): void {
    this.held.clear()
    this.rows = 0
  }
}

/** The key of one range: every part that decides its rows, each JSON-quoted so no id can stand for two parts. */
export function rangeKey(tabId: string, conversationId: string, thread: string | null, sequence: Record<string, number>, limit: number,
  version: number, fields: string, namedBy?: string): string {
  return JSON.stringify([tabId, conversationId, thread, sequence, limit, version, fields, namedBy ?? null])
}

/** A chat's newest numbered row: a hidden one (recipients only) moves messageSeq but not lastMessageSequence. A range bounded by
 *  it holds every row a read of it could find, and none written after. */
export const chatTop = (group: { messageSeq?: number; lastMessageSequence?: number }): number =>
  Math.max(group.messageSeq ?? 0, group.lastMessageSequence ?? 0)

/** What an edit or a delete in the chat moves (messageEdits.ts), with reactions. */
export const chatVersion = (group: { reactionSeq?: number }): number => group.reactionSeq ?? 0

export const RANGE_ENTRIES = 4_000
export const RANGE_ROWS = 200_000
export const RANGE_TTL_MS = 10 * 60_000

/** Test seam: forget every kept range (inbox.ts holds them). */
export const resetRangeCache = (): void => { for (const clear of clears) clear() }
const clears: Array<() => void> = []
/** A cache whose ranges resetRangeCache forgets. */
export function rangeCache<T>(): RangeCache<T> {
  const cache = new RangeCache<T>({ entries: RANGE_ENTRIES, rows: RANGE_ROWS, ttlMs: RANGE_TTL_MS })
  clears.push(() => cache.clear())
  return cache
}
