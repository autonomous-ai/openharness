import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import { stableId, type Author, type Conversation, type SuperTabState } from '../src/superTabs/model.js'
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
  const uri = replica.getUri(`swarm_inbox_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const each of [owner, peer, outsider]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
  // The owner's own machine runs the Swarm's worker, so the owner may write as it.
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
 *  ("Secret work"), peer's Buddy chat, and peer's closed Chat with PM from before Buddies (nobody reads it). */
async function scene(extra: (s: ReturnType<typeof swarm>) => void = () => {}) {
  const s = swarm(MIGRATED)
  s.join(peerActor)
  s.join(outsiderActor)
  const secret = s.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).projectId as string
  const web = s.group('Web')
  const worker = s.add('worker-harness', web, false, ownerActor, 'host', owner.sub)
  s.run({ type: 'work.assign', conversationId: web, agentId: worker })
  const secretGroup = s.group('Secret work', secret)
  const closedId = s.group('Peer and PM')
  let buddyId = s.group('Peer\'s Buddy')
  s.edit(state => {
    const generation = state.people.find(p => p.id === peer.sub)!.generation
    state.conversations.find(c => c.id === closedId)!.audience = { people: [{ id: peer.sub, generation }] }
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
  return { tabId, web, worker, secretGroup, closedId, buddyId, leads: state.leadsConversationId! }
}

const get = async (url: string, as: AuthUser | 'team' = owner) => {
  const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${as === 'team' ? 'team' : as.sub}` } })
  return { status: response.statusCode, body: response.json() as { data: any; error?: { code: string; message: string } } }
}
const inbox = (tabId: string, as: AuthUser | 'team' = owner) => get(`/api/super-tabs/${tabId}/inbox`, as)

/** Sends a message as a person (or as an agent the owner runs) through the real command, and answers its stored row. */
async function send(tabId: string, conversationId: string, text: string, opts: { as?: AuthUser; agentId?: string; replyTo?: string } = {}) {
  await store.execute(opts.as ?? owner, tabId, { operationId: randomUUID(), command: { type: 'message.send', conversationId, text,
    replyTo: opts.replyTo ?? null, recipientIds: [] } }, opts.agentId)
  return (await db.superTabMessage.findFirst({ where: { tabId, conversationId, text }, orderBy: { sequence: 'desc' } }))!
}
const agentAuthor = (id: string): Author => ({ kind: 'agent', id, name: id, membershipGeneration: 'fixture' })
const personAuthor = (u: AuthUser): Author => ({ kind: 'person', id: u.sub, name: u.email, membershipGeneration: 'fixture' })

/** Rows no command writes (a Buddy's reply, legacy notices), stored as the store stores them: numbered after the chat's
 *  newest, the chat's counters moved as numberMessages moves them for rows people read. */
async function insert(tabId: string, conversationId: string, rows: Array<{ id?: string; text: string; author: Author; thread?: string | null;
  source?: Record<string, unknown>; recipientIds?: string[] }>) {
  const ids: string[] = []
  await swarmTransaction(db, async tx => {
    const current = (await parts.loadActive(tx, tabId, { groupIds: [conversationId] })).groups.find(g => g.key === conversationId)!
    const data = structuredClone(current.data!) as Conversation
    for (const row of rows) {
      const sequence = (data.messageSeq ?? 0) + 1
      const id = row.id ?? `m-${randomUUID()}`
      ids.push(id)
      data.messageSeq = sequence
      const hidden = !!row.source?.recipientsOnly
      if (!hidden) {
        data.lastMessageSequence = sequence
        data.lastActivityAt = new Date().toISOString()
        if (!row.thread || row.thread === id) data.lastMainSequence = sequence
      }
      await tx.superTabMessage.create({ data: { id, tabId, conversationId, sequence, author: row.author as never, text: row.text,
        thread: row.thread === undefined ? id : row.thread, recipientIds: row.recipientIds ?? [], mentions: [],
        ...(row.source ? { source: row.source as never } : {}), createdAt: new Date() } })
    }
    await guardedWrite(tx, tabId, { op: 'update', kind: 'group', key: conversationId, seen: current.version, data }, Date.now())
  })
  return ids
}
const markRead = async (tabId: string, conversationId: string, sequence: number, as: AuthUser) => {
  const response = await app.inject({ method: 'POST', url: `/api/super-tabs/${tabId}/conversations/${conversationId}/read`,
    headers: { authorization: `Bearer ${as.sub}` }, payload: { sequence } })
  expect(response.statusCode).toBe(200)
}
const threadsOf = (data: any) => (data.threads as any[]).map(t => ({ chat: t.conversationId, root: t.root.text, unread: t.unreadReplies,
  last: t.lastReplier?.id ?? null }))
const latestOf = (data: any) => Object.fromEntries((data.latest as any[]).map(l => [l.conversationId, l.message.text]))

/** Every chat gets a thread with replies and a newer top-level message:
 *  Web (public): owner's root, two owner replies and one worker reply, then "Web latest".
 *  Secret work (owner's private project): owner's root, a worker reply, then "Secret latest".
 *  Peer's Buddy chat: peer's root, the Buddy's reply, then the Buddy's "Buddy latest".
 *  Peer's closed Chat with PM: a root, a reply and "Closed latest", read by nobody.
 *  Leads: the owner's "Leads note". */
async function busyScene() {
  const s = await scene()
  const webRoot = await send(s.tabId, s.web, 'Web root')
  await send(s.tabId, s.web, 'Web reply 1', { replyTo: webRoot.id })
  await send(s.tabId, s.web, 'Web reply 2', { replyTo: webRoot.id })
  await send(s.tabId, s.web, 'Web worker reply', { replyTo: webRoot.id, agentId: s.worker })
  const webLatest = await send(s.tabId, s.web, 'Web latest')
  const [secretRoot] = await insert(s.tabId, s.secretGroup, [{ text: 'Secret root', author: personAuthor(owner) }])
  await insert(s.tabId, s.secretGroup, [{ text: 'Secret reply', author: agentAuthor(s.worker), thread: secretRoot }, { text: 'Secret latest', author: personAuthor(owner) }])
  const [buddyRoot] = await insert(s.tabId, s.buddyId, [{ text: 'Buddy root', author: personAuthor(peer) }])
  await insert(s.tabId, s.buddyId, [{ text: 'Buddy reply', author: agentAuthor('buddy-agent'), thread: buddyRoot }, { text: 'Buddy latest', author: agentAuthor('buddy-agent') }])
  const [closedRoot] = await insert(s.tabId, s.closedId, [{ text: 'Closed root', author: personAuthor(peer) }])
  await insert(s.tabId, s.closedId, [{ text: 'Closed reply', author: agentAuthor(s.worker), thread: closedRoot }, { text: 'Closed latest', author: personAuthor(peer) }])
  await send(s.tabId, s.leads, 'Leads note')
  return { ...s, webRoot, webLatest }
}

describe('a person\'s inbox: unread threads and each chat\'s latest message', () => {
  it('gives a collaborator exactly the chats the messages read gives them: their own Buddy chat, never the private project or the closed chat', async () => {
    const s = await busyScene()
    const { status, body } = await inbox(s.tabId, peer)
    expect(status).toBe(200)
    // No read mark yet: every reply by someone else is unread, as the phone counts a chat with no mark.
    expect(threadsOf(body.data)).toEqual([
      { chat: s.buddyId, root: 'Buddy root', unread: 1, last: 'buddy-agent' },
      { chat: s.web, root: 'Web root', unread: 3, last: s.worker },
    ])
    expect(latestOf(body.data)).toEqual({ [s.web]: 'Web latest', [s.buddyId]: 'Buddy latest', [s.leads]: 'Leads note' })
    expect(body.data.more).toBe(false)
    expect(JSON.stringify(body.data)).not.toMatch(/Secret|Closed|secret|closed/)
    expect(JSON.stringify(body.data)).not.toContain(s.secretGroup)
    expect(JSON.stringify(body.data)).not.toContain(s.closedId)
  })

  it('gives the owner the private project, never a collaborator\'s Buddy chat or closed chat, and never counts their own replies', async () => {
    const s = await busyScene()
    const { status, body } = await inbox(s.tabId, owner)
    expect(status).toBe(200)
    // In Web the owner wrote the root and two replies: only the worker's reply is unread for them.
    expect(threadsOf(body.data)).toEqual([
      { chat: s.secretGroup, root: 'Secret root', unread: 1, last: s.worker },
      { chat: s.web, root: 'Web root', unread: 1, last: s.worker },
    ])
    expect(latestOf(body.data)).toEqual({ [s.web]: 'Web latest', [s.secretGroup]: 'Secret latest', [s.leads]: 'Leads note' })
    expect(JSON.stringify(body.data)).not.toMatch(/Buddy|Closed/)
    expect(JSON.stringify(body.data)).not.toContain(s.buddyId)
  })

  it('gives someone outside the private project and the Buddy chat only the public chats', async () => {
    const s = await busyScene()
    const { status, body } = await inbox(s.tabId, outsider)
    expect(status).toBe(200)
    expect(threadsOf(body.data)).toEqual([{ chat: s.web, root: 'Web root', unread: 3, last: s.worker }])
    expect(latestOf(body.data)).toEqual({ [s.web]: 'Web latest', [s.leads]: 'Leads note' })
    expect(JSON.stringify(body.data)).not.toMatch(/Secret|Buddy|Closed/)
  })

  it('answers the root, the last reply time and the latest message as the messages read shows them', async () => {
    const s = await busyScene()
    const { body } = await inbox(s.tabId, outsider)
    const page = (await get(`/api/super-tabs/${s.tabId}/conversations/${s.web}/messages`, outsider)).body.data.messages as any[]
    const shown = (text: string) => page.find(m => m.text === text)
    const thread = body.data.threads[0]
    expect(thread).toEqual({ conversationId: s.web, rootId: s.webRoot.id,
      root: { id: shown('Web root').id, sequence: shown('Web root').sequence, author: shown('Web root').author, text: 'Web root',
        createdAt: shown('Web root').createdAt, attachments: 0 },
      lastReplyAt: shown('Web worker reply').createdAt, lastReplySequence: shown('Web worker reply').sequence,
      lastReplier: shown('Web worker reply').author, unreadReplies: 3 })
    expect(body.data.latest.find((l: any) => l.conversationId === s.web)).toEqual({ conversationId: s.web,
      message: { id: shown('Web latest').id, sequence: shown('Web latest').sequence, author: shown('Web latest').author, text: 'Web latest',
        createdAt: shown('Web latest').createdAt, attachments: 0 } })
  })

  it('counts only replies past the person\'s read mark, and drops a thread they have read', async () => {
    const s = await busyScene()
    const reply1 = await db.superTabMessage.findFirstOrThrow({ where: { tabId: s.tabId, text: 'Web reply 1' } })
    await markRead(s.tabId, s.web, reply1.sequence, peer)
    expect(threadsOf((await inbox(s.tabId, peer)).body.data).filter(t => t.chat === s.web)).toEqual([{ chat: s.web, root: 'Web root', unread: 2, last: s.worker }])
    await markRead(s.tabId, s.web, s.webLatest.sequence, peer)
    const after = (await inbox(s.tabId, peer)).body.data
    expect(threadsOf(after).filter(t => t.chat === s.web)).toEqual([])
    // The latest message stays: the Buddies list shows it whether read or not.
    expect(latestOf(after)[s.web]).toBe('Web latest')
  })

  it('never counts or names a row people cannot read, and never lists a thread whose root they cannot read', async () => {
    const s = await busyScene()
    // An agent-only notice in the Web thread (a reply only its recipient reads), and an agent-only root with a reply under it.
    await insert(s.tabId, s.web, [{ text: 'Hidden reply', author: agentAuthor('hidden-agent'), thread: s.webRoot.id, source: { kind: 'note', recipientsOnly: true },
      recipientIds: [s.worker] }])
    const [hiddenRoot] = await insert(s.tabId, s.web, [{ text: 'Hidden root', author: agentAuthor('hidden-agent'), source: { kind: 'note', recipientsOnly: true },
      recipientIds: [s.worker] }])
    await insert(s.tabId, s.web, [{ text: 'Reply under a hidden root', author: agentAuthor(s.worker), thread: hiddenRoot }])
    const { body } = await inbox(s.tabId, outsider)
    expect(threadsOf(body.data)).toEqual([{ chat: s.web, root: 'Web root', unread: 3, last: s.worker }])
    expect(JSON.stringify(body.data)).not.toMatch(/Hidden|hidden-agent/)
  })

  it('shows as latest the message a page ends with when the newest row is a task chat copy of a Lead notice nobody reads', async () => {
    const s = await busyScene()
    // A lost-task notice stored before such copies were marked (pageReads.ts deliveredCopies), whose Lead copy reached the Lead.
    const [copy] = await insert(s.tabId, s.web, [{ text: 'Lost task notice', author: agentAuthor('swarm'), source: { kind: 'work-lost' } }])
    await insert(s.tabId, s.leads, [{ id: stableId(copy!, 'lead'), text: 'Lead copy', author: agentAuthor('swarm'), source: { kind: 'work-lost' },
      recipientIds: ['lead-agent'] }])
    const page = (await get(`/api/super-tabs/${s.tabId}/conversations/${s.web}/messages`, outsider)).body.data.messages as any[]
    expect(page.map(m => m.text)).not.toContain('Lost task notice')
    expect(latestOf((await inbox(s.tabId, outsider)).body.data)[s.web]).toBe('Web latest')
  })

  it('never names a last replier who can no longer read the chat', async () => {
    const s = await busyScene()
    // Outsider replies in Web, then leaves the Swarm: peer still sees the reply counted, but not who wrote it.
    await send(s.tabId, s.web, 'Outsider reply', { as: outsider, replyTo: s.webRoot.id })
    await store.execute(owner, s.tabId, { operationId: randomUUID(), command: { type: 'member.remove', userId: outsider.sub } })
    const thread = (await inbox(s.tabId, peer)).body.data.threads.find((t: any) => t.conversationId === s.web)
    expect(thread.unreadReplies).toBe(4)
    // As thread summaries name them: the newest author who can still read the chat.
    expect(thread.lastReplier.id).toBe(s.worker)
    expect(JSON.stringify(thread)).not.toContain(outsider.sub)
  })

  it('refuses a removed member, a Team session and an agent alike, with nothing about the Swarm\'s chats', async () => {
    const s = await busyScene()
    await store.execute(owner, s.tabId, { operationId: randomUUID(), command: { type: 'member.remove', userId: peer.sub } })
    const removed = await inbox(s.tabId, peer)
    // Refused as the messages read refuses them, not answered as a member with nothing to read.
    const page = await get(`/api/super-tabs/${s.tabId}/conversations/${s.web}/messages`, peer)
    expect(page.status).toBe(403)
    expect({ status: removed.status, code: removed.body.error?.code }).toEqual({ status: page.status, code: page.body.error?.code })
    expect(removed.body.data).toBeUndefined()
    expect(JSON.stringify(removed.body)).not.toMatch(/Web|Buddy|Leads/)
    const team = await inbox(s.tabId, 'team')
    expect(team.status).toBe(403)
    expect(JSON.stringify(team.body)).not.toMatch(/Web|Secret|Leads/)
    // An agent has no read marks: the read takes no agent at all.
    expect((await get(`/api/super-tabs/${s.tabId}/inbox?asAgentId=${s.worker}`, owner)).status).toBe(400)
    // Another Swarm's id reads as one that does not exist.
    expect((await inbox(`tab-${randomUUID()}`, owner)).status).toBe(404)
  })
})

describe('what the inbox costs the database', () => {
  const CHATS = 35
  /** A person in CHATS active public chats, each with a thread of 5 replies past a top-level message, plus one long chat
   *  of 3000 rows they have never opened. */
  async function bigScene() {
    const s = await scene(f => { for (let i = 0; i < CHATS; i++) f.group(`Chat ${i}`) })
    const state = (await store.readLoad(peer, s.tabId)).state
    const chats = state.conversations.filter(c => c.title.startsWith('Chat ')).map(c => c.id)
    for (const chat of chats) {
      const [root] = await insert(s.tabId, chat, [{ text: `Root in ${chat}`, author: personAuthor(owner) }])
      await insert(s.tabId, chat, [...Array.from({ length: 5 }, (_, i) => ({ text: `Reply ${i}`, author: agentAuthor(s.worker), thread: root })),
        { text: `Latest in ${chat}`, author: personAuthor(owner) }])
    }
    const long: Array<{ text: string; author: Author; thread?: string | null }> = []
    for (let i = 0; i < 1000; i++) {
      long.push({ text: `Long root ${i}`, author: personAuthor(owner) })
    }
    const roots = await insert(s.tabId, s.web, long)
    await insert(s.tabId, s.web, roots.flatMap((root, i) => [{ text: `Long reply ${i}a`, author: agentAuthor(s.worker), thread: root },
      { text: `Long reply ${i}b`, author: agentAuthor(s.worker), thread: root }]))
    return { ...s, chats }
  }
  const sent = async () => {
    const out = ((await db.$runCommandRaw({ serverStatus: 1 })) as { network: { bytesOut: unknown } }).network.bytesOut
    return typeof out === 'number' ? out : Number((out as { $numberLong?: string; $numberInt?: string }).$numberLong ?? (out as { $numberInt?: string }).$numberInt)
  }

  it(`reads by index only and examines a bounded number of messages for a person with ${CHATS}+ active chats`, async () => {
    const s = await bigScene()
    expect(await db.superTabMessage.count({ where: { tabId: s.tabId } })).toBeGreaterThan(3000)
    await inbox(s.tabId, peer)
    await db.$runCommandRaw({ profile: 0 })
    await db.$runCommandRaw({ drop: 'system.profile' }).catch(() => {})
    await db.$runCommandRaw({ create: 'system.profile', capped: true, size: 16 * 1024 * 1024 })
    await db.$runCommandRaw({ profile: 2, slowms: 0 })
    let reply: Awaited<ReturnType<typeof inbox>>
    try {
      reply = await inbox(s.tabId, peer)
    } finally { await db.$runCommandRaw({ profile: 0 }) }
    expect(reply.status).toBe(200)
    // What MongoDB sent for one more call, unprofiled, less what reading the counter itself costs (as superTabRead.test.ts).
    const first = await sent(), own = await sent() - first
    const start = await sent()
    await inbox(s.tabId, peer)
    const bytesFromDatabase = Math.max(0, await sent() - start - own)
    const rows = (await db.$runCommandRaw({ aggregate: 'system.profile', pipeline: [{ $match: { ns: { $not: { $regex: 'system\\.' } } } }, ...PROFILE_STAGES],
      cursor: {} }) as unknown as { cursor: { firstBatch: ProfileEntry[] } }).cursor.firstBatch.map(profileEntry)
    const messages = rows.filter(r => r.ns.endsWith('.SuperTabMessage'))
    expect(rows.filter(r => r.planSummary === 'COLLSCAN')).toEqual([])
    for (const r of messages) expect(r.planSummary, JSON.stringify(r)).toMatch(/^IXSCAN/)
    // A read's later batches (getmore) belong to that read.
    const reads = rows.filter(r => r.op !== 'getmore')
    const messageReads = messages.filter(r => r.op !== 'getmore')
    const docsExamined = rows.reduce((n, r) => n + (r.docsExamined ?? 0), 0)
    const messageDocs = messages.reduce((n, r) => n + (r.docsExamined ?? 0), 0)
    const replyBytes = JSON.stringify(reply.body.data).length
    console.info(`inbox cost: ${CHATS + 4} active chats, ${reads.length} database reads (${messageReads.length} of messages), ` +
      `${docsExamined} docs examined (${messageDocs} messages), ${bytesFromDatabase} bytes from the database, ${replyBytes} reply bytes\n` +
      reads.map(r => `  ${r.ns.split('.').at(-1)} ${r.op} ${r.planSummary ?? ''} docs=${r.docsExamined ?? 0}`).join('\n'))
    // A fixed few reads whatever the chat count: the latest rows, the unread rows, their roots (the read marks are another
    // collection). Nothing new to check for delivered copies here, so no read for them.
    expect(messageReads.length).toBeLessThanOrEqual(3)
    expect(reads.length).toBeLessThanOrEqual(5)
    // Bounded by the caps, never by history: the long chat's 3000 rows are read only to its newest UNREAD_SCAN + 1, so all
    // the chats together examine about one row per chat for the latest, 30 chats' unread rows and their roots.
    expect(messageDocs).toBeLessThan(600)
    expect(reply.body.data.latest).toHaveLength(CHATS + 1)
    // The long chat had more unread rows than one read takes: the reply says so.
    expect(reply.body.data.more).toBe(true)
    expect(replyBytes).toBeLessThan(60_000)
    expect(bytesFromDatabase).toBeLessThan(250_000)
  }, 60_000)
})
