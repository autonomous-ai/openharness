import { createHash, randomUUID } from 'node:crypto'
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
import { ACTIVITY_EXPIRY_MS, ACTIVITY_READS, activityDigest, resetActivityReads, sweepActivity, writeReplyActivity } from '../src/superTabs/activity.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { plan, profiled, reads } from './plans.test-support.js'
import { SESSION_ENDED_KIND } from '../src/superTabs/buddySessions.js'
import { threadFacet } from '../src/superTabs/pageReads.js'
import { CHAT_SETTING_DEFAULT_KEEP_MS, sweepChatSettings } from '../src/superTabs/chatSettings.js'
import type { Command, SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { swarmNoticeId, type PhoneNotice } from '../src/push/sender.js'
import { generateKeyPairSync } from 'node:crypto'
import { sendPhoneNotices } from '../src/push/send.js'
import { apnsSender, type ApnsRequest } from '../src/push/apns.js'
import { fcmSender } from '../src/push/fcm.js'
import { registerPushDevice } from '../src/push/devices.js'
import { quietRepeats } from '../src/push/repeats.js'
import { NOW, outsider as outsiderActor, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
let store: SuperTabStore
// The same database through a client that reports each command, for the cost test; quiet unless `listening`.
let measured: PrismaClient
let measuredStore: SuperTabStore
let tally: Record<string, number> | null = null
// What each write would tell phones, after its commit (push/notices.ts, task #2905).
const phones: PhoneNotice[] = []
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
  store = new SuperTabStore(db, Date.now, null, { phoneNotices: notices => { phones.push(...notices) } })
  measured = new PrismaClient({ datasources: { db: { url: uri } }, log: [{ emit: 'event', level: 'query' }] })
  measuredStore = new SuperTabStore(measured)
  measured.$on('query', (event: { query: string }) => {
    if (!tally) return
    const name = /db\.(\w+)\.(\w+)/.exec(event.query)
    const key = name ? `${name[1]}.${name[2]}` : event.query.slice(0, 40)
    tally[key] = (tally[key] ?? 0) + 1
  })
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
  await measured?.$disconnect()
  await replica?.stop()
})
beforeEach(() => resetActivityReads())

/** A Swarm in parts: a public chat ("Web", with a worker on the owner's machine), a project shared with the owner alone
 *  ("Secret work"), a public project the owner can make private later ("Open chat"), and peer's Buddy chat. */
async function scene(extra: Array<{ kind: 'person'; userId: string; email: string }> = []) {
  const s = swarm(MIGRATED)
  s.join(peerActor)
  s.join(outsiderActor)
  for (const person of extra) s.join(person)
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
    // A person by the name they set (personNames.ts), else their username.
    await run(s.tabId, { type: 'member.name', name: 'Peer Person' }, peer)
    expect((await items(s.tabId)).find(i => i.messageId === reply).actor.name).toBe('Peer Person')
    expect(typeof list[0].messageSequence).toBe('number')
    // The person who replied hears of the replies after theirs, never of their own; nothing for a reply in one's own thread.
    expect((await items(s.tabId, peer)).map(i => i.messageId)).toEqual([agentReply])
    const ownerAdds = await send(s.tabId, s.web, 'Owner adds', owner, root)
    expect((await items(s.tabId)).length).toBe(2)
    expect((await items(s.tabId, peer)).map(i => i.messageId)).toEqual([ownerAdds, agentReply])
  })

  it('tells the author of the message replied to as well as the thread\'s, once each', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    const peerReply = await send(s.tabId, s.web, 'Peer answers', peer, root)
    const outsiderReply = await send(s.tabId, s.web, 'Outsider answers peer', outsider, peerReply)
    expect((await items(s.tabId, peer)).map(i => i.messageId)).toEqual([outsiderReply])
    expect((await items(s.tabId)).map(i => i.messageId)).toEqual([outsiderReply, peerReply])
  })

  it('stops new reply Activity while the thread is unfollowed and resumes after following again', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    const first = await send(s.tabId, s.web, 'Peer answers', peer, root)
    expect((await items(s.tabId)).map(i => i.messageId)).toEqual([first])

    expect((await call('POST', `/api/super-tabs/${s.tabId}/conversations/${s.web}/threads/${root}/follow`, owner, { follow: false })).status).toBe(200)
    const whileUnfollowed = await send(s.tabId, s.web, 'Peer answers while unfollowed', peer, root)
    expect((await items(s.tabId)).map(i => i.messageId)).toEqual([first])

    expect((await call('POST', `/api/super-tabs/${s.tabId}/conversations/${s.web}/threads/${root}/follow`, owner, { follow: true })).status).toBe(200)
    const afterFollowing = await send(s.tabId, s.web, 'Peer answers after following', peer, root)
    expect((await items(s.tabId)).map(i => i.messageId)).toEqual([afterFollowing, first])
    expect((await items(s.tabId)).some(i => i.messageId === whileUnfollowed)).toBe(false)
  })

  it('lists nothing for a top-level message, or for a message of another person\'s chat', async () => {
    const s = await scene()
    await send(s.tabId, s.web, 'Top level by peer', peer)
    expect(await items(s.tabId)).toEqual([])
  })
})

describe('Phone push: a write tells the phones of whoever its rows tell (task #2905)', () => {
  const tagging = async (tabId: string, conversationId: string, text: string, as: AuthUser, replyTo: string | null, mentions: string[]) =>
    (await run(tabId, { type: 'message.send', conversationId, text, replyTo, recipientIds: [], mentions }, as)).result.messageId as string
  const told = async (write: () => Promise<unknown>) => {
    phones.length = 0
    await write()
    return phones.map(n => ({ personId: n.personId, kind: n.key.split(':')[0], link: n.link, title: n.title }))
  }

  it('tells the thread\'s starter of a reply, linking the reply in its thread, and nobody of a message outside threads', async () => {
    const s = await scene()
    let root = ''
    expect(await told(async () => { root = await send(s.tabId, s.web, 'Owner root') })).toEqual([])
    let reply = ''
    const notices = await told(async () => { reply = await send(s.tabId, s.web, 'Peer answers', peer, root) })
    expect(notices).toEqual([{ personId: owner.sub, kind: 'reply', link: `swarm:${s.tabId}/${s.web}/message/${reply}/thread/${root}`, title: expect.stringMatching(/ replied in a thread$/) }])
    const row = await db.superTabActivity.findFirst({ where: { tabId: s.tabId, personId: owner.sub, messageId: reply } })
    expect(phones[0]!.key).toBe(`reply:${s.tabId}:${row!.id}`)
  })

  it('tells a person who muted the chat of a tag alone, never of a reply', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Peer root', peer)
    expect((await notify(s.tabId, s.web, 'muted', peer)).status).toBe(200)
    expect(await told(() => send(s.tabId, s.web, 'Owner answers', owner, root))).toEqual([])
    let tag = ''
    expect(await told(async () => { tag = await tagging(s.tabId, s.web, 'Peer, please check', owner, root, [peer.sub]) }))
      .toEqual([{ personId: peer.sub, kind: 'mention', link: `swarm:${s.tabId}/${s.web}/message/${tag}/thread/${root}`, title: expect.stringMatching(/ tagged you$/) }])
  })
})

describe('Phone push end to end on the server: a write, its phones, and what Apple and Google are sent (task #3248)', () => {
  const apnsKeys = { teamId: 'TEAM123456', topic: 'ai.autonomous.harness.ios', sandbox: null,
    production: { keyId: 'ABC123DEFG', privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey } }
  const fcmAccount = { projectId: 'harness-push', clientEmail: 'push@harness-push.iam.gserviceaccount.com', tokenUri: 'https://oauth2.googleapis.com/token',
    privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }

  it('a reply\'s write reaches each phone of the person it tells, in the request Apple and Google take, and never the author\'s phone', async () => {
    const apple: ApnsRequest[] = []
    const google: Array<{ url: string; body: string }> = []
    const fetcher = (async (url: string, init: RequestInit) => {
      google.push({ url, body: String(init.body) })
      return url === fcmAccount.tokenUri ? new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), { status: 200 })
        : new Response(JSON.stringify({ name: 'projects/harness-push/messages/1' }), { status: 200 })
    }) as unknown as typeof fetch
    const senders = { ios: apnsSender(apnsKeys, { transport: async request => { apple.push(request); return { status: 200, reason: null } } }),
      android: fcmSender(fcmAccount, { fetcher }) }
    const sending: Array<Promise<void>> = []
    const pushing = new SuperTabStore(db, Date.now, null, { phoneNotices: notices => { sending.push(sendPhoneNotices(db, senders, notices)) } })
    const s = await scene()
    const iphone = `${'a1'.repeat(32)}`, android = 'fcm:owner-android', authors = `${'b2'.repeat(32)}`
    await registerPushDevice(db, owner.sub, { platform: 'ios', token: iphone }, Date.now())
    await registerPushDevice(db, owner.sub, { platform: 'android', token: android }, Date.now())
    await registerPushDevice(db, peer.sub, { platform: 'ios', token: authors }, Date.now())
    const root = await send(s.tabId, s.web, 'Owner root')
    const reply = (await pushing.execute(peer, s.tabId, { operationId: randomUUID(),
      command: { type: 'message.send', conversationId: s.web, text: 'Peer answers: the secret plan', replyTo: root, recipientIds: [] } }) as { result: Record<string, unknown> }).result.messageId as string
    await Promise.all(sending)
    const row = await db.superTabActivity.findFirstOrThrow({ where: { tabId: s.tabId, personId: owner.sub, messageId: reply } })
    const key = `reply:${s.tabId}:${row.id}`, link = `swarm:${s.tabId}/${s.web}/message/${reply}/thread/${root}`, slot = `thread:${s.tabId}:${s.web}:${root}`
    // Apple: one request, to the owner's iPhone alone.
    expect(apple.map(r => r.path)).toEqual([`/3/device/${iphone}`])
    expect(apple[0]!.headers).toMatchObject({ 'apns-topic': 'ai.autonomous.harness.ios', 'apns-push-type': 'alert', 'apns-priority': '10',
      'apns-collapse-id': String(swarmNoticeId(slot)) })
    const body = JSON.parse(apple[0]!.body)
    expect(body).toEqual({ aps: { alert: { title: expect.stringMatching(/ replied in a thread$/), subtitle: expect.any(String), body: 'Open Harness to read it.' },
      sound: 'default', 'thread-id': 'swarm-needs-you', category: 'swarm-needs-you' }, key, link, slot })
    // Google: one message, to the owner's Android phone, tagged with the thread's slot, its key in its data so the app knows it.
    const messages = google.filter(c => c.url !== fcmAccount.tokenUri).map(c => JSON.parse(c.body).message)
    expect(messages).toEqual([{ token: android, notification: { title: body.aps.alert.title, body: `${body.aps.alert.subtitle} · Open Harness to read it.` },
      android: { priority: 'high', notification: { channel_id: 'swarm-needs-you', tag: slot, visibility: 'PRIVATE' } }, data: { key, link, slot } }])
    // Nothing written in the chat leaves the server.
    expect(JSON.stringify([apple, google])).not.toContain('secret plan')
    expect(JSON.stringify(apple)).not.toContain(authors)
  })
})

describe('Phone push: a thread sounds once until it is read (task #3248)', () => {
  const readThrough = async (tabId: string, conversationId: string, root: string, messageId: string, as: AuthUser) => {
    const { sequence } = await db.superTabMessage.findUniqueOrThrow({ where: { id: messageId } })
    expect((await call('POST', `/api/super-tabs/${tabId}/conversations/${conversationId}/threads/${root}/read`, as, { sequence })).status).toBe(200)
  }
  /** The notices a write made, as they go out: each person's, and whether it is quiet. */
  const sent = async (write: () => Promise<unknown>) => {
    phones.length = 0
    await write()
    return (await quietRepeats(db, [...phones])).map(n => ({ to: n.personId, kind: n.key.split(':')[0], quiet: n.quiet === true }))
  }

  it('sends a thread\'s next reply quietly while one before it is unread, and with sound again once the thread is read', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    let second = ''
    expect(await sent(() => send(s.tabId, s.web, 'Peer answers', peer, root))).toEqual([{ to: owner.sub, kind: 'reply', quiet: false }])
    expect(await sent(async () => { second = await send(s.tabId, s.web, 'Peer again', peer, root) })).toEqual([{ to: owner.sub, kind: 'reply', quiet: true }])
    await readThrough(s.tabId, s.web, root, second, owner)
    expect(await sent(() => send(s.tabId, s.web, 'Peer a third time', peer, root))).toEqual([{ to: owner.sub, kind: 'reply', quiet: false }])
  })

  it('keeps each person and each thread apart, and never quiets a tag', async () => {
    const s = await scene()
    const first = await send(s.tabId, s.web, 'Owner root')
    const other = await send(s.tabId, s.web, 'Owner second root')
    await send(s.tabId, s.web, 'Peer answers', peer, first)
    // Another thread of the owner's has no unread reply yet: it sounds.
    expect(await sent(() => send(s.tabId, s.web, 'Peer answers there', peer, other))).toEqual([{ to: owner.sub, kind: 'reply', quiet: false }])
    // Outsider is tagged in the first thread (peer, who only replied there, hears nothing); outsider then hears of its next
    // reply with sound: the unread replies are the owner's.
    expect(await sent(() => run(s.tabId, { type: 'message.send', conversationId: s.web, text: 'Outsider, look', replyTo: first, recipientIds: [], mentions: [outsider.sub] })))
      .toEqual([{ to: outsider.sub, kind: 'mention', quiet: false }])
    expect((await sent(() => send(s.tabId, s.web, 'Peer once more', peer, first))).sort((a, b) => a.to.localeCompare(b.to)))
      .toEqual([{ to: owner.sub, kind: 'reply', quiet: true }, { to: outsider.sub, kind: 'reply', quiet: false }].sort((a, b) => a.to.localeCompare(b.to)))
  })

  it('reads a thread\'s unread replies once, through the Activity thread index', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    for (let i = 0; i < 3; i++) await send(s.tabId, s.web, `Peer answers ${i}`, peer, root)
    // Another thread's rows, which the read must not examine.
    const other = await send(s.tabId, s.web, 'Owner other root')
    for (let i = 0; i < 3; i++) await send(s.tabId, s.web, `Peer elsewhere ${i}`, peer, other)
    phones.length = 0
    await send(s.tabId, s.web, 'Peer last', peer, root)
    const notices = [...phones]
    const rows = reads(await profiled(db, () => quietRepeats(db, notices)), 'SuperTabActivity', ['threadId'])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.planSummary, JSON.stringify(plan(rows))).toMatch(/IXSCAN \{ tabId: 1, personId: 1, conversationId: 1, threadId: 1 \}/)
    expect(rows[0]!.docsExamined).toBeLessThanOrEqual(4)
  })

  it('reads nothing when no reply is pushed', async () => {
    const tag: PhoneNotice = { personId: owner.sub, key: 'mention:t', title: 't', subtitle: '', body: '', link: 'swarm:t/c/message/m', slot: 'mention:t' }
    const rows = await profiled(db, async () => { expect(await quietRepeats(db, [tag])).toEqual([tag]) })
    expect(rows.filter(e => e.ns.endsWith('.SuperTabActivity'))).toEqual([])
  })
})

describe('Phone push: who each push type reaches, and what it carries (task #3248)', () => {
  const tagging = async (tabId: string, conversationId: string, text: string, as: AuthUser, replyTo: string | null, mentions: string[],
    extra: Record<string, unknown> = {}, asAgentId?: string) =>
    (await run(tabId, { type: 'message.send', conversationId, text, replyTo, recipientIds: [], mentions, ...extra } as Command, as, asAgentId)).result.messageId as string
  /** Every notice the write made, whole. */
  const pushed = async (write: () => Promise<unknown>) => {
    phones.length = 0
    await write()
    return [...phones]
  }
  /** Whom the write told, by kind: `reply` or `mention`, per person. */
  const whom = async (write: () => Promise<unknown>) => (await pushed(write)).map(n => `${n.key.split(':')[0]}:${n.personId}`).sort()
  const swarmName = async (tabId: string) => ((await store.read(owner, tabId)).state as unknown as SuperTabState).name
  const tellsIn = (list: string[], kind: 'reply' | 'mention', as: AuthUser) => list.includes(`${kind}:${as.sub}`)

  it('a reply push carries its row\'s key, who replied, the project, no words of the reply, and the link to the reply in its thread', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    let reply = ''
    const [notice, ...more] = await pushed(async () => { reply = await send(s.tabId, s.web, 'Peer answers: the secret plan', peer, root) })
    expect(more).toEqual([])
    const row = await db.superTabActivity.findFirstOrThrow({ where: { tabId: s.tabId, personId: owner.sub, messageId: reply } })
    expect(notice).toEqual({ personId: owner.sub, key: `reply:${s.tabId}:${row.id}`, title: expect.stringMatching(/^.+ replied in a thread$/),
      subtitle: await swarmName(s.tabId), body: 'Open Harness to read it.', link: `swarm:${s.tabId}/${s.web}/message/${reply}/thread/${root}`,
      slot: `thread:${s.tabId}:${s.web}:${root}`, thread: { tabId: s.tabId, conversationId: s.web, threadId: root, rowId: row.id, at: row.createdAt.getTime() } })
    expect(notice!.title).not.toMatch(/^Someone /)
    expect(JSON.stringify(notice)).not.toContain('secret plan')
    // A project's own chat names that project.
    const openRoot = await send(s.tabId, s.openChat, 'Owner root in Open')
    const [inOpen] = await pushed(() => send(s.tabId, s.openChat, 'Peer answers', peer, openRoot))
    expect(inOpen!.subtitle).toBe('Open')
  })

  it('a reply reaches the thread\'s starter, the quoted message\'s author and people tagged earlier in it, never its author nor one who only replied (Tony\'s rule)', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    // The starter alone hears of the first reply; its author never.
    const peerReply = await send(s.tabId, s.web, 'Peer answers', peer, root)
    // The owner tags outsider in the thread: outsider hears of that by the tag alone; peer, who only replied, hears nothing.
    expect(await whom(() => tagging(s.tabId, s.web, 'Outsider, look', owner, root, [outsider.sub]))).toEqual([`mention:${outsider.sub}`])
    // Outsider answers peer's reply: the starter, and peer as the quoted author, hear of it; outsider never.
    expect(await whom(() => send(s.tabId, s.web, 'Outsider answers peer', outsider, peerReply))).toEqual([`reply:${owner.sub}`, `reply:${peer.sub}`].sort())
    // The owner answers in their own thread: outsider, tagged in it, hears; peer, who only replied there, reads it in Activity.
    const ownAnswer = await whom(() => send(s.tabId, s.web, 'Owner again', owner, root))
    expect(ownAnswer).toEqual([`reply:${outsider.sub}`])
    expect((await items(s.tabId, peer)).some(i => i.text === 'Owner again')).toBe(true)
  })

  it('an agent\'s reply in a person\'s thread is worded with the agent\'s name', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    const [notice, ...more] = await pushed(() => send(s.tabId, s.web, 'Worker answers', owner, root, s.worker))
    expect(more).toEqual([])
    expect(notice).toMatchObject({ personId: owner.sub, title: 'worker-harness replied in a thread' })
  })

  it('a reply that tags a person tells them by the tag alone, once', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    await send(s.tabId, s.web, 'Peer answers', peer, root)
    expect(await whom(() => tagging(s.tabId, s.web, 'Owner, here', peer, root, [owner.sub]))).toEqual([`mention:${owner.sub}`])
  })

  it('a reply never reaches a person who muted the chat, unfollowed the thread, or can no longer read the chat', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.openChat, 'Owner root')
    // Both are tagged in the thread, so each would hear of its replies.
    await tagging(s.tabId, s.openChat, 'Peer and outsider, look', owner, root, [peer.sub, outsider.sub])
    expect(await whom(() => send(s.tabId, s.openChat, 'Owner adds', owner, root))).toEqual([`reply:${outsider.sub}`, `reply:${peer.sub}`].sort())
    expect((await notify(s.tabId, s.openChat, 'muted', peer)).status).toBe(200)
    expect((await call('POST', `/api/super-tabs/${s.tabId}/conversations/${s.openChat}/threads/${root}/follow`, outsider, { follow: false })).status).toBe(200)
    expect(await whom(() => send(s.tabId, s.openChat, 'Owner again', owner, root))).toEqual([])
    // Outsider follows again; then the owner makes the project private to themselves, and outsider can no longer read it.
    expect((await call('POST', `/api/super-tabs/${s.tabId}/conversations/${s.openChat}/threads/${root}/follow`, outsider, { follow: true })).status).toBe(200)
    expect(await whom(() => send(s.tabId, s.openChat, 'Owner once more', owner, root))).toEqual([`reply:${outsider.sub}`])
    await run(s.tabId, { type: 'project.sharing', projectId: s.open, visibility: 'private', memberIds: [] })
    expect(await whom(() => send(s.tabId, s.openChat, 'Owner after closing', owner, root))).toEqual([])
  })

  it('pushes nothing for a message outside threads that tags nobody, or for a reaction', async () => {
    const s = await scene()
    let top = ''
    expect(await whom(async () => { top = await send(s.tabId, s.web, 'Top level by peer', peer) })).toEqual([])
    expect(await whom(() => react(s.tabId, s.web, top, true, owner))).toEqual([])
  })

  it('a tag links the message in the chat, in its thread only when it is only there', async () => {
    const s = await scene()
    let top = ''
    const [inChat] = await pushed(async () => { top = await tagging(s.tabId, s.web, 'Peer, look', owner, null, [peer.sub]) })
    const row = await db.superTabMention.findFirstOrThrow({ where: { tabId: s.tabId, personId: peer.sub, messageId: top } })
    expect(inChat).toEqual({ personId: peer.sub, key: `mention:${row.id}`, title: expect.stringMatching(/^.+ tagged you$/), subtitle: await swarmName(s.tabId),
      body: 'Open Harness to read it.', link: `swarm:${s.tabId}/${s.web}/message/${top}`, slot: `mention:${row.id}` })
    let threadOnly = ''
    const [inThread] = await pushed(async () => { threadOnly = await tagging(s.tabId, s.web, 'Peer, in here', owner, top, [peer.sub]) })
    expect(inThread!.link).toBe(`swarm:${s.tabId}/${s.web}/message/${threadOnly}/thread/${top}`)
    let alsoInChat = ''
    const [both] = await pushed(async () => { alsoInChat = await tagging(s.tabId, s.web, 'Peer, everyone sees this', owner, top, [peer.sub], { alsoSend: true }) })
    expect(both!.link).toBe(`swarm:${s.tabId}/${s.web}/message/${alsoInChat}`)
  })

  it('an agent\'s tag is worded with the agent\'s name; one\'s own tag tells nobody; a tag held for a quiet chat is not pushed', async () => {
    const s = await scene()
    expect(await pushed(() => tagging(s.tabId, s.web, 'Peer, the build is red', owner, null, [peer.sub], {}, s.worker)))
      .toEqual([expect.objectContaining({ personId: peer.sub, title: 'worker-harness tagged you' })])
    expect(await whom(() => tagging(s.tabId, s.web, 'Note to self', owner, null, [owner.sub]))).toEqual([])
    expect(await whom(() => tagging(s.tabId, s.web, 'Peer, if nobody takes this', owner, null, [peer.sub], { mentionsIfNoWorker: true }))).toEqual([])
  })

  it('a decision asked of a person reaches their phone once, worded as the app does, linking its card; asking it again does not', async () => {
    const s = await scene()
    const ask = (question: string) => run(s.tabId, { type: 'decision.ask', conversationId: s.web, personId: peer.sub,
      questions: [{ question, options: ['Yes', 'No'], recommended: 0, unblocks: 'The release' }] } as Command, owner, s.worker)
    let ids: string[] = []
    const notices = await pushed(async () => { ids = (await ask('Ship it today?')).result.decisionIds as string[] })
    expect(notices).toEqual([{ personId: peer.sub, key: `decision:${ids[0]}`, slot: `decision:${ids[0]}`, title: 'worker-harness asks you',
      subtitle: await swarmName(s.tabId), body: 'Open Harness to answer.', link: `swarm:${s.tabId}/${s.web}/decision/${ids[0]}` }])
    // The same open question asked again is the same decision: no second push.
    expect(await pushed(() => ask('Ship it today?'))).toEqual([])
  })

  it('a decision a task\'s needs_human asks of a person reaches their phone too', async () => {
    const s = await scene()
    const state = (await store.read(owner, s.tabId)).state as unknown as SuperTabState
    const assignmentId = state.conversations.find(c => c.id === s.web)!.assignment!.id
    const notices = await pushed(() => run(s.tabId, { type: 'work.status', conversationId: s.web, assignmentId, status: 'needs_human',
      result: 'Ship it behind a flag?', ask: { personId: peer.sub, options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' } } as Command,
    owner, s.worker))
    expect(notices.map(n => [n.personId, n.key.split(':')[0], n.title, n.link.includes('/decision/'), n.quiet === true]))
      .toEqual([[peer.sub, 'decision', 'worker-harness asks you', true, false]])
  })

  it('one ask of several questions sounds once', async () => {
    const s = await scene()
    const notices = await pushed(() => run(s.tabId, { type: 'decision.ask', conversationId: s.web, personId: peer.sub, questions: [
      { question: 'Which day?', options: ['Mon', 'Tue'], recommended: 0, unblocks: 'The plan' },
      { question: 'Which machine?', options: ['Mac', 'Linux'], recommended: 0, unblocks: 'The plan' }] } as Command, owner, s.worker))
    expect(notices.map(n => [n.personId, n.title, n.quiet === true])).toEqual([[peer.sub, 'worker-harness asks you', false], [peer.sub, 'worker-harness asks you', true]])
  })

  it('tags nobody who cannot read the chat, so no push reaches them', async () => {
    const s = await scene()
    await expect(tagging(s.tabId, s.secretGroup, 'Peer, see this', owner, null, [peer.sub])).rejects.toMatchObject({ code: 'INVALID_MENTION' })
    expect(phones.filter(n => n.personId === peer.sub && n.link.includes(s.secretGroup))).toEqual([])
  })
})

describe('Activity: a reply tells everyone in its thread (task #2745)', () => {
  const tagging = async (tabId: string, conversationId: string, text: string, as: AuthUser, replyTo: string | null, mentions: string[]) =>
    (await run(tabId, { type: 'message.send', conversationId, text, replyTo, recipientIds: [], mentions }, as)).result.messageId as string
  const tags = async (tabId: string, as: AuthUser) => (await call('GET', `/api/super-tabs/${tabId}/mentions?state=waiting`, as)).body.data.mentions as any[]
  const follow = (tabId: string, conversationId: string, root: string, value: boolean, as: AuthUser) =>
    call('POST', `/api/super-tabs/${tabId}/conversations/${conversationId}/threads/${root}/follow`, as, { follow: value })
  const rowsOf = (tabId: string, as: AuthUser) => db.superTabActivity.findMany({ where: { tabId, personId: as.sub }, select: { messageId: true } })
    .then(rows => rows.map(r => r.messageId).sort())

  it('tells the starter and every person who replied, but never the reply\'s author', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    const peerReply = await send(s.tabId, s.web, 'Peer answers', peer, root)
    const outsiderReply = await send(s.tabId, s.web, 'Outsider answers the root', outsider, root)
    expect((await items(s.tabId)).map(i => i.messageId)).toEqual([outsiderReply, peerReply])
    expect((await items(s.tabId, peer)).map(i => i.messageId)).toEqual([outsiderReply])
    expect(await items(s.tabId, outsider)).toEqual([])
    const peerAgain = await send(s.tabId, s.web, 'Peer again', peer, root)
    expect((await items(s.tabId, outsider)).map(i => i.messageId)).toEqual([peerAgain])
    expect((await items(s.tabId, peer)).map(i => i.messageId)).toEqual([outsiderReply])
  })

  it('tells a person tagged earlier in the thread of later replies, and a person tagged in the reply by the tag alone', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    const tagReply = await tagging(s.tabId, s.web, 'Outsider, look', owner, root, [outsider.sub])
    expect((await tags(s.tabId, outsider)).map(t => t.messageId)).toEqual([tagReply])
    // Tagged in the reply itself: the tag tells them, with no second row for the same message.
    expect(await rowsOf(s.tabId, outsider)).toEqual([])
    const later = await send(s.tabId, s.web, 'Peer answers', peer, root)
    expect((await items(s.tabId, outsider)).map(i => i.messageId)).toEqual([later])
    // The starter tagged in a reply hears of it by the tag, not by a reply row too.
    const tagsOwner = await tagging(s.tabId, s.web, 'Owner, here', peer, root, [owner.sub])
    expect((await tags(s.tabId, owner)).map(t => t.messageId)).toContain(tagsOwner)
    expect(await rowsOf(s.tabId, owner)).toEqual([later].sort())
  })

  it('stops for a person who unfollowed the thread, while a tag there still tells them', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    await send(s.tabId, s.web, 'Peer answers', peer, root)
    expect((await follow(s.tabId, s.web, root, false, peer)).status).toBe(200)
    const quiet = await send(s.tabId, s.web, 'Outsider answers', outsider, root)
    expect((await items(s.tabId, peer)).some(i => i.messageId === quiet)).toBe(false)
    expect(await rowsOf(s.tabId, peer)).toEqual([])
    const tag = await tagging(s.tabId, s.web, 'Peer, one thing', outsider, root, [peer.sub])
    expect((await tags(s.tabId, peer)).map(t => t.messageId)).toEqual([tag])
  })

  it('writes no reply rows for a person who muted the chat, and a tag there still tells them', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Peer root', peer)
    await send(s.tabId, s.web, 'Outsider answers', outsider, root)
    expect((await notify(s.tabId, s.web, 'muted', peer)).status).toBe(200)
    await send(s.tabId, s.web, 'Owner answers', owner, root)
    expect(await rowsOf(s.tabId, peer)).toHaveLength(1)
    // Outsider, who replied and did not mute, still hears of it.
    expect(await rowsOf(s.tabId, outsider)).toHaveLength(1)
    const tag = await tagging(s.tabId, s.web, 'Peer, please check', owner, root, [peer.sub])
    expect((await tags(s.tabId, peer)).map(t => t.messageId)).toEqual([tag])
  })

  it('tells nobody new of a Swarm notice or an agent-only notice in a thread: the starter alone, as before', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    await send(s.tabId, s.web, 'Peer answers', peer, root)
    const state = (await store.read(owner, s.tabId)).state as unknown as SuperTabState
    const rootRow = await db.superTabMessage.findUniqueOrThrow({ where: { id: root } })
    const draft = (id: string, source: Record<string, unknown>, recipients: string[] = []) => ({ id, conversationId: s.web, text: 'Notice', replyTo: null,
      recipients, thread: root, source, author: { kind: 'agent' as const, id: s.worker, name: 'worker-harness', membershipGeneration: 'fixture' } })
    await db.$transaction(async tx => {
      const threads = new Map([[root, await threadFacet(tx, s.tabId, s.web, [root])]])
      await writeReplyActivity(tx, s.tabId, [draft('swarm-notice', { kind: 'system' }), draft('agent-only', { kind: 'agent-only' }, [s.worker])],
        new Map([['swarm-notice', rootRow.sequence + 10], ['agent-only', rootRow.sequence + 11]]), Date.now(), { state, threads })
    })
    const notices = (rows: string[]) => rows.filter(id => id === 'swarm-notice' || id === 'agent-only')
    expect(notices(await rowsOf(s.tabId, owner))).toEqual(['swarm-notice'])
    expect(notices(await rowsOf(s.tabId, peer))).toEqual([])
  })

  it('still tells the starter of a Swarm notice in a chat the command did not load, as before', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    await send(s.tabId, s.web, 'Peer answers', peer, root)
    const read = (await store.read(owner, s.tabId)).state as unknown as SuperTabState
    // The command's state without this chat, as a quiet chat is left out of it.
    const state = { ...read, conversations: read.conversations.filter(c => c.id !== s.web) }
    const rootRow = await db.superTabMessage.findUniqueOrThrow({ where: { id: root } })
    await db.$transaction(async tx => {
      const threads = new Map([[root, await threadFacet(tx, s.tabId, s.web, [root])]])
      await writeReplyActivity(tx, s.tabId, [{ id: 'quiet-notice', conversationId: s.web, text: 'Notice', replyTo: null, recipients: [], thread: root,
        source: { kind: 'system' }, author: { kind: 'agent' as const, id: s.worker, name: 'worker-harness', membershipGeneration: 'fixture' } }],
      new Map([['quiet-notice', rootRow.sequence + 10]]), Date.now(), { state, threads })
    })
    expect((await rowsOf(s.tabId, owner)).includes('quiet-notice')).toBe(true)
  })

  it('writes nothing for a person who left the Swarm or can no longer read the chat', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.openChat, 'Owner root')
    await send(s.tabId, s.openChat, 'Peer answers', peer, root)
    await send(s.tabId, s.openChat, 'Outsider answers', outsider, root)
    await run(s.tabId, { type: 'member.remove', userId: outsider.sub })
    const afterLeaving = await send(s.tabId, s.openChat, 'Owner again', owner, root)
    expect((await rowsOf(s.tabId, outsider)).includes(afterLeaving)).toBe(false)
    expect((await rowsOf(s.tabId, peer)).includes(afterLeaving)).toBe(true)
    // The owner makes the project private to themselves: peer can no longer read the chat.
    await run(s.tabId, { type: 'project.sharing', projectId: s.open, visibility: 'private', memberIds: [] })
    const afterLosing = await send(s.tabId, s.openChat, 'Owner once more', owner, root)
    expect((await rowsOf(s.tabId, peer)).includes(afterLosing)).toBe(false)
  })
})

describe('Activity: what one thread reply costs (task #2745)', () => {
  it('reads three times by id whatever the thread, and writes one row per person told', async () => {
    const counts: Array<{ people: number; total: number; commands: Record<string, number>; rows: number }> = []
    for (const size of [1, 10, 50]) {
      const extra = Array.from({ length: size }, (_, i) => ({ kind: 'person' as const, userId: `2${String(size).padStart(3, '0')}${String(i).padStart(20, '0')}`,
        email: `fanout-${size}-${i}@example.com` }))
      for (const person of extra) await db.user.create({ data: { id: person.userId, externalId: `fixture-${person.userId}`, email: person.email, autonomousEnv: 'prod' } })
      const s = await scene(extra)
      const root = await send(s.tabId, s.web, 'Owner root')
      for (const person of extra) await send(s.tabId, s.web, 'In the thread', user(person), root)
      // The reply measured: by peer, telling the starter and the `size` people who replied.
      const commands: Record<string, number> = {}
      tally = commands
      const reply = await (async () => (await measuredStore.execute(peer, s.tabId, { operationId: randomUUID(),
        command: { type: 'message.send', conversationId: s.web, text: 'Measured reply', replyTo: root, recipientIds: [] } })) as { result: Record<string, unknown> })()
      tally = null
      const rows = await db.superTabActivity.count({ where: { tabId: s.tabId, messageId: reply.result.messageId as string } })
      expect(rows).toBe(size + 1)
      const total = Object.values(commands).reduce((n, v) => n + v, 0)
      counts.push({ people: size + 1, total, commands: Object.fromEntries(Object.entries(commands).filter(([k]) => /Activity|ThreadMark|ChatSetting/.test(k))), rows })
    }
    console.log(`reply fan-out: ${JSON.stringify(counts)}`)
    // The reads Activity makes are the same for a thread of 2 people and of 51.
    const reads = (c: Record<string, number>) => Object.entries(c).filter(([k]) => /ThreadMark|ChatSetting/.test(k)).reduce((n, [, v]) => n + v, 0)
    expect(new Set(counts.map(c => reads(c.commands))).size).toBe(1)
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

  const markThread = (tabId: string, conversationId: string, threadId: string, sequence: number, as: AuthUser = owner) =>
    call('POST', `/api/super-tabs/${tabId}/conversations/${conversationId}/threads/${threadId}/read`, as, { sequence })
  const markChat = (tabId: string, conversationId: string, sequence: number, as: AuthUser = owner) =>
    call('POST', `/api/super-tabs/${tabId}/conversations/${conversationId}/read`, as, { sequence })
  const sequenceOf = async (id: string) => (await db.superTabMessage.findUniqueOrThrow({ where: { id } })).sequence
  const sendAlso = async (tabId: string, conversationId: string, text: string, as: AuthUser, replyTo: string) =>
    (await run(tabId, { type: 'message.send', conversationId, text, replyTo, recipientIds: [], alsoSend: true }, as)).result.messageId as string

  it('marks the reply rows of a thread read, on every device, when the thread is read past them', async () => {
    const s = await scene()
    const before = (await derived(s.tabId, owner)).activityDigest
    const root = await send(s.tabId, s.web, 'Owner root')
    const first = await send(s.tabId, s.web, 'Worker answers', owner, root, s.worker)
    const second = await send(s.tabId, s.web, 'Worker answers again', owner, root, s.worker)
    expect((await items(s.tabId)).map(i => i.read)).toEqual([false, false])
    expect((await derived(s.tabId, owner)).activityDigest).not.toBe(before)
    // A mark short of the second reply clears only the first.
    expect((await markThread(s.tabId, s.web, root, await sequenceOf(first))).status).toBe(200)
    expect((await items(s.tabId)).map(i => [i.messageId, i.read])).toEqual([[second, false], [first, true]])
    expect((await markThread(s.tabId, s.web, root, await sequenceOf(second))).status).toBe(200)
    expect((await items(s.tabId)).map(i => i.read)).toEqual([true, true])
    expect((await derived(s.tabId, owner)).activityDigest).toBe(before)
    // An older mark afterwards moves nothing back.
    await markThread(s.tabId, s.web, root, await sequenceOf(first))
    expect((await items(s.tabId)).map(i => i.read)).toEqual([true, true])
  })

  it('leaves another person\'s rows, other threads\' rows and reactions unread when a thread is read', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    const other = await send(s.tabId, s.web, 'Owner other root')
    const peerRoot = await send(s.tabId, s.web, 'Peer root', peer)
    await send(s.tabId, s.web, 'Answer to peer', owner, peerRoot)
    await send(s.tabId, s.web, 'Answer', owner, root, s.worker)
    await send(s.tabId, s.web, 'Answer elsewhere', owner, other, s.worker)
    await react(s.tabId, s.web, root, true, peer)
    const newest = await sequenceOf((await db.superTabMessage.findFirstOrThrow({ where: { tabId: s.tabId }, orderBy: { sequence: 'desc' } })).id)
    await markThread(s.tabId, s.web, root, newest)
    expect((await items(s.tabId)).map(i => [i.text, i.read])).toEqual([[null, false], ['Answer elsewhere', false], ['Answer', true]].map(([text, read]) =>
      [text ?? 'Owner root', read]))
    expect((await items(s.tabId, peer)).map(i => i.read)).toEqual([false])
  })

  it('marks a reply also sent to the chat read when the chat is read, and a thread-only reply not', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    const only = await send(s.tabId, s.web, 'Only in the thread', peer, root)
    const also = await sendAlso(s.tabId, s.web, 'Also in the chat', peer, root)
    const newest = await sequenceOf(also)
    expect((await markChat(s.tabId, s.web, newest)).status).toBe(200)
    expect((await items(s.tabId)).map(i => [i.messageId, i.read])).toEqual([[also, true], [only, false]])
    expect((await markThread(s.tabId, s.web, root, await sequenceOf(only))).status).toBe(200)
    expect((await items(s.tabId)).map(i => i.read)).toEqual([true, true])
  })

  it('leaves a row written before rows kept a sequence unread by a read', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    const reply = await send(s.tabId, s.web, 'Peer answers', peer, root)
    await db.superTabActivity.updateMany({ where: { tabId: s.tabId }, data: { sequence: null, alsoInChat: null } })
    await markThread(s.tabId, s.web, root, await sequenceOf(reply))
    await markChat(s.tabId, s.web, await sequenceOf(reply))
    expect((await items(s.tabId)).map(i => i.read)).toEqual([false])
  })

  it('writes no row for a Buddy session\'s ended line, and still one for its answers', async () => {
    const s = await scene()
    const root = await send(s.tabId, s.web, 'Owner root')
    const rootRow = await db.superTabMessage.findUniqueOrThrow({ where: { id: root } })
    const draft = (id: string, source?: Record<string, unknown>) => ({ id, conversationId: s.web, text: 'Reply', replyTo: root, recipients: [], thread: root,
      author: { kind: 'agent' as const, id: s.worker, name: 'worker-harness', membershipGeneration: 'fixture' }, ...(source ? { source } : {}) })
    const write = (...ids: [string, Record<string, unknown> | undefined][]) => db.$transaction(tx => writeReplyActivity(tx, s.tabId,
      ids.map(([id, source]) => draft(id, source)), new Map(ids.map(([id], i) => [id, rootRow.sequence + 1 + i])), Date.now()))
    await write(['ended-line', { kind: SESSION_ENDED_KIND, reason: 'done', thread: root }])
    expect(await db.superTabActivity.count({ where: { tabId: s.tabId } })).toBe(0)
    await write(['answer', undefined])
    expect(await db.superTabActivity.findMany({ where: { tabId: s.tabId }, select: { messageId: true, sequence: true, alsoInChat: true } }))
      .toEqual([{ messageId: 'answer', sequence: rootRow.sequence + 1, alsoInChat: null }])
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

// Ken's 13:20 VN prod scan, 2026-11-05 (task #3146): SuperTabActivity {tabId, personId, createdAt} was in Atlas's slow log by time
// (79 ops, 23 s). Its explain(): the digest every person's read asks for examined each of the person's rows of 30 days, 865
// for the busiest, to return the 26 unread. Through the unread index it examines the unread rows alone.
describe('the unread-activity digest\'s plan (#3146)', () => {
  it('examines only the unread rows, a row with no readAt among them, and digests them as before', async () => {
    await listNamedIndexes(db)
    const tabId = `tab-${randomUUID()}`, personId = randomUUID().replaceAll('-', '').slice(0, 24), now = Date.now()
    const row = (i: number, readAt: Date | null) => ({ id: `act-${tabId}-${i}`, tabId, personId, kind: 'reply', conversationId: 'c', messageId: `m${i}`,
      threadId: null, actorKind: 'person', actorId: 'someone', emoji: null, createdAt: new Date(now - i * 60_000), readAt })
    await db.superTabActivity.createMany({ data: [...Array.from({ length: 300 }, (_, i) => row(i + 10, new Date(now))), row(1, null), row(2, null)] })
    // A row written before readAt was kept has no such field at all.
    await db.$runCommandRaw({ insert: 'SuperTabActivity', documents: [{ _id: `act-${tabId}-3`, tabId, personId, kind: 'reply', conversationId: 'c',
      messageId: 'm3', actorKind: 'person', actorId: 'someone', createdAt: { $date: new Date(now - 3 * 60_000).toISOString() } }] })
    let digest = ''
    const reads = (await profiled(db, async () => { digest = await activityDigest(db, tabId, personId, now) })).filter(e => e.ns.endsWith('.SuperTabActivity'))
    const unread = [`act-${tabId}-1`, `act-${tabId}-2`, `act-${tabId}-3`]
    expect(digest).toBe(createHash('sha256').update(unread.sort().join('\n')).digest('base64url').slice(0, 16))
    expect(reads.map(e => ({ plan: e.planSummary, keys: e.keysExamined, docs: e.docsExamined, returned: e.nreturned })))
      // `readAt: null` is two ranges of the index, null and missing: one scan of each.
      .toEqual([{ plan: expect.stringMatching(/^(IXSCAN \{ tabId: 1, personId: 1, readAt: 1, createdAt: 1 \}(, |$))+$/), keys: 3, docs: 3, returned: 3 }])
  })
})
