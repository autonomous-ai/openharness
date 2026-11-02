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
import { CATCH_UP_SCAN } from '../src/superTabs/catchUp.js'
import { stableId } from '../src/superTabs/model.js'
import { HostReads } from '../src/superTabs/read/host.js'
import type { Conversation, SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { READ_MARK_EXPIRY_MS, sweepThreadMarks, THREAD_MARK_CAP, writeThreadMark } from '../src/superTabs/readMarks.js'
import { listNamedIndexes, NAMED_INDEX } from '../src/superTabs/parts/indexed.js'
import { NOW, outsider as outsiderActor, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
let clock = NOW
const user = (actor: { userId: string; email: string }): AuthUser => ({ sub: actor.userId, email: actor.email, autonomousEnv: 'prod', role: 'user' })
const [owner, peer, outsider] = [ownerActor, peerActor, outsiderActor].map(user) as [AuthUser, AuthUser, AuthUser]
const ownerTeam: AuthUser = { ...owner, harnessSessionId: 'owner-team-session', harnessSessionKind: 'team' }
const signedIn = (authorization: string | undefined) =>
  authorization === 'Bearer team' ? ownerTeam : [owner, peer, outsider].find(u => `Bearer ${u.sub}` === authorization)
const MIGRATED = NOW - 60_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_read_marks_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const each of [owner, peer, outsider]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
  // The owner's machine, where the fixture's worker runs (reading as that agent).
  await db.machine.create({ data: { machineId: 'host', userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  const store = new SuperTabStore(db, () => clock)
  app = Fastify()
  app.setErrorHandler(errorHandler)
  // External SSO is replaced with fixture accounts; every permission and write below is real.
  app.addHook('onRequest', async (request, reply) => {
    const found = signedIn(request.headers.authorization)
    if (!found) return reply.code(401).send({ success: false })
    request.user = found
  })
  await app.register(superTabRoutes, { store, github: null, reads: new SwarmReads(store, { now: () => clock }),
    hosts: new HostReads(store, { now: () => clock }) })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm in parts: a public conversation with 100 messages, and a private project's conversation only its owner reads. */
async function scene() {
  const s = swarm(MIGRATED)
  s.join(peerActor)
  s.join(outsiderActor)
  const secret = s.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).projectId as string
  const web = s.group('Web')
  const secretGroup = s.group('Secret work', secret)
  const worker = s.add('worker', web, false, ownerActor, 'host', owner.sub)
  s.edit(state => {
    state.conversations.find(c => c.id === web)!.lastMessageSequence = 100
    state.conversations.find(c => c.id === secretGroup)!.lastMessageSequence = 50
  })
  const tabId = `tab-${randomUUID()}`
  await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId } as SuperTabState, revision: 3 })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  return { tabId, web, secretGroup, worker }
}

const call = async (method: 'GET' | 'POST', url: string, as: AuthUser, payload?: unknown) => {
  const response = await app.inject({ method, url, headers: { authorization: as === ownerTeam ? 'Bearer team' : `Bearer ${as.sub}` },
    ...(payload ? { payload } : {}) })
  return { status: response.statusCode, body: response.json() as { data: any; error?: { code: string } } }
}
const mark = (tabId: string, conversationId: string, sequence: number, as: AuthUser = owner, query = '') =>
  call('POST', `/api/super-tabs/${tabId}/conversations/${conversationId}/read${query}`, as, { sequence })
const firstLoad = async (tabId: string, as: AuthUser) => (await call('GET', `/api/super-tabs/${tabId}/parts`, as)).body.data
const marksOf = async (tabId: string, as: AuthUser) => (await firstLoad(tabId, as)).derived.readMarks as Record<string, number> | undefined

describe('read marks (one per person and conversation)', () => {
  it('keeps the person\'s mark and gives it back in their own read only', async () => {
    const s = await scene()
    expect(await mark(s.tabId, s.web, 40)).toMatchObject({ status: 200, body: { data: { sequence: 40 } } })
    expect(await marksOf(s.tabId, owner)).toEqual({ [s.web]: 40 })
    // Another reader of the same conversation never sees it: no read receipts.
    expect(await marksOf(s.tabId, peer)).toEqual({})
    await mark(s.tabId, s.web, 70, peer)
    expect(await marksOf(s.tabId, peer)).toEqual({ [s.web]: 70 })
    expect(await marksOf(s.tabId, owner)).toEqual({ [s.web]: 40 })
  })

  it('never moves a mark back, whichever device writes last', async () => {
    const s = await scene()
    await mark(s.tabId, s.web, 60)
    expect((await mark(s.tabId, s.web, 20)).body.data).toEqual({ sequence: 60 })
    expect(await marksOf(s.tabId, owner)).toEqual({ [s.web]: 60 })
    // Devices racing on a conversation read for the first time: the highest wins and one row is kept.
    const other = await scene()
    await Promise.all([30, 90, 45, 10, 80].map(n => mark(other.tabId, other.web, n)))
    expect(await marksOf(other.tabId, owner)).toEqual({ [other.web]: 90 })
    expect(await db.superTabReadMark.count({ where: { tabId: other.tabId } })).toBe(1)
  })

  it('stops at the conversation\'s newest message', async () => {
    const s = await scene()
    expect((await mark(s.tabId, s.web, 5_000)).body.data).toEqual({ sequence: 100 })
  })

  it('refuses a conversation the person cannot read, and stores nothing', async () => {
    const s = await scene()
    expect((await mark(s.tabId, s.secretGroup, 10, outsider)).status).toBe(404)
    expect((await mark(s.tabId, 'no-such-group', 10, outsider)).status).toBe(404)
    expect(await db.superTabReadMark.count({ where: { tabId: s.tabId } })).toBe(0)
  })

  it('stops sending a mark once the person can no longer read its conversation', async () => {
    const s = await scene()
    await mark(s.tabId, s.web, 30, peer)
    expect(await marksOf(s.tabId, peer)).toEqual({ [s.web]: 30 })
    // The conversation becomes the owner's alone, as a private chat is (read/views.ts canReadGroup).
    await swarmTransaction(db, async tx => {
      const current = (await parts.loadActive(tx, s.tabId, { groupIds: [s.web] })).groups.find(g => g.key === s.web)!
      const data = { ...structuredClone(current.data!), audience: { people: [{ id: owner.sub, generation: 0 }] } } as Conversation
      await guardedWrite(tx, s.tabId, { op: 'update', kind: 'group', key: s.web, seen: current.version, data }, clock)
    })
    expect(await marksOf(s.tabId, peer)).toEqual({})
    expect((await mark(s.tabId, s.web, 40, peer)).status).toBe(404)
  })

  it('keeps no marks for agents', async () => {
    const s = await scene()
    expect((await mark(s.tabId, s.web, 10, owner, '?asAgentId=some-agent')).status).toBe(400)
    expect(await db.superTabReadMark.count({ where: { tabId: s.tabId } })).toBe(0)
  })

  it('sends a later read only the marks that moved since its cursor', async () => {
    const s = await scene()
    clock = NOW
    await mark(s.tabId, s.secretGroup, 10)
    // The cursor overlaps the last 30 s (read/cursor.ts), so a mark is old news to a read a minute later.
    clock = NOW + 60_000
    const cursor = (await firstLoad(s.tabId, owner)).cursor as string
    const changes = async (at: number) => {
      clock = at
      return (await call('GET', `/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, owner)).body.data.derived.readMarks
    }
    expect(await changes(NOW + 61_000)).toEqual({})
    clock = NOW + 62_000
    await mark(s.tabId, s.web, 25)
    expect(await changes(NOW + 63_000)).toEqual({ [s.web]: 25 })
    clock = NOW
  })
})

describe('catch-up summary (what the reader missed since their mark)', () => {
  const lead = { kind: 'agent', id: 'lead-agent', name: 'Lead', displayName: 'River', membershipGeneration: 'g' }
  /** Rows written as the store writes them, numbered from 1 in `conversationId`; scenes repeat conversation ids, so the tab names them. */
  const write = (tabId: string, conversationId: string, rows: Array<{ text: string; source?: object; mentions?: string[]; recipientIds?: string[] }>) =>
    db.superTabMessage.createMany({ data: rows.map((row, i) => ({ id: `${tabId}-${conversationId}-m${i + 1}`, tabId, conversationId, sequence: i + 1, author: lead,
      text: row.text, recipientIds: row.recipientIds ?? [], mentions: row.mentions ?? [], ...(row.source ? { source: row.source } : {}) })) })
  const catchUp = (tabId: string, conversationId: string, after: number, as: AuthUser = owner, query = '') =>
    call('GET', `/api/super-tabs/${tabId}/conversations/${conversationId}/catch-up?after=${after}${query}`, as)
  const scenario = async () => {
    const s = await scene()
    await write(s.tabId, s.web, [
      { text: 'Read already', mentions: [owner.sub] },
      { text: '🎉 Shipped: Avatars. https://github.com/o/r/pull/7', source: { kind: 'ship', title: 'Avatars' } },
      { text: 'Owner, which colour?', mentions: [owner.sub] },
      { text: 'Peer, which font?', mentions: [peer.sub] },
      // An agent-only notice is its recipient's alone, tag and all.
      { text: 'Skill update for the Lead', source: { kind: 'agent-only' }, mentions: [owner.sub], recipientIds: ['lead-agent'] },
      { text: 'Stuck\n\nNo simulator on this Mac.', source: { kind: 'system' } },
    ])
    await write(s.tabId, s.secretGroup, [{ text: 'Secret question', mentions: [owner.sub] }])
    const decision = (id: string, personId: string, conversationId: string, answeredAt?: Date) => ({ id, tabId: s.tabId, batchId: id, projectId: 'p',
      conversationId, personId, askerAgentId: 'lead-agent', question: 'Which?', options: ['A', 'B'], recommended: 0, unblocks: 'Work', createdAt: new Date(NOW),
      ...(answeredAt ? { answeredAt } : {}) })
    await db.superTabDecision.createMany({ data: [decision(`${s.tabId}-d1`, owner.sub, s.web), decision(`${s.tabId}-d2`, peer.sub, s.web),
      decision(`${s.tabId}-d3`, owner.sub, s.web, new Date(NOW)), decision(`${s.tabId}-d4`, owner.sub, s.secretGroup)] })
    return s
  }

  it('lists what landed, what is blocked and what needs the reader, from the rows past the mark they may read', async () => {
    const s = await scenario()
    const { status, body } = await catchUp(s.tabId, s.web, 1)
    expect(status).toBe(200)
    expect(body.data).toEqual({ after: 1, through: 6, unread: 4, more: false, decisions: 1,
      landed: { total: 1, items: [{ messageId: `${s.tabId}-${s.web}-m2`, sequence: 2, author: 'River', text: 'Avatars' }] },
      blocked: { total: 1, items: [{ messageId: `${s.tabId}-${s.web}-m6`, sequence: 6, author: 'River', text: 'Stuck: No simulator on this Mac.' }] },
      needsYou: { total: 1, items: [{ messageId: `${s.tabId}-${s.web}-m3`, sequence: 3, author: 'River', text: 'Owner, which colour?' }] } })
    // Another reader's tags and decisions are their own.
    expect((await catchUp(s.tabId, s.web, 1, peer)).body.data).toMatchObject({ decisions: 1,
      needsYou: { total: 1, items: [{ text: 'Peer, which font?' }] } })
  })

  // The #2213 merge with main (#2177): a task chat's copy of a Lead's notice stored before such copies were marked, whose Lead
  // copy reached the Lead, is read by no one (pageReads.ts deliveredCopies). The summary leaves it out as the page does.
  it('leaves out a task chat copy of a Lead notice that its Lead copy delivered, as the page does', async () => {
    const s = await scene()
    await write(s.tabId, s.web, [
      { text: 'Read already' },
      { text: 'COPY: "Avatars" lost its task. Owner, who takes it?', source: { kind: 'work-lost' }, mentions: [owner.sub] },
      { text: 'Owner, which colour?', mentions: [owner.sub] },
    ])
    const copy = `${s.tabId}-${s.web}-m2`
    await db.superTabMessage.create({ data: { id: stableId(copy, 'lead'), tabId: s.tabId, conversationId: 'lead', sequence: 1, author: lead,
      text: 'COPY: "Avatars" lost its task.', recipientIds: ['lead-agent'], mentions: [], source: { kind: 'work-lost' } } })
    const { status, body } = await catchUp(s.tabId, s.web, 1)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ unread: 1, needsYou: { total: 1, items: [{ messageId: `${s.tabId}-${s.web}-m3` }] } })
    expect(JSON.stringify(body.data)).not.toContain('COPY')
  })

  it('says when the span is longer than one summary reads, and lists no status from its first part as current', async () => {
    const s = await scene()
    // A task stuck early in the span, working again and asking the reader past the cap.
    const rows = Array.from({ length: CATCH_UP_SCAN }, (_, i) => ({ text: i === 4 ? 'Stuck\n\nNo simulator.' : `Update ${i + 1}`,
      ...(i === 4 ? { source: { kind: 'system' } } : {}) }))
    await write(s.tabId, s.web, [...rows, { text: 'Working', source: { kind: 'system' } }, { text: 'Owner, which colour?', mentions: [owner.sub] }])
    const { body } = await catchUp(s.tabId, s.web, 0)
    expect(body.data).toMatchObject({ after: 0, through: CATCH_UP_SCAN, unread: CATCH_UP_SCAN, more: true,
      blocked: { total: 0 }, landed: { total: 0 }, needsYou: { total: 0 } })
  })

  it('refuses a conversation the reader cannot read, and one that does not exist', async () => {
    const s = await scenario()
    expect((await catchUp(s.tabId, s.secretGroup, 0, outsider)).status).toBe(404)
    expect((await catchUp(s.tabId, 'no-such-group', 0, outsider)).status).toBe(404)
    // Its owner reads it.
    expect((await catchUp(s.tabId, s.secretGroup, 0)).body.data).toMatchObject({ decisions: 1, needsYou: { total: 1 } })
  })

  it('stops summarizing a conversation once the reader can no longer read it', async () => {
    const s = await scenario()
    expect((await catchUp(s.tabId, s.web, 1, peer)).status).toBe(200)
    await swarmTransaction(db, async tx => {
      const current = (await parts.loadActive(tx, s.tabId, { groupIds: [s.web] })).groups.find(g => g.key === s.web)!
      const data = { ...structuredClone(current.data!), audience: { people: [{ id: owner.sub, generation: 0 }] } } as Conversation
      await guardedWrite(tx, s.tabId, { op: 'update', kind: 'group', key: s.web, seen: current.version, data }, clock)
    })
    expect((await catchUp(s.tabId, s.web, 1, peer)).status).toBe(404)
  })

  it('is for people reading as themselves: never an agent or a Team session', async () => {
    const s = await scenario()
    expect((await catchUp(s.tabId, s.web, 1, owner, '&asAgentId=lead-agent')).status).toBe(400)
    expect((await catchUp(s.tabId, s.web, 1, ownerTeam)).status).toBe(403)
    expect((await call('GET', `/api/super-tabs/${s.tabId}/conversations/${s.web}/catch-up`, owner)).status).toBe(400)
  })
})

describe('thread marks (one per person and thread)', () => {
  /** A thread rooted at `root` in `conversationId`: the root, then `replies` replies numbered after it. */
  const thread = (tabId: string, conversationId: string, root: string, at: number, replies = 2) =>
    db.superTabMessage.createMany({ data: Array.from({ length: replies + 1 }, (_, i) => ({ id: i ? `${root}-r${i}` : root, tabId, conversationId,
      sequence: at + i, thread: root, author: { kind: 'agent', id: 'lead-agent' }, text: i ? `Reply ${i}` : 'Root', recipientIds: [], mentions: [] })) })
  const scenario = async () => {
    const s = await scene()
    const root = `${s.tabId}-root`, secretRoot = `${s.tabId}-secret-root`, agentRoot = `${s.tabId}-agent-root`
    await thread(s.tabId, s.web, root, 10)
    await thread(s.tabId, s.secretGroup, secretRoot, 20)
    // An agent-only notice to the Lead, with a reply: no person reads it.
    await db.superTabMessage.createMany({ data: [agentRoot, `${agentRoot}-r1`].map((id, i) => ({ id, tabId: s.tabId, conversationId: s.web, sequence: 30 + i,
      thread: agentRoot, author: { kind: 'agent', id: 'lead-agent' }, text: 'For the Lead', recipientIds: ['lead-agent'], mentions: [],
      source: { kind: 'agent-only' } })) })
    return { ...s, root, secretRoot, agentRoot }
  }
  const markThread = (tabId: string, conversationId: string, root: string, sequence: number, as: AuthUser = owner, query = '') =>
    call('POST', `/api/super-tabs/${tabId}/conversations/${conversationId}/threads/${root}/read${query}`, as, { sequence })
  const threadMarksOf = async (tabId: string, as: AuthUser, query = '') =>
    (await call('GET', `/api/super-tabs/${tabId}/parts${query}`, as)).body.data.derived.threadMarks as Record<string, Record<string, number>> | undefined

  it('keeps the person\'s thread mark and gives it back in their own read only', async () => {
    const s = await scenario()
    expect(await markThread(s.tabId, s.web, s.root, 11)).toMatchObject({ status: 200, body: { data: { sequence: 11 } } })
    expect(await threadMarksOf(s.tabId, owner)).toEqual({ [s.web]: { [s.root]: 11 } })
    // Another reader of the same thread never sees it, and a person with none gets no field at all.
    expect(await threadMarksOf(s.tabId, peer)).toBeUndefined()
    await markThread(s.tabId, s.web, s.root, 12, peer)
    expect(await threadMarksOf(s.tabId, peer)).toEqual({ [s.web]: { [s.root]: 12 } })
    expect(await threadMarksOf(s.tabId, owner)).toEqual({ [s.web]: { [s.root]: 11 } })
    // An agent reading as itself (a Buddy is one) has none, though its owner has.
    const asAgent = await call('GET', `/api/super-tabs/${s.tabId}/parts?asAgentId=${s.worker}`, owner)
    expect(asAgent.status, JSON.stringify(asAgent.body.error)).toBe(200)
    expect(asAgent.body.data.derived.threadMarks).toBeUndefined()
  })

  it('never moves a thread mark back, whichever device writes last', async () => {
    const s = await scenario()
    await markThread(s.tabId, s.web, s.root, 12)
    expect((await markThread(s.tabId, s.web, s.root, 10)).body.data).toEqual({ sequence: 12 })
    expect(await threadMarksOf(s.tabId, owner)).toEqual({ [s.web]: { [s.root]: 12 } })
    const other = await scenario()
    await Promise.all([10, 12, 11, 10, 12].map(n => markThread(other.tabId, other.web, other.root, n)))
    expect(await threadMarksOf(other.tabId, owner)).toEqual({ [other.web]: { [other.root]: 12 } })
    expect(await db.superTabThreadMark.count({ where: { tabId: other.tabId } })).toBe(1)
  })

  it('stops at the conversation\'s newest message', async () => {
    const s = await scenario()
    expect((await markThread(s.tabId, s.web, s.root, 5_000)).body.data).toEqual({ sequence: 100 })
  })

  it('leaves the conversation\'s own mark as it was: a client without thread marks reads the same', async () => {
    const s = await scenario()
    await mark(s.tabId, s.web, 5)
    await markThread(s.tabId, s.web, s.root, 12)
    expect(await marksOf(s.tabId, owner)).toEqual({ [s.web]: 5 })
    expect(await db.superTabReadMark.count({ where: { tabId: s.tabId } })).toBe(1)
  })

  it('refuses a thread of another conversation, an unknown one and one the person cannot read alike, storing nothing', async () => {
    const s = await scenario()
    const refused = [
      await markThread(s.tabId, s.secretGroup, s.secretRoot, 21, outsider),
      // The private chat's thread named under a conversation the person reads.
      await markThread(s.tabId, s.web, s.secretRoot, 21, outsider),
      await markThread(s.tabId, s.web, 'no-such-root', 21, outsider),
      await markThread(s.tabId, 'no-such-group', s.root, 21, outsider),
      // A reply is no thread's root; an agent-only notice is no person's.
      await markThread(s.tabId, s.web, `${s.root}-r1`, 21, outsider),
      await markThread(s.tabId, s.web, s.agentRoot, 31, outsider),
    ]
    expect(refused.map(r => r.status)).toEqual([404, 404, 404, 404, 404, 404])
    expect(new Set(refused.map(r => JSON.stringify(r.body.error)))).toHaveLength(1)
    expect(JSON.stringify(refused)).not.toContain('Secret')
    expect(await db.superTabThreadMark.count({ where: { tabId: s.tabId } })).toBe(0)
  })

  it('stops sending a thread mark once the person can no longer read its conversation', async () => {
    const s = await scenario()
    await markThread(s.tabId, s.web, s.root, 11, peer)
    expect(await threadMarksOf(s.tabId, peer)).toEqual({ [s.web]: { [s.root]: 11 } })
    await swarmTransaction(db, async tx => {
      const current = (await parts.loadActive(tx, s.tabId, { groupIds: [s.web] })).groups.find(g => g.key === s.web)!
      const data = { ...structuredClone(current.data!), audience: { people: [{ id: owner.sub, generation: 0 }] } } as Conversation
      await guardedWrite(tx, s.tabId, { op: 'update', kind: 'group', key: s.web, seen: current.version, data }, clock)
    })
    expect(await threadMarksOf(s.tabId, peer)).toBeUndefined()
    expect((await markThread(s.tabId, s.web, s.root, 12, peer)).status).toBe(404)
  })

  it('never sends a change read a thread mark of a conversation the reader lost', async () => {
    const s = await scenario()
    clock = NOW
    const cursor = (await firstLoad(s.tabId, peer)).cursor as string
    clock = NOW + 1_000
    await markThread(s.tabId, s.web, s.root, 11, peer)
    await swarmTransaction(db, async tx => {
      const current = (await parts.loadActive(tx, s.tabId, { groupIds: [s.web] })).groups.find(g => g.key === s.web)!
      const data = { ...structuredClone(current.data!), audience: { people: [{ id: owner.sub, generation: 0 }] } } as Conversation
      await guardedWrite(tx, s.tabId, { op: 'update', kind: 'group', key: s.web, seen: current.version, data }, clock)
    })
    clock = NOW + 2_000
    const changed = (await call('GET', `/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, peer)).body.data
    expect(JSON.stringify(changed.derived ?? {})).not.toContain(s.root)
    clock = NOW
  })

  it('keeps no thread marks for agents or Team sessions', async () => {
    const s = await scenario()
    expect((await markThread(s.tabId, s.web, s.root, 11, owner, '?asAgentId=some-agent')).status).toBe(400)
    expect((await markThread(s.tabId, s.web, s.root, 11, ownerTeam)).status).toBe(403)
    expect(await db.superTabThreadMark.count({ where: { tabId: s.tabId } })).toBe(0)
  })

  it('sends a later read only the thread marks that moved since its cursor', async () => {
    const s = await scenario()
    clock = NOW
    await markThread(s.tabId, s.secretGroup, s.secretRoot, 21)
    clock = NOW + 60_000
    const cursor = (await firstLoad(s.tabId, owner)).cursor as string
    const changes = async (at: number) => {
      clock = at
      return (await call('GET', `/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, owner)).body.data.derived.threadMarks
    }
    expect(await changes(NOW + 61_000)).toBeUndefined()
    clock = NOW + 62_000
    await markThread(s.tabId, s.web, s.root, 12)
    expect(await changes(NOW + 63_000)).toEqual({ [s.web]: { [s.root]: 12 } })
    clock = NOW
  })

  it(`keeps at most ${THREAD_MARK_CAP} per person and Swarm, dropping the least recently moved`, async () => {
    const s = await scenario()
    const write = (threadId: string, at: number, personId = owner.sub) =>
      writeThreadMark(db, { tabId: s.tabId, personId, conversationId: s.web, threadId, sequence: 1, now: at })
    for (let i = 0; i < THREAD_MARK_CAP; i++) await write(`t${i}`, NOW + i)
    // Another person's marks count apart.
    await write('t0', NOW, peer.sub)
    // t0 moves on, so t1 is now the least recently moved.
    await writeThreadMark(db, { tabId: s.tabId, personId: owner.sub, conversationId: s.web, threadId: 't0', sequence: 2, now: NOW + THREAD_MARK_CAP })
    await write('newest', NOW + THREAD_MARK_CAP + 1)
    const kept = await db.superTabThreadMark.findMany({ where: { tabId: s.tabId, personId: owner.sub }, select: { threadId: true } })
    expect(kept).toHaveLength(THREAD_MARK_CAP)
    expect(kept.map(k => k.threadId)).toEqual(expect.arrayContaining(['t0', 'newest']))
    expect(kept.map(k => k.threadId)).not.toContain('t1')
    expect(await db.superTabThreadMark.count({ where: { tabId: s.tabId, personId: peer.sub } })).toBe(1)
  }, 60_000)

  it('sweeps marks untouched for 180 days and those of Swarms and people gone, keeping every live one', async () => {
    const s = await scenario()
    const write = (threadId: string, at: number, personId = owner.sub, tabId = s.tabId) =>
      writeThreadMark(db, { tabId, personId, conversationId: s.web, threadId, sequence: 1, now: at })
    const now = NOW + READ_MARK_EXPIRY_MS + 60_000
    await write('old', NOW)
    await write('fresh', now - 1_000)
    await write('peers', now - 1_000, peer.sub)
    // Someone no longer in the Swarm, and a Swarm that is gone.
    await write('left', now - 1_000, 'person-who-left')
    await write('deleted-swarm', now - 1_000, owner.sub, `${s.tabId}-deleted`)
    const result = await sweepThreadMarks(db, now, { walk: { after: '' }, swarms: 100_000 })
    const kept = await db.superTabThreadMark.findMany({ where: { tabId: { startsWith: s.tabId } }, select: { threadId: true } })
    expect(kept.map(k => k.threadId).sort()).toEqual(['fresh', 'peers'])
    expect(result.expired).toBeGreaterThanOrEqual(1)
    expect(result.lost).toBeGreaterThanOrEqual(2)
  })

  /** Marks in Swarms named `${prefix}-${name}`, one person each, moved now. */
  const marksIn = async (prefix: string, names: string[]) => {
    for (const name of names) await writeThreadMark(db, { tabId: `${prefix}-${name}`, personId: owner.sub, conversationId: 'c', threadId: 't', sequence: 1, now: NOW })
  }
  const swarmsWithMarks = async (prefix: string) =>
    [...new Set((await db.superTabThreadMark.findMany({ where: { tabId: { startsWith: prefix } }, select: { tabId: true } })).map(m => m.tabId.slice(prefix.length + 1)))].sort()

  it('never reads a Swarm row without its member list as having no members: only a row that is gone loses its marks', async () => {
    const prefix = `zz-sweep-${randomUUID()}`
    await marksIn(prefix, ['gone', 'no-members'])
    // A Swarm row stored without memberIds (an older or partial row), written as is.
    await db.$runCommandRaw({ insert: 'SuperTab', documents: [{ _id: `${prefix}-no-members`, ownerId: owner.sub, autonomousEnv: 'prod', state: {} }] })
    const result = await sweepThreadMarks(db, NOW, { walk: { after: prefix }, swarms: 10 })
    expect(await swarmsWithMarks(prefix)).toEqual(['no-members'])
    expect(result.swarmsChecked).toBe(2)
  })

  it('checks a bounded number of Swarms a pass, going on from where the last pass stopped and starting over after the last', async () => {
    const prefix = `zz-walk-${randomUUID()}`
    await marksIn(prefix, ['a', 'b', 'c'])
    const at = { after: prefix }
    expect((await sweepThreadMarks(db, NOW, { walk: at, swarms: 2 })).swarmsChecked).toBe(2)
    expect(await swarmsWithMarks(prefix)).toEqual(['c'])
    expect(at.after).toBe(`${prefix}-b`)
    await sweepThreadMarks(db, NOW, { walk: at, swarms: 2 })
    expect(await swarmsWithMarks(prefix)).toEqual([])
    // Past the last Swarm with marks, the next pass starts from the first.
    expect(at.after).toBe('')
  })

  it('keeps its place in the database: a restarted worker goes on from there, and a Swarm whose check failed is checked again', async () => {
    const prefix = `zz-restart-${randomUUID()}`
    await marksIn(prefix, ['a', 'b', 'c'])
    await db.superTabSweepCursor.upsert({ where: { id: 'thread-marks' }, create: { id: 'thread-marks', after: prefix, updatedAt: new Date(NOW) },
      update: { after: prefix } })
    // The first process checks two Swarms, then stops; nothing of it stays in memory.
    expect((await sweepThreadMarks(db, NOW, { swarms: 2 })).swarmsChecked).toBe(2)
    expect((await db.superTabSweepCursor.findUniqueOrThrow({ where: { id: 'thread-marks' } })).after).toBe(`${prefix}-b`)
    // The next one fails while deleting c's marks: its place stays before c.
    const failing = new Proxy(db, { get: (target, key) => key === '$runCommandRaw'
      ? async (command: { deletes?: Array<{ q: { tabId?: string } }> }) => {
        if (command.deletes?.some(d => d.q.tabId === `${prefix}-c`)) throw new Error('connection reset')
        return target.$runCommandRaw(command as never)
      }
      : Reflect.get(target, key) }) as PrismaClient
    await expect(sweepThreadMarks(failing, NOW, { swarms: 2 })).rejects.toThrow('connection reset')
    expect((await db.superTabSweepCursor.findUniqueOrThrow({ where: { id: 'thread-marks' } })).after).toBe(`${prefix}-b`)
    expect(await swarmsWithMarks(prefix)).toEqual(['c'])
    await sweepThreadMarks(db, NOW, { swarms: 2 })
    expect(await swarmsWithMarks(prefix)).toEqual([])
  })

  it('reads a person\'s thread marks through their named indexes, planned once', async () => {
    const s = await scenario()
    await markThread(s.tabId, s.web, s.root, 11)
    await listNamedIndexes(db)
    await db.$runCommandRaw({ planCacheClear: 'SuperTabThreadMark' })
    await db.$runCommandRaw({ profile: 0 })
    await db.$runCommandRaw({ drop: 'system.profile' }).catch(() => {})
    await db.$runCommandRaw({ create: 'system.profile', capped: true, size: 16 * 1024 * 1024 })
    await db.$runCommandRaw({ profile: 2, slowms: 0 })
    try {
      const cursor = (await firstLoad(s.tabId, owner)).cursor as string
      await call('GET', `/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, owner)
    } finally {
      await db.$runCommandRaw({ profile: 0 })
    }
    const rows = (await db.$runCommandRaw({ find: 'system.profile', filter: { ns: { $regex: '\\.SuperTabThreadMark$' } }, batchSize: 1000 }) as unknown as
      { cursor: { firstBatch: Array<{ command?: { hint?: unknown }; planSummary?: string; fromMultiPlanner?: boolean }> } }).cursor.firstBatch
    const hints = rows.map(row => JSON.stringify(row.command?.hint))
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(new Set(hints)).toEqual(new Set([JSON.stringify(NAMED_INDEX.SuperTabThreadMark.person)]))
    expect(rows.every(row => row.planSummary?.startsWith('IXSCAN') && !row.fromMultiPlanner), JSON.stringify(rows.map(r => r.planSummary))).toBe(true)
  })
})
