import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// Roadmap Phase 3.7: the worker's hourly people rollup and minute billing sync read through an index that bounds them. A
// fresh loopback replica set; the app's own Prisma client is pointed at it before anything imports it. Never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
let rollupPeople: typeof import('../src/services/ProductUsagePeopleRollupService.js')['rollupPeople']
let billing: typeof import('../src/services/MachineBillingWorkerService.js')['machineBillingWorkerService']
const DAY = 86_400_000
const NOW = Date.parse('2026-10-29T08:00:00Z')
const today = Math.floor(NOW / DAY) * DAY

beforeAll(async () => {
  let uri: string
  ({ replica, db, uri } = await planDatabase('worker_index_plans_test'))
  process.env.DATABASE_URL = uri
  rollupPeople = (await import('../src/services/ProductUsagePeopleRollupService.js')).rollupPeople
  billing = (await import('../src/services/MachineBillingWorkerService.js')).machineBillingWorkerService
})
afterAll(async () => {
  await (await import('../src/lib/prisma.js')).prisma.$disconnect()
  await db?.$disconnect()
  await replica?.stop()
})

describe('the hourly people rollup', () => {
  it('reads only the activity marks of the days it counts, by the day index', async () => {
    const mark = (subject: string, day: number) => ({ subject, dayUtc: new Date(day), expiresAt: new Date(day + 40 * DAY), surfaces: ['cli'], worked: true,
      signupDay: new Date(day), staff: false })
    // Marks of days long past, which a read not bounded by day examines too.
    await db.productUsageActivity.createMany({ data: [
      ...Array.from({ length: 20 }, (_, i) => mark(`old-${i}`, today - 30 * DAY)),
      mark('recent-a', today - DAY), mark('recent-b', today - 2 * DAY), mark('recent-c', today - 3 * DAY),
    ] })
    const entries = await profiled(db, () => rollupPeople(new Date(NOW)))
    const rows = reads(entries, 'product_usage_activity', ['dayUtc'])
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.nreturned).toBe(3)
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(3)
    expect(rows[0]!.planSummary, JSON.stringify(plan(rows))).toMatch(/IXSCAN \{ dayUtc: 1/)
  })
})

describe('the minute billing sync', () => {
  // The (billingStatus, externalSubscriptionStatus, externalSubscriptionEndAt) index serves it although the status is not in the
  // filter: Mongo seeks to each status's end-time range, so it reads only the subscriptions it returns, and a few keys per
  // status. Another index on machines, rewritten on every 15 s report, would cost more than those keys (roadmap Phase 3.7).
  it('reads only the active subscriptions ending near now, by an index bounding the end time', async () => {
    const machine = (endAt: number, fields: Record<string, unknown> = {}) => ({ machineId: `m-${randomUUID()}`, userId: randomUUID().replaceAll('-', '').slice(0, 24),
      apiKey: `k-${randomUUID()}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote', billingStatus: 'active', externalSubscriptionId: `s-${randomUUID()}`,
      externalSubscriptionEndAt: new Date(endAt), externalSubscriptionStatus: 2, deletedAt: null, ...fields })
    await db.machine.createMany({ data: [
      // Active subscriptions ending next month, of several provider statuses: a read the end time does not bound examines them.
      ...Array.from({ length: 20 }, (_, i) => machine(Date.now() + 30 * DAY, { externalSubscriptionStatus: i % 4 })),
      machine(Date.now() + 5 * 60_000), machine(Date.now() - 10 * 60_000, { externalSubscriptionStatus: 3 }),
    ] })
    const entries = await profiled(db, () => (billing as unknown as { findSyncCandidates(): Promise<unknown[]> }).findSyncCandidates())
    const rows = reads(entries, 'machines', ['externalSubscriptionEndAt', 'billingStatus'])
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.nreturned).toBe(2)
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(2)
    // Four statuses among these machines: at most one key past each status's range, and one at each range's start.
    expect(rows[0]!.keysExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(2 + 2 * 4)
    expect(rows[0]!.planSummary).toMatch(/externalSubscriptionEndAt/)
  })
})
