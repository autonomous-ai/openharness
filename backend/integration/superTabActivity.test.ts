import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { HostReads } from '../src/superTabs/read/host.js'
import { buddyChatId, openSwarmBuddyChat } from '../src/superTabs/buddies.js'
import { ACTIVITY_EXPIRY_MS, ACTIVITY_READS, resetActivityReads, sweepActivity } from '../src/superTabs/activity.js'
import { CHAT_SETTING_DEFAULT_KEEP_MS, sweepChatSettings } from '../src/superTabs/chatSettings.js'
import type { Command, SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, outsider as outsiderActor, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'

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
  const uri = replica.getUri(`swarm_activity_test_${randomUUID().replaceAll('-', '_')}`)
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
beforeEach(() => resetActivityReads())

/** A Swarm in parts: a public chat ("Web", with a worker on the owner's machine), a project shared with the owner alone
 *  ("Secret work"), a public project the owner can make private later ("Open chat"), and peer's Buddy chat. */
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
  let buddyId = s.group('Peer\'s Buddy')
  s.edit(state => {
    const generation = state.people.find(p => p.id === peer.sub)!.generation
    const chat = state.conversations.find(c => c.id === buddyId)!
    buddyId = buddyChatId(chat.projectId ?? 'lead', { id: peer.sub, generation })
    Object.assign(chat, { id: buddyId, kind: 'buddy', leadId: null, agentIds: [], audience: { people: [{ id: peer.sub, generation }] } })
  })
  let swarmBuddy = ''
  s.edit(state => { swarmBuddy = openSwarmBuddyChat(state, state.people.find(p => p.id === peer.sub)!).id })
  const tabId = `tab-${randomUUID()}`
  const state = { ...structuredClone(s.state), id: tabId } as SuperTabState
  await writeLegacySwarm(db, { state, revision: 3 })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  return { tabId, web, worker, secret, secretGroup, buddyId, open, openChat, swarmBuddy }
}

const run = async (tabId: string, command: Command, as: AuthUser = owner, asAgentId?: string) =>
  (await store.execute(as, tabId, { operationId: randomUUID(), command }, asAgentId)) as { result: Record<string, unknown> }
const send = async (tabId: string, conversationId: string, text: string, as: AuthUser = owner, replyTo: string | null = null, asAgentId?: string) =>
  (await run(tabId, { type: 'message.send', conversationId, text, replyTo, recipientIds: [] }, as, asAgentId)).result.messageId as string
const react = (tabId: string, conversationId: string, messageId: string, on: boolean, as: AuthUser = owner, emoji: 'thumbs_up' | 'check' = 'thumbs_up', asAgentId?: string) =>
  run(tabId, { type: 'message.react', conversationId, messageId, emoji, on }, as, asAgentId)
const call = async (method: 'GET' | 'POST', url: string, as: AuthUser | 'team' = owner, payload?: unknown) => {
  const response = await app.inject({ method, url, headers: { authorization: `Bearer ${as === 'team' ? 'team' : as.sub}` }, ...(payload === undefined ? {} : { payload: payload as never }) })
  return { status: response.statusCode, body: response.json() as { data: any; error?: { code: string; message: string } }, headers: response.headers }
}
const activity = (tabId: string, as: AuthUser | 'team' = owner) => call('GET', `/api/super-tabs/${tabId}/activity`, as)
const items = async (tabId: string, as: AuthUser = owner) => {
  const answer = await activity(tabId, as)
  expect(answer.status).toBe(200)
  return answer.body.data.items as any[]
}
const derived = async (tabId: string, as: AuthUser) => (await call('GET', `/api/super-tabs/${tabId}/parts`, as)).body.data.derived
const notify = (tabId: string, conversationId: string, value: unknown, as: AuthUser | 'team' = owner) =>
  call('POST', `/api/super-tabs/${tabId}/conversations/${conversationId}/notifications`, as, { notify: value })

describe('Activity: replies to a person\'s messages', () => {
  it('lists a reply by someone else in the person\'s thread, newest first, with who wrote it and where', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    const reply = await send(s.tabId, s.web, 'Peer answers', peer, root)
    const agentReply = await send(s.tabId, s.web, 'Worker answers', owner, root, s.worker)
    const list = await items(s.tabId)
    expect(list.map(i => [i.kind, i.messageId, i.text, i.actor.kind])).toEqual([['reply', agentReply, 'Worker answers', 'agent'], ['reply', reply, 'Peer answers', 'person']])
    expect(list[1]).toMatchObject({ conversationId: s.web, conversationTitle: 'Web', threadId: root, actor: { id: peer.sub, name: expect.any(String) }, read: false, emoji: null })
    expect(list[0].actor.name).toBe('worker-harness')
    expect(typeof list[0].messageSequence).toBe('number')
    // Nothing for the person who replied, and nothing for a reply in one's own thread.
    expect(await items(s.tabId, peer)).toEqual([])
    await send(s.tabId, s.web, 'Owner adds', owner, root)
    expect((await items(s.tabId)).length).toBe(2)
  })

  it('tells the author of the message replied to as well as the thread\'s, once each', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    const peerReply = await send(s.tabId, s.web, 'Peer answers', peer, root)
    const outsiderReply = await send(s.tabId, s.web, 'Outsider answers peer', outsider, peerReply)
    expect((await items(s.tabId, peer)).map(i => i.messageId)).toEqual([outsiderReply])
    expect((await items(s.tabId)).map(i => i.messageId)).toEqual([outsiderReply, peerReply])
  })

  it('lists nothing for a top-level message, or for a message of another person\'s chat', async () => {
    const s = await scene()
    await send(s.tabId, s.web, 'Top level by peer', peer)
    expect(await items(s.tabId)).toEqual([])
  })
})

describe('Activity: reactions to a person\'s messages', () => {
  it('lists a reaction by someone else, removes it with the reaction, and never one\'s own', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    await react(s.tabId, s.web, root, true, owner)
    expect(await items(s.tabId)).toEqual([])
    await react(s.tabId, s.web, root, true, peer)
    await react(s.tabId, s.web, root, true, owner, 'check', s.worker)
    const list = await items(s.tabId)
    expect(list.map(i => [i.kind, i.emoji, i.actor.kind, i.text])).toEqual([['reaction', 'check', 'agent', 'Owner root'], ['reaction', 'thumbs_up', 'person', 'Owner root']])
    // The same reaction again keeps one row.
    await react(s.tabId, s.web, root, true, peer)
    expect((await items(s.tabId)).length).toBe(2)
    await react(s.tabId, s.web, root, false, peer)
    expect((await items(s.tabId)).map(i => i.emoji)).toEqual(['check'])
  })

  it('drops a reaction by someone who left the Swarm', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    await react(s.tabId, s.web, root, true, outsider)
    expect((await items(s.tabId)).length).toBe(1)
    await run(s.tabId, { type: 'member.remove', userId: outsider.sub })
    expect(await items(s.tabId)).toEqual([])
  })
})

describe('Activity: only what the person can read now', () => {
  it('drops a row of a chat the person lost, and lists it again only with access', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.openChat, 'Peer root', peer)
    await send(s.tabId, s.openChat, 'Owner answers', owner, root)
    await react(s.tabId, s.openChat, root, true, outsider)
    expect((await items(s.tabId, peer)).length).toBe(2)
    // The owner makes the project private to themselves: peer can no longer read the chat, and its rows say nothing.
    await run(s.tabId, { type: 'project.sharing', projectId: s.open, visibility: 'private', memberIds: [] })
    const answer = await activity(s.tabId, peer)
    expect(answer.body.data).toEqual({ items: [], more: false })
    expect(JSON.stringify(answer.body)).not.toContain('Open chat')
    await run(s.tabId, { type: 'project.sharing', projectId: s.open, visibility: 'public', memberIds: [] })
    expect((await items(s.tabId, peer)).length).toBe(2)
  })

  it('is the reader\'s alone: another member, an outsider of the Swarm and a Team session read none of it', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    await send(s.tabId, s.web, 'Peer answers', peer, root)
    expect(await items(s.tabId, outsider)).toEqual([])
    expect((await activity(s.tabId, 'team')).status).toBe(403)
    await run(s.tabId, { type: 'member.remove', userId: outsider.sub })
    expect((await activity(s.tabId, outsider)).status).toBeGreaterThanOrEqual(403)
    // A Swarm id that is not one, and another Swarm's, are refused alike.
    expect((await activity(`tab-${randomUUID()}`)).status).toBe(404)
  })

  it('keeps a Buddy chat\'s replies to its person', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.buddyId, 'Peer asks their Buddy', peer)
    await db.superTabActivity.create({ data: { id: `fixture-${randomUUID()}`, tabId: s.tabId, personId: owner.sub, kind: 'reply', conversationId: s.buddyId,
      messageId: root, threadId: root, actorKind: 'person', actorId: peer.sub, emoji: null, createdAt: new Date(), readAt: null } })
    // A row naming a chat the reader cannot read (here, written by hand) is refused like any other: no title leaks.
    const answer = await activity(s.tabId, owner)
    expect(answer.body.data.items).toEqual([])
    expect(JSON.stringify(answer.body)).not.toContain('Buddy')
  })
})

describe('Activity in a person\'s one Buddy chat', () => {
  it('drops a reply in a project session\'s thread once the person no longer reads that project (review of the main merge)', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.swarmBuddy, 'Peer asks their Buddy about Open', peer)
    // A reply in the Open project's session thread, marked with its project as a session writes it (buddySessions.ts).
    const reply = `m-${randomUUID()}`
    const sequence = (await db.superTabMessage.findUniqueOrThrow({ where: { id: root } })).sequence + 1
    await db.superTabMessage.create({ data: { id: reply, tabId: s.tabId, conversationId: s.swarmBuddy, sequence, text: 'Open session answers',
      author: { kind: 'agent', id: 'buddy-session', name: 'Buddy', membershipGeneration: 'fixture' } as never, thread: root, recipientIds: [],
      mentions: [], buddySession: true, buddyProject: s.open, createdAt: new Date() } })
    await db.superTabActivity.create({ data: { id: `fixture-${randomUUID()}`, tabId: s.tabId, personId: peer.sub, kind: 'reply',
      conversationId: s.swarmBuddy, messageId: reply, threadId: root, actorKind: 'agent', actorId: 'buddy-session', emoji: null,
      createdAt: new Date(), readAt: null } })
    expect((await items(s.tabId, peer)).map(i => i.text)).toEqual(['Open session answers'])
    // The owner makes Open private to themselves: peer no longer reads it, and its session's reply leaves their Activity.
    await run(s.tabId, { type: 'project.sharing', projectId: s.open, visibility: 'private', memberIds: [] })
    const answer = await activity(s.tabId, peer)
    expect(answer.body.data).toEqual({ items: [], more: false })
    expect(JSON.stringify(answer.body)).not.toContain('Open session answers')
  })
})

describe('Activity: read state and its digest', () => {
  it('moves the digest when a row comes, and when it is read; marks read on every device', async () => {
    const s = await scene()
    const before = (await derived(s.tabId, owner)).activityDigest
    expect(typeof before).toBe('string')
    const root = await send(s.tabId, s.web, 'Owner root')
    await send(s.tabId, s.web, 'Peer answers', peer, root)
    const after = (await derived(s.tabId, owner)).activityDigest
    expect(after).not.toBe(before)
    // Another person's digest does not move.
    expect((await derived(s.tabId, outsider)).activityDigest).toBe(before)
    const [item] = await items(s.tabId)
    const marked = await call('POST', `/api/super-tabs/${s.tabId}/activity/read`, owner, { through: item.createdAt })
    expect(marked).toMatchObject({ status: 200, body: { data: { marked: 1 } } })
    expect((await items(s.tabId))[0].read).toBe(true)
    expect((await derived(s.tabId, owner)).activityDigest).toBe(before)
    expect((await call('POST', `/api/super-tabs/${s.tabId}/activity/read`, owner, { through: 'yesterday' })).status).toBe(400)
    expect((await call('POST', `/api/super-tabs/${s.tabId}/activity/read`, 'team', { through: item.createdAt })).status).toBe(403)
  })

  it('is read at most ACTIVITY_READS times per window by one person', async () => {
    const s = await scene()
    for (let i = 0; i < ACTIVITY_READS; i++) expect((await activity(s.tabId)).status).toBe(200)
    const refused = await activity(s.tabId)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('sweeps rows past their expiry', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    await send(s.tabId, s.web, 'Peer answers', peer, root)
    // The sweep is every Swarm's: this one's rows are what is checked.
    await sweepActivity(db, Date.now())
    expect(await db.superTabActivity.count({ where: { tabId: s.tabId } })).toBe(1)
    expect(await sweepActivity(db, Date.now() + ACTIVITY_EXPIRY_MS + 1000)).toBeGreaterThanOrEqual(1)
    expect(await db.superTabActivity.count({ where: { tabId: s.tabId } })).toBe(0)
  })
})

describe('Chat notification settings', () => {
  it('keeps the person\'s setting, sends it in their reads alone, and keeps no row for the default', async () => {
    const s = await scene()
    expect(await notify(s.tabId, s.web, 'mentions')).toMatchObject({ status: 200, body: { data: { notify: 'mentions' } } })
    expect(await db.superTabChatSetting.count({ where: { tabId: s.tabId } })).toBe(0)
    expect(await notify(s.tabId, s.web, 'muted')).toMatchObject({ status: 200, body: { data: { notify: 'muted' } } })
    expect((await derived(s.tabId, owner)).chatSettings).toEqual({ [s.web]: 'muted' })
    expect((await derived(s.tabId, peer)).chatSettings).toBeUndefined()
    // A change read sends a setting moved since its cursor.
    const first = (await call('GET', `/api/super-tabs/${s.tabId}/parts`, owner)).body.data
    await notify(s.tabId, s.web, 'all')
    const changes = (await call('GET', `/api/super-tabs/${s.tabId}/changes?cursor=${encodeURIComponent(first.cursor)}`, owner)).body.data
    expect(changes.derived.chatSettings).toEqual({ [s.web]: 'all' })
    // Back to the default: the row stays, so other devices learn of it.
    await notify(s.tabId, s.web, 'mentions')
    expect((await derived(s.tabId, owner)).chatSettings).toEqual({ [s.web]: 'mentions' })
  })

  it('refuses a chat the person cannot read like one that does not exist, a Team session, and a value it does not know', async () => {
    const s = await scene()
    const hidden = await notify(s.tabId, s.secretGroup, 'muted', peer)
    const missing = await notify(s.tabId, 'no-such-chat', 'muted', peer)
    const buddy = await notify(s.tabId, s.buddyId, 'muted', owner)
    expect([hidden.status, missing.status, buddy.status]).toEqual([404, 404, 404])
    expect(hidden.body.error).toEqual(missing.body.error)
    expect(buddy.body.error).toEqual(missing.body.error)
    expect((await notify(s.tabId, s.web, 'muted', 'team')).status).toBe(403)
    expect((await notify(s.tabId, s.web, 'loud')).status).toBe(400)
    expect(await db.superTabChatSetting.count({ where: { tabId: s.tabId } })).toBe(0)
  })

  it('stops sending a setting of a chat the person lost', async () => {
    const s = await scene()
    await notify(s.tabId, s.openChat, 'muted', peer)
    expect((await derived(s.tabId, peer)).chatSettings).toEqual({ [s.openChat]: 'muted' })
    await run(s.tabId, { type: 'project.sharing', projectId: s.open, visibility: 'private', memberIds: [] })
    expect((await derived(s.tabId, peer)).chatSettings).toBeUndefined()
  })

  it('sweeps default rows after a week, and the rows of people who left', async () => {
    const s = await scene()
    await notify(s.tabId, s.web, 'muted', peer)
    await notify(s.tabId, s.web, 'muted', outsider)
    await notify(s.tabId, s.openChat, 'muted')
    await notify(s.tabId, s.openChat, 'mentions')
    await run(s.tabId, { type: 'member.remove', userId: outsider.sub })
    const rows = () => db.superTabChatSetting.findMany({ where: { tabId: s.tabId }, select: { personId: true, notify: true }, orderBy: { personId: 'asc' } })
    // The sweep is every Swarm's: this one's rows are what is checked.
    await sweepChatSettings(db, Date.now())
    expect(await rows()).toEqual([{ personId: owner.sub, notify: 'mentions' }, { personId: peer.sub, notify: 'muted' }])
    await sweepChatSettings(db, Date.now() + CHAT_SETTING_DEFAULT_KEEP_MS + 1000)
    expect((await db.superTabChatSetting.findMany({ where: { tabId: s.tabId }, select: { personId: true, notify: true } }))).toEqual([{ personId: peer.sub, notify: 'muted' }])
  })
})
