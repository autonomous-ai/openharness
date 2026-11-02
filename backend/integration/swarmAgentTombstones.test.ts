import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { loadDeliveryParts } from '../src/superTabs/parts/light.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// Prod profile 2026-11-02 (v1.3.86): a Swarm's live-agent read planned on [tabId, changedAt] and examined 1,070 agents to
// return 40, because about 1,000 removed agents stayed as tombstones. A fresh loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const NOW = Date.parse('2026-11-02T13:00:00Z')
const DAY = 86_400_000
const maker: AuthUser = { sub: randomUUID().replaceAll('-', '').slice(0, 24), email: 'agents@example.com', autonomousEnv: 'prod', role: 'user' }
const LIVE = 40, REMOVED = 1000
let busy: string, other: string, empty: string

const agent = (tabId: string, key: string, fields: Record<string, unknown> = {}) => ({ id: `${tabId}:${key}`, tabId, key, version: 1,
  changedAt: new Date(NOW - 30 * DAY), ordinal: 1, data: { id: key }, machineId: 'm', machineOwnerId: maker.sub, contributorId: maker.sub,
  deleted: false, purgeAt: null, ...fields })
const removed = (tabId: string, key: string, purgeAt: Date | null = null) => agent(tabId, key, { deleted: true, purgeAt, data: {} })

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_agents_test'))
  store = new SuperTabStore(db, () => NOW)
  await db.user.create({ data: { id: maker.sub, externalId: `fixture-${maker.sub}`, email: maker.email, autonomousEnv: 'prod' } })
  busy = (await store.create(maker, randomUUID(), 'Busy')).id
  other = (await store.create(maker, randomUUID(), 'Other')).id
  empty = (await store.create(maker, randomUUID(), 'Only tombstones')).id
  await db.swarmAgent.createMany({ data: [
    ...Array.from({ length: LIVE }, (_, i) => agent(busy, `live-${i}`)),
    ...Array.from({ length: REMOVED }, (_, i) => removed(busy, `gone-${i}`)),
    ...Array.from({ length: 200 }, (_, i) => agent(other, `other-${i}`)),
    ...Array.from({ length: 50 }, (_, i) => removed(empty, `gone-${i}`)),
  ] })
  await listNamedIndexes(db)
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe('the live-agent read', () => {
  it('uses the [tabId, deleted] index and examines only live agents', async () => {
    let parts: Awaited<ReturnType<typeof loadDeliveryParts>> | undefined
    const entries = await profiled(db, async () => { parts = await db.$transaction(tx => loadDeliveryParts(tx, busy, [], [])) })
    expect(parts!.agents.map(a => a.key).sort()).toEqual(Array.from({ length: LIVE }, (_, i) => `live-${i}`).sort())
    const read = reads(entries, 'SwarmAgent', ['tabId', 'deleted'])
    expect(read, JSON.stringify(plan(read))).toHaveLength(1)
    expect(read[0]!.planSummary, JSON.stringify(plan(read))).toMatch(/IXSCAN \{ tabId: 1, deleted: 1 \}/)
    expect(read[0]!.docsExamined, JSON.stringify(plan(read))).toBe(LIVE)
  })

  it('returns none for a Swarm of tombstones only, through the same index', async () => {
    let parts: Awaited<ReturnType<typeof loadDeliveryParts>> | undefined
    const entries = await profiled(db, async () => { parts = await db.$transaction(tx => loadDeliveryParts(tx, empty, [], [])) })
    expect(parts!.agents).toEqual([])
    const read = reads(entries, 'SwarmAgent', ['tabId', 'deleted'])
    expect(read[0]!.planSummary, JSON.stringify(plan(read))).toMatch(/IXSCAN \{ tabId: 1, deleted: 1 \}/)
    expect(read[0]!.docsExamined, JSON.stringify(plan(read))).toBe(0)
  })
})

describe('an agent added again after its tombstone is gone', () => {
  const added = (tabId: string, key: string) => db.$transaction(tx => guardedWrite(tx, tabId, { op: 'insert', kind: 'agent', key, ordinal: 1, first: 1,
    data: { id: key, machineId: 'm', machineOwnerId: maker.sub, contributorId: maker.sub } }, NOW))
  const configuration = (tabId: string, agentId: string, revision: number) => ({ id: `${tabId}:${agentId}:${revision}`, tabId, agentId, revision,
    configuration: {}, assignmentIds: [], actorKey: 'person:owner', observedAt: new Date(NOW - DAY) })

  it('starts above its configuration revisions, so versions never go back', async () => {
    await db.superTabConfiguration.createMany({ data: [configuration(other, 'back', 500), configuration(other, 'back', 900),
      configuration(busy, 'back', 5000)] })
    expect(await added(other, 'back')).toBe(901)
    expect((await db.swarmAgent.findUniqueOrThrow({ where: { id: `${other}:back` } })).version).toBe(901)
  })

  it('starts at the first version when it has no configuration', async () => {
    expect(await added(other, 'new')).toBe(1)
  })
})
