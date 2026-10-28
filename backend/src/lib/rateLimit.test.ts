import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

import { createRateLimiter, useSharedRateCounter, type WindowCounter } from './rateLimit.js'
import { logger } from '../utils/logger.js'

/** What Redis is to the limiters: one fixed-window count per key, shared by every pod. */
function sharedCounter(): WindowCounter & { keys: string[] } {
  const counts = new Map<string, number>()
  const keys: string[] = []
  const counter = async (asked: string[]) => asked.map((key) => {
    keys.push(key)
    const next = (counts.get(key) ?? 0) + 1
    counts.set(key, next)
    return next
  })
  return Object.assign(counter, { keys })
}

afterEach(() => {
  useSharedRateCounter(null)
  vi.mocked(logger.warn).mockClear()
  vi.mocked(logger.info).mockClear()
})

async function allowedOf(limiter: { allows(key: string, now?: number): Promise<boolean> }, key: string, times: number, now = 0) {
  let allowed = 0
  for (let i = 0; i < times; i++) if (await limiter.allows(key, now)) allowed++
  return allowed
}

describe('rate limiter', () => {
  it('without a shared counter, counts in this process, per key and per window', async () => {
    const limiter = createRateLimiter('route', 60_000, 3)

    expect(await allowedOf(limiter, 'user-1', 5)).toBe(3)
    expect(await allowedOf(limiter, 'user-2', 1)).toBe(1)
    expect(await allowedOf(limiter, 'user-1', 1, 60_000)).toBe(1)
  })

  it('with a shared counter, every pod spends one budget instead of each having its own', async () => {
    useSharedRateCounter(sharedCounter())
    const podA = createRateLimiter('route', 60_000, 3)
    const podB = createRateLimiter('route', 60_000, 3)

    const allowed = (await allowedOf(podA, 'user-1', 2)) + (await allowedOf(podB, 'user-1', 2)) + (await allowedOf(podA, 'user-1', 2))

    expect(allowed).toBe(3)
  })

  it('keeps limiters with different names apart and starts a new window on time', async () => {
    const counter = sharedCounter()
    useSharedRateCounter(counter)
    const route = createRateLimiter('route', 60_000, 1)
    const reports = createRateLimiter('reports', 60_000, 1)

    expect(await route.allows('user-1', 0)).toBe(true)
    expect(await reports.allows('user-1', 0)).toBe(true)
    expect(await route.allows('user-1', 59_999)).toBe(false)
    expect(await route.allows('user-1', 60_000)).toBe(true)
    expect(counter.keys).toEqual(['rl:route:user-1:0', 'rl:reports:user-1:0', 'rl:route:user-1:0', 'rl:route:user-1:1'])
  })

  it('while the shared counter fails, falls back to counting in this process, and says so once each way', async () => {
    let down = true
    const counter = sharedCounter()
    useSharedRateCounter(async (keys, windowMs) => { if (down) throw new Error('redis circuit open'); return counter(keys, windowMs) })
    const limiter = createRateLimiter('route', 60_000, 2)

    expect(await allowedOf(limiter, 'user-1', 4)).toBe(2)
    down = false
    await limiter.allows('user-2')
    await limiter.allows('user-2')

    expect(vi.mocked(logger.warn).mock.calls.filter(([m]) => String(m).includes('rate limits'))).toHaveLength(1)
    expect(vi.mocked(logger.info).mock.calls.filter(([m]) => String(m).includes('rate limits'))).toHaveLength(1)
  })

  it('reset forgets this process\' counts', async () => {
    const limiter = createRateLimiter('route', 60_000, 1)
    await limiter.allows('user-1')
    limiter.reset()

    expect(await limiter.allows('user-1')).toBe(true)
  })
})
