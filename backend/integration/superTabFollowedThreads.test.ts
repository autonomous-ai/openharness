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
import { buddyChatId } from '../src/superTabs/buddies.js'
import { resetInboxReads } from '../src/superTabs/read/inbox.js'
import { MAX_READ_THREADS, resetThreadsReads, THREADS_READS, THREADS_WINDOW_MS } from '../src/superTabs/read/followedThreads.js'
import type { Author, Conversation, SuperTabState } from '../src/superTabs/model.js'
import { THREAD_MARK_CAP, writeThreadFollow, writeThreadMark } from '../src/superTabs/readMarks.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
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
  source?: Record<string, unknown>; recipientIds?: string[]; mentions?: string[] }>) {
  const ids: string[] = []
  await swarmTransaction(db, async tx => {
    const current = (await parts.loadActive(tx, tabId, { groupIds: [conversationId] })).groups.find(g => g.key === conversationId)!
    const data = structuredClone(current.data!) as Conversation
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
      await tx.superTabMessage.create({ data: { id, tabId, conversationId, sequence, author: row.author as never, text: row.text,
        thread: row.thread === undefined ? id : row.thread, recipientIds: row.recipientIds ?? [], mentions: row.mentions ?? [],
        ...(row.source ? { source: row.source as never } : {}), createdAt: new Date() } })
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

  it('keeps the chat\'s mark for a thread the person never opened, and a Follow alone is no mark', async () => {
    expect((await inbox((await behindScene()).tabId, peer)).body.data.threads).toEqual([])
    const followed = await behindScene({ followOnly: true })
    expect((await inbox(followed.tabId, peer)).body.data.threads).toEqual([])
    expect(roots((await threads(followed.tabId, peer)).body.data.read)).toEqual(['Peer root'])
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

  it(`answers the ${MAX_READ_THREADS} read threads with the newest replies and says there are more`, async () => {
    const s = await scene()
    const many = await insert(s.tabId, s.web, Array.from({ length: MAX_READ_THREADS + 5 }, (_, i) => ({ text: `Root ${i}`, author: personAuthor(peer) })))
    await markRead(s.tabId, s.web, await sequenceOf(many.at(-1)!), peer)
    await insert(s.tabId, s.web, many.map(thread => ({ text: 'Reply', author: agentAuthor(s.worker), thread })))
    await markRead(s.tabId, s.web, await newestIn(s.tabId, s.web), peer)
    for (const root of many) await follow(s.tabId, s.web, root, true, peer)
    const { body } = await threads(s.tabId, peer)
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

  it('reads by index only and examines a bounded number of messages, whatever a thread\'s length', async () => {
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
    await threads(s.tabId, peer)
    await db.$runCommandRaw({ profile: 0 })
    await db.$runCommandRaw({ drop: 'system.profile' }).catch(() => {})
    await db.$runCommandRaw({ create: 'system.profile', capped: true, size: 16 * 1024 * 1024 })
    await db.$runCommandRaw({ profile: 2, slowms: 0 })
    let reply: Awaited<ReturnType<typeof threads>>
    try { reply = await threads(s.tabId, peer) } finally { await db.$runCommandRaw({ profile: 0 }) }
    expect(reply.status).toBe(200)
    const rows = (await db.$runCommandRaw({ aggregate: 'system.profile', pipeline: [{ $match: { ns: { $not: { $regex: 'system\\.' } } } }, ...PROFILE_STAGES],
      cursor: {} }) as unknown as { cursor: { firstBatch: ProfileEntry[] } }).cursor.firstBatch.map(profileEntry)
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
})
