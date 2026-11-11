/**
 * The read cache's minute log, `swarm cache` (spec 2026-11-02, "Checking it on prod"): per entry name, how reads were
 * served (hit, patched, loaded in full and why) and what the verify sample found. Counts only, never an id. An entry
 * name is counted up to its first `:` (`group:abc` is `group`), so the log stays small.
 */
import { logger } from '../utils/logger.js'

export type ReloadReason = 'cold' | 'age' | 'epoch' | 'parts' | 'error' | 'off' | 'since'
export type CacheEvent = 'hit' | 'full' | 'patch' | 'verify' | 'mismatch'

interface Counts {
  hits: number; full: number; fullBytes: number; patches: number; patchParts: number; patchBytes: number
  reloads: Partial<Record<ReloadReason, number>>; verify: number; mismatches: number
}

let entries = new Map<string, Counts>()
/** The read cache's deltas (parts/load.ts loadDelta with held rows): how many, how many changed rows they listed by key and
 *  version, and how many of those they read whole. The rest came from the delta before (#2783). */
let deltaRows = { deltas: 0, stamps: 0, whole: 0 }

export function recordDeltaRows(rows: { stamps: number; whole: number }): void {
  deltaRows.deltas++
  deltaRows.stamps += rows.stamps
  deltaRows.whole += rows.whole
}

export function recordCache(name: string, event: CacheEvent, detail: { bytes?: number; parts?: number; reason?: ReloadReason } = {}): void {
  const key = name.split(':', 1)[0]!
  let counts = entries.get(key)
  if (!counts) entries.set(key, counts = { hits: 0, full: 0, fullBytes: 0, patches: 0, patchParts: 0, patchBytes: 0, reloads: {}, verify: 0, mismatches: 0 })
  switch (event) {
    case 'hit': counts.hits++; break
    case 'full':
      counts.full++
      counts.fullBytes += detail.bytes ?? 0
      if (detail.reason) counts.reloads[detail.reason] = (counts.reloads[detail.reason] ?? 0) + 1
      break
    case 'patch': counts.patches++; counts.patchParts += detail.parts ?? 0; counts.patchBytes += detail.bytes ?? 0; break
    case 'verify': counts.verify++; break
    case 'mismatch': counts.mismatches++; break
  }
}

export function startCacheStats({ everyMs = 60_000, log = (message: string, context: Record<string, unknown>) => logger.info(message, context) }:
  { everyMs?: number; log?: (message: string, context: Record<string, unknown>) => void } = {}): () => void {
  let since = Date.now()
  const timer = setInterval(() => {
    const now = Date.now(), window = entries, rows = deltaRows
    entries = new Map()
    deltaRows = { deltas: 0, stamps: 0, whole: 0 }
    if (window.size || rows.deltas) log('swarm cache', { windowMs: now - since, entries: Object.fromEntries(window), ...rows.deltas ? { deltaRows: rows } : {} })
    since = now
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
