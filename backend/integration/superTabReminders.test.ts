import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { HostReads } from '../src/superTabs/read/host.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { REMINDER_CAP, REMINDER_EXPIRY_MS, REMINDER_READS, resetReminderReads, sweepReminders } from '../src/superTabs/reminders.js'
import { stableId, type Command, type SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, outsider as outsiderActor, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'
import { plan, planDatabase, profiled, reads } from './plans.test-support.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
let store: SuperTabStore
let clock = NOW
const MINUTE = 60_000, DAY = 24 * 60 * MINUTE
const user = (actor: { userId: string; email: string }): AuthUser => ({ sub: actor.userId, email: actor.email, autonomousEnv: 'prod', role: 'user' })
const [owner, peer, outsider] = [ownerActor, peerActor, outsiderActor].map(user) as [AuthUser, AuthUser, AuthUser]
const ownerTeam: AuthUser = { ...owner, harnessSessionId: 'owner-team-session', harnessSessionKind: 'team' }
const signedIn = (authorization: string | undefined) =>
  authorization === 'Bearer team' ? ownerTeam : [owner, peer, outsider].find(u => `Bearer ${u.sub}` === authorization)
const MIGRATED = NOW - MINUTE

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_reminders_test'))
  for (const each of [owner, peer, outsider]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'host', userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  store = new SuperTabStore(db, () => clock)
  app = Fastify()
  app.setErrorHandler(errorHandler)
  // External SSO is replaced with fixture accounts; every permission and write below is real.
  app.addHook('onRequest', async (request, reply) => {
    const found = signedIn(request.headers.authorization)
    if (!found) return reply.code(401).send({ success: false })
    request.user = found
  })
  await app.register(superTabRoutes, { store, github: null, reads: new SwarmReads(store, { now: () => clock }), hosts: new HostReads(store, { now: () => clock }) })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})
beforeEach(() => {
  clock = NOW
  resetReminderReads()
})

/** A Swarm in parts: a public chat ("Web", with a worker on the owner's machine), a project shared with the owner alone
 *  ("Secret work"), and a public project the owner can make private later ("Open chat"). */
async function scene() {
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
  const tabId = `tab-${randomUUID()}`
  await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId } as SuperTabState, revision: 3 })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  return { tabId, web, worker, secret, secretGroup, open, openChat }
}

const run = async (tabId: string, command: Command, as: AuthUser = owner, asAgentId?: string) =>
  (await store.execute(as, tabId, { operationId: randomUUID(), command }, asAgentId)) as { result: Record<string, unknown> }
const send = async (tabId: string, conversationId: string, text: string, as: AuthUser = owner, replyTo: string | null = null, asAgentId?: string) =>
  (await run(tabId, { type: 'message.send', conversationId, text, replyTo, recipientIds: [] }, as, asAgentId)).result.messageId as string
const call = async (method: 'GET' | 'PUT' | 'DELETE', url: string, as: AuthUser = owner, payload?: unknown) => {
  const response = await app.inject({ method, url, headers: { authorization: as === ownerTeam ? 'Bearer team' : `Bearer ${as.sub}` },
    ...(payload === undefined ? {} : { payload: payload as never }) })
  return { status: response.statusCode, body: response.json() as { data: any; error?: { code: string; message: string } }, headers: response.headers }
}
const iso = (at: number) => new Date(at).toISOString()
const reminderUrl = (tabId: string, conversationId: string, messageId: string, query = '') =>
  `/api/super-tabs/${tabId}/conversations/${conversationId}/messages/${messageId}/reminder${query}`
const set = (tabId: string, conversationId: string, messageId: string, at: number | string, as: AuthUser = owner, query = '') =>
  call('PUT', reminderUrl(tabId, conversationId, messageId, query), as, { at: typeof at === 'number' ? iso(at) : at })
const clear = (tabId: string, conversationId: string, messageId: string, as: AuthUser = owner, query = '') =>
  call('DELETE', reminderUrl(tabId, conversationId, messageId, query), as)
const list = (tabId: string, as: AuthUser = owner, query = '') => call('GET', `/api/super-tabs/${tabId}/reminders${query}`, as)
const due = async (tabId: string, as: AuthUser = owner) => {
  const answer = await list(tabId, as)
  expect(answer.status).toBe(200)
  return answer.body.data as { due: any[]; next: string | null }
}
const derived = async (tabId: string, as: AuthUser = owner, query = '') => (await call('GET', `/api/super-tabs/${tabId}/parts${query}`, as)).body.data.derived

describe('Reminders: a message brought back to its person at a time', () => {
  it('a due reminder shows in Activity once: not before its time, then once, with its message, author and chat', async () => {
    const s = await scene()
    const message = await send(s.tabId, s.web, 'Should a reminder clear when opened?', owner, null, s.worker)
    const at = NOW + 20 * MINUTE
    const stored = await set(s.tabId, s.web, message, at)
    expect(stored).toMatchObject({ status: 200, body: { data: { id: expect.any(String), dueAt: iso(at) } } })
    // Not before its time: the list is empty and says when the next one is due, so the client wakes then.
    expect(await due(s.tabId)).toEqual({ due: [], next: iso(at) })
    clock = at - 1
    expect((await due(s.tabId)).due).toEqual([])
    clock = at
    const item = { id: stored.body.data.id, conversationId: s.web, conversationTitle: 'Web', projectName: expect.any(String), messageId: message,
      messageSequence: expect.any(Number), threadId: null, author: { kind: 'agent', id: s.worker, name: 'worker-harness' },
      text: 'Should a reminder clear when opened?', dueAt: iso(at) }
    expect(await due(s.tabId)).toEqual({ due: [item], next: null })
    // Two reads, also racing, give the same one row.
    const [first, second] = await Promise.all([due(s.tabId), due(s.tabId)])
    expect(first).toEqual({ due: [item], next: null })
    expect(second).toEqual(first)
  })

  it('names the thread of a reply that lives only there, and the person who wrote it, newest due first', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    const reply = await send(s.tabId, s.web, 'Peer answers in the thread', peer, root)
    await run(s.tabId, { type: 'member.name', name: 'Peer Person' }, peer)
    await set(s.tabId, s.web, root, NOW + 10 * MINUTE)
    await set(s.tabId, s.web, reply, NOW + 20 * MINUTE)
    clock = NOW + 30 * MINUTE
    const listed = (await due(s.tabId)).due
    expect(listed.map(i => [i.messageId, i.threadId, i.author.kind, i.author.name])).toEqual([[reply, root, 'person', 'Peer Person'], [root, null, 'person', expect.any(String)]])
  })

  it('replaces the time when set again, removes it when cleared, and moves the digest on each', async () => {
    const s = await scene()
    const message = await send(s.tabId, s.web, 'Remind me')
    const empty = (await derived(s.tabId)).remindersDigest
    expect(typeof empty).toBe('string')
    await set(s.tabId, s.web, message, NOW + 60 * MINUTE)
    const once = (await derived(s.tabId)).remindersDigest
    expect(once).not.toBe(empty)
    expect((await set(s.tabId, s.web, message, NOW + 120 * MINUTE)).body.data.dueAt).toBe(iso(NOW + 120 * MINUTE))
    const again = (await derived(s.tabId)).remindersDigest
    expect(again).not.toBe(once)
    expect(await db.superTabReminder.count({ where: { tabId: s.tabId } })).toBe(1)
    expect(await due(s.tabId)).toEqual({ due: [], next: iso(NOW + 120 * MINUTE) })
    // Another person's digest, and an agent's read, never move with it: an agent has none.
    expect((await derived(s.tabId, peer)).remindersDigest).toBe(empty)
    expect((await derived(s.tabId, owner, `?asAgentId=${s.worker}`)).remindersDigest).toBeUndefined()
    expect((await clear(s.tabId, s.web, message)).body.data).toEqual({ cleared: true })
    expect((await derived(s.tabId)).remindersDigest).toBe(empty)
    expect(await due(s.tabId)).toEqual({ due: [], next: null })
    expect((await clear(s.tabId, s.web, message)).body.data).toEqual({ cleared: false })
  })

  it('refuses a time that is not in the future or more than 30 days ahead', async () => {
    const s = await scene()
    const message = await send(s.tabId, s.web, 'Remind me')
    for (const at of [NOW, NOW - MINUTE, NOW + 30 * DAY + 1]) {
      const refused = await set(s.tabId, s.web, message, at)
      expect(refused.status, iso(at)).toBe(400)
      expect(refused.body.error?.code).toBe('INVALID_REMINDER')
    }
    expect((await set(s.tabId, s.web, message, 'tomorrow')).status).toBe(400)
    expect((await set(s.tabId, s.web, message, NOW + 30 * DAY)).status).toBe(200)
  })

  it('is the person\'s alone: another member, an agent and a Team session never read, set or clear it', async () => {
    const s = await scene()
    const message = await send(s.tabId, s.web, 'Owner asks')
    await set(s.tabId, s.web, message, NOW + 20 * MINUTE)
    clock = NOW + 20 * MINUTE
    expect(await due(s.tabId, peer)).toEqual({ due: [], next: null })
    expect((await clear(s.tabId, s.web, message, peer)).body.data).toEqual({ cleared: false })
    for (const answer of [await list(s.tabId, ownerTeam), await set(s.tabId, s.web, message, NOW + 40 * MINUTE, ownerTeam), await clear(s.tabId, s.web, message, ownerTeam)]) {
      expect(answer.status).toBe(403)
    }
    for (const answer of [await list(s.tabId, owner, `?asAgentId=${s.worker}`), await set(s.tabId, s.web, message, NOW + 40 * MINUTE, owner, `?asAgentId=${s.worker}`),
      await clear(s.tabId, s.web, message, owner, `?asAgentId=${s.worker}`)]) {
      expect(answer.status).toBe(400)
    }
    expect((await due(s.tabId)).due.map(i => [i.messageId, i.dueAt])).toEqual([[message, iso(NOW + 20 * MINUTE)]])
  })

  it('refuses a message the person cannot read, one of another chat and one that does not exist alike, storing nothing', async () => {
    const s = await scene()
    const secret = await send(s.tabId, s.secretGroup, 'Secret question')
    const open = await send(s.tabId, s.web, 'Open question')
    // A notice for agents alone is never shown to a person (read/inbox.ts readable).
    const notice = `${s.tabId}-notice`
    await db.superTabMessage.create({ data: { id: notice, tabId: s.tabId, conversationId: s.web, sequence: 999, text: 'For the Lead',
      author: { kind: 'agent', id: s.worker, name: 'worker-harness', membershipGeneration: 'g' }, recipientIds: [s.worker], mentions: [], source: { kind: 'agent-only' } } })
    const later = NOW + 20 * MINUTE
    const refusals = [await set(s.tabId, s.secretGroup, secret, later, outsider), await set(s.tabId, s.secretGroup, open, later),
      await set(s.tabId, s.web, `${s.tabId}-missing`, later), await set(s.tabId, s.web, notice, later), await set(s.tabId, 'no-such-group', open, later, outsider)]
    expect(refusals.map(r => r.status)).toEqual([404, 404, 404, 404, 404])
    expect(new Set(refusals.map(r => JSON.stringify(r.body))).size).toBe(1)
    expect((await clear(s.tabId, s.secretGroup, secret, outsider)).status).toBe(404)
    expect(await db.superTabReminder.count({ where: { tabId: s.tabId } })).toBe(0)
  })

  it('drops a reminder of a message the person can no longer read, and lists it again only with access', async () => {
    const s = await scene()
    const message = await send(s.tabId, s.openChat, 'Owner asks in Open')
    await set(s.tabId, s.openChat, message, NOW + 20 * MINUTE, peer)
    clock = NOW + 20 * MINUTE
    expect((await due(s.tabId, peer)).due.map(i => i.messageId)).toEqual([message])
    // The owner makes the project private to themselves: peer can no longer read the chat, and the reminder says nothing.
    await run(s.tabId, { type: 'project.sharing', projectId: s.open, visibility: 'private', memberIds: [] })
    const answer = await list(s.tabId, peer)
    expect(answer.body.data).toEqual({ due: [], next: null })
    expect(JSON.stringify(answer.body)).not.toContain('Open')
    await run(s.tabId, { type: 'project.sharing', projectId: s.open, visibility: 'public', memberIds: [] })
    expect((await due(s.tabId, peer)).due.map(i => i.messageId)).toEqual([message])
  })

  it(`refuses one more than ${REMINDER_CAP} pending reminders per person and Swarm, but lets one be set again`, async () => {
    const s = await scene()
    const [kept, more] = [await send(s.tabId, s.web, 'Kept'), await send(s.tabId, s.web, 'One too many')]
    const row = (messageId: string, n: number) => ({ id: stableId(s.tabId, owner.sub, messageId), tabId: s.tabId, personId: owner.sub, conversationId: s.web,
      messageId, dueAt: new Date(NOW + (n + 1) * MINUTE), createdAt: new Date(NOW) })
    await db.superTabReminder.createMany({ data: [row(kept, 0), ...Array.from({ length: REMINDER_CAP - 1 }, (_, n) => row(`${s.tabId}-other-${n}`, n + 1))] })
    const refused = await set(s.tabId, s.web, more, NOW + 5 * MINUTE)
    expect(refused.status).toBe(409)
    expect(refused.body.error?.code).toBe('REMINDER_LIMIT')
    expect((await set(s.tabId, s.web, kept, NOW + 5 * MINUTE)).status).toBe(200)
    // Another person's reminders count apart.
    expect((await set(s.tabId, s.web, more, NOW + 5 * MINUTE, peer)).status).toBe(200)
    expect(await db.superTabReminder.count({ where: { tabId: s.tabId, personId: owner.sub } })).toBe(REMINDER_CAP)
  })

  it('sweeps reminders due more than 30 days ago, keeping later ones', async () => {
    const s = await scene()
    const [old, soon] = [await send(s.tabId, s.web, 'Old'), await send(s.tabId, s.web, 'Soon')]
    await set(s.tabId, s.web, old, NOW + MINUTE)
    await set(s.tabId, s.web, soon, NOW + 2 * DAY)
    // The sweep is every Swarm's: this one's rows are what is checked.
    await sweepReminders(db, NOW + 2 * MINUTE)
    expect(await db.superTabReminder.count({ where: { tabId: s.tabId } })).toBe(2)
    expect(await sweepReminders(db, NOW + MINUTE + REMINDER_EXPIRY_MS + 1)).toBeGreaterThanOrEqual(1)
    expect((await db.superTabReminder.findMany({ where: { tabId: s.tabId }, select: { messageId: true } })).map(r => r.messageId)).toEqual([soon])
  })

  it('is read at most REMINDER_READS times per window by one person', async () => {
    const s = await scene()
    for (let i = 0; i < REMINDER_READS; i++) expect((await list(s.tabId)).status).toBe(200)
    const refused = await list(s.tabId)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('reads the person\'s reminders by (tabId, personId, dueAt), and the sweep by dueAt, each on its index', async () => {
    const s = await scene()
    const [first, second] = [await send(s.tabId, s.web, 'First'), await send(s.tabId, s.web, 'Second')]
    await set(s.tabId, s.web, first, NOW + MINUTE)
    await set(s.tabId, s.web, second, NOW + 2 * DAY)
    clock = NOW + 10 * MINUTE
    await listNamedIndexes(db)
    const entries = await profiled(db, async () => {
      await due(s.tabId)
      await derived(s.tabId)
      await set(s.tabId, s.web, first, NOW + 20 * MINUTE)
      await sweepReminders(db, clock)
    })
    const person = reads(entries, 'SuperTabReminder', ['personId'])
    // The due list, the next one, the digest and the cap's count.
    expect(person.length, JSON.stringify(plan(person))).toBeGreaterThanOrEqual(4)
    for (const entry of person) {
      expect(entry.planSummary, JSON.stringify(plan([entry]))).toMatch(/^IXSCAN \{ tabId: 1, personId: 1, dueAt: 1 \}/)
      expect(entry.docsExamined ?? 0, JSON.stringify(plan([entry]))).toBeLessThanOrEqual(2)
    }
    const sweep = reads(entries, 'SuperTabReminder', ['dueAt'], ['personId'])
    expect(sweep.length).toBeGreaterThanOrEqual(1)
    for (const entry of sweep) expect(entry.planSummary, JSON.stringify(plan([entry]))).toMatch(/^IXSCAN \{ dueAt: 1 \}/)
  })
})
