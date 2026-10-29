import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { listGroupIndexes } from '../src/superTabs/parts/indexed.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { SwarmWorkspaces } from '../src/superTabs/workspaceStore.js'
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
    expect(rows[0]!.command?.hint, 'the read names its index').toBeTruthy()
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
    expect(rows[0]!.command?.hint, 'the read names its index').toBeTruthy()
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
    expect(rows[0]!.command?.hint, 'the read names its index').toBeTruthy()
  })
})
