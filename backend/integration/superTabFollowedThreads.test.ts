import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import * as parts from '../src/superTabs/parts/index.js'
import { swarmTransaction } from '../src/superTabs/cache.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { HostReads } from '../src/superTabs/read/host.js'
import { buddyChatId, openSwarmBuddyChat } from '../src/superTabs/buddies.js'
import { resetInboxReads } from '../src/superTabs/read/inbox.js'
import { MAX_READ_THREADS, resetThreadsReads, TAGGED_THREADS, THREADS_READS, THREADS_WINDOW_MS } from '../src/superTabs/read/followedThreads.js'
import type { Author, Conversation, SuperTabState } from '../src/superTabs/model.js'
import { stableId } from '../src/superTabs/model.js'
import { THREAD_MARK_CAP, writeThreadFollow, writeThreadMark } from '../src/superTabs/readMarks.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { backfillThreads } from '../src/superTabs/threadBackfill.js'
import { NOW, outsider as outsiderActor, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'
import { PROFILE_STAGES, profileEntry, type ProfileEntry } from './bench/profile.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
let store: SuperTabStore
const user = (actor: { userId: string; email: string }): AuthUser => ({ sub: actor.userId, email: actor.email, autonomousEnv: 'prod', role: 'user' })
const [owner, peer, outsider] = [ownerActor, peerActor, outsiderActor].map(user) as [AuthUser, AuthUser, AuthUser]
const ownerTeam: AuthUser = { ...owner, harnessSessionId: 'owner-team-session', harnessSessionKind: 'team' }
const signedIn = (authorization: string | undefined) =>
  authorization === 'Bearer team' ? ownerTeam : [owner, peer, outsider].find(u => `Bearer ${u.sub}` === authorization)
const MIGRATED = NOW - 60_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_follows_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const each of [owner, peer, outsider]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'host', userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  store = new SuperTabStore(db)
  app = Fastify()
  app.setErrorHandler(errorHandler)
  // External SSO is replaced with fixture accounts; every permission and write below is real.
  app.addHook('onRequest', async (request, reply) => {
    const found = signedIn(request.headers.authorization)
    if (!found) return reply.code(401).send({ success: false })
    request.user = found
  })
  await app.register(superTabRoutes, { store, github: null, reads: new SwarmReads(store), hosts: new HostReads(store) })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm in parts: a public project ("Web", with a worker on the owner's machine), a project private to its owner
 *  ("Secret work"), and peer's Buddy chat. */
async function scene(extra: (s: ReturnType<typeof swarm>) => void = () => {}) {
  const s = swarm(MIGRATED)
  s.join(peerActor)
  s.join(outsiderActor)
  const secret = s.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).projectId as string
  const open = s.run({ type: 'project.create', name: 'Open', visibility: 'public', brief: '' }).projectId as string
  const openChat = s.group('Open chat', open)
  const web = s.group('Web')
  const worker = s.add('worker-harness', web, false, ownerActor, 'host', owner.sub)
  s.run({ type: 'work.assign', conversationId: web, agentId: worker })
  const secretGroup = s.group('Secret work', secret)
  let buddyId = s.group('Peer\'s Buddy')
  s.edit(state => {
    const generation = state.people.find(p => p.id === peer.sub)!.generation
    const chat = state.conversations.find(c => c.id === buddyId)!
    buddyId = buddyChatId(chat.projectId ?? 'lead', { id: peer.sub, generation })
    Object.assign(chat, { id: buddyId, kind: 'buddy', leadId: null, agentIds: [], audience: { people: [{ id: peer.sub, generation }] } })
  })
  extra(s)
  const tabId = `tab-${randomUUID()}`
  const state = { ...structuredClone(s.state), id: tabId } as SuperTabState
  await writeLegacySwarm(db, { state, revision: 3 })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  return { tabId, web, worker, secret, secretGroup, buddyId, open, openChat }
}

const call = async (method: 'GET' | 'POST', url: string, as: AuthUser | 'team' = owner, payload?: unknown) => {
  const response = await app.inject({ method, url, headers: { authorization: `Bearer ${as === 'team' ? 'team' : as.sub}` }, ...(payload === undefined ? {} : { payload: payload as never }) })
  return { status: response.statusCode, body: response.json() as { data: any; error?: { code: string; message: string } }, headers: response.headers }
}
const inbox = (tabId: string, as: AuthUser | 'team' = owner) => call('GET', `/api/super-tabs/${tabId}/inbox`, as)
const threads = (tabId: string, as: AuthUser | 'team' = owner) => call('GET', `/api/super-tabs/${tabId}/threads`, as)
const follow = (tabId: string, conversationId: string, root: string, value: boolean | null, as: AuthUser | 'team' = owner, query = '') =>
  call('POST', `/api/super-tabs/${tabId}/conversations/${conversationId}/threads/${root}/follow${query}`, as, { follow: value })
const markThread = (tabId: string, conversationId: string, root: string, sequence: number, as: AuthUser = owner) =>
  call('POST', `/api/super-tabs/${tabId}/conversations/${conversationId}/threads/${root}/read`, as, { sequence })
const markRead = async (tabId: string, conversationId: string, sequence: number, as: AuthUser) => {
  expect((await call('POST', `/api/super-tabs/${tabId}/conversations/${conversationId}/read`, as, { sequence })).status).toBe(200)
}
const agentAuthor = (id: string): Author => ({ kind: 'agent', id, name: id, membershipGeneration: 'fixture' })
const personAuthor = (u: AuthUser): Author => ({ kind: 'person', id: u.sub, name: u.email, membershipGeneration: 'fixture' })

/** Rows stored as the store stores them: numbered after the chat's newest, the chat's counters moved as numberMessages moves
 *  them for rows people read (as superTabInbox.test.ts). */
async function insert(tabId: string, conversationId: string, rows: Array<{ id?: string; text: string; author: Author; thread?: string | null;
  source?: Record<string, unknown>; recipientIds?: string[]; mentions?: string[]; buddySession?: boolean; buddyProject?: string }>) {
  const ids: string[] = []
  await swarmTransaction(db, async tx => {
    const current = (await parts.loadActive(tx, tabId, { groupIds: [conversationId] })).groups.find(g => g.key === conversationId)!
    const data = structuredClone(current.data!) as Conversation
    const messages: Array<{ id: string; tabId: string; conversationId: string; sequence: number; author: never; text: string;
      thread: string | null; recipientIds: string[]; mentions: string[]; source?: never; buddySession?: boolean; buddyProject?: string; createdAt: Date }> = []
    for (const row of rows) {
      const sequence = (data.messageSeq ?? 0) + 1
      const id = row.id ?? `m-${randomUUID()}`
      ids.push(id)
      data.messageSeq = sequence
      if (!row.source?.recipientsOnly) {
        data.lastMessageSequence = sequence
        data.lastActivityAt = new Date().toISOString()
        if (!row.thread || row.thread === id) data.lastMainSequence = sequence
      }
      messages.push({ id, tabId, conversationId, sequence, author: row.author as never, text: row.text,
        thread: row.thread === undefined ? id : row.thread, recipientIds: row.recipientIds ?? [], mentions: row.mentions ?? [],
        ...(row.source ? { source: row.source as never } : {}), ...(row.buddySession ? { buddySession: true } : {}), ...(row.buddyProject ? { buddyProject: row.buddyProject } : {}), createdAt: new Date() })
    }
    for (let offset = 0; offset < messages.length; offset += 500) {
      await tx.superTabMessage.createMany({ data: messages.slice(offset, offset + 500) })
    }
    await guardedWrite(tx, tabId, { op: 'update', kind: 'group', key: conversationId, seen: current.version, data }, Date.now())
  })
  return ids
}
async function editChat(tabId: string, conversationId: string, edit: (data: Conversation) => void) {
  await swarmTransaction(db, async tx => {
    const current = (await parts.loadActive(tx, tabId, { groupIds: [conversationId] })).groups.find(g => g.key === conversationId)!
    const data = structuredClone(current.data!) as Conversation
    edit(data)
    await guardedWrite(tx, tabId, { op: 'update', kind: 'group', key: conversationId, seen: current.version, data }, Date.now())
  })
}
const sequenceOf = async (id: string) => (await db.superTabMessage.findUniqueOrThrow({ where: { id } })).sequence
const newestIn = async (tabId: string, conversationId: string) =>
  (await db.superTabMessage.findFirstOrThrow({ where: { tabId, conversationId }, orderBy: { sequence: 'desc' } })).sequence
const stored = (tabId: string, threadId: string, as: AuthUser = owner) =>
  db.superTabThreadMark.findMany({ where: { tabId, threadId, personId: as.sub }, select: { sequence: true, follow: true } })
const roots = (list: any[]) => list.map(t => t.root.text)

beforeEach(() => { resetInboxReads(); resetThreadsReads() })

describe('Follow and Unfollow, kept on the person\'s thread mark', () => {
  async function threadScene() {
    const s = await scene()
    const [root] = await insert(s.tabId, s.web, [{ text: 'Web root', author: personAuthor(owner) }])
    const [, last] = await insert(s.tabId, s.web, [{ text: 'Reply 1', author: agentAuthor(s.worker), thread: root }, { text: 'Reply 2', author: agentAuthor(s.worker), thread: root }])
    const [secretRoot] = await insert(s.tabId, s.secretGroup, [{ text: 'Secret root', author: personAuthor(owner) }])
    const [buddyRoot] = await insert(s.tabId, s.buddyId, [{ text: 'Buddy root', author: personAuthor(peer) }])
    const [hiddenRoot] = await insert(s.tabId, s.web, [{ text: 'Hidden root', author: agentAuthor('hidden-agent'), source: { kind: 'note', recipientsOnly: true },
      recipientIds: [s.worker] }])
    // The chat's newest row a person reads: the hidden root moves no counter.
    return { ...s, root: root!, secretRoot: secretRoot!, buddyRoot: buddyRoot!, hiddenRoot: hiddenRoot!, top: await sequenceOf(last!) }
  }

  it('stores Follow, Unfollow and neither for the person alone, answering what it stored', async () => {
    const s = await threadScene()
    expect(await follow(s.tabId, s.web, s.root, true, peer)).toMatchObject({ status: 200, body: { data: { follow: true } } })
    // Written before the person read it anywhere: a mark of 0, which every client reads as none.
    expect(await stored(s.tabId, s.root, peer)).toEqual([{ sequence: 0, follow: true }])
    expect(await stored(s.tabId, s.root, owner)).toEqual([])
    expect((await follow(s.tabId, s.web, s.root, false, peer)).body.data).toEqual({ follow: false })
    expect(await stored(s.tabId, s.root, peer)).toEqual([{ sequence: 0, follow: false }])
    expect((await follow(s.tabId, s.web, s.root, null, peer)).body.data).toEqual({ follow: null })
    expect(await stored(s.tabId, s.root, peer)).toEqual([{ sequence: 0, follow: null }])
    expect(await db.superTabThreadMark.count({ where: { tabId: s.tabId } })).toBe(1)
    // Only true, false or null.
    expect((await call('POST', `/api/super-tabs/${s.tabId}/conversations/${s.web}/threads/${s.root}/follow`, peer, { follow: 'yes' })).status).toBe(400)
    expect((await call('POST', `/api/super-tabs/${s.tabId}/conversations/${s.web}/threads/${s.root}/follow`, peer, {})).status).toBe(400)
  })

  it('keeps the mark when a Follow is written, and the Follow when the mark moves', async () => {
    const s = await threadScene()
    const top = s.top
    await markThread(s.tabId, s.web, s.root, top - 1, peer)
    await follow(s.tabId, s.web, s.root, true, peer)
    expect(await stored(s.tabId, s.root, peer)).toEqual([{ sequence: top - 1, follow: true }])
    await markThread(s.tabId, s.web, s.root, top, peer)
    expect(await stored(s.tabId, s.root, peer)).toEqual([{ sequence: top, follow: true }])
    // The first load still sends marks as numbers, as old clients read them.
    const derived = (await call('GET', `/api/super-tabs/${s.tabId}/parts`, peer)).body.data.derived
    expect(derived.threadMarks).toEqual({ [s.web]: { [s.root]: top } })
  })

  it('settles racing first writes on one row: the highest mark and the Follow both kept', async () => {
    const s = await threadScene()
    const top = s.top
    await Promise.all([follow(s.tabId, s.web, s.root, true, peer), markThread(s.tabId, s.web, s.root, top - 1, peer), follow(s.tabId, s.web, s.root, true, peer),
      markThread(s.tabId, s.web, s.root, top, peer), follow(s.tabId, s.web, s.root, true, peer)])
    expect(await stored(s.tabId, s.root, peer)).toEqual([{ sequence: top, follow: true }])
  })

  it(`counts toward the ${THREAD_MARK_CAP} marks a person keeps, as a read that moves the mark`, async () => {
    const s = await threadScene()
    const write = (threadId: string, at: number) => writeThreadMark(db, { tabId: s.tabId, personId: owner.sub, conversationId: s.web, threadId, sequence: 1, now: at })
    for (let i = 0; i < THREAD_MARK_CAP; i++) await write(`t${i}`, NOW + i)
    // A Follow of t0 moves it, so t1 is now the least recently moved; a Follow of a new thread is one more row past the cap.
    await writeThreadFollow(db, { tabId: s.tabId, personId: owner.sub, conversationId: s.web, threadId: 't0', follow: true, now: NOW + THREAD_MARK_CAP })
    await writeThreadFollow(db, { tabId: s.tabId, personId: owner.sub, conversationId: s.web, threadId: 'followed', follow: true, now: NOW + THREAD_MARK_CAP + 1 })
    const kept = await db.superTabThreadMark.findMany({ where: { tabId: s.tabId, personId: owner.sub }, select: { threadId: true, follow: true, sequence: true } })
    expect(kept).toHaveLength(THREAD_MARK_CAP)
    expect(kept).toEqual(expect.arrayContaining([{ threadId: 't0', follow: true, sequence: 1 }, { threadId: 'followed', follow: true, sequence: 0 }]))
    expect(kept.map(k => k.threadId)).not.toContain('t1')
  }, 60_000)

  it('refuses another project\'s thread, a private chat\'s, another person\'s Buddy chat\'s, a hidden root and an unknown one alike, storing nothing', async () => {
    const s = await threadScene()
    const [reply] = await insert(s.tabId, s.web, [{ text: 'Reply 3', author: agentAuthor(s.worker), thread: s.root }])
    const refused = [
      await follow(s.tabId, s.secretGroup, s.secretRoot, true, peer),
      // The private chat's root named under a conversation the person reads.
      await follow(s.tabId, s.web, s.secretRoot, true, peer),
      await follow(s.tabId, s.buddyId, s.buddyRoot, true, outsider),
      await follow(s.tabId, s.web, s.buddyRoot, true, outsider),
      await follow(s.tabId, s.web, s.hiddenRoot, true, peer),
      // A reply is no thread's root.
      await follow(s.tabId, s.web, reply!, true, peer),
      await follow(s.tabId, s.web, 'no-such-root', true, peer),
      await follow(s.tabId, 'no-such-group', s.root, true, peer),
    ]
    expect(refused.map(r => r.status)).toEqual(refused.map(() => 404))
    expect(new Set(refused.map(r => JSON.stringify(r.body)))).toHaveLength(1)
    expect(JSON.stringify(refused)).not.toMatch(/Secret|Buddy|Hidden/)
    // A Team session, an agent and someone who left are refused too.
    expect((await follow(s.tabId, s.web, s.root, true, 'team')).status).toBe(403)
    expect((await follow(s.tabId, s.web, s.root, true, owner, `?asAgentId=${s.worker}`)).status).toBe(400)
    await store.execute(owner, s.tabId, { operationId: randomUUID(), command: { type: 'member.remove', userId: outsider.sub } })
    expect((await follow(s.tabId, s.web, s.root, true, outsider)).status).toBe(404)
    expect(await db.superTabThreadMark.count({ where: { tabId: s.tabId } })).toBe(0)
  })
})

describe('the inbox honors Follow and Unfollow', () => {
  it('never lists a thread the person unfollowed, though they are in it, and lists it again once they clear that', async () => {
    const s = await scene()
    const [root] = await insert(s.tabId, s.web, [{ text: 'Peer root', author: personAuthor(peer) }])
    await markRead(s.tabId, s.web, await sequenceOf(root!), peer)
    await insert(s.tabId, s.web, [{ text: 'Worker reply', author: agentAuthor(s.worker), thread: root }])
    expect(roots((await inbox(s.tabId, peer)).body.data.threads)).toEqual(['Peer root'])
    await follow(s.tabId, s.web, root!, false, peer)
    expect((await inbox(s.tabId, peer)).body.data.threads).toEqual([])
    await follow(s.tabId, s.web, root!, null, peer)
    expect(roots((await inbox(s.tabId, peer)).body.data.threads)).toEqual(['Peer root'])
  })

  it('lists a thread the person follows though they never wrote or were tagged there, with the same shape', async () => {
    const s = await scene()
    const [root] = await insert(s.tabId, s.web, [{ text: 'Owner root', author: personAuthor(owner) }])
    await markRead(s.tabId, s.web, await sequenceOf(root!), peer)
    await insert(s.tabId, s.web, [{ text: 'Worker reply', author: agentAuthor(s.worker), thread: root }])
    expect((await inbox(s.tabId, peer)).body.data.threads).toEqual([])
    await follow(s.tabId, s.web, root!, true, peer)
    const [thread] = (await inbox(s.tabId, peer)).body.data.threads
    expect(Object.keys(thread).sort()).toEqual(['conversationId', 'lastReplier', 'lastReplyAt', 'lastReplySequence', 'root', 'rootId', 'unreadReplies'])
    expect(thread).toMatchObject({ conversationId: s.web, rootId: root, unreadReplies: 1, lastReplier: { id: s.worker } })
  })
})

describe('a thread reply past the person\'s thread mark, though the chat\'s mark is further on', () => {
  /** Peer's thread in Web with a reply peer read; a later thread-only reply; then a main message peer reads in the chat. With
   *  `opened`, peer read the thread to its first reply on some device; with `followOnly`, peer only followed it. */
  async function behindScene(opts: { opened?: boolean; followOnly?: boolean } = {}) {
    const s = await scene()
    const [root] = await insert(s.tabId, s.web, [{ text: 'Peer root', author: personAuthor(peer) }])
    await markRead(s.tabId, s.web, await sequenceOf(root!), peer)
    const [first] = await insert(s.tabId, s.web, [{ text: 'First reply', author: agentAuthor(s.worker), thread: root }])
    if (opts.opened) await markThread(s.tabId, s.web, root!, await sequenceOf(first!), peer)
    if (opts.followOnly) await follow(s.tabId, s.web, root!, true, peer)
    await insert(s.tabId, s.web, [{ text: 'Thread-only reply', author: agentAuthor(s.worker), thread: root }])
    const [main] = await insert(s.tabId, s.web, [{ text: 'Main message', author: personAuthor(owner) }])
    await markRead(s.tabId, s.web, await sequenceOf(main!), peer)
    return { ...s, root: root! }
  }

  it('counts it from the thread\'s own mark: reading the chat\'s main stream never reads a reply only in the thread', async () => {
    const s = await behindScene({ opened: true })
    const [thread] = (await inbox(s.tabId, peer)).body.data.threads
    expect(thread).toMatchObject({ conversationId: s.web, rootId: s.root, unreadReplies: 1 })
    expect(roots((await threads(s.tabId, peer)).body.data.unread)).toEqual(['Peer root'])
    expect((await threads(s.tabId, peer)).body.data.read).toEqual([])
    // Read in the thread, it is gone.
    await markThread(s.tabId, s.web, s.root, await newestIn(s.tabId, s.web), peer)
    expect((await inbox(s.tabId, peer)).body.data.threads).toEqual([])
  })

  it('counts a thread the person never opened from the chat\'s mark before the read, and a Follow alone takes that mark (Diego, 11-01)', async () => {
    // Both replies are only in the thread: reading the chat at the main message read neither (read/threadMarkSeeds.ts).
    const never = await behindScene()
    expect((await inbox(never.tabId, peer)).body.data.threads).toMatchObject([{ rootId: never.root, unreadReplies: 2 }])
    const followed = await behindScene({ followOnly: true })
    expect((await inbox(followed.tabId, peer)).body.data.threads).toMatchObject([{ rootId: followed.root, unreadReplies: 2 }])
    expect(roots((await threads(followed.tabId, peer)).body.data.unread)).toEqual(['Peer root'])
    expect((await threads(followed.tabId, peer)).body.data.read).toEqual([])
  })
})

describe('a person\'s followed threads (GET /threads)', () => {
  /** Web: peer marked the chat read at its roots. "Unread" (peer's, a new reply), "Read" (peer's, read to its end), "Opened" (owner's,
   *  peer opened it but is not in it), "Followed" (owner's, peer follows it and read it), "Unfollowed" (peer's, read, unfollowed),
   *  "Tagged" (owner's, tags peer in a reply, read). Secret work: owner's "Secret root" with a reply, peer has a mark on it from
   *  before (written directly). */
  async function followScene() {
    const s = await scene()
    const [unread, read, opened, followed, unfollowed, tagged] = await insert(s.tabId, s.web, [
      { text: 'Unread', author: personAuthor(peer) }, { text: 'Read', author: personAuthor(peer) }, { text: 'Opened', author: personAuthor(owner) },
      { text: 'Followed', author: personAuthor(owner) }, { text: 'Unfollowed', author: personAuthor(peer) }, { text: 'Tagged', author: personAuthor(owner) }])
    await markRead(s.tabId, s.web, await sequenceOf(tagged!), peer)
    for (const root of [read, opened, followed, unfollowed]) await insert(s.tabId, s.web, [{ text: 'Worker reply', author: agentAuthor(s.worker), thread: root! }])
    await insert(s.tabId, s.web, [{ text: 'Owner tags peer', author: personAuthor(owner), thread: tagged!, mentions: [peer.sub] }])
    for (const root of [read, opened, followed, unfollowed, tagged]) await markThread(s.tabId, s.web, root!, await newestIn(s.tabId, s.web), peer)
    await follow(s.tabId, s.web, followed!, true, peer)
    await follow(s.tabId, s.web, unfollowed!, false, peer)
    await insert(s.tabId, s.web, [{ text: 'New reply', author: agentAuthor(s.worker), thread: unread! }])
    const [secretRoot] = await insert(s.tabId, s.secretGroup, [{ text: 'Secret root', author: personAuthor(owner), mentions: [] }])
    await insert(s.tabId, s.secretGroup, [{ text: 'Secret reply', author: agentAuthor(s.worker), thread: secretRoot }])
    await writeThreadFollow(db, { tabId: s.tabId, personId: peer.sub, conversationId: s.secretGroup, threadId: secretRoot!, follow: true, now: Date.now() })
    return { ...s, unread: unread!, read: read!, opened: opened!, followed: followed!, unfollowed: unfollowed!, tagged: tagged! }
  }

  it('answers the inbox\'s unread threads first, then the read ones the person follows, newest reply first', async () => {
    const s = await followScene()
    const { status, body } = await threads(s.tabId, peer)
    expect(status).toBe(200)
    expect(body.data.unread).toEqual((await inbox(s.tabId, peer)).body.data.threads.map((t: any) => ({ ...t, follow: null })))
    expect(roots(body.data.unread)).toEqual(['Unread'])
    // Never the one they opened but are not in, the one they unfollowed, or the private chat's.
    expect(roots(body.data.read)).toEqual(['Tagged', 'Followed', 'Read'])
    expect(body.data.more).toBe(false)
    expect(JSON.stringify(body.data)).not.toMatch(/Secret|Opened|Unfollowed/)
    const reply = await db.superTabMessage.findFirstOrThrow({ where: { tabId: s.tabId, thread: s.followed, text: 'Worker reply' } })
    const root = await db.superTabMessage.findUniqueOrThrow({ where: { id: s.followed } })
    expect(body.data.read[1]).toEqual({ conversationId: s.web, rootId: s.followed,
      root: { id: s.followed, sequence: root.sequence, author: root.author, text: 'Followed', createdAt: root.createdAt.toISOString(), attachments: 0 },
      replies: 1, lastReplyAt: reply.createdAt.toISOString(), lastReplySequence: reply.sequence, lastReplier: reply.author, follow: true })
    expect(body.data.read.map((t: any) => t.follow)).toEqual([null, true, null])
    // Another reader's follows and marks are their own.
    expect((await threads(s.tabId, outsider)).body.data).toEqual({ unread: [], read: [], more: false })
  })

  it('lists a followed thread once it has a new reply among the unread, with its follow', async () => {
    const s = await followScene()
    await insert(s.tabId, s.web, [{ text: 'Another reply', author: agentAuthor(s.worker), thread: s.followed }])
    const { body } = await threads(s.tabId, peer)
    expect(body.data.unread.map((t: any) => [t.root.text, t.follow])).toEqual([['Followed', true], ['Unread', null]])
    expect(roots(body.data.read)).toEqual(['Tagged', 'Read'])
  })

  it('stops listing a chat\'s threads once the person can no longer read it: removed from a private chat, the project made private, out of the Swarm', async () => {
    const s = await followScene()
    // Out of this chat's audience.
    await editChat(s.tabId, s.web, data => { data.audience = { people: [{ id: owner.sub, generation: 0 }] } })
    expect((await threads(s.tabId, peer)).body.data).toEqual({ unread: [], read: [], more: false })
    await editChat(s.tabId, s.web, data => { delete data.audience })
    expect(roots((await threads(s.tabId, peer)).body.data.read)).toEqual(['Tagged', 'Followed', 'Read'])
    // A project made private without them (one with no agent's terminal in it).
    const [openRoot] = await insert(s.tabId, s.openChat, [{ text: 'Open root', author: personAuthor(peer) }])
    await insert(s.tabId, s.openChat, [{ text: 'Open reply', author: personAuthor(owner), thread: openRoot }])
    await markRead(s.tabId, s.openChat, await newestIn(s.tabId, s.openChat), peer)
    await markThread(s.tabId, s.openChat, openRoot!, await newestIn(s.tabId, s.openChat), peer)
    expect(roots((await threads(s.tabId, peer)).body.data.read)).toEqual(['Open root', 'Tagged', 'Followed', 'Read'])
    await store.execute(owner, s.tabId, { operationId: randomUUID(), command: { type: 'project.sharing', projectId: s.open, visibility: 'private', memberIds: [] } })
    expect(roots((await threads(s.tabId, peer)).body.data.read)).toEqual(['Tagged', 'Followed', 'Read'])
    expect(JSON.stringify((await threads(s.tabId, peer)).body.data)).not.toMatch(/Open/)
    await store.execute(owner, s.tabId, { operationId: randomUUID(), command: { type: 'project.sharing', projectId: s.open, visibility: 'public', memberIds: [] } })
    expect(roots((await threads(s.tabId, peer)).body.data.read)).toEqual(['Open root', 'Tagged', 'Followed', 'Read'])
    // Out of the Swarm: refused as for one that does not exist, naming nothing.
    await store.execute(owner, s.tabId, { operationId: randomUUID(), command: { type: 'member.remove', userId: peer.sub } })
    const left = await threads(s.tabId, peer)
    expect(left.status).toBe(404)
    expect(left.body.data).toBeUndefined()
    expect(JSON.stringify(left.body)).not.toMatch(/Web|Followed|Tagged/)
  })

  it('leaves out an archived chat\'s threads', async () => {
    const s = await followScene()
    await editChat(s.tabId, s.web, data => { data.archived = true })
    expect((await threads(s.tabId, peer)).body.data).toEqual({ unread: [], read: [], more: false })
  })

  it('never lists a thread whose root people cannot read, nor counts or names a reply they cannot read', async () => {
    const s = await followScene()
    const [hiddenRoot] = await insert(s.tabId, s.web, [{ text: 'Hidden root', author: agentAuthor('hidden-agent'), source: { kind: 'note', recipientsOnly: true },
      recipientIds: [s.worker], mentions: [peer.sub] }])
    await insert(s.tabId, s.web, [{ text: 'Reply under a hidden root', author: agentAuthor(s.worker), thread: hiddenRoot, mentions: [peer.sub] },
      { text: 'Hidden reply', author: agentAuthor('hidden-agent'), thread: s.read, source: { kind: 'note', recipientsOnly: true }, recipientIds: [s.worker] }])
    // A mark row for the hidden thread, as no route would write one, and a Follow of it; the chat read past both, so the
    // hidden thread would be a read one.
    await writeThreadFollow(db, { tabId: s.tabId, personId: peer.sub, conversationId: s.web, threadId: hiddenRoot!, follow: true, now: Date.now() })
    await markRead(s.tabId, s.web, await newestIn(s.tabId, s.web), peer)
    const { body } = await threads(s.tabId, peer)
    expect(roots(body.data.read)).toEqual(['Tagged', 'Followed', 'Read'])
    expect(body.data.more).toBe(false)
    expect(body.data.read.find((t: any) => t.rootId === s.read)).toMatchObject({ replies: 1, lastReplier: { id: s.worker } })
    expect(JSON.stringify(body.data)).not.toMatch(/Hidden|hidden-agent/)
  })

  it('gives the same answer from the thread summaries as from the thread rows, a long thread\'s whole count included', async () => {
    const s = await followScene()
    // What a person never reads, as a reply and as a thread's newest row; a Lead's copy of a notice stays the Lead's.
    await insert(s.tabId, s.web, [{ text: 'Hidden reply', author: agentAuthor('hidden-agent'), thread: s.followed, source: { kind: 'note', recipientsOnly: true },
      recipientIds: [s.worker] }])
    // A thread the person replied in long ago, then 150 replies of the worker's, read to its end.
    const [long] = await insert(s.tabId, s.web, [{ text: 'Long', author: personAuthor(owner) }])
    await insert(s.tabId, s.web, [{ text: 'Peer reply', author: personAuthor(peer), thread: long! },
      ...Array.from({ length: 150 }, (_, i) => ({ text: `Worker ${i}`, author: agentAuthor(s.worker), thread: long! }))])
    await markRead(s.tabId, s.web, await newestIn(s.tabId, s.web), peer)
    await markThread(s.tabId, s.web, long!, await newestIn(s.tabId, s.web), peer)
    // An unread reply past the person's thread mark, in a thread they are tagged in: more, not a read thread.
    await insert(s.tabId, s.web, [{ text: 'Past the mark', author: agentAuthor(s.worker), thread: s.tagged }])
    const rows = (await threads(s.tabId, peer)).body.data
    await backfillThreads(db, Date.now())
    resetThreadsReads()
    expect((await threads(s.tabId, peer)).body.data).toEqual(rows)
    expect(roots(rows.read)).toEqual(['Long', 'Followed', 'Read'])
    expect(roots(rows.unread)).toEqual(['Tagged', 'Unread'])
    expect(rows.read[0]).toMatchObject({ rootId: long, replies: 151, lastReplier: { id: s.worker } })
    expect(rows.read[1]).toMatchObject({ rootId: s.followed, replies: 1, lastReplier: { id: s.worker } })
    expect(JSON.stringify(rows)).not.toMatch(/Hidden|hidden-agent/)
  })

  it('counts no reply of a project the person cannot read in their Swarm Buddy chat\'s thread, before and after its summaries', async () => {
    let chat = ''
    const s = await scene(f => f.edit(state => { chat = openSwarmBuddyChat(state, state.people.find(p => p.id === peer.sub)!).id }))
    const [root] = await insert(s.tabId, chat, [{ text: 'Buddy root', author: personAuthor(peer) }])
    // The Secret project is its owner's alone: a session's reply of it stays in the chat, read by no one there now.
    await insert(s.tabId, chat, [{ text: 'Buddy reply', author: agentAuthor('peer-buddy'), thread: root! },
      { text: 'Secret session reply', author: agentAuthor('peer-session'), thread: root!, buddySession: true, buddyProject: s.secret }])
    await markRead(s.tabId, chat, await newestIn(s.tabId, chat), peer)
    await markThread(s.tabId, chat, root!, await newestIn(s.tabId, chat), peer)
    const before = (await threads(s.tabId, peer)).body.data
    expect(before.read).toMatchObject([{ rootId: root, replies: 1, lastReplier: { id: 'peer-buddy' } }])
    await backfillThreads(db, Date.now())
    resetThreadsReads()
    expect((await threads(s.tabId, peer)).body.data).toEqual(before)
  })

  it(`answers the ${MAX_READ_THREADS} read threads with the newest replies and says there are more`, async () => {
    const s = await scene()
    const many = await insert(s.tabId, s.web, Array.from({ length: MAX_READ_THREADS + 5 }, (_, i) => ({ text: `Root ${i}`, author: personAuthor(peer) })))
    await markRead(s.tabId, s.web, await sequenceOf(many.at(-1)!), peer)
    await insert(s.tabId, s.web, many.map(thread => ({ text: 'Reply', author: agentAuthor(s.worker), thread })))
    await markRead(s.tabId, s.web, await newestIn(s.tabId, s.web), peer)
    // Each read in its thread: reading the chat reads no reply only in a thread.
    const top = await newestIn(s.tabId, s.web)
    for (const root of many) await writeThreadMark(db, { tabId: s.tabId, personId: peer.sub, conversationId: s.web, threadId: root, sequence: top, now: Date.now() })
    for (const root of many) await follow(s.tabId, s.web, root, true, peer)
    const { body } = await threads(s.tabId, peer)
    expect(body.data.unread).toEqual([])
    expect(body.data.read).toHaveLength(MAX_READ_THREADS)
    expect(body.data.more).toBe(true)
  })

  it('refuses a Team session and an agent', async () => {
    const s = await followScene()
    const team = await threads(s.tabId, 'team')
    expect(team.status).toBe(403)
    expect(JSON.stringify(team.body)).not.toMatch(/Web|Followed/)
    expect((await call('GET', `/api/super-tabs/${s.tabId}/threads?asAgentId=${s.worker}`)).status).toBe(400)
    expect((await threads(`tab-${randomUUID()}`)).status).toBe(404)
  })

  it(`allows a person ${THREADS_READS} reads of one Swarm's threads per window, then answers 429 with Retry-After`, async () => {
    const s = await followScene()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Math.ceil(Date.now() / THREADS_WINDOW_MS) * THREADS_WINDOW_MS + 1_000)
      for (let i = 0; i < THREADS_READS; i++) expect((await threads(s.tabId, peer)).status).toBe(200)
      const refused = await threads(s.tabId, peer)
      expect(refused.status).toBe(429)
      expect(refused.headers['retry-after']).toBe('9')
      expect(refused.body.error?.code).toBe('RATE_LIMITED')
      expect(JSON.stringify(refused.body)).not.toMatch(/Web|Followed/)
      // Counted apart from the inbox, per person and per Swarm.
      expect((await inbox(s.tabId, peer)).status).toBe(200)
      expect((await threads(s.tabId, owner)).status).toBe(200)
      vi.setSystemTime(Date.now() + THREADS_WINDOW_MS)
      expect((await threads(s.tabId, peer)).status).toBe(200)
    } finally { vi.useRealTimers() }
  })

  /** Web: 70 roots of peer's, read to their ends in their threads; the first 10 hold 300 replies each, the rest one. */
  async function longScene() {
    const s = await scene()
    const long = await insert(s.tabId, s.web, Array.from({ length: 70 }, (_, i) => ({ text: `Long root ${i}`, author: personAuthor(peer) })))
    for (let batch = 0; batch < 3; batch++) {
      await insert(s.tabId, s.web, Array.from({ length: 1000 }, (_, i) => ({ text: `Long reply ${batch}.${i}`, author: agentAuthor(s.worker), thread: long[i % 10]! })))
    }
    await insert(s.tabId, s.web, long.slice(10).map(thread => ({ text: 'Reply', author: agentAuthor(s.worker), thread })))
    await markRead(s.tabId, s.web, await newestIn(s.tabId, s.web), peer)
    // Read to their ends; the long threads' marks moved last, so they are among the candidates.
    const top = await newestIn(s.tabId, s.web)
    for (const root of long.toReversed()) await writeThreadMark(db, { tabId: s.tabId, personId: peer.sub, conversationId: s.web, threadId: root, sequence: top, now: Date.now() })
    return { ...s, long }
  }
  /** One threads read under the profiler, after a warm read: its reply, and the operations each collection served. */
  async function profiledThreads(tabId: string) {
    await threads(tabId, peer)
    await db.$runCommandRaw({ profile: 0 })
    await db.$runCommandRaw({ drop: 'system.profile' }).catch(() => {})
    await db.$runCommandRaw({ create: 'system.profile', capped: true, size: 16 * 1024 * 1024 })
    await db.$runCommandRaw({ profile: 2, slowms: 0 })
    let reply: Awaited<ReturnType<typeof threads>>
    try { reply = await threads(tabId, peer) } finally { await db.$runCommandRaw({ profile: 0 }) }
    expect(reply.status).toBe(200)
    const rows = (await db.$runCommandRaw({ aggregate: 'system.profile', pipeline: [{ $match: { ns: { $not: { $regex: 'system\\.' } } } }, ...PROFILE_STAGES],
      cursor: {} }) as unknown as { cursor: { firstBatch: ProfileEntry[] } }).cursor.firstBatch.map(profileEntry)
    return { reply, rows }
  }

  it('reads by index only and examines a bounded number of messages, whatever a thread\'s length', async () => {
    const s = await longScene()
    const { reply, rows } = await profiledThreads(s.tabId)
    const messages = rows.filter(r => r.ns.endsWith('.SuperTabMessage'))
    expect(rows.filter(r => r.planSummary === 'COLLSCAN')).toEqual([])
    for (const r of messages) expect(r.planSummary, JSON.stringify(r)).toMatch(/^IXSCAN/)
    // The roots by id, then the candidates' newest rows in one read (60 threads, under CHATS_PER_READ).
    expect(messages.filter(r => r.op !== 'getmore').length).toBeLessThanOrEqual(3)
    // 60 candidate threads at most THREAD_SCAN rows each, never the long threads' 300.
    expect(messages.reduce((n, r) => n + (r.docsExamined ?? 0), 0)).toBeLessThan(60 * 100 + 200)
    expect(reply.body.data.read).toHaveLength(MAX_READ_THREADS)
    expect(reply.body.data.more).toBe(true)
    // A long thread's count stops at what the scan read.
    expect(reply.body.data.read.every((t: any) => t.replies <= 100)).toBe(true)
  }, 120_000)

  it('reads the candidates\' thread summaries, never their messages, once the Swarm\'s summaries are backfilled', async () => {
    const s = await longScene()
    await backfillThreads(db, Date.now())
    const { reply, rows } = await profiledThreads(s.tabId)
    const messages = rows.filter(r => r.ns.endsWith('.SuperTabMessage')), summaries = rows.filter(r => r.ns.endsWith('.SuperTabThread'))
    expect(rows.filter(r => r.planSummary === 'COLLSCAN')).toEqual([])
    // No message read by the thread index: the 70 roots by id, and the inbox's reads, which find nothing unread.
    expect(messages.filter(r => /thread/.test(r.planSummary ?? '')), JSON.stringify(messages)).toEqual([])
    expect(messages.reduce((n, r) => n + (r.docsExamined ?? 0), 0)).toBeLessThanOrEqual(70)
    // The 60 candidates' summaries in one read by id, one small row each.
    expect(summaries.filter(r => r.op !== 'getmore')).toHaveLength(1)
    expect(summaries[0]!.planSummary).toMatch(/^IXSCAN \{ _id: 1 \}/)
    expect(summaries.reduce((n, r) => n + (r.docsExamined ?? 0), 0)).toBeLessThanOrEqual(60)
    expect(reply.body.data.read).toHaveLength(MAX_READ_THREADS)
    expect(reply.body.data.more).toBe(true)
  }, 120_000)

  // Ken's scan of 11-04 (task #2768): the unread threads' member check read each thread's newest 100 rows before the mark in
  // one $or branch per thread, and long threads sent it to one $unionWith branch per thread. It reads their summaries now.
  /** Web: 60 roots of the owner's; the first 10 hold 300 worker replies. Peer replied early in every third thread (i % 3 == 0)
   *  and is tagged early in the next (i % 3 == 1); in a long thread both are more than 100 rows before the mark. Peer read the
   *  chat, then each thread got one new worker reply. */
  async function memberScene() {
    const s = await scene()
    const roots = await insert(s.tabId, s.web, Array.from({ length: 60 }, (_, i) => ({ text: `Member root ${i}`, author: personAuthor(owner) })))
    await insert(s.tabId, s.web, roots.flatMap((thread, i) => i % 3 === 0 ? [{ text: `Peer early ${i}`, author: personAuthor(peer), thread }]
      : i % 3 === 1 ? [{ text: `Tags peer ${i}`, author: personAuthor(owner), thread, mentions: [peer.sub] }] : []))
    for (let batch = 0; batch < 3; batch++) {
      await insert(s.tabId, s.web, Array.from({ length: 1000 }, (_, i) => ({ text: `History ${batch}.${i}`, author: agentAuthor(s.worker), thread: roots[i % 10]! })))
    }
    await markRead(s.tabId, s.web, await newestIn(s.tabId, s.web), peer)
    await insert(s.tabId, s.web, roots.map(thread => ({ text: 'New reply', author: agentAuthor(s.worker), thread })))
    return { ...s, roots, member: roots.filter((_, i) => i % 3 !== 2) }
  }

  it('counts the person in a thread they wrote or were tagged in long before their mark, once the Swarm\'s summaries are backfilled', async () => {
    const s = await memberScene()
    // Before the backfill: each thread's newest 100 rows before the mark, as before, so a long thread's early rows are not seen.
    const long = new Set(s.roots.slice(0, 10))
    const before = (await threads(s.tabId, peer)).body.data
    expect(before.unread.map((t: any) => t.rootId).sort()).toEqual(s.member.filter(r => !long.has(r)).sort())
    await backfillThreads(db, Date.now())
    resetThreadsReads()
    const after = (await threads(s.tabId, peer)).body.data
    expect(after.unread.map((t: any) => t.rootId).sort()).toEqual([...s.member].sort())
    // Every thread listed before is listed the same way after.
    expect(after.unread.filter((t: any) => !long.has(t.rootId))).toEqual(before.unread)
  }, 120_000)

  it('learns whether the person is in each unread thread from its summary, in one read, never from its messages', async () => {
    const s = await memberScene()
    await backfillThreads(db, Date.now())
    const { reply, rows } = await profiledThreads(s.tabId)
    const messages = rows.filter(r => r.ns.endsWith('.SuperTabMessage')), summaries = rows.filter(r => r.ns.endsWith('.SuperTabThread'))
    console.info(`threads cost, 60 unread candidates (10 of 300 rows): ${rows.filter(r => r.op !== 'getmore').length} reads\n` +
      rows.map(r => `  ${r.ns.split('.').at(-1)} ${r.op} ${(r.planSummary ?? '').slice(0, 80)} docs=${r.docsExamined ?? 0}`).join('\n'))
    expect(rows.filter(r => r.planSummary === 'COLLSCAN')).toEqual([])
    // No message read by the thread index: the chat's rows past the mark, and the 60 roots by id.
    expect(messages.filter(r => /thread/.test(r.planSummary ?? '')), JSON.stringify(messages)).toEqual([])
    expect(messages.reduce((n, r) => n + (r.docsExamined ?? 0), 0)).toBeLessThanOrEqual(2 * 61)
    // The 60 candidates' summaries in one read by id, one small row each.
    expect(summaries.filter(r => r.op !== 'getmore')).toHaveLength(1)
    expect(summaries[0]!.planSummary).toMatch(/^IXSCAN \{ _id: 1 \}/)
    expect(summaries.reduce((n, r) => n + (r.docsExamined ?? 0), 0)).toBeLessThanOrEqual(60)
    expect(reply.body.data.unread).toHaveLength(s.member.length)
  }, 120_000)

  // Ken's scan of 11-04 16:40 (task #2838): since #2962 the threads route returned 2.8x the database bytes per call (203 KB to
  // ~580 KB). The member check read each candidate's whole summary: the root's source, and the first and newest row of every
  // author with their names, though it asks only whether one person wrote or was tagged there.
  /** Web: 60 roots of an agent's, each with a source as large as a route's; 6 agents with display names reply in each, and the
   *  owner and outsider are tagged. Peer replied early in every third thread (i % 3 == 0), is tagged early in the next
   *  (i % 3 == 1), and is not in the rest. Peer read the chat, then each thread got one new worker reply. */
  async function crowdedScene() {
    const s = await scene()
    const named = (id: string): Author => ({ ...agentAuthor(id), displayName: `${id} the agent on Elvis-MacBook-Pro.local` })
    const source = { kind: 'route-fixture', candidates: Array.from({ length: 12 }, (_, i) => ({ agent: `candidate-${i}`, why: 'x'.repeat(80) })) }
    const roots = await insert(s.tabId, s.web, Array.from({ length: 60 }, (_, i) => ({ text: `Crowded root ${i}`, author: named('lead'), source })))
    await insert(s.tabId, s.web, roots.flatMap((thread, i) => [
      ...i % 3 === 0 ? [{ text: `Peer early ${i}`, author: personAuthor(peer), thread }] : [],
      ...i % 3 === 1 ? [{ text: `Tags peer ${i}`, author: named('agent-0'), thread, mentions: [peer.sub] }] : [],
      ...Array.from({ length: 6 }, (_, a) => ({ text: `Agent ${a} on ${i}`, author: named(`agent-${a}`), thread, mentions: [owner.sub, outsider.sub] })),
    ]))
    await markRead(s.tabId, s.web, await newestIn(s.tabId, s.web), peer)
    await insert(s.tabId, s.web, roots.map(thread => ({ text: 'New reply', author: agentAuthor(s.worker), thread })))
    await backfillThreads(db, Date.now())
    return { ...s, roots, member: roots.filter((_, i) => i % 3 !== 2) }
  }

  it('reads of each candidate\'s summary only the rows that name the person: the bytes follow their threads, not every author', async () => {
    const s = await crowdedScene()
    const { reply, rows } = await profiledThreads(s.tabId)
    const summaries = rows.filter(r => r.ns.endsWith('.SuperTabThread'))
    const bytes = (of: typeof rows) => of.reduce((n, r) => n + (r.responseLength ?? 0), 0)
    console.info(`threads read, 60 unread candidates, 40 naming the person: ${bytes(rows)} database bytes in all, ${bytes(summaries)} of them summaries\n` +
      rows.map(r => `  ${r.ns.split('.').at(-1)} ${r.op} ${(r.planSummary ?? '').slice(0, 60)} docs=${r.docsExamined ?? 0} returned=${r.nreturned ?? 0} bytes=${r.responseLength ?? 0}`).join('\n'))
    expect(reply.body.data.unread.map((t: any) => t.rootId).sort()).toEqual([...s.member].sort())
    // Still one read by id, examining one summary per candidate (#2962's gain).
    expect(summaries.filter(r => r.op !== 'getmore')).toHaveLength(1)
    expect(summaries[0]!.planSummary).toMatch(/^IXSCAN \{ _id: 1 \}/)
    expect(summaries.reduce((n, r) => n + (r.docsExamined ?? 0), 0)).toBeLessThanOrEqual(60)
    // Only the 40 summaries that name the person come back, each with only the parts that do: a few hundred bytes each.
    expect(summaries.reduce((n, r) => n + (r.nreturned ?? 0), 0)).toBe(s.member.length)
    expect(bytes(summaries)).toBeLessThanOrEqual(s.member.length * 400)
  }, 120_000)

  it('keeps reading a Swarm Buddy chat\'s rows to learn whether the person is in a thread: its summary cannot hide a lost project\'s row', async () => {
    let chat = ''
    const s = await scene(f => f.edit(state => { chat = openSwarmBuddyChat(state, state.people.find(p => p.id === peer.sub)!).id }))
    const [root] = await insert(s.tabId, chat, [{ text: 'Buddy root', author: agentAuthor('peer-buddy') }])
    // Peer's own reply in a session of the Secret project, which they do not read: it must not make them a member.
    await insert(s.tabId, chat, [{ text: 'Secret session words', author: personAuthor(peer), thread: root!, buddySession: true, buddyProject: s.secret }])
    await markRead(s.tabId, chat, await newestIn(s.tabId, chat), peer)
    await insert(s.tabId, chat, [{ text: 'Buddy reply', author: agentAuthor('peer-buddy'), thread: root! }])
    expect((await threads(s.tabId, peer)).body.data.unread).toEqual([])
    await backfillThreads(db, Date.now())
    resetThreadsReads()
    expect((await threads(s.tabId, peer)).body.data.unread).toEqual([])
    resetInboxReads()
    expect((await inbox(s.tabId, peer)).body.data.threads).toEqual([])
  })
})

describe('a thread the person is tagged in, in a chat they never opened (GET /threads)', () => {
  /** The tag row the store writes for a tagged message (mentions.ts writeMentions); `insert` stores messages only. */
  const tag = (tabId: string, conversationId: string, messageId: string, as: AuthUser = peer, options: { at?: number; resolved?: boolean; projectId?: string } = {}) =>
    db.superTabMention.create({ data: { id: `${tabId}-${messageId}-${as.sub}`, tabId, personId: as.sub, projectId: options.projectId ?? 'lead', conversationId, messageId,
      authorAgentId: owner.sub, createdAt: new Date(options.at ?? Date.now()), resolvedAt: options.resolved ? new Date() : null } })
  /** Owner's root with owner's reply tagging peer: peer never marked the chat read. */
  async function tagged(tabId: string, conversationId: string, label: string, worker: string) {
    const [root] = await insert(tabId, conversationId, [{ text: `${label} root`, author: personAuthor(owner) }])
    const [reply] = await insert(tabId, conversationId, [{ text: `${label} reply`, author: agentAuthor(worker), thread: root!, mentions: [peer.sub] }])
    await tag(tabId, conversationId, reply!)
    return { root: root!, reply: reply! }
  }

  it('lists it as a read thread, though the inbox counts the chat as read and lists none of its threads', async () => {
    const s = await scene()
    const t = await tagged(s.tabId, s.web, 'Tagged', s.worker)
    expect((await inbox(s.tabId, peer)).body.data.threads).toEqual([])
    const { status, body } = await threads(s.tabId, peer)
    expect(status).toBe(200)
    expect(body.data.unread).toEqual([])
    expect(roots(body.data.read)).toEqual(['Tagged root'])
    expect(body.data.read[0]).toMatchObject({ conversationId: s.web, rootId: t.root, replies: 1, follow: null })
    expect(body.data.more).toBe(false)
    // The tag is the person's own: nobody else is shown the thread for it.
    expect((await threads(s.tabId, outsider)).body.data).toEqual({ unread: [], read: [], more: false })
  })

  it('lists a thread whose root is the tagged message, and one whose tag is answered, once each', async () => {
    const s = await scene()
    const [rootTagged, answered] = await insert(s.tabId, s.web, [{ text: 'Tagged at the root', author: personAuthor(owner), mentions: [peer.sub] },
      { text: 'Answered root', author: personAuthor(owner) }])
    const [, answeredReply] = await insert(s.tabId, s.web, [{ text: 'Reply', author: agentAuthor(s.worker), thread: rootTagged! }, { text: 'Tagged reply', author: agentAuthor(s.worker), thread: answered!, mentions: [peer.sub] }])
    await tag(s.tabId, s.web, rootTagged!)
    await tag(s.tabId, s.web, answeredReply!, peer, { resolved: true })
    await tag(s.tabId, s.web, answeredReply!, owner)
    const { body } = await threads(s.tabId, peer)
    expect(roots(body.data.read).sort()).toEqual(['Answered root', 'Tagged at the root'])
  })

  it('never lists a thread whose tag names a chat they cannot read, another chat\'s message, a hidden root, an archived chat or an expired tag, naming nothing', async () => {
    const s = await scene()
    // A private project's thread: peer's tag row exists, as no route would write one.
    const secret = await tagged(s.tabId, s.secretGroup, 'Secret', s.worker)
    // A tag row for peer that names the open chat but another chat's message.
    const [forgedRoot] = await insert(s.tabId, s.secretGroup, [{ text: 'Forged root', author: personAuthor(owner) }])
    const [forgedReply] = await insert(s.tabId, s.secretGroup, [{ text: 'Forged reply', author: agentAuthor(s.worker), thread: forgedRoot!, mentions: [peer.sub] }])
    await tag(s.tabId, s.web, forgedReply!)
    // A thread whose root only agents read.
    const [hiddenRoot] = await insert(s.tabId, s.web, [{ text: 'Hidden root', author: agentAuthor('hidden-agent'), source: { kind: 'note', recipientsOnly: true }, recipientIds: [s.worker] }])
    const [hiddenReply] = await insert(s.tabId, s.web, [{ text: 'Reply under a hidden root', author: agentAuthor(s.worker), thread: hiddenRoot!, mentions: [peer.sub] }])
    await tag(s.tabId, s.web, hiddenReply!)
    // An expired tag (30 days), and an archived chat's.
    const old = await tagged(s.tabId, s.openChat, 'Expired', s.worker)
    await db.superTabMention.updateMany({ where: { tabId: s.tabId, messageId: old.reply }, data: { createdAt: new Date(Date.now() - 31 * 24 * 60 * 60_000) } })
    const archived = await tagged(s.tabId, s.web, 'Archived', s.worker)
    expect(roots((await threads(s.tabId, peer)).body.data.read)).toEqual(['Archived root'])
    await editChat(s.tabId, s.web, data => { data.archived = true })
    expect((await threads(s.tabId, peer)).body.data).toEqual({ unread: [], read: [], more: false })
    expect(JSON.stringify((await threads(s.tabId, peer)).body)).not.toMatch(/Secret|Forged|Hidden|hidden-agent|Expired|Archived/)
    expect([secret.root, archived.root, old.root]).toHaveLength(3)
  })

  it('leaves out a thread they unfollowed, and a Buddy chat of another person', async () => {
    const s = await scene()
    const t = await tagged(s.tabId, s.web, 'Unfollowed', s.worker)
    await follow(s.tabId, s.web, t.root, false, peer)
    const other = await tagged(s.tabId, s.web, 'Kept', s.worker)
    // Peer\'s Buddy chat is theirs alone: a tag of the owner there names nothing for the owner.
    const [buddyRoot] = await insert(s.tabId, s.buddyId, [{ text: 'Buddy root', author: personAuthor(peer) }])
    const [buddyReply] = await insert(s.tabId, s.buddyId, [{ text: 'Buddy reply', author: personAuthor(peer), thread: buddyRoot!, mentions: [owner.sub] }])
    await tag(s.tabId, s.buddyId, buddyReply!, owner)
    expect(roots((await threads(s.tabId, peer)).body.data.read)).toEqual(['Kept root'])
    const ownerRead = (await threads(s.tabId, owner)).body.data
    expect(JSON.stringify(ownerRead)).not.toMatch(/Buddy/)
    expect(other.root).toBeTruthy()
  })

  it('stops listing it once they lose the chat, and again lists it when they read it', async () => {
    const s = await scene()
    await tagged(s.tabId, s.web, 'Revoked', s.worker)
    expect(roots((await threads(s.tabId, peer)).body.data.read)).toEqual(['Revoked root'])
    await editChat(s.tabId, s.web, data => { data.audience = { people: [{ id: owner.sub, generation: 0 }] } })
    expect((await threads(s.tabId, peer)).body.data).toEqual({ unread: [], read: [], more: false })
    await editChat(s.tabId, s.web, data => { delete data.audience })
    expect(roots((await threads(s.tabId, peer)).body.data.read)).toEqual(['Revoked root'])
    await store.execute(owner, s.tabId, { operationId: randomUUID(), command: { type: 'member.remove', userId: peer.sub } })
    const left = await threads(s.tabId, peer)
    expect(left.status).toBe(404)
    expect(JSON.stringify(left.body)).not.toMatch(/Revoked|Web/)
  })

  it(`checks at most ${TAGGED_THREADS} tagged threads, newest tag first, and says there are more`, async () => {
    const s = await scene()
    const many = await insert(s.tabId, s.web, Array.from({ length: TAGGED_THREADS + 5 }, (_, i) => ({ text: `Root ${i}`, author: personAuthor(owner) })))
    const replies = await insert(s.tabId, s.web, many.map(thread => ({ text: 'Reply', author: agentAuthor(s.worker), thread, mentions: [peer.sub] })))
    for (const [i, reply] of replies.entries()) await tag(s.tabId, s.web, reply, peer, { at: Date.now() - (replies.length - i) * 1000 })
    const { body } = await threads(s.tabId, peer)
    expect(body.data.read).toHaveLength(TAGGED_THREADS)
    expect(body.data.more).toBe(true)
    // The newest tags: the last roots.
    expect(roots(body.data.read)).toContain(`Root ${TAGGED_THREADS + 4}`)
    expect(roots(body.data.read)).not.toContain('Root 0')
  })

  /** An older tag in `older`, and TAGGED_THREADS + 1 newer ones in `chat` (the caller then hides them from the list). */
  async function olderBehindNewer(tabId: string, older: string, chat: string, worker: string) {
    const old = await tagged(tabId, older, 'Older', worker)
    await db.superTabMention.updateMany({ where: { tabId, messageId: old.reply }, data: { createdAt: new Date(Date.now() - 3_600_000) } })
    const roots = await insert(tabId, chat, Array.from({ length: TAGGED_THREADS + 1 }, (_, i) => ({ text: `Newer ${i}`, author: personAuthor(owner) })))
    const replies = await insert(tabId, chat, roots.map(thread => ({ text: 'Reply', author: agentAuthor(worker), thread, mentions: [peer.sub] })))
    for (const reply of replies) await tag(tabId, chat, reply)
    return roots
  }

  it('does not let newer tags in an archived chat use up the cap and hide an older tag in an open chat', async () => {
    const s = await scene()
    await olderBehindNewer(s.tabId, s.web, s.openChat, s.worker)
    await editChat(s.tabId, s.openChat, data => { data.archived = true })
    const { body } = await threads(s.tabId, peer)
    expect(roots(body.data.read)).toEqual(['Older root'])
    expect(body.data.more).toBe(false)
    expect(JSON.stringify(body.data)).not.toMatch(/Newer/)
  })

  it('does not let newer tags in threads they unfollowed use up the cap and hide an older tag', async () => {
    const s = await scene()
    const newer = await olderBehindNewer(s.tabId, s.web, s.web, s.worker)
    for (const root of newer) expect((await follow(s.tabId, s.web, root, false, peer)).status).toBe(200)
    const { body } = await threads(s.tabId, peer)
    expect(roots(body.data.read)).toEqual(['Older root'])
    expect(body.data.more).toBe(false)
    expect(JSON.stringify(body.data)).not.toMatch(/Newer/)
  })
})

// Task #2265 (Diego): a person's own message from the phone, the web or the dial left the chat bold on their other apps, and a chat
// set to All could tell them of it, as a send never moved its author's mark.
describe('a person\'s own message leaves the chat read for them', () => {
  const send = async (tabId: string, conversationId: string, as: AuthUser, text: string, more: Record<string, unknown> = {}) => {
    const answer = await call('POST', `/api/super-tabs/${tabId}/commands`, as, { operationId: randomUUID(),
      command: { type: 'message.send', conversationId, text, replyTo: null, recipientIds: [], ...more } })
    expect(answer.status).toBe(200)
    return answer.body.data.result.messageId as string
  }
  const markOf = async (tabId: string, conversationId: string, as: AuthUser) =>
    (await db.superTabReadMark.findUnique({ where: { id: stableId(tabId, conversationId, as.sub) }, select: { sequence: true } }))?.sequence ?? 0

  it('moves their mark to their message, and nobody else\'s', async () => {
    const s = await scene()
    const id = await send(s.tabId, s.web, owner, 'From my phone')
    expect(await markOf(s.tabId, s.web, owner)).toBe(await sequenceOf(id))
    expect(await markOf(s.tabId, s.web, peer)).toBe(0)
  })

  it('tells their other apps in the same read that says the chat moved', async () => {
    const s = await scene()
    const id = await send(s.tabId, s.web, owner, 'From my phone')
    const derived = (await call('GET', `/api/super-tabs/${s.tabId}/parts`, owner)).body.data.derived
    expect(derived.readMarks[s.web]).toBe(await sequenceOf(id))
  })

  it('leaves the mark for a reply only in a thread, and moves it for one also sent to the chat', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, owner, 'Root')
    const at = await markOf(s.tabId, s.web, owner)
    await send(s.tabId, s.web, owner, 'Only in the thread', { replyTo: root })
    expect(await markOf(s.tabId, s.web, owner)).toBe(at)
    const also = await send(s.tabId, s.web, owner, 'Also in the chat', { replyTo: root, alsoSend: true })
    expect(await markOf(s.tabId, s.web, owner)).toBe(await sequenceOf(also))
  })

  it('never reads a thread for them: a teammate\'s reply it passes still counts in the inbox', async () => {
    const s = await scene()
    const [root] = await insert(s.tabId, s.web, [{ text: 'Owner root', author: personAuthor(owner) }])
    await markRead(s.tabId, s.web, await sequenceOf(root!), owner)
    await insert(s.tabId, s.web, [{ text: 'Worker reply', author: agentAuthor(s.worker), thread: root }])
    await send(s.tabId, s.web, owner, 'From my phone')
    expect(roots((await inbox(s.tabId, owner)).body.data.threads)).toEqual(['Owner root'])
  })
})
