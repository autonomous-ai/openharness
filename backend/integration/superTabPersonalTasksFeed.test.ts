import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { commandSchema } from '../src/superTabs/commands.js'
import type { Conversation } from '../src/superTabs/model.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { feedIdsOf, markFeedIds } from '../src/superTabs/read/feedIds.js'
import { linkOlderDuplicates } from '../src/superTabs/read/olderDuplicates.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// Task #4203: the person's Tasks feed is the history of their own agents' tasks, their requests and their proposals,
// dormant and archived ones too, newest first, paged through one index, and only what they may read.
let replica: MongoMemoryReplSet, db: PrismaClient
const owner: AuthUser = { sub: '560000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '560000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const bystander: AuthUser = { sub: '560000000000000000000003', email: 'bystander@example.com', autonomousEnv: 'prod', role: 'user' }
const outsider: AuthUser = { sub: '560000000000000000000004', email: 'outsider@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MINUTE = 60_000

beforeAll(async () => {
  ({ replica, db } = await planDatabase('personal_tasks_feed'))
  await listNamedIndexes(db)
  for (const u of [owner, peer, bystander, outsider]) await db.user.create({ data: { id: u.sub, externalId: `fixture-${u.sub}`, email: u.email, autonomousEnv: 'prod' } })
  for (const [machineId, user] of [['feed-owner-mac', owner], ['feed-peer-mac', peer]] as const)
    await db.machine.create({ data: { machineId, userId: user.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
})
afterAll(async () => { await db?.$disconnect(); await replica?.stop() })

/** A Swarm where peer's own agent works a task the owner asked for (then archived and dormant), peer asked for a task and
 *  proposed one, the owner's agent works the owner's own task, and a private project of the owner's holds tasks that name peer. */
async function fixture() {
  let now = Date.now() - 1_000 * MINUTE
  const store = new SuperTabStore(db, () => now, null, { readCache: null })
  const tab = (await store.create(owner, randomUUID(), 'Feed', 'public')).id
  const execute = async (command: unknown, user = owner, asAgentId?: string) => {
    now += MINUTE
    return (await store.execute(user, tab, { operationId: randomUUID(), command: commandSchema.parse(command) }, asAgentId)).result as Record<string, unknown>
  }
  for (const person of [peer, bystander]) {
    const invitation = await execute({ type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
    await execute({ type: 'invite.accept', inviteId: invitation.inviteId }, person)
  }
  const pm = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'feed-owner-mac', harnessId: randomUUID(), name: 'PM', configuration: config, lead: true })).agentId)
  const task = async (title: string, requesterId?: string) => String((await execute({ type: 'conversation.create', title, priority: 'P2',
    ...requesterId ? { requesterId } : { noRequesterReason: 'fixture' },
    task: { goal: title, changes: title, constraints: 'none', owns: ['backend/'] }, checks: [{ description: `${title} works`, independent: false }] }, owner, pm)).conversationId)
  const theirs = await task('Peer agent work', owner.sub)
  const peerAgent = String((await execute({ type: 'agent.add', conversationId: theirs, machineId: 'feed-peer-mac', harnessId: randomUUID(), name: 'Peers', configuration: config, lead: false }, peer)).agentId)
  await execute({ type: 'work.assign', conversationId: theirs, agentId: peerAgent }, owner, pm)
  const asked = await task('Peer asked', peer.sub)
  // The Board switch is #3819's command; the proposal cards read only its stored value.
  const head = await db.swarmHead.findUniqueOrThrow({ where: { id: `${tab}:head` } })
  const data = head.data as unknown as { projects: Array<{ boardMode?: true }> }
  data.projects[0]!.boardMode = true
  await db.swarmHead.update({ where: { id: head.id }, data: { data: data as never, version: head.version + 1 } })
  const proposal = String((await execute({ type: 'proposal.create', projectId: 'lead', title: 'Keep drafts', text: 'Keep offline drafts', goal: 'Preserve work',
    why: 'Reconnect loses drafts', doneWhen: 'Draft returns', evidence: ['Repro'], priority: 'P2' }, peer)).conversationId)
  const ownersOwn = await task('Owner work', owner.sub)
  const ownerAgent = String((await execute({ type: 'agent.add', conversationId: ownersOwn, machineId: 'feed-owner-mac', harnessId: randomUUID(), name: 'Builder', configuration: config, lead: false })).agentId)
  await execute({ type: 'work.assign', conversationId: ownersOwn, agentId: ownerAgent }, owner, pm)
  const secret = String((await execute({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' })).projectId)
  // Archived and quiet, as the archive pass leaves a finished task: still in its people's history.
  const row = await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: tab, key: theirs } } })
  await db.swarmGroup.update({ where: { id: row.id }, data: { archived: true, dormant: true,
    data: { ...row.data as object, archived: true, dormant: true } as never } })
  return { store, tab, execute, now: () => now, theirs, asked, proposal, ownersOwn, secret, peerAgent, ownerAgent }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/** `n` copies of `key`'s row under new keys, each a minute older than the one before from `newest`, in `projectId`. */
async function copies(f: Fixture, key: string, n: number, newest: number, projectId?: string, tie = 0): Promise<string[]> {
  const { id: _id, ...row } = await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: f.tab, key } } })
  const keys = Array.from({ length: n }, (_, i) => `${projectId ? 'hidden' : 'copy'}-${String(i).padStart(3, '0')}`)
  await db.swarmGroup.createMany({ data: keys.map((k, i) => {
    // `tie` rows share one moment: the cursor goes on by key within it.
    const at = new Date(newest - Math.max(0, i - tie) * MINUTE)
    return { ...row, id: `${f.tab}:${k}`, key: k, ordinal: row.ordinal + i + 1, lastActivityAt: at, ...projectId ? { projectId } : {},
      data: { ...row.data as object, id: k, title: k, lastActivityAt: at.toISOString(), ...projectId ? { projectId } : {} } as never }
  }) })
  return keys
}

const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id)

describe('the person\'s Tasks feed (task #4203)', () => {
  it('lists my agents\' tasks, archived ones too, my requests and my proposals, never another\'s own work', async () => {
    const f = await fixture()
    const feed = (await new SwarmReads(f.store).firstLoad(peer, f.tab)).personalTasks!
    expect(feed).toMatchObject({ reset: true, removed: [], olderCursor: null })
    expect(ids(feed.upserts)).toEqual([f.proposal, f.asked, f.theirs])
    expect(feed.upserts.find(r => r.id === f.theirs)).toMatchObject({ status: 'working', agent: { id: f.peerAgent },
      requester: { id: owner.sub } })
  })

  it('pages older tasks newest first through a cursor, with no repeat or gap across rows of the same moment', async () => {
    const f = await fixture()
    const older = await copies(f, f.asked, 60, f.now() - 10 * MINUTE, undefined, 5)
    const reads = new SwarmReads(f.store)
    const first = (await reads.firstLoad(peer, f.tab)).personalTasks!
    expect(first.upserts).toHaveLength(50)
    expect(first.olderCursor).toEqual(expect.any(String))
    const second = await reads.personalTasks(peer, f.tab, first.olderCursor!)
    expect(second).toMatchObject({ reset: false, removed: [], olderCursor: null })
    const all = [...ids(first.upserts), ...ids(second.upserts)]
    expect(new Set(all).size).toBe(all.length)
    expect(new Set(all)).toEqual(new Set([f.proposal, f.asked, f.theirs, ...older]))
    const at = [...first.upserts, ...second.upserts].map(r => r.at)
    expect(at).toEqual([...at].sort((a, b) => b - a))
  })

  it('never lists, nor hands out as a cursor, a task the reader may not read, and lists nothing for a bystander', async () => {
    const f = await fixture()
    // Newer than everything, naming peer, in a project only the owner reads.
    const hidden = await copies(f, f.asked, 55, f.now() + 100 * MINUTE, f.secret)
    await copies(f, f.asked, 49, f.now() - 10 * MINUTE)
    const reads = new SwarmReads(f.store)
    const first = (await reads.firstLoad(peer, f.tab)).personalTasks!
    expect(first.upserts).toHaveLength(50)
    expect(ids(first.upserts).some(id => hidden.includes(id))).toBe(false)
    const cursor = JSON.parse(Buffer.from(first.olderCursor!, 'base64url').toString()) as { k: string }
    expect(ids(first.upserts)).toContain(cursor.k)
    const second = await reads.personalTasks(peer, f.tab, first.olderCursor!)
    expect(ids(second.upserts).some(id => hidden.includes(id))).toBe(false)
    expect((await reads.firstLoad(bystander, f.tab)).personalTasks!.upserts).toEqual([])
    await expect(reads.personalTasks(outsider, f.tab)).rejects.toThrow()
    await expect(reads.personalTasks(peer, f.tab, 'not-a-cursor')).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  })

  it('reads a page through the feed index, examining about what it returns', async () => {
    const f = await fixture()
    await copies(f, f.asked, 120, f.now() - 10 * MINUTE)
    const reads = new SwarmReads(f.store)
    const first = (await reads.firstLoad(peer, f.tab)).personalTasks!
    const entries = await profiled(db, () => reads.personalTasks(peer, f.tab, first.olderCursor!))
    const feed = plan(readsOf(entries))
    expect(feed.length).toBeGreaterThan(0)
    for (const read of feed) {
      expect(read.plan).toContain('IXSCAN { tabId: 1, feedIds: 1, lastActivityAt: 1, key: 1 }')
      expect(read.docsExamined).toBeLessThanOrEqual(read.returned + 1)
    }
  })

  it('keeps a task of my agent after that agent is closed, by the login it ran under', async () => {
    const f = await fixture()
    await f.execute({ type: 'agent.remove', agentId: f.peerAgent }, peer)
    const feed = (await new SwarmReads(f.store).firstLoad(peer, f.tab)).personalTasks!
    expect(ids(feed.upserts)).toContain(f.theirs)
    expect(feed.upserts.find(r => r.id === f.theirs)!.agent).toBeNull()
  })

  it('skips tasks I can no longer read inside the database: a page is one or two reads however many there are', async () => {
    const f = await fixture()
    await copies(f, f.asked, 300, f.now() + 100 * MINUTE, f.secret)
    const reads = new SwarmReads(f.store)
    let page: Awaited<ReturnType<typeof reads.personalTasks>> | undefined
    const entries = await profiled(db, async () => { page = await reads.personalTasks(peer, f.tab) })
    expect(ids(page!.upserts)).toEqual([f.proposal, f.asked, f.theirs])
    const feed = plan(readsOf(entries))
    expect(feed.length).toBeLessThanOrEqual(2)
    for (const read of feed) expect(read.returned).toBeLessThanOrEqual(50)
  })

  it('sets the column at startup on rows written before it, with the login of an assignment\'s agent from before it was stored', async () => {
    const f = await fixture()
    await db.$runCommandRaw({ update: 'SwarmGroup', updates: [{ q: { tabId: f.tab }, u: { $unset: { feedIds: '', 'data.assignment.execution.contributorId': '' } }, multi: true }] })
    expect(await markFeedIds(db)).toBeGreaterThan(0)
    const rows = await db.swarmGroup.findMany({ where: { tabId: f.tab } })
    const column = (key: string) => [...rows.find(r => r.key === key)!.feedIds].sort()
    expect(column(f.theirs)).toEqual([owner.sub, f.peerAgent, peer.sub].sort())
    expect(column(f.ownersOwn)).toEqual([owner.sub, f.ownerAgent].sort())
    for (const row of rows.filter(r => !(r.data as unknown as Conversation).assignment))
      expect([...row.feedIds].sort(), row.key).toEqual(feedIdsOf(row.data as unknown as Conversation).sort())
    expect(await markFeedIds(db)).toBe(0)
  })
})

// Task #4480: a duplicate links to the task its reason names however long that task has been quiet, only in its own project.
describe('a duplicate of a quiet task (task #4480)', () => {
  /** [key] gone quiet two days ago, as the dormancy sweep leaves a finished task: no command loads it unless named. */
  const quiet = async (f: Fixture, key: string) => {
    const row = await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: f.tab, key } } })
    const at = new Date(f.now() - 2 * 24 * 60 * MINUTE)
    await db.swarmGroup.update({ where: { id: row.id }, data: { dormant: true, lastActivityAt: at,
      data: { ...row.data as object, dormant: true, lastActivityAt: at.toISOString() } as never } })
    return (row.data as unknown as Conversation).number!
  }
  const feedOf = async (f: Fixture) => ids((await new SwarmReads(f.store).firstLoad(peer, f.tab)).personalTasks!.upserts)
  const create = async (f: Fixture, title: string, projectId?: string) => String((await f.execute({ type: 'conversation.create', title, priority: 'P2',
    requesterId: peer.sub, ...projectId ? { projectId } : {}, task: { goal: title, changes: title, constraints: 'none', owns: ['backend/'] },
    checks: [{ description: `${title} works`, independent: false }] })).conversationId)
  const cancel = (f: Fixture, conversationId: string, reason: string) => f.execute({ type: 'work.cancel', conversationId, assignmentId: 'current', reason })

  it('leaves the Tasks feed when its real task has been quiet for days, cancelled now or before', async () => {
    const f = await fixture()
    const real = await quiet(f, f.asked)
    const now = await create(f, 'Duplicate cancelled now'), before = await create(f, 'Duplicate cancelled before')
    await cancel(f, before, 'Duplicate')
    expect(await feedOf(f)).toEqual(expect.arrayContaining([now, before]))
    await cancel(f, now, `Duplicate of #${real}`)
    await cancel(f, before, `Duplicate of #${real}`)
    const feed = await feedOf(f)
    expect(feed).not.toContain(now)
    expect(feed).not.toContain(before)
    for (const key of [now, before]) {
      const row = await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: f.tab, key } } })
      expect((row.data as unknown as Conversation).foldedInto, key).toEqual([f.asked])
    }
  })

  it('leaves at worker start when it was cancelled before #4480 shipped, with a line saying where its work goes on', async () => {
    const f = await fixture()
    const real = await quiet(f, f.asked)
    const other = String((await f.execute({ type: 'project.create', name: 'Other', visibility: 'public', brief: '' })).projectId)
    const elsewhere = ((await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: f.tab, key: await create(f, 'Real elsewhere', other) } } }))
      .data as unknown as Conversation).number
    // An assigned task cancelled as a duplicate, its reason in its assignment's result.
    const assigned = await create(f, 'Assigned duplicate')
    const agent = String((await f.execute({ type: 'agent.add', conversationId: assigned, machineId: 'feed-peer-mac', harnessId: randomUUID(), name: 'Dupe', configuration: config, lead: false }, peer)).agentId)
    await f.execute({ type: 'work.assign', conversationId: assigned, agentId: agent })
    const assignment = ((await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: f.tab, key: assigned } } })).data as unknown as Conversation).assignment!
    await f.execute({ type: 'work.cancel', conversationId: assigned, assignmentId: assignment.id, reason: `Duplicate of #${real}` })
    // Tasks nobody was assigned, their reasons only in their cancel lines.
    const inside = await create(f, 'Unassigned duplicate'), across = await create(f, 'Across projects'), waiting = await create(f, 'Waiting')
    await cancel(f, inside, `Being done inside #${real}`)
    await cancel(f, across, `Duplicate of #${elsewhere}`)
    await cancel(f, waiting, `Waiting on #${real}`)
    // As a backend from before #4480 stored them: no number column and no link, so each is still in the feed.
    await db.$runCommandRaw({ update: 'SwarmGroup', updates: [{ q: { tabId: f.tab }, u: { $unset: { number: '', feedIds: '', 'data.foldedInto': '' } }, multi: true }] })
    await markFeedIds(db)
    expect(await feedOf(f)).toEqual(expect.arrayContaining([assigned, inside, across, waiting]))

    expect(await linkOlderDuplicates(db, f.store)).toBe(2)
    const feed = await feedOf(f)
    expect(feed).not.toContain(assigned)
    expect(feed).not.toContain(inside)
    expect(feed).toEqual(expect.arrayContaining([across, waiting, f.asked]))
    for (const key of [assigned, inside]) {
      const lines = await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: key } })
      expect(lines.filter(m => m.text.includes(`goes on in #${real}`)), key).toHaveLength(1)
    }
    const rows = await db.swarmGroup.findMany({ where: { tabId: f.tab } })
    for (const row of rows) expect(row.number, row.key).toBe((row.data as unknown as Conversation).number ?? null)
    expect(await linkOlderDuplicates(db, f.store)).toBe(0)
  })

  it('stays when the task it names is in another project', async () => {
    const f = await fixture()
    const other = String((await f.execute({ type: 'project.create', name: 'Other', visibility: 'public', brief: '' })).projectId)
    const elsewhere = await create(f, 'Real task elsewhere', other)
    const number = (await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: f.tab, key: elsewhere } } })).data as unknown as Conversation
    const dup = await create(f, 'Named across projects')
    await cancel(f, dup, `Duplicate of #${number.number}`)
    expect(await feedOf(f)).toContain(dup)
    const row = await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: f.tab, key: dup } } })
    expect((row.data as unknown as Conversation).foldedInto).toBeUndefined()
  })
})

describe('the Tasks feed backfill when the database refuses its writes (review of #3465)', () => {
  it('stops and says so, never reading the same rows again forever', async () => {
    const f = await fixture()
    await db.$runCommandRaw({ update: 'SwarmGroup', updates: [{ q: { tabId: f.tab }, u: { $unset: { feedIds: '' } }, multi: true }] })
    // Any row that would get a non-empty column is refused.
    await db.$runCommandRaw({ collMod: 'SwarmGroup', validator: { $or: [{ feedIds: { $exists: false } }, { feedIds: { $size: 0 } }] }, validationAction: 'error' })
    try {
      await expect(markFeedIds(db)).rejects.toThrow(/refused/)
    } finally {
      await db.$runCommandRaw({ collMod: 'SwarmGroup', validator: {} })
    }
    expect(await markFeedIds(db)).toBeGreaterThan(0)
  }, 20_000)
})

const readsOf = (entries: Awaited<ReturnType<typeof profiled>>) => reads(entries, 'SwarmGroup', ['feedIds'])
