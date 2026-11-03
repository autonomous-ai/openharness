import { describe, expect, it, vi } from 'vitest'
import { recordCache, startCacheStats } from './cacheStats.js'

describe('swarm cache log', () => {
  it('counts by entry name and reason, and logs nothing in an empty window', () => {
    vi.useFakeTimers()
    try {
      const log = vi.fn()
      const stop = startCacheStats({ everyMs: 60_000, log })
      vi.advanceTimersByTime(60_000)
      expect(log).not.toHaveBeenCalled()
      recordCache('base', 'hit')
      recordCache('group:abc', 'hit')
      recordCache('group:def', 'patch', { parts: 3, bytes: 900 })
      recordCache('base', 'full', { bytes: 2_000, reason: 'cold' })
      recordCache('base', 'full', { bytes: 1_000, reason: 'age' })
      vi.advanceTimersByTime(60_000)
      expect(log).toHaveBeenCalledWith('swarm cache', { windowMs: 60_000, entries: {
        base: { hits: 1, full: 2, fullBytes: 3_000, patches: 0, patchParts: 0, patchBytes: 0, reloads: { cold: 1, age: 1 }, verify: 0, mismatches: 0 },
        group: { hits: 1, full: 0, fullBytes: 0, patches: 1, patchParts: 3, patchBytes: 900, reloads: {}, verify: 0, mismatches: 0 },
      } })
      stop()
    } finally { vi.useRealTimers() }
  })
})
