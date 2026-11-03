import { afterEach, expect, it, vi } from 'vitest'
import { startMemoryStats } from './memoryStats.js'

afterEach(() => vi.useRealTimers())

const MB = 1024 * 1024

it('logs the process memory in MB and what the Swarm read cache holds, every minute (prod 2026-11-03: 2 -> 6 pods on memory)', () => {
  vi.useFakeTimers()
  const log = vi.fn()
  const usage = () => ({ rss: 700.4 * MB, heapTotal: 400 * MB, heapUsed: 350.6 * MB, external: 30 * MB, arrayBuffers: 12 * MB })
  const stop = startMemoryStats({ everyMs: 60_000, log, usage, cache: () => ({ entries: 120, bytes: 50 * MB }) })
  expect(log).not.toHaveBeenCalled()
  vi.advanceTimersByTime(60_000)
  expect(log).toHaveBeenCalledWith('memory', { rssMb: 700, heapTotalMb: 400, heapUsedMb: 351, externalMb: 30, arrayBuffersMb: 12,
    cache: { entries: 120, mb: 50 } })
  stop()
  vi.advanceTimersByTime(60_000)
  expect(log).toHaveBeenCalledTimes(1)
})

it('says no cache when the process has none (SWARM_READ_CACHE=off, or no stamps)', () => {
  vi.useFakeTimers()
  const log = vi.fn()
  const stop = startMemoryStats({ everyMs: 60_000, log, cache: () => null })
  vi.advanceTimersByTime(60_000)
  expect(log.mock.calls[0]![1]).not.toHaveProperty('cache')
  expect(log.mock.calls[0]![1].rssMb).toBeGreaterThan(0)
  stop()
})
