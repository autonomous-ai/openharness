import { describe, expect, it } from 'vitest'
import { loadKpis, mongoOperations } from './kpi.js'

describe('mongoOperations', () => {
  it('sums every operation MongoDB served, as serverStatus reports them through Prisma', () => {
    const status = { opcounters: { insert: { $numberLong: '10' }, query: 200, update: { $numberInt: '30' }, delete: 4, getmore: 6, command: { $numberLong: '50' } } }
    expect(mongoOperations(status)).toBe(300)
  })
})

describe('loadKpis', () => {
  it('turns the counters around the load into the roadmap numbers', () => {
    expect(loadKpis({ ms: 120_000, operations: 36_000, cpuMicros: 30_000_000, failedAttempts: 6 }))
      .toEqual({ mongoOpsPerSecond: 300, cpuPercent: 25, retriesPerMinute: 3 })
  })
})
