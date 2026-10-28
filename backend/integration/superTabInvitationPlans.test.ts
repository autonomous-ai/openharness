import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { invitedSwarms } from '../src/superTabs/invitedSwarms.js'
import type { Command } from '../src/superTabs/commands.js'
import { logger } from '../src/utils/logger.js'
import { PROFILE_STAGES, queryShape } from './bench/profile.js'

// Ken's prod profile (2026-10-28 20:12): a person's invitation list spent 313 ms planning its SuperTab read. Prisma sends
// `invitedEmails: { has }` as $expr, which only the autonomousEnv prefix of an index can bound, so the planner races every
// autonomousEnv index over every Swarm of the environment. The read runs here under Mongo's profiler with the plan cache
// emptied first: it must name its index (never planned, no $expr), read only the Swarms it returns, and list the same
// invitations as before. A fresh loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const DAY = 86_400_000
const NOW = Date.parse('2026-10-28T13:00:00.000Z')
let clock = NOW
const owner: AuthUser = { sub: '100000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const devOwner: AuthUser = { ...owner, autonomousEnv: 'dev' }
/** Signs in with their address in other case and spacing than the invitations hold it. */
const invited: AuthUser = { sub: '100000000000000000000009', email: ' Invited@Example.com ', autonomousEnv: 'prod', role: 'user' }
/** Other Swarms of the environment, each with a member, a machine and someone else invited: what prod's planner raced over. */
const OTHERS = 400
/** The index the read names: by Swarm id within an email, the order Prisma's read capped them in. */
const INVITED = { autonomousEnv: 1, invitedEmails: 1, _id: 1 }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_invite_plans_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db, () => clock)
}, 120000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

const run = (user: AuthUser, tab: string, command: Command) => store.execute(user, tab, { operationId: randomUUID(), command })
/** A Swarm of `user`'s that invites invited@example.com as `role`: its invitation's id and expiry. */
async function inviting(user: AuthUser, name: string, role: 'collaborator' | 'viewer') {
  const tabId = (await store.create(user, randomUUID(), name)).id
  const inviteId = (await run(user, tabId, { type: 'invite.create', email: 'invited@example.com', role, conversationId: 'lead' })).result.inviteId as string
  return { tabId, name, inviteId, role, expiresAt: clock + 7 * DAY }
}

/** One read of `collection` as the profiler saw it, with the plan cache emptied first: a read a test's planner serves from
 *  its cache is planned again in prod whenever the cache misses. */
interface Read { shape: string; plans: string[]; multiPlanned: boolean; planningMicros: number; docsExamined: number; returned: number }
async function profiled(collection: string, read: () => Promise<unknown>): Promise<Read[]> {
  await db.$runCommandRaw({ planCacheClear: collection })
  await db.$runCommandRaw({ profile: 0 })
  await db.$runCommandRaw({ drop: 'system.profile' }).catch(() => {})
  await db.$runCommandRaw({ create: 'system.profile', capped: true, size: 64 * 1024 * 1024 })
  await db.$runCommandRaw({ profile: 2, slowms: 0 })
  try {
    await read()
  } finally {
    await db.$runCommandRaw({ profile: 0 })
  }
  const stages = [{ $match: { ns: { $regex: `\\.${collection}$` }, op: { $in: ['command', 'getmore', 'query'] } } },
    { $project: { ...PROFILE_STAGES[0]!.$project, queryHash: 1, fromMultiPlanner: 1, planningTimeMicros: 1 } }]
  const rows = (await db.$runCommandRaw({ aggregate: 'system.profile', pipeline: stages, cursor: { batchSize: 100000 } }) as unknown as
    { cursor: { firstBatch: Array<{ match?: unknown; command?: { filter?: unknown }; planSummary?: string; docsExamined?: number; nreturned?: number
      queryHash?: string; fromMultiPlanner?: boolean; planningTimeMicros?: number }> } }).cursor.firstBatch
  const reads = new Map<string, Read>()
  for (const row of rows) {
    const id = row.queryHash ?? `${reads.size}`
    const filter = row.match ?? row.command?.filter
    const read = reads.get(id) ?? { shape: '', plans: [], multiPlanned: false, planningMicros: 0, docsExamined: 0, returned: 0 }
    if (filter !== undefined && !read.shape) read.shape = queryShape(filter)
    if (row.planSummary && !read.plans.includes(row.planSummary)) read.plans.push(row.planSummary)
    read.multiPlanned ||= !!row.fromMultiPlanner
    read.planningMicros += Number(row.planningTimeMicros ?? 0)
    read.docsExamined += Number(row.docsExamined ?? 0)
    read.returned += Number(row.nreturned ?? 0)
    reads.set(id, read)
  }
  return [...reads.values()]
}

describe('a person\'s invitation list (Ken\'s prod profile, 2026-10-28)', () => {
  let open: Array<Awaited<ReturnType<typeof inviting>>>
  beforeAll(async () => {
    // An invitation that expired, one accepted (no longer pending) and one in another environment: none is listed.
    clock = NOW - 10 * DAY
    await inviting(owner, 'Expired', 'viewer')
    clock = NOW - DAY
    const accepted = await inviting(owner, 'Accepted', 'collaborator')
    await run({ ...invited, email: 'invited@example.com' }, accepted.tabId, { type: 'invite.accept', inviteId: accepted.inviteId })
    await inviting(devOwner, 'Elsewhere', 'collaborator')
    open = [await inviting(owner, 'Alpha', 'collaborator'), await inviting(owner, 'Beta', 'viewer')]
    clock = NOW
    await db.superTab.createMany({ data: Array.from({ length: OTHERS }, (_, i) => ({ id: `other-${String(i).padStart(3, '0')}`, ownerId: owner.sub,
      autonomousEnv: 'prod', memberIds: [owner.sub, `member-${i}`], invitedEmails: [`someone-${i}@example.com`], machineIds: [`machine-${i}`],
      workspaceId: `workspace-${i}`, format: 2, state: { version: 2 } })) })
  })

  it('lists the pending invitations of its environment, as before', async () => {
    const listed = await store.invitations(invited)
    expect(listed.sort((a, b) => a.name.localeCompare(b.name))).toEqual(open.map(i => ({ tabId: i.tabId, name: i.name, inviteId: i.inviteId,
      role: i.role, expiresAt: i.expiresAt })))
  })

  it('reads the Swarms that invite them through the invitedEmails index by name, examining only those', async () => {
    const reads = await profiled('SuperTab', () => store.invitations(invited))
    expect(reads).toHaveLength(1)
    const [read] = reads
    expect(read!.shape, JSON.stringify(read)).not.toContain('$expr')
    expect(read!.multiPlanned, JSON.stringify(read)).toBe(false)
    expect(read!.plans).toEqual(['IXSCAN { autonomousEnv: 1, invitedEmails: 1, _id: 1 }'])
    // Alpha, Beta, and the expired one: its expiry is in the Swarm's head, read after.
    expect(read!.docsExamined, JSON.stringify(read)).toBeLessThanOrEqual(3)
  })

  // A rollback or a database whose index was never built: naming a missing index fails the read, so it reads without it.
  it('answers without the index when the database lacks it, and says so', async () => {
    const said = vi.spyOn(logger, 'error')
    await withoutIndex(async () => {
      const listed = await store.invitations(invited)
      expect(listed.map(i => i.tabId).sort()).toEqual(open.map(i => i.tabId).sort())
      expect(said).toHaveBeenCalledWith(expect.stringContaining('lacks the invitedEmails index'), { index: INVITED })
    }).finally(() => said.mockRestore())
  })
})

/** Runs `body` while the database lacks the index the read names, as after a rollback. */
async function withoutIndex(body: () => Promise<void>) {
  const listed = await db.$runCommandRaw({ listIndexes: 'SuperTab' }) as unknown as { cursor: { firstBatch: Array<{ key: Record<string, number>; name: string }> } }
  const index = listed.cursor.firstBatch.find(i => JSON.stringify(i.key) === JSON.stringify(INVITED))!
  await db.$runCommandRaw({ dropIndexes: 'SuperTab', index: index.name })
  try {
    await body()
  } finally {
    await db.$runCommandRaw({ createIndexes: 'SuperTab', indexes: [{ key: INVITED, name: index.name }] })
  }
}

// Review of #2020: Prisma's read sorted by Swarm id before taking 100. A read capped in another order lists another 100,
// and so other invitations, once more than 100 Swarms invite one address.
describe('more than 100 Swarms invite one address', () => {
  const CROWD = 105
  beforeAll(async () => {
    // Stored in reverse id order: a read that takes the index's or the collection's own order takes the wrong 100.
    await db.superTab.createMany({ data: Array.from({ length: CROWD }, (_, i) => ({ id: `crowd-${String(CROWD - 1 - i).padStart(3, '0')}`, ownerId: owner.sub,
      autonomousEnv: 'prod', memberIds: [owner.sub], invitedEmails: ['crowd@example.com'], machineIds: [], workspaceId: 'workspace-crowd',
      format: 2, state: { version: 2 } })) })
  })
  const first100 = Array.from({ length: 100 }, (_, i) => `crowd-${String(i).padStart(3, '0')}`)
  /** The Swarms the read before #2020 listed: Prisma's own `has` filter and cap. */
  const prismaRead = async () => (await db.superTab.findMany({ where: { autonomousEnv: 'prod', invitedEmails: { has: 'crowd@example.com' } }, take: 100,
    select: { id: true } })).map(r => r.id)

  it('reads the first 100 by Swarm id, as Prisma did, from the index without sorting them all', async () => {
    let ids: string[] = []
    const reads = await profiled('SuperTab', async () => { ids = (await invitedSwarms(db, 'prod', 'crowd@example.com', 100)).map(r => r.id) })
    expect(ids).toEqual(first100)
    expect(await prismaRead()).toEqual(first100)
    expect(reads).toHaveLength(1)
    expect(reads[0]!.multiPlanned, JSON.stringify(reads[0])).toBe(false)
    expect(reads[0]!.plans).toEqual(['IXSCAN { autonomousEnv: 1, invitedEmails: 1, _id: 1 }'])
    expect(reads[0]!.docsExamined, JSON.stringify(reads[0])).toBeLessThanOrEqual(100)
  })

  it('reads the same 100 in the same order without the index', async () => {
    const said = vi.spyOn(logger, 'error').mockImplementation(() => {})
    await withoutIndex(async () => {
      expect((await invitedSwarms(db, 'prod', 'crowd@example.com', 100)).map(r => r.id)).toEqual(first100)
      expect(await prismaRead()).toEqual(first100)
    }).finally(() => said.mockRestore())
  })
})
