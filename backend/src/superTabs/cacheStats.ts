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
    const now = Date.now(), window = entries
    entries = new Map()
    if (window.size) log('swarm cache', { windowMs: now - since, entries: Object.fromEntries(window) })
    since = now
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
