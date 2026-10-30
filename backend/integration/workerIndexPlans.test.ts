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

describe('the nightly routing reflection', () => {
  // Which projects it reads: a $group in Mongo over the evidence week index, never Prisma's groupBy (Lead, 10-30).
  it('finds the projects with routed work in the last two weeks by the evidence week index, reading only those weeks', async () => {
    const { reflectionCandidates } = await import('../src/lib/routingReflection.js')
    const { weekStart } = await import('../src/superTabs/leaderboard/week.js')
    const row = (tabId: string, projectId: string, week: number, kind: string) => ({ id: randomUUID(), tabId, projectId, engine: 'claude', model: 'opus',
      kind, week: new Date(week), updatedAt: new Date(week) })
    await db.superTabModelEvidence.createMany({ data: [
      // Weeks long past, which a read not bounded by week examines too.
      ...Array.from({ length: 20 }, (_, i) => row(`old-tab-${i}`, 'lead', weekStart(NOW - 60 * DAY), 'feature')),
      row('tab-a', 'lead', weekStart(NOW), 'feature'), row('tab-a', 'lead', weekStart(NOW), 'docs'), row('tab-a', 'web', weekStart(NOW - 7 * DAY), 'fix'),
    ] })
    let candidates: Map<string, string[]> | undefined
    const entries = await profiled(db, async () => { candidates = await reflectionCandidates(db, NOW) })
    expect(candidates).toEqual(new Map([['tab-a', expect.arrayContaining(['lead', 'web'])]]))
    expect(candidates!.get('tab-a')).toHaveLength(2)
    const rows = reads(entries, 'SuperTabModelEvidence', ['week'])
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(3)
    expect(rows[0]!.planSummary, JSON.stringify(plan(rows))).toMatch(/IXSCAN \{ week: 1/)
  })

  it('reads a Swarm’s failed starts of the last 7 days by its tabId+createdAt index', async () => {
    const { failedStarts } = await import('../src/superTabs/costs/read.js')
    const decision = (createdAt: number, outcome: string | null) => ({ id: randomUUID(), tabId: 'tab-f', conversationId: 'g1', record: {},
      final: { kind: 'new', startId: randomUUID(), machineId: 'secret-mac', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, outcome, createdAt: new Date(createdAt) })
    await db.superTabRouteDecision.createMany({ data: [
      ...Array.from({ length: 20 }, () => decision(NOW - 30 * DAY, 'failed')),
      decision(NOW - DAY, 'failed'), decision(NOW - 2 * DAY, 'done'), decision(NOW - 3 * DAY, null),
    ] })
    let found: Awaited<ReturnType<typeof failedStarts>> = []
    const entries = await profiled(db, async () => { found = await failedStarts(db, 'tab-f', NOW - 7 * DAY) })
    expect(found).toEqual([{ conversationId: 'g1', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', at: NOW - DAY }])
    const rows = reads(entries, 'SuperTabRouteDecision', ['tabId', 'createdAt'])
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(3)
    expect(rows[0]!.planSummary, JSON.stringify(plan(rows))).toMatch(/IXSCAN \{ tabId: 1, createdAt: 1/)
  })
})
