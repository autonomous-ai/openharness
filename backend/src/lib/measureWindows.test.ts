import { afterEach, expect, it, vi } from 'vitest'
import { measureWindows } from './measureWindows.js'

afterEach(() => vi.useRealTimers())

it('opens at once for forMs, then once every everyMs, and closes an open window when stopped', () => {
  vi.useFakeTimers()
  const events: string[] = []
  const stop = measureWindows({ everyMs: 1_000, forMs: 100, open: () => events.push(`open ${Date.now() % 10_000}`), close: () => events.push('close') })
  const t0 = Date.now() % 10_000
  vi.advanceTimersByTime(100)
  expect(events).toEqual([`open ${t0}`, 'close'])
  vi.advanceTimersByTime(900)
  expect(events).toHaveLength(3)
  vi.advanceTimersByTime(50)
  stop()
  expect(events.at(-1)).toBe('close')
  vi.advanceTimersByTime(5_000)
  expect(events).toHaveLength(4)
})
