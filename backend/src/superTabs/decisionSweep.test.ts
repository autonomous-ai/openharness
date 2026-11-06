import { afterEach, describe, expect, it, vi } from 'vitest'
import { startDecisionSweep } from './decisionSweep.js'
import { logger } from '../lib/logger.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('decision deadline schedule', () => {
  it('runs immediately and each minute, and stops future passes', async () => {
    vi.useFakeTimers()
    const times: number[] = []
    const stop = startDecisionSweep(async now => { times.push(now) })
    await vi.advanceTimersByTimeAsync(0)
    expect(times).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(times).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(times).toHaveLength(2)
    expect(times[1]! - times[0]!).toBe(60_000)
    stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(times).toHaveLength(2)
  })

  it('does not overlap a slow pass, and resumes once it finishes', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    let count = 0
    const waiting = new Promise<void>(resolve => { finish = resolve })
    const stop = startDecisionSweep(async () => { count++; if (count === 1) await waiting })
    await vi.advanceTimersByTimeAsync(180_000)
    expect(count).toBe(1)
    finish()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(count).toBe(2)
    stop()
  })

  it('reports a failed pass without content and tries again on the next minute', async () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => {})
    let count = 0
    const stop = startDecisionSweep(async () => { if (++count === 1) throw new Error('private option text') })
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toHaveBeenCalledOnce()
    expect(JSON.stringify(errors.mock.calls)).not.toContain('private option text')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(count).toBe(2)
    stop()
  })
})
