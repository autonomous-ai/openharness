import { describe, expect, it, vi } from 'vitest'
import { countReport, localReportMemory, machineReportLine, RECORD_TTL_MS, recordHolds, redisReportMemory, type ReportRecord } from './machineReports.js'
import { SWEEP_EVERY_MS } from './liveness.js'

/** The Redis commands the memory uses, with Redis' own expiry, on a clock the test moves; `down` fails every command. */
function fakeRedis() {
  let now = 0
  const keys = new Map<string, { value: string | Map<string, string>; until: number }>()
  const live = (key: string) => { const entry = keys.get(key); return entry && entry.until > now ? entry : undefined }
  const redis = {
    down: false,
    tick: (ms: number) => { now += ms },
    check() { if (redis.down) throw new Error('Redis is unreachable') },
    async hget(key: string, field: string) { redis.check(); const entry = live(key); return entry ? (entry.value as Map<string, string>).get(field) ?? null : null },
    async hset(key: string, field: string, value: string) {
      redis.check()
      const entry = live(key) ?? { value: new Map<string, string>(), until: Infinity }
      ;(entry.value as Map<string, string>).set(field, value)
      keys.set(key, entry)
      return 1
    },
    async pexpire(key: string, ms: number) { redis.check(); const entry = live(key); if (entry) entry.until = now + ms; return entry ? 1 : 0 },
    async set(key: string, value: string, px: 'PX', ms: number, nx: 'NX') {
      redis.check()
      if (px !== 'PX' || nx !== 'NX') throw new Error('expected PX and NX')
      if (live(key)) return null
      keys.set(key, { value, until: now + ms })
      return 'OK' as const
    },
  }
  return redis
}

const recordAt = (at: number): ReportRecord => ({ stamp: 7, lentCount: 2, removals: false, deadline: at + 60_000, team: false, members: ['p1'],
  preparable: ['s1'], at })

describe('what a full machine report leaves for the next one (DB 2.5)', () => {
  it('reads back what was recorded, per machine, until two minutes after the Swarm\'s last record', async () => {
    const redis = fakeRedis(), memory = redisReportMemory(redis)
    await memory.set('t1', 'm1', recordAt(1))
    expect(await memory.get('t1', 'm1')).toEqual(recordAt(1))
    expect(await memory.get('t1', 'm2')).toBeUndefined()
    redis.tick(RECORD_TTL_MS - 1)
    await memory.set('t1', 'm2', recordAt(2))
    redis.tick(RECORD_TTL_MS - 1)
    expect(await memory.get('t1', 'm1')).toEqual(recordAt(1))
    redis.tick(1)
    expect(await memory.get('t1', 'm1')).toBeUndefined()
  })

  it('reads a record it cannot parse, or one Redis cannot give, as missing', async () => {
    const redis = fakeRedis(), memory = redisReportMemory(redis)
    await redis.hset('swarm:machine-full:t1', 'm1', '{"stamp":"x"}')
    expect(await memory.get('t1', 'm1')).toBeUndefined()
    await memory.set('t1', 'm1', recordAt(1))
    redis.down = true
    expect(await memory.get('t1', 'm1')).toBeUndefined()
    await expect(memory.set('t1', 'm1', recordAt(2))).resolves.toBeUndefined()
  })

  it('sweeps a Swarm once per 30 seconds between every server sharing Redis', async () => {
    const redis = fakeRedis(), a = redisReportMemory(redis), b = redisReportMemory(redis)
    expect([await a.sweepDue('t1', 0), await b.sweepDue('t1', 0), await a.sweepDue('t2', 0)]).toEqual([true, false, true])
    redis.tick(SWEEP_EVERY_MS - 1)
    expect(await b.sweepDue('t1', SWEEP_EVERY_MS - 1)).toBe(false)
    redis.tick(1)
    expect([await b.sweepDue('t1', SWEEP_EVERY_MS), await a.sweepDue('t1', SWEEP_EVERY_MS)]).toEqual([true, false])
  })

  it('keeps the sweep clock on this server alone while Redis fails', async () => {
    const redis = fakeRedis(), memory = redisReportMemory(redis)
    redis.down = true
    expect([await memory.sweepDue('t1', 0), await memory.sweepDue('t1', SWEEP_EVERY_MS - 1), await memory.sweepDue('t1', SWEEP_EVERY_MS)])
      .toEqual([true, false, true])
  })

  it('remembers alone without Redis, records and sweeps both', async () => {
    let now = 0
    const memory = localReportMemory(() => now)
    await memory.set('t1', 'm1', recordAt(0))
    expect(await memory.get('t1', 'm1')).toEqual(recordAt(0))
    now = RECORD_TTL_MS
    expect(await memory.get('t1', 'm1')).toBeUndefined()
    expect([await memory.sweepDue('t1', 0), await memory.sweepDue('t1', 1)]).toEqual([true, false])
  })

  it('counts fast and full reports for the minute line, and starts again after each', () => {
    machineReportLine(60_000)
    countReport('fast'); countReport('fast'); countReport('full')
    expect(machineReportLine(60_000)).toMatchObject({ windowMs: 60_000, fast: 2, full: 1, pod: expect.any(String) })
    expect(machineReportLine(60_000)).toMatchObject({ fast: 0, full: 0 })
    vi.restoreAllMocks()
  })
})

describe('when a full report\'s record still holds (task #3119)', () => {
  // Recorded at main 7 with this machine's host stamp 3 and every host's 2; `now` is what Redis says now.
  const record = { ...recordAt(0), stamp: 7, hosts: { host: 3, all: 2 } }
  const now = (moved: Partial<{ main: number; hosted: number; uncovered: number; host: number; all: number }> = {}) =>
    ({ main: 7, hosted: 7, uncovered: 0, host: 3, all: 2, ...moved })

  it('holds while the Swarm is unchanged, or changed only where this machine\'s host is not concerned', () => {
    expect(recordHolds(record, now())).toBe(true)
    expect(recordHolds(record, now({ main: 9, hosted: 9 }))).toBe(true)
  })

  it('ends with a change for this machine\'s host or for every host', () => {
    expect(recordHolds(record, now({ main: 9, hosted: 9, host: 4 }))).toBe(false)
    expect(recordHolds(record, now({ main: 9, hosted: 9, all: 3 }))).toBe(false)
  })

  it('ends with any change while a server of the release before writes, and with one it wrote since the record', () => {
    // Its bump is the latest: nothing says whom it concerned.
    expect(recordHolds(record, now({ main: 9, hosted: 8 }))).toBe(false)
    // A newer server's bump came after it, and found it: it came after this record was read.
    expect(recordHolds(record, now({ main: 10, hosted: 10, uncovered: 9 }))).toBe(false)
    // One the record's own load saw is no reason.
    expect(recordHolds(record, now({ main: 10, hosted: 10, uncovered: 7 }))).toBe(true)
  })

  it('holds a record of the release before only while the Swarm is unchanged', () => {
    const { hosts: _hosts, ...older } = record
    expect(recordHolds(older, now())).toBe(true)
    expect(recordHolds(older, now({ main: 9, hosted: 9 }))).toBe(false)
  })
})
