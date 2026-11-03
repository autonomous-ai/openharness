import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient, type Prisma } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { buddyChatId } from '../src/superTabs/buddies.js'
import { refreshThreads, threadFacet } from '../src/superTabs/pageReads.js'
import { backfillThreads } from '../src/superTabs/threadBackfill.js'
import type { SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, outsider as outsiderActor, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'
import { profiledReads } from './profiledReads.test-support.js'
import { filterOf, plan, profiled, reads } from './plans.test-support.js'

// Spec 5 phase D (docs/superpowers/specs/2026-10-30-swarm-messages-delta-and-retention-design.md): a page reads its threads'
// summaries from SuperTabThread once its Swarm is backfilled, and every reader's threads stay what the $facet gave them.
// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const user = (actor: { userId: string; email: string }): AuthUser => ({ sub: actor.userId, email: actor.email, autonomousEnv: 'prod', role: 'user' })
const [owner, peer, outsider] = [ownerActor, peerActor, outsiderActor].map(user) as [AuthUser, AuthUser, AuthUser]
const MIGRATED = NOW - 60_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_threads_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const each of [owner, peer, outsider]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
  // The owner's own machine runs the Swarm's agents, so reading as one of them needs no machine share.
  await db.machine.create({ data: { machineId: 'host', userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  store = new SuperTabStore(db)
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

const person = (actor: AuthUser) => ({ kind: 'person', id: actor.sub, name: actor.email, membershipGeneration: 'gen' })
const agent = (id: string) => ({ kind: 'agent', id, name: id, membershipGeneration: 'gen' })
let sequence = 10, scenes = 0

/** A migrated Swarm: a Lead, a worker in Web, and peer's Buddy, in the project chat and in its own Buddy chat. Web holds a lone
 *  root and threads with every kind of reply a reader may skip: a note to the Lead alone, a route row (no Buddy reads it), a
 *  tag. Its root `w-b` is a note to the worker alone. The Buddy chat holds a thread with replies of a Buddy session. */
async function scene() {
  const s = swarm(MIGRATED)
  s.join(peerActor)
  s.join(outsiderActor)
  const lead = s.add('lead-harness', 'lead', true, ownerActor, 'host', owner.sub)
  const web = s.group('Web')
  const worker = s.add('worker-harness', web, false, ownerActor, 'host', owner.sub)
  const buddy = s.add('buddy-harness', 'lead', false, ownerActor, 'host', owner.sub)
  let buddyChat = ''
  s.edit(state => {
    const generation = state.people.find(p => p.id === peer.sub)!.generation
    const projectId = state.projects![0]!.id
    state.agents.find(a => a.id === buddy)!.buddyOf = { personId: peer.sub, generation }
    buddyChat = buddyChatId(projectId, { id: peer.sub, generation })
    state.conversations.push({ id: buddyChat, kind: 'buddy', projectId, title: 'Buddy', leadId: null, agentIds: [buddy], archived: false,
      brief: '', checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: peer.sub, generation }] } })
  })
  const tabId = `tab-${randomUUID()}`
  await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId } as SuperTabState, revision: 700 })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  const note = (to: string) => ({ source: { kind: 'note', recipientsOnly: true }, recipientIds: [to] })
  // Message ids are unique across Swarms: each scene's carry its own prefix.
  const prefix = `s${++scenes}-`, id = (name: string) => prefix + name
  const rows: Row[] = [
    { id: 'w-lone', conversationId: web, thread: 'w-lone', author: person(owner) },
    { id: 'w-a', conversationId: web, thread: 'w-a', author: person(owner) },
    { id: 'w-a1', conversationId: web, thread: 'w-a', author: agent(worker) },
    { id: 'w-a2', conversationId: web, thread: 'w-a', author: agent(worker), ...note(lead) },
    { id: 'w-a3', conversationId: web, thread: 'w-a', author: agent(lead), source: { kind: 'route' } },
    { id: 'w-a4', conversationId: web, thread: 'w-a', author: person(peer), mentions: [outsider.sub] },
    { id: 'w-a5', conversationId: web, thread: 'w-a', author: person(outsider) },
    { id: 'w-b', conversationId: web, thread: 'w-b', author: agent(lead), ...note(worker) },
    { id: 'w-b1', conversationId: web, thread: 'w-b', author: agent(worker) },
    { id: 'w-c', conversationId: web, thread: 'w-c', author: person(owner) },
    { id: 'w-c1', conversationId: web, thread: 'w-c', author: agent(lead), source: { kind: 'route' } },
    { id: 'b-root', conversationId: buddyChat, thread: 'b-root', author: person(peer) },
    { id: 'b-r1', conversationId: buddyChat, thread: 'b-root', author: agent(buddy) },
    { id: 'b-r2', conversationId: buddyChat, thread: 'b-root', author: person(peer), buddySession: true },
    { id: 'b-r3', conversationId: buddyChat, thread: 'b-root', author: agent(buddy), buddySession: true },
  ]
  await insert(tabId, prefix, rows)
  const readers: Array<[string, string, AuthUser, string?]> = [['owner', web, owner], ['peer', web, peer], ['outsider', web, outsider],
    ['Buddy', web, owner, buddy], ['worker', web, owner, worker], ['Lead', web, owner, lead], ['peer in the Buddy chat', buddyChat, peer],
    ['Buddy in its chat', buddyChat, owner, buddy]]
  return { tabId, web, buddyChat, lead, worker, buddy, readers, prefix, id }
}

interface Row { id: string; conversationId: string; thread: string; author: object; mentions?: string[]; source?: object; recipientIds?: string[]; buddySession?: boolean }
/** Rows written as an older release writes them, no summary touched; ids and threads named without the scene's prefix. */
async function insert(tabId: string, prefix: string, rows: Row[]) {
  await db.superTabMessage.createMany({ data: rows.map(row => ({ recipientIds: [], mentions: [], ...row, id: prefix + row.id, thread: prefix + row.thread,
    tabId, text: row.id, sequence: ++sequence, createdAt: new Date() })) })
}

/** Each reader's newest page of its conversation. */
const pages = async (s: Awaited<ReturnType<typeof scene>>) => Object.fromEntries(await Promise.all(s.readers.map(async ([name, conversationId, as, agentId]) =>
  [name, await store.messages(as, s.tabId, conversationId, {}, agentId)] as const)))
const replies = (page: { threads: Array<{ id: string; replies: number }> }) => Object.fromEntries(page.threads.map(t => [t.id.replace(/^s\d+-/, ''), t.replies]))
const sorted = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort()

describe('thread summaries (spec 5 phase D)', () => {
  it('gives every reader the same page from the summaries as from the $facet, lone roots and hidden replies included', async () => {
    const s = await scene()
    const before = await pages(s)
    // Each reader skips its own kinds of reply: no summary counts a note to agents alone (a reader of `w-b`'s root still counts
    // its reply), and a Buddy no route row, nor the session's replies in its own chat.
    expect(Object.fromEntries(Object.entries(before).map(([name, page]) => [name, replies(page)]))).toEqual({
      owner: { 'w-a': 4, 'w-c': 1 }, peer: { 'w-a': 4, 'w-c': 1 }, outsider: { 'w-a': 4, 'w-c': 1 }, Buddy: { 'w-a': 3 },
      worker: { 'w-a': 4, 'w-b': 1, 'w-c': 1 }, Lead: { 'w-a': 4, 'w-c': 1 }, 'peer in the Buddy chat': { 'b-root': 3 }, 'Buddy in its chat': { 'b-root': 1 } })
    expect(await db.superTabThread.count({ where: { tabId: s.tabId } })).toBe(0)

    await backfillThreads(db, Date.now())
    // One summary per thread with a reply: none for the lone root.
    expect((await db.superTabThread.findMany({ where: { tabId: s.tabId }, select: { id: true } })).map(t => t.id).sort()).toEqual(['b-root', 'w-a', 'w-b', 'w-c'].map(s.id))
    expect(await pages(s)).toEqual(before)
  })

  it('reads through the $facet until its Swarm is backfilled, and the summaries by id after', async () => {
    const s = await scene()
    const read = () => profiledReads(db, /\.SuperTab(Message|Thread)$/, () => store.messages(owner, s.tabId, s.web, {}))
    const facet = await read()
    expect(facet.byCollection.SuperTabThread).toBeUndefined()
    await backfillThreads(db, Date.now())
    const summaries = await read()
    expect(summaries.value).toEqual(facet.value)
    expect(summaries.byCollection).toEqual({ SuperTabMessage: facet.byCollection.SuperTabMessage! - 1, SuperTabThread: 1 })
  })

  it('rewrites a thread\'s summary in the transaction that sends a reply, a lone root\'s first one too', async () => {
    const s = await scene()
    await backfillThreads(db, Date.now())
    for (const replyTo of ['w-a', 'w-lone'].map(s.id)) {
      await store.execute(owner, s.tabId, { operationId: randomUUID(), command: { type: 'message.send', conversationId: s.web, text: 'More', replyTo,
        recipientIds: [], mentions: [outsider.sub] } as never })
      const stored = await db.superTabThread.findUniqueOrThrow({ where: { id: replyTo } })
      const facet = await threadFacet(db, s.tabId, s.web, [replyTo])
      expect(sorted(stored.parts as unknown[])).toEqual(sorted(facet.parts))
      expect(sorted(stored.mentions as unknown[])).toEqual(sorted(facet.mentions))
    }
    expect(replies(await store.messages(owner, s.tabId, s.web, {}))).toEqual({ 'w-a': 5, 'w-c': 1, 'w-lone': 1 })
  })

  it('leaves no summary when the reply\'s transaction fails', async () => {
    const s = await scene()
    await expect(db.$transaction(async tx => {
      await tx.superTabMessage.create({ data: { id: s.id('w-lone-r'), tabId: s.tabId, conversationId: s.web, thread: s.id('w-lone'), sequence: 999, text: 'x',
        author: person(owner), recipientIds: [], mentions: [] } })
      await refreshThreads(tx, s.tabId, s.web, [s.id('w-lone')])
      expect(await tx.superTabThread.findUnique({ where: { id: s.id('w-lone') } })).not.toBeNull()
      throw new Error('rolled back')
    })).rejects.toThrow('rolled back')
    expect(await db.superTabThread.findUnique({ where: { id: s.id('w-lone') } })).toBeNull()
  })

  it('counts at the next backfill a reply an older release wrote after the marker', async () => {
    const s = await scene()
    await backfillThreads(db, Date.now())
    // An older release writes the reply as any command does (its conversation moves on), but leaves the summary as it was.
    const summary = async () => (await db.$runCommandRaw({ find: 'SuperTabThread', filter: { _id: s.id('w-a') } }) as unknown as
      { cursor: { firstBatch: Prisma.InputJsonObject[] } }).cursor.firstBatch[0]!
    const before = await summary()
    await store.execute(owner, s.tabId, { operationId: randomUUID(), command: { type: 'message.send', conversationId: s.web, text: 'Late', replyTo: s.id('w-a'),
      recipientIds: [] } as never })
    await db.$runCommandRaw({ update: 'SuperTabThread', updates: [{ q: { _id: s.id('w-a') }, u: before }] })
    expect(replies(await store.messages(owner, s.tabId, s.web, {}))['w-a']).toBe(4)
    const entries = await profiled(db, () => backfillThreads(db, Date.now()))
    expect(replies(await store.messages(owner, s.tabId, s.web, {}))['w-a']).toBe(5)
    // Only the changed conversation's newest messages are read again, never every message of each Swarm.
    expect(plan(reads(entries, 'SuperTabMessage', ['tabId'], ['conversationId']))).toEqual([])
    const walked = reads(entries, 'SuperTabMessage', ['conversationId'], ['thread']).filter(entry => JSON.stringify(filterOf(entry)).includes(s.tabId))
    expect(walked.reduce((sum, entry) => sum + entry.docsExamined, 0), JSON.stringify(plan(walked))).toBeLessThanOrEqual(12)
    const stored = await db.superTabThread.findUniqueOrThrow({ where: { id: s.id('w-a') } })
    expect(sorted(stored.parts as unknown[])).toEqual(sorted((await threadFacet(db, s.tabId, s.web, [s.id('w-a')])).parts))
  })
})
