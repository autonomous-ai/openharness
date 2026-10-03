import { afterEach, describe, expect, it, vi } from 'vitest'
import { awakeTimeout, sleptFor } from './sleepAware.js'

afterEach(() => { vi.useRealTimers() })

describe('sleptFor', () => {
  it('reads an ordinary or merely late tick as awake, and a far-late one as the sleep it was', () => {
    expect(sleptFor(20_000, 20_000)).toBe(0)
    expect(sleptFor(39_000, 20_000)).toBe(0)
    expect(sleptFor(2_300_000, 20_000)).toBe(2_280_000)
  })
})

describe('awakeTimeout', () => {
  it('fires after the awake time, like a timer that nothing interrupted', async () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    awakeTimeout(fired, 60_000, { tickMs: 10_000 })
    await vi.advanceTimersByTimeAsync(50_000)
    expect(fired).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fired).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fired).toHaveBeenCalledOnce()
  })

  // The safe-mode clock: 15 minutes that a lid closed for forty used to spend in one go, exiting
  // the daemon on the first loop turn after the wake (2026-09-28 18:46:51).
  it('does not spend a sleep, however long, on its deadline', async () => {
    vi.useFakeTimers()
    let asleepMs = 0
    const fired = vi.fn()
    awakeTimeout(fired, 900_000, { tickMs: 10_000, now: () => performance.now() + asleepMs })
    await vi.advanceTimersByTimeAsync(300_000)
    asleepMs += 2_280_000
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fired).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(590_000)
    expect(fired).toHaveBeenCalledOnce()
  })

  it('can be called off', async () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    awakeTimeout(fired, 20_000, { tickMs: 10_000 }).cancel()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fired).not.toHaveBeenCalled()
  })
})
