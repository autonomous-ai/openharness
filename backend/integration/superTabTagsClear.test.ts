import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
import { resolveByAnswer } from '../src/superTabs/mentions.js'
import { plan, profiled } from './plans.test-support.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
let store: SuperTabStore
const user = (actor: { userId: string; email: string }): AuthUser => ({ sub: actor.userId, email: actor.email, autonomousEnv: 'prod', role: 'user' })
const [owner, peer, outsider] = [ownerActor, peerActor, outsiderActor].map(user) as [AuthUser, AuthUser, AuthUser]
const signedIn = (authorization: string | undefined) => [owner, peer, outsider].find(u => `Bearer ${u.sub}` === authorization)
const MIGRATED = NOW - 60_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_tags_clear_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const each of [owner, peer, outsider]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
  // The owner's own machine runs the Swarm's agents, so the owner may write as them.
  await db.machine.create({ data: { machineId: 'host', userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  store = new SuperTabStore(db)
  app = Fastify()
  app.setErrorHandler(errorHandler)
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

/** A Swarm in parts: the first project (a PM, the chat "Web" with a worker) and peer's Buddy chat in it. */
async function scene() {
  const s = swarm(MIGRATED)
  s.join(peerActor)
  s.join(outsiderActor)
  const pm = s.add('pm-harness', 'lead', true, ownerActor, 'host', owner.sub)
  const web = s.group('Web')
  const worker = s.add('worker-harness', web, false, ownerActor, 'host', owner.sub)
  s.run({ type: 'work.assign', conversationId: web, agentId: worker })
  let buddyId = s.group('Peer\'s Buddy')
  s.edit(state => {
    const generation = state.people.find(p => p.id === peer.sub)!.generation
    const chat = state.conversations.find(c => c.id === buddyId)!
    buddyId = buddyChatId(chat.projectId ?? 'lead', { id: peer.sub, generation })
    Object.assign(chat, { id: buddyId, kind: 'buddy', leadId: null, agentIds: [], audience: { people: [{ id: peer.sub, generation }] } })
  })
  const tabId = `tab-${randomUUID()}`
  await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId } as SuperTabState, revision: 3 })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  return { tabId, web, pm, worker, buddyId }
}

const agentAuthor = (id: string): Author => ({ kind: 'agent', id, name: id, membershipGeneration: 'fixture' })
const personAuthor = (u: AuthUser): Author => ({ kind: 'person', id: u.sub, name: u.email, membershipGeneration: 'fixture' })

/** Stores a message as the store stores one (numbered after the chat's newest) and, when it tags, the tag; answers its id. */
async function say(tabId: string, conversationId: string, author: Author, opts: { thread?: string; alsoInChat?: boolean; tags?: AuthUser[] } = {}) {
  const id = `m-${randomUUID()}`
  await swarmTransaction(db, async tx => {
    const current = (await parts.loadActive(tx, tabId, { groupIds: [conversationId] })).groups.find(g => g.key === conversationId)!
    const data = structuredClone(current.data!) as Conversation
    const sequence = (data.messageSeq ?? 0) + 1
    data.messageSeq = data.lastMessageSequence = sequence
    if (!opts.thread || opts.alsoInChat) data.lastMainSequence = sequence
    await tx.superTabMessage.create({ data: { id, tabId, conversationId, sequence, author: author as never, text: 'Please look.', thread: opts.thread ?? id,
      ...(opts.alsoInChat ? { alsoInChat: true } : {}), recipientIds: [], mentions: (opts.tags ?? []).map(t => t.sub), createdAt: new Date() } })
    await guardedWrite(tx, tabId, { op: 'update', kind: 'group', key: conversationId, seen: current.version, data }, Date.now())
    for (const tagged of opts.tags ?? []) {
      await tx.superTabMention.create({ data: { id: stableId(tabId, id, tagged.sub), tabId, personId: tagged.sub, projectId: 'lead', conversationId,
        messageId: id, authorAgentId: author.id, createdAt: new Date(), resolvedAt: null, resolvedBy: null } })
    }
  })
  return id
}
const tagFor = (messageId: string, who: AuthUser) => db.superTabMention.findFirstOrThrow({ where: { messageId, personId: who.sub } })
const listed = async (tabId: string, as: AuthUser) => {
  const response = await app.inject({ method: 'GET', url: `/api/super-tabs/${tabId}/mentions?state=waiting`, headers: { authorization: `Bearer ${as.sub}` } })
  expect(response.statusCode).toBe(200)
  return (response.json().data.mentions as Array<{ messageId: string }>).map(m => m.messageId)
}
const post = async (url: string, as: AuthUser, payload: object) => {
  const response = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${as.sub}` }, payload })
  expect(response.statusCode).toBe(200)
}
const sequenceOf = async (id: string) => (await db.superTabMessage.findUniqueOrThrow({ where: { id } })).sequence
const markChat = async (s: { tabId: string; web: string }, sequence: number, as: AuthUser) => post(`/api/super-tabs/${s.tabId}/conversations/${s.web}/read`, as, { sequence })
const markThread = async (s: { tabId: string; web: string }, root: string, sequence: number, as: AuthUser) =>
  post(`/api/super-tabs/${s.tabId}/conversations/${s.web}/threads/${root}/read`, as, { sequence })

describe('reading clears tags', () => {
  it('reading the chat past a tag resolves it as read', async () => {
    const s = await scene()
    const tag = await say(s.tabId, s.web, agentAuthor(s.pm), { tags: [peer] })
    expect(await listed(s.tabId, peer)).toEqual([tag])
    await markChat(s, await sequenceOf(tag), peer)
    expect(await listed(s.tabId, peer)).toEqual([])
    expect((await tagFor(tag, peer)).resolvedBy).toBe('read')
  })

  // ENGINEERING §4: a read mark is on the request path. The tags it passes are resolved in one write, never one per tag.
  it('a mark past thirty tags resolves them in one write', async () => {
    const s = await scene()
    const tags: string[] = []
    for (let i = 0; i < 30; i++) tags.push(await say(s.tabId, s.web, agentAuthor(s.pm), { tags: [peer] }))
    const newest = await sequenceOf(tags.at(-1)!)
    const entries = await profiled(db, () => markChat(s, newest, peer))
    expect(await listed(s.tabId, peer)).toEqual([])
    expect(await Promise.all(tags.map(async tag => (await tagFor(tag, peer)).resolvedBy))).toEqual(tags.map(() => 'read'))
    expect(entries.filter(e => e.ns.endsWith('.SuperTabMention') && e.op === 'update')).toHaveLength(1)
  })

  it('a mark before the tag leaves it waiting', async () => {
    const s = await scene()
    await say(s.tabId, s.web, personAuthor(owner))
    const tag = await say(s.tabId, s.web, agentAuthor(s.pm), { tags: [peer] })
    await markChat(s, (await sequenceOf(tag)) - 1, peer)
    expect(await listed(s.tabId, peer)).toEqual([tag])
  })

  it('a chat mark does not clear a tag in a thread reply; its thread mark does', async () => {
    const s = await scene()
    const root = await say(s.tabId, s.web, personAuthor(owner))
    const tag = await say(s.tabId, s.web, agentAuthor(s.pm), { thread: root, tags: [peer] })
    await markChat(s, await sequenceOf(tag), peer)
    expect(await listed(s.tabId, peer)).toEqual([tag])
    await markThread(s, root, await sequenceOf(tag), peer)
    expect(await listed(s.tabId, peer)).toEqual([])
    expect((await tagFor(tag, peer)).resolvedBy).toBe('read')
  })

  it('a reply also sent to the chat clears by the chat mark', async () => {
    const s = await scene()
    const root = await say(s.tabId, s.web, personAuthor(owner))
    const tag = await say(s.tabId, s.web, agentAuthor(s.pm), { thread: root, alsoInChat: true, tags: [peer] })
    await markChat(s, await sequenceOf(tag), peer)
    expect(await listed(s.tabId, peer)).toEqual([])
    expect((await tagFor(tag, peer)).resolvedBy).toBe('read')
  })

  it('a failed tag resolve still stores and answers the read mark', async () => {
    const s = await scene()
    const tag = await say(s.tabId, s.web, agentAuthor(s.pm), { tags: [peer] })
    const sequence = await sequenceOf(tag)
    const real = db.superTabMention.findMany.bind(db.superTabMention) as (args: { select?: object }) => Promise<unknown>
    // Only resolveRead's capped read (the first, before the answer is built) fails.
    const spy = vi.spyOn(db.superTabMention, 'findMany').mockImplementation(((args: { select?: object }) => Object.keys(args.select ?? {}).join() === 'id,messageId' ? Promise.reject(new Error('boom')) : real(args)) as never)
    const response = await app.inject({ method: 'POST', url: `/api/super-tabs/${s.tabId}/conversations/${s.web}/read`, headers: { authorization: `Bearer ${peer.sub}` }, payload: { sequence } })
    spy.mockRestore()
    expect(response.statusCode).toBe(200)
    expect(response.json().data.sequence).toBe(sequence)
  })

  it('another person\'s read leaves my tag', async () => {
    const s = await scene()
    const tag = await say(s.tabId, s.web, agentAuthor(s.pm), { tags: [peer] })
    await markChat(s, await sequenceOf(tag), owner)
    expect(await listed(s.tabId, peer)).toEqual([tag])
  })
})

describe('answering clears tags', () => {
  const sendTo = (s: { tabId: string }, conversationId: string, as: AuthUser) => store.execute(as, s.tabId, { operationId: randomUUID(),
    command: { type: 'message.send', conversationId, text: 'Go ahead.', replyTo: null, recipientIds: [] } })

  it('posting in my Buddy chat clears the PM\'s tag in a task chat', async () => {
    const s = await scene()
    const tag = await say(s.tabId, s.web, agentAuthor(s.pm), { tags: [peer] })
    await sendTo(s, s.buddyId, peer)
    expect(await listed(s.tabId, peer)).toEqual([])
    expect((await tagFor(tag, peer)).resolvedBy).toBe('answer')
  })

  // ENGINEERING §4: a person's post runs this in its message.send. The tags are found by the person's own index; the agent that
  // made each is in no index, so they are read once, never once per agent answered.
  it('answering five agents reads the person\'s tags once, and resolves only those five agents\' waiting tags', async () => {
    const tabId = `tab-${randomUUID()}`, now = Date.now()
    const agents = Array.from({ length: 10 }, (_, i) => `agent-${i}`)
    // 200 tags of one person, 20 by each agent; one in four already resolved.
    const tags = Array.from({ length: 200 }, (_, i) => ({ id: `${tabId}-tag-${i}`, tabId, personId: peer.sub, projectId: 'lead', conversationId: 'lead',
      messageId: `m-${i}`, authorAgentId: agents[i % 10]!, createdAt: new Date(now - 60_000 - i * 1000),
      resolvedAt: i % 4 === 0 ? new Date(now - 30_000) : null, resolvedBy: i % 4 === 0 ? 'read' : null }))
    await db.superTabMention.createMany({ data: tags })
    const answered = agents.slice(0, 5)
    const entries = await profiled(db, () => resolveByAnswer(db as never, tabId, peer.sub, answered, now))
    const ops = entries.filter(e => e.ns.endsWith('.SuperTabMention')), examined = ops.reduce((sum, e) => sum + (e.docsExamined ?? 0), 0)
    const expected = tags.filter(tag => answered.includes(tag.authorAgentId) && !tag.resolvedAt).map(tag => tag.id).sort()
    const after = await db.superTabMention.findMany({ where: { tabId }, select: { id: true, resolvedBy: true } })
    expect(after.filter(row => row.resolvedBy === 'answer').map(row => row.id).sort()).toEqual(expected)
    expect(after.filter(row => row.resolvedBy === 'read')).toHaveLength(50)
    expect(after.filter(row => !row.resolvedBy)).toHaveLength(150 - expected.length)
    // Each of the person's tags once, then the resolved ones in one write by their ids.
    expect(examined, `examined ${examined} for ${tags.length} tags, ${expected.length} resolved: ${JSON.stringify(plan(ops).slice(0, 3))}`).toBeLessThanOrEqual(tags.length + expected.length)
    expect(ops.filter(e => e.op === 'update')).toHaveLength(1)
  })

  it('a tag by another agent stays', async () => {
    const s = await scene()
    const tag = await say(s.tabId, s.web, agentAuthor(s.worker), { tags: [peer] })
    await sendTo(s, s.buddyId, peer)
    expect(await listed(s.tabId, peer)).toEqual([tag])
  })
})
