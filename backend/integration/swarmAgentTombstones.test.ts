import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { loadDeliveryParts } from '../src/superTabs/parts/light.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import { AGENT_RECHECK_MS, purgeAgentTombstones, requeueCompactedAgents } from '../src/superTabs/agentTombstones.js'
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

  // Desktop keeps the newest version it saw of each part, a tombstone's too, until it reloads (desktop parts.dart _newer): an
  // agent back at or below its tombstone's version stays hidden there.
  it('starts above every version its Swarm\'s purged agents reached', async () => {
    await db.$runCommandRaw({ update: 'SwarmHead', updates: [{ q: { _id: `${other}:head` }, u: { $set: { agentFloor: 900 } } }] })
    expect(await added(other, 'back')).toBe(901)
    expect((await db.swarmAgent.findUniqueOrThrow({ where: { id: `${other}:back` } })).version).toBe(901)
  })

  it('starts at the first version in a Swarm that purged none', async () => {
    const fresh = (await store.create(maker, randomUUID(), 'Fresh')).id
    expect(await added(fresh, 'new')).toBe(1)
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
      // The highest versions: a purged one sets its Swarm's floor, a kept one does not.
      { ...removed(tab, 'purged-high', due), version: 90 }, { ...removed(tab, 'kept-high', due), version: 500 },
      agent(tab, 'later', { deleted: true, purgeAt: new Date(NOW + DAY) }),
      ...Array.from({ length: 5 }, (_, i) => agent(tab, `live-${i}`)),
      removed(second, 'unnamed', due),
    ] })
    await db.swarmGroup.createMany({ data: [
      group('open-1', { agentIds: ['member', 'live-0', 'kept-high'] }), group('open-2', { leadId: 'lead', assignment: { agentId: 'assignee' } }),
      group('quiet', { agentIds: ['in-dormant'] }, { dormant: true }), group('gone', { agentIds: ['in-removed'] }, { deleted: true }),
    ] })
    await db.swarmStart.createMany({ data: [start('s-live', 'started'), start('s-removed', 'removed-start', { deleted: true })] })
    entries = await profiled(db, async () => { first = await purgeAgentTombstones(db, NOW) })
    repeat = await profiled(db, async () => { again = await purgeAgentTombstones(db, NOW) })
  })

  it('deletes only tombstones past their purge time that nothing open names', async () => {
    expect(first).toEqual({ purged: 6, kept: 5 })
    expect(await keysIn(tab)).toEqual(['assignee', 'kept-high', 'lead', 'later', ...Array.from({ length: 5 }, (_, i) => `live-${i}`), 'member', 'started'].sort())
    expect(await keysIn(second)).toEqual([])
    const later = await db.swarmAgent.findUniqueOrThrow({ where: { id: `${tab}:later` } })
    expect(later).toMatchObject({ deleted: true, data: { id: 'later' }, purgeAt: new Date(NOW + DAY) })
    // Other Swarms' agents and tombstones not yet due stay.
    expect(await db.swarmAgent.count({ where: { tabId: busy } })).toBe(LIVE + REMOVED)
  })

  it('raises each Swarm\'s agent floor to the highest version it purged, before the tombstones go', async () => {
    const floor = async (tabId: string) => ((await db.swarmHead.aggregateRaw({ pipeline: [{ $match: { _id: `${tabId}:head` } },
      { $project: { _id: 0, agentFloor: 1 } }] })) as unknown as Array<{ agentFloor?: number }>)[0]?.agentFloor
    expect(await floor(tab)).toBe(90)
    expect(await floor(second)).toBe(1)
    expect(await floor(busy)).toBeUndefined()
  })

  it('keeps a tombstone an open conversation or a live start names, compacted, and checks it again a day later', async () => {
    for (const key of ['member', 'lead', 'assignee', 'started', 'kept-high']) {
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
    expect(found[0]!.docsExamined, JSON.stringify(plan(found))).toBe(11)
    // One read per Swarm with due tombstones, of its open conversations only.
    const groups = reads(entries, 'SwarmGroup', ['agentIds'])
    expect(groups.map(e => e.command?.hint), JSON.stringify(plan(groups))).toEqual([{ tabId: 1, dormant: 1, changedAt: 1 }, { tabId: 1, dormant: 1, changedAt: 1 }])
    const starts = reads(entries, 'SwarmStart', ['agentId'])
    expect(starts.map(e => e.planSummary), JSON.stringify(plan(starts))).toEqual(['IXSCAN { tabId: 1, agentId: 1 }', 'IXSCAN { tabId: 1, agentId: 1 }'])
  })
})

describe('tombstones compacted before the purge', () => {
  it('get a purge time, and the next sweep purges them', async () => {
    await db.swarmMember.create({ data: { id: `${busy}:gone-member`, tabId: busy, key: 'gone-member', version: 1, changedAt: new Date(NOW - 30 * DAY),
      ordinal: 1, data: {}, deleted: true, purgeAt: null } })
    let queued = 0
    const agents = await db.swarmAgent.count()
    const entries = await profiled(db, async () => { queued = await requeueCompactedAgents(db, NOW) })
    expect(queued).toBe(REMOVED + 50)
    const update = reads(entries, 'SwarmAgent', ['deleted', 'purgeAt'])
    expect(update, JSON.stringify(plan(update))).toHaveLength(1)
    // One pass, once per worker start: never more than the agents there are.
    expect(update[0]!.docsExamined, JSON.stringify(plan(update))).toBeLessThanOrEqual(agents)
    // A member's tombstone keeps its compaction for good.
    expect((await db.swarmMember.findUniqueOrThrow({ where: { id: `${busy}:gone-member` } })).purgeAt).toBeNull()
    expect(await purgeAgentTombstones(db, NOW + 1)).toEqual({ purged: REMOVED + 50, kept: 0 })
    expect(await db.swarmAgent.count({ where: { tabId: busy } })).toBe(LIVE)
    expect(await db.swarmAgent.count({ where: { tabId: empty } })).toBe(0)
    expect(await requeueCompactedAgents(db, NOW)).toBe(0)
  })
})

describe('the purge when something changes or fails under it', () => {
  const LATER = NOW + 2 * DAY

  it('leaves a tombstone whose Swarm\'s floor it could not raise, and checks it again a day later instead of every pass', async () => {
    // No head: the floor's update matches nothing, so the tombstone's version would be lost. A full batch of them must not spin.
    const headless = `headless-${randomUUID()}`
    await db.swarmAgent.createMany({ data: Array.from({ length: 500 }, (_, i) => removed(headless, `gone-${i}`, new Date(LATER - DAY))) })
    // Earlier cases' tombstones fall due by now too; these 500 are among the kept.
    expect((await purgeAgentTombstones(db, LATER)).kept).toBeGreaterThanOrEqual(500)
    expect(await db.swarmAgent.count({ where: { tabId: headless } })).toBe(500)
    expect((await db.swarmAgent.findUniqueOrThrow({ where: { id: `${headless}:gone-0` } })).purgeAt).toEqual(new Date(LATER + AGENT_RECHECK_MS))
  })

  it('leaves a tombstone revived between its read and its delete, at the version it continued from', async () => {
    const tabId = (await store.create(maker, randomUUID(), 'Racing')).id
    await db.swarmAgent.create({ data: { ...removed(tabId, 'back', new Date(LATER - DAY)), version: 7 } })
    // The agent comes back (parts/write.ts continues from its tombstone) just before the purge deletes.
    let revived = false
    const racing = new Proxy(db, { get(target, property, receiver) {
      if (property !== '$runCommandRaw') return Reflect.get(target, property, receiver)
      return async (command: Record<string, unknown>) => {
        if (command.delete === 'SwarmAgent' && !revived) {
          revived = true
          await db.$transaction(tx => guardedWrite(tx, tabId, { op: 'insert', kind: 'agent', key: 'back', ordinal: 1, first: 1,
            data: { id: 'back', machineId: 'm', machineOwnerId: maker.sub, contributorId: maker.sub } }, LATER))
        }
        return target.$runCommandRaw(command as never)
      }
    } })
    expect(await purgeAgentTombstones(racing, LATER)).toEqual({ purged: 0, kept: 0 })
    expect(revived).toBe(true)
    expect(await db.swarmAgent.findUniqueOrThrow({ where: { id: `${tabId}:back` } })).toMatchObject({ deleted: false, version: 8 })
  })
})
