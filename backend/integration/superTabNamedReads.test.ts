import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { listGroupIndexes } from '../src/superTabs/parts/indexed.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { SwarmWorkspaces } from '../src/superTabs/workspaceStore.js'
import { agentOpenDeliveries } from '../src/superTabs/pageReads.js'
import { loadChanged } from '../src/superTabs/parts/index.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// Roadmap Phase 3 (database optimization, 2026-10-29): Prisma sends `in` and `has` as $expr, which the planner bounds by an
// index's first field alone; on 28 Oct such reads scanned 50 M documents for 220 k returned. Each read here names its index,
// and under Mongo's profiler examines no document it does not return. A fresh loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const NOW = Date.parse('2026-10-29T08:00:00Z')
/** A person; their id is an ObjectId, as a user row's is. */
const person = (name: string): AuthUser => ({ sub: randomUUID().replaceAll('-', '').slice(0, 24), email: `${name}@example.com`, autonomousEnv: 'prod', role: 'user' })
const owner = person('owner')
/** Swarms of other people in the same environment: a read bounded by the environment alone examines these too. */
const OTHERS = 12

/** A SuperTab row of `ownerId`, in parts (format 2), with these members and machines. */
async function swarmRow(ownerId: string, fields: { memberIds?: string[]; machineIds?: string[]; cleanupMachineIds?: string[]; autonomousEnv?: string } = {}) {
  const id = `tab-${randomUUID()}`
  await db.superTab.create({ data: { id, ownerId, autonomousEnv: fields.autonomousEnv ?? 'prod', memberIds: fields.memberIds ?? [ownerId], invitedEmails: [],
    machineIds: fields.machineIds ?? [], cleanupMachineIds: fields.cleanupMachineIds ?? [], format: 2, state: { version: 2 } } })
  return id
}

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_named_reads_test'))
  store = new SuperTabStore(db, () => NOW)
  await listGroupIndexes(db)
  for (let i = 0; i < OTHERS; i++) {
    const other = person(`other${i}`)
    await swarmRow(other.sub, { memberIds: [other.sub, `user-guest-${i}`] })
  }
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe('the owner\'s grid poll', () => {
  it('finds the owner\'s Swarms by the owner index, examining none of anyone else\'s', async () => {
    const mine = [await swarmRow(owner.sub), await swarmRow(owner.sub)]
    // Another environment's Swarm of the same owner id is never theirs here.
    await swarmRow(owner.sub, { autonomousEnv: 'dev' })
    const entries = await profiled(db, () => store.hostGrids(owner))
    const rows = reads(entries, 'SuperTab', ['ownerId'])
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.nreturned).toBe(mine.length)
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(mine.length)
    expect(rows[0]!.command?.hint, `the read names its index: ${JSON.stringify(plan(rows))}`).toBeTruthy()
  })
})

/** A person with a user row, as a signed-in person has. */
async function signedIn(name: string): Promise<AuthUser> {
  const user = person(name)
  await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: 'prod' } })
  return user
}

describe('a person\'s Swarm list', () => {
  let me: AuthUser
  let mine: string[]
  beforeAll(async () => {
    me = await signedIn('lister')
    // Swarms of other people, born in parts: a read bounded by the environment alone examines these too.
    for (let i = 0; i < 4; i++) await store.create(await signedIn(`maker${i}`), randomUUID(), `Theirs ${i}`)
    mine = []
    for (let i = 0; i < 3; i++) mine.push((await store.create(me, randomUUID(), `Mine ${i}`)).id)
    mine.sort()
  })

  const memberReads = (entries: Awaited<ReturnType<typeof profiled>>) => reads(entries, 'SuperTab', ['memberIds'])
  const bounded = (rows: ReturnType<typeof memberReads>, returned: number) => {
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.nreturned).toBe(returned)
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(returned)
    expect(rows[0]!.keysExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(returned + 1)
    expect(rows[0]!.command?.hint, `the read names its index: ${JSON.stringify(plan(rows))}`).toBeTruthy()
  }

  it('the Swarms page reads only the person\'s Swarms, in id order, by the member index', async () => {
    let listed: Awaited<ReturnType<SwarmReads['list']>> | undefined
    const entries = await profiled(db, async () => { listed = await new SwarmReads(store, { now: () => NOW }).list(me) })
    expect(listed!.tabs.map(t => t.id)).toEqual(mine)
    expect(listed!.next).toBeNull()
    bounded(memberReads(entries), mine.length)
  })

  it('the store\'s list and its later page read the same way', async () => {
    let first: Awaited<ReturnType<SuperTabStore['list']>> | undefined
    let later: Awaited<ReturnType<SuperTabStore['list']>> | undefined
    const whole = await profiled(db, async () => { first = await store.list(me) })
    expect(first!.tabs.map(t => t.id)).toEqual(mine)
    bounded(memberReads(whole), mine.length)
    const after = await profiled(db, async () => { later = await store.list(me, mine[0]) })
    expect(later!.tabs.map(t => t.id)).toEqual(mine.slice(1))
    bounded(memberReads(after), mine.length - 1)
  })

  it('a Workspace removal finds only the removed person\'s Swarms of that Workspace', async () => {
    const workspaceId = (await db.superTab.findUniqueOrThrow({ where: { id: mine[0]! } })).workspaceId!
    const left: string[] = []
    const workspaces = new SwarmWorkspaces(db, { transaction: body => db.$transaction(body), now: () => NOW,
      leave: async (_person, tabId) => { left.push(tabId) } })
    await db.swarmWorkspaceRemoval.create({ data: { id: `${workspaceId}:${me.sub}:g1`, workspaceId, userId: me.sub, email: me.email, generation: 'g1',
      autonomousEnv: 'prod', removedAt: new Date(NOW), removedBy: owner.sub, finishedAt: null, purgeAt: null } })
    const entries = await profiled(db, () => workspaces.finishPending(workspaceId, me.sub))
    const inWorkspace = (await db.superTab.findMany({ where: { workspaceId }, select: { id: true } })).map(r => r.id).filter(id => mine.includes(id))
    expect(left.sort()).toEqual(inWorkspace.sort())
    const rows = memberReads(entries)
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    // Bounded by the person's Swarms, whichever Workspace each is in.
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(mine.length)
    expect(rows[0]!.command?.hint, `the read names its index: ${JSON.stringify(plan(rows))}`).toBeTruthy()
  })
})

describe('an agent\'s open deliveries', () => {
  const tabId = `tab-${randomUUID()}`, agentId = `${tabId}-agent`
  const delivery = (id: string, fields: { agentId?: string; status: string; createdAt: number; conversationId?: string }) => ({ id: `${tabId}-${id}`, tabId,
    conversationId: fields.conversationId ?? 'c1', messageId: `${tabId}-m-${id}`, agentId: fields.agentId ?? agentId, machineId: 'm1', membershipGeneration: 'g',
    authorKind: 'person', authorId: owner.sub, authorGeneration: 'g', status: fields.status, createdAt: new Date(fields.createdAt) })
  beforeAll(async () => {
    await db.superTabDelivery.createMany({ data: [
      // Its own finished deliveries, which a read bounded by the agent alone examines too.
      ...Array.from({ length: 10 }, (_, i) => delivery(`done-${i}`, { status: i % 2 ? 'confirmed' : 'cancelled', createdAt: NOW - 100_000 + i })),
      // Another agent's open ones.
      ...Array.from({ length: 5 }, (_, i) => delivery(`theirs-${i}`, { agentId: `${tabId}-other`, status: 'queued', createdAt: NOW - 50_000 + i })),
      delivery('claimed', { status: 'claimed', createdAt: NOW - 3000, conversationId: 'c2' }),
      delivery('queued', { status: 'queued', createdAt: NOW - 1000 }),
    ] })
    // One stored before its optional fields existed: Prisma reads each as null.
    await db.$runCommandRaw({ insert: 'SuperTabDelivery', documents: [{ _id: `${tabId}-old`, tabId, conversationId: 'c1', messageId: `${tabId}-m-old`, agentId,
      machineId: 'm1', membershipGeneration: 'g', authorKind: 'agent', authorId: 'lead', authorGeneration: 'g', status: 'uncertain',
      createdAt: { $date: new Date(NOW - 2000).toISOString() }, updatedAt: { $date: new Date(NOW - 2000).toISOString() } }] })
  })

  it('reads only its own open ones, oldest first, by the agent index', async () => {
    let open: Awaited<ReturnType<typeof agentOpenDeliveries>> = []
    const entries = await profiled(db, async () => { open = await db.$transaction(tx => agentOpenDeliveries(tx, tabId, agentId)) })
    expect(open.map(d => d.id)).toEqual([`${tabId}-claimed`, `${tabId}-old`, `${tabId}-queued`])
    const rows = reads(entries, 'SuperTabDelivery', ['tabId', 'agentId', 'status'])
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(3)
    expect(rows[0]!.keysExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(3 + 3)
    expect(rows[0]!.command?.hint, `the read names its index: ${JSON.stringify(plan(rows))}`).toBeTruthy()
  })

  it('returns each row as Prisma reads it, outside a transaction too', async () => {
    const prisma = await db.superTabDelivery.findMany({ where: { tabId, agentId, status: { in: ['queued', 'claimed', 'uncertain'] } }, orderBy: { createdAt: 'asc' } })
    expect(await agentOpenDeliveries(db, tabId, agentId)).toEqual(prisma)
    const old = prisma.find(d => d.id === `${tabId}-old`)!
    expect(old.nativeContextId).toBeNull()
    expect(old.holdSince).toBeNull()
  })
})

describe('what changed in a set of Swarms since a cursor', () => {
  const OLD = new Date(NOW - 3_600_000), SINCE = new Date(NOW - 1_800_000), LATER = new Date(NOW - 60_000)
  const SWARM_PARTS = ['swarmHead', 'swarmMember', 'swarmAgent', 'swarmGroup', 'swarmMachine', 'swarmStart', 'swarmProgress'] as const
  let ids: string[]
  beforeAll(async () => {
    const maker = await signedIn('changer')
    ids = []
    for (let i = 0; i < 3; i++) ids.push((await store.create(maker, randomUUID(), `Changed ${i}`)).id)
    for (const model of SWARM_PARTS) await (db[model] as unknown as { updateMany(args: unknown): Promise<unknown> }).updateMany({ where: { tabId: { in: ids } }, data: { changedAt: OLD } })
    const machine = (key: string, changedAt: Date, readAt: Date | null) => ({ id: `${ids[0]}:${key}`, tabId: ids[0]!, key, version: 1, changedAt, ordinal: 1,
      data: { machineId: key }, machineId: key, cleanupOwnerIds: [], readAt })
    // Quiet machines of the first Swarm: a read bounded by the Swarm alone examines these too.
    await db.swarmMachine.createMany({ data: [...Array.from({ length: 6 }, (_, i) => machine(`machine:quiet-${i}`, OLD, OLD)),
      machine('machine:read', OLD, LATER), machine('machine:changed', LATER, null), machine('machine:both', LATER, LATER)] })
    await db.swarmMember.updateMany({ where: { tabId: ids[0]! }, data: { changedAt: LATER } })
  })

  it('reads each kind by its changes index, and machines also by when they were read, examining only what changed', async () => {
    let changed = new Map<string, Array<{ kind: string; key: string; readAt?: number }>>()
    const entries = await profiled(db, async () => { changed = await db.$transaction(tx => loadChanged(tx, ids, SINCE)) })
    const keys = (tabId: string) => changed.get(tabId)!.map(p => `${p.kind}:${p.key}`).sort()
    const members = (await db.swarmMember.findMany({ where: { tabId: ids[0]! } })).map(m => `member:${m.key}`)
    expect(keys(ids[0]!)).toEqual([...members, 'machine:machine:both', 'machine:machine:changed', 'machine:machine:read'].sort())
    expect(keys(ids[1]!)).toEqual([])
    expect(keys(ids[2]!)).toEqual([])
    expect(changed.get(ids[0]!)!.find(p => p.key === 'machine:read')!.readAt).toBe(LATER.getTime())
    const swarmReads = entries.filter(e => /\.Swarm(Head|Member|Agent|Group|Machine|Start|Progress)$/.test(e.ns))
    expect(swarmReads.length, JSON.stringify(plan(swarmReads))).toBe(8)
    for (const read of swarmReads) {
      expect(read.docsExamined, `${read.ns} ${JSON.stringify(plan([read]))}`).toBeLessThanOrEqual(read.nreturned!)
      expect(read.command?.hint, `${read.ns} names its index: ${JSON.stringify(plan([read]))}`).toBeTruthy()
    }
  })
})
