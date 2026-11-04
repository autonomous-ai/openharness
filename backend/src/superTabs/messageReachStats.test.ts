import { afterEach, describe, expect, it, vi } from 'vitest'
import { LATE_MS, recordMessageReach, startMessageReachStats } from './messageReachStats.js'

// Task #2840 (Watch Production): Ken's guard "how fast a message reaches its reader" had no measurement in any production log.
describe('message reach latency', () => {
  afterEach(() => { vi.useRealTimers() })

  function started(options: Parameters<typeof startMessageReachStats>[0] = {}) {
    vi.useFakeTimers()
    const log = vi.fn()
    const stop = startMessageReachStats({ pod: 'pod-1', ...options, log })
    return { log, stop }
  }

  it('logs each minute, per reader and way, the count, p50, p95 and max in ms, with the pod and window', () => {
    const { log, stop } = started()
    for (let ms = 1; ms <= 100; ms++) recordMessageReach({ reader: 'agent', via: 'delivery' }, ms)
    recordMessageReach({ reader: 'person', via: 'read' }, 250)
    vi.advanceTimersByTime(60_000)
    expect(log).toHaveBeenCalledTimes(1)
    const [message, context] = log.mock.calls[0]!
    expect(message).toBe('message reach latency')
    expect(context).toEqual({ pod: 'pod-1', windowMs: 60_000, rows: [
      { reader: 'agent', via: 'delivery', n: 100, p50: 50, p95: 95, max: 100 },
      { reader: 'person', via: 'read', n: 1, p50: 250, p95: 250, max: 250 },
    ] })
    stop()
  })

  // A reader that was away and catches up is not a slow delivery: counted apart, so it cannot set the p95. A live app reads
  // new messages within seconds of a push or its poll (15 s at most, off screen), so a read a minute late is a catch-up (an
  // app brought back, review of #2995); an agent's delivery includes the time it was busy, so it gets 10 minutes.
  it('counts a read over a minute old and a delivery over 10 minutes old as late, outside the percentiles', () => {
    const { log, stop } = started()
    recordMessageReach({ reader: 'person', via: 'read' }, 400)
    recordMessageReach({ reader: 'person', via: 'read' }, LATE_MS.read + 1)
    recordMessageReach({ reader: 'person', via: 'read' }, 5 * 60_000)
    recordMessageReach({ reader: 'agent', via: 'delivery' }, 5 * 60_000)
    recordMessageReach({ reader: 'agent', via: 'delivery' }, LATE_MS.delivery + 1)
    recordMessageReach({ reader: 'buddy', via: 'read' }, 3 * 3_600_000)
    vi.advanceTimersByTime(60_000)
    expect(log.mock.calls[0]![1].rows).toEqual([
      { reader: 'person', via: 'read', n: 1, p50: 400, p95: 400, max: 400, late: 2 },
      { reader: 'agent', via: 'delivery', n: 1, p50: 300_000, p95: 300_000, max: 300_000, late: 1 },
      { reader: 'buddy', via: 'read', n: 0, late: 1 },
    ])
    expect(LATE_MS).toEqual({ read: 60_000, delivery: 600_000 })
    stop()
  })

  it('says nothing for a minute nothing reached anyone, and starts each window empty', () => {
    const { log, stop } = started()
    vi.advanceTimersByTime(60_000)
    expect(log).not.toHaveBeenCalled()
    recordMessageReach({ reader: 'agent', via: 'delivery' }, 10)
    vi.advanceTimersByTime(60_000)
    vi.advanceTimersByTime(60_000)
    expect(log).toHaveBeenCalledTimes(1)
    stop()
  })

  // Memory stays bounded however busy the pod: a fixed sample per row, while count and max cover every message.
  it('keeps a bounded sample per row, its count and max covering every message', () => {
    const { log, stop } = started({ maxSamples: 10, random: () => 0.99 })
    for (let i = 0; i < 1_000; i++) recordMessageReach({ reader: 'agent', via: 'delivery' }, i === 500 ? 9_000 : 5)
    vi.advanceTimersByTime(60_000)
    expect(log.mock.calls[0]![1].rows[0]).toMatchObject({ n: 1_000, max: 9_000 })
    stop()
  })

  it('logs what is left when stopped, and records nothing once stopped', () => {
    const { log, stop } = started()
    recordMessageReach({ reader: 'agent', via: 'delivery' }, 30)
    stop()
    expect(log).toHaveBeenCalledTimes(1)
    recordMessageReach({ reader: 'agent', via: 'delivery' }, 30)
    vi.advanceTimersByTime(120_000)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('carries no ids, text or emails: only reader kinds, ways and numbers', () => {
    const { log, stop } = started()
    recordMessageReach({ reader: 'person', via: 'read' }, 12)
    stop()
    const keys = new Set<string>()
    const walk = (value: unknown) => { if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { keys.add(k); walk(v) } }
    walk(log.mock.calls[0]![1])
    expect([...keys].sort()).toEqual(['0', 'max', 'n', 'p50', 'p95', 'pod', 'reader', 'rows', 'via', 'windowMs'])
  })
})
