import { describe, expect, it } from 'vitest'
import { createLastHour, type LastHourOptions } from './lastHour.js'

type Line = Record<string, any>

/** An hour on a clock the test moves: one minute per roll, with `cpuPerMinute` ms of process CPU in each. */
function hour(options: Partial<LastHourOptions> & { cpuPerMinute?: number } = {}) {
  let at = 0, cpu = 0
  const lines: Line[] = []
  const h = createLastHour({ pod: 'pod-1', now: () => at, cpuMs: () => cpu, log: (message, context) => lines.push({ message, ...context }), ...options })
  const minute = () => { at += 60_000; cpu += options.cpuPerMinute ?? 0; h.roll() }
  return { h, lines, minute, last: () => lines.at(-1)! }
}

describe('the last hour', () => {
  it('sums every minute of the last 60 and drops older ones, so the newest line alone covers the hour', () => {
    const { h, minute, last } = hour({ cpuPerMinute: 600 })
    for (let i = 0; i < 61; i++) {
      h.request('GET /api/super-tabs/:tabId/changes', 10, false)
      minute()
    }
    expect(last()).toMatchObject({ message: 'last hour', pod: 'pod-1', minutes: 60, windowMs: 3_600_000, requests: 60, cpuMs: 36_000 })
    expect(last().routes['GET /api/super-tabs/:tabId/changes']).toMatchObject({ n: 60, perMinute: 1, ms: 600, errors: 0 })
  })

  it('says how much of the hour it covers after a restart', () => {
    const { h, minute, last } = hour()
    for (let i = 0; i < 10; i++) { h.request('GET /api/health', 1, false); minute() }
    expect(last()).toMatchObject({ minutes: 10, windowMs: 600_000, requests: 10 })
    expect(last().routes['GET /api/health'].perMinute).toBe(1)
  })

  it('gives CPU and DB bytes per request, the whole process and per route', () => {
    const { h, minute, last } = hour({ cpuPerMinute: 1_000 })
    for (let i = 0; i < 4; i++) h.request('GET /api/a', 20, i === 0)
    h.db(new Map([['http GET /api/a', { n: 8, ms: 4, bytes: 40_000 }], ['web-ws terminal_input', { n: 2, ms: 1, bytes: 500 }]]))
    h.busy(new Map([['http GET /api/a', 200], ['web-ws terminal_input', 30]]))
    minute()
    expect(last()).toMatchObject({ requests: 4, errors: 1, cpuMs: 1_000, cpuMsPerRequest: 250, dbQueries: 10, dbBytes: 40_500, dbBytesPerRequest: 10_000 })
    expect(last().routes['GET /api/a']).toEqual({ n: 4, perMinute: 4, errors: 1, ms: 80, dbQueries: 8, dbBytes: 40_000, dbBytesPerRequest: 10_000,
      busyMs: 200, busyMsPerRequest: 50 })
    expect(last().work).toEqual({ 'web-ws terminal_input': { dbQueries: 2, dbBytes: 500, busyMs: 30 } })
  })

  it('leaves busy time out when the CPU profile is off, rather than reporting zero', () => {
    const { h, minute, last } = hour()
    h.request('GET /api/a', 5, false)
    minute()
    expect(last().routes['GET /api/a']).not.toHaveProperty('busyMs')
    expect(last()).not.toHaveProperty('busyMs')
  })

  it('reports zero per request for an hour with no requests, never NaN or Infinity', () => {
    const { h, minute, last } = hour({ cpuPerMinute: 500 })
    h.db(new Map([['background', { n: 3, ms: 2, bytes: 900 }]]))
    minute()
    expect(last()).toMatchObject({ requests: 0, cpuMsPerRequest: 0, dbBytesPerRequest: 0, dbBytes: 900 })
    expect(JSON.stringify(last())).not.toMatch(/NaN|Infinity|null/)
  })

  it('keeps at most maxKeys names; any further one counts as other', () => {
    const { h, minute, last } = hour({ maxKeys: 5, top: 100 })
    for (let i = 0; i < 9; i++) h.request(`GET /api/r${i}`, 1, false)
    minute()
    expect(Object.keys(last().routes)).toHaveLength(5)
    expect(last().routes.other.n).toBe(5)
    expect(last()).toMatchObject({ requests: 9, routeCount: 5 })
  })

  it('caps the sum across minutes too, when each minute brings new names', () => {
    const { h, minute, last } = hour({ maxKeys: 5, top: 100 })
    for (let i = 0; i < 9; i++) { h.request(`GET /api/r${i}`, 1, false); minute() }
    expect(Object.keys(last().routes)).toHaveLength(5)
    expect(last().routes.other.n).toBe(5)
  })

  it('lists the routes that took the most time, read the most DB bytes or burned the most CPU', () => {
    const { h, minute, last } = hour({ top: 2 })
    h.request('GET /slow', 900, false)
    h.request('GET /slower', 1_000, false)
    h.request('GET /heavy', 1, false)
    h.request('GET /hot', 1, false)
    h.request('GET /quiet', 1, false)
    h.db(new Map([['http GET /heavy', { n: 1, ms: 1, bytes: 9_000_000 }]]))
    h.busy(new Map([['http GET /hot', 5_000]]))
    minute()
    expect(Object.keys(last().routes)).toEqual(['GET /slower', 'GET /slow', 'GET /heavy', 'GET /hot'])
    expect(last()).toMatchObject({ requests: 5, routeCount: 5 })
  })
})
