import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { loadDeliveryParts } from '../src/superTabs/parts/light.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import { AGENT_RECHECK_MS, purgeAgentTombstones } from '../src/superTabs/agentTombstones.js'
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

describe('the hourly purge of agent tombstones', () => {
  let tab: string, second: string
  let first: Awaited<ReturnType<typeof purgeAgentTombstones>>, again: Awaited<ReturnType<typeof purgeAgentTombstones>>
  let entries: Awaited<ReturnType<typeof profiled>>, repeat: Awaited<ReturnType<typeof profiled>>
  const due = new Date(NOW - DAY)
  const group = (key: string, data: Record<string, unknown>, fields: Record<string, unknown> = {}) => ({ id: `${tab}:${key}`, tabId: tab, key,
    version: 1, changedAt: new Date(NOW - DAY), ordinal: 1, data: { id: key, agentIds: [], leadId: null, ...data },
    agentIds: (data.agentIds as string[] | undefined) ?? [], lastActivityAt: new Date(NOW - DAY), ...fields })
  const start = (key: string, agentId: string, fields: Record<string, unknown> = {}) => ({ id: `${tab}:${key}`, tabId: tab, key, version: 1,
    changedAt: new Date(NOW - DAY), ordinal: 1, data: {}, machineId: 'm', conversationId: 'c', agentId, ...fields })
  const keysIn = async (tabId: string) => (await db.swarmAgent.findMany({ where: { tabId }, select: { key: true } })).map(a => a.key).sort()

  beforeAll(async () => {
    tab = (await store.create(maker, randomUUID(), 'Purged')).id
    second = (await store.create(maker, randomUUID(), 'Purged too')).id
    await db.swarmAgent.createMany({ data: [
      ...['unnamed', 'member', 'lead', 'assignee', 'started', 'in-dormant', 'in-removed', 'removed-start'].map(key => removed(tab, key, due)),
      agent(tab, 'later', { deleted: true, purgeAt: new Date(NOW + DAY) }),
      ...Array.from({ length: 5 }, (_, i) => agent(tab, `live-${i}`)),
      removed(second, 'unnamed', due),
    ] })
    await db.swarmGroup.createMany({ data: [
      group('open-1', { agentIds: ['member', 'live-0'] }), group('open-2', { leadId: 'lead', assignment: { agentId: 'assignee' } }),
      group('quiet', { agentIds: ['in-dormant'] }, { dormant: true }), group('gone', { agentIds: ['in-removed'] }, { deleted: true }),
    ] })
    await db.swarmStart.createMany({ data: [start('s-live', 'started'), start('s-removed', 'removed-start', { deleted: true })] })
    entries = await profiled(db, async () => { first = await purgeAgentTombstones(db, NOW) })
    repeat = await profiled(db, async () => { again = await purgeAgentTombstones(db, NOW) })
  })

  it('deletes only tombstones past their purge time that nothing open names', async () => {
    expect(first).toEqual({ purged: 5, kept: 4 })
    expect(await keysIn(tab)).toEqual(['assignee', 'lead', 'later', ...Array.from({ length: 5 }, (_, i) => `live-${i}`), 'member', 'started'].sort())
    expect(await keysIn(second)).toEqual([])
    const later = await db.swarmAgent.findUniqueOrThrow({ where: { id: `${tab}:later` } })
    expect(later).toMatchObject({ deleted: true, data: { id: 'later' }, purgeAt: new Date(NOW + DAY) })
    // Other Swarms' agents and tombstones not yet due stay.
    expect(await db.swarmAgent.count({ where: { tabId: busy } })).toBe(LIVE + REMOVED)
  })

  it('keeps a tombstone an open conversation or a live start names, compacted, and checks it again a day later', async () => {
    for (const key of ['member', 'lead', 'assignee', 'started']) {
      expect(await db.swarmAgent.findUniqueOrThrow({ where: { id: `${tab}:${key}` } }), key)
        .toMatchObject({ deleted: true, data: {}, purgeAt: new Date(NOW + AGENT_RECHECK_MS) })
    }
    expect(again).toEqual({ purged: 0, kept: 0 })
    const read = reads(repeat, 'SwarmAgent', ['purgeAt'])
    expect(read.map(e => e.docsExamined), JSON.stringify(plan(read))).toEqual([0])
  })

  it('finds due tombstones by the purge index and the names by the open-conversation index', () => {
    const found = reads(entries, 'SwarmAgent', ['purgeAt']).filter(e => e.op !== 'update' && e.op !== 'remove')
    expect(found, JSON.stringify(plan(found))).toHaveLength(1)
    expect(found[0]!.planSummary, JSON.stringify(plan(found))).toMatch(/IXSCAN \{ purgeAt: 1 \}/)
    expect(found[0]!.docsExamined, JSON.stringify(plan(found))).toBe(9)
    const groups = reads(entries, 'SwarmGroup', ['agentIds'])
    expect(groups, JSON.stringify(plan(groups))).toHaveLength(1)
    expect(groups[0]!.command?.hint, JSON.stringify(plan(groups))).toEqual({ tabId: 1, dormant: 1, changedAt: 1 })
    const starts = reads(entries, 'SwarmStart', ['agentId'])
    expect(starts[0]!.planSummary, JSON.stringify(plan(starts))).toMatch(/IXSCAN \{ tabId: 1, agentId: 1 \}/)
  })
})
