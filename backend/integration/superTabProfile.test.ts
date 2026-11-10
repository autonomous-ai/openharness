import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
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
import { MemoryAttachmentStore, MemoryAvatarStore, SharedAvatarStore } from '../src/superTabs/attachments.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import type { Command } from '../src/superTabs/commands.js'
import { RETIRED_NOTE } from '../src/superTabs/retired.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
let app: FastifyInstance
const files = new MemoryAttachmentStore()
const pictures = new MemoryAvatarStore('https://avatars.example.test')
const owner: AuthUser = { sub: '200000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '200000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const outsider: AuthUser = { sub: '200000000000000000000003', email: 'outsider@example.com', autonomousEnv: 'prod', role: 'user' }
const run = (tab: string, command: Command, user = owner, asAgentId?: string, operationId = randomUUID()) =>
  store.execute(user, tab, { operationId, command }, asAgentId)
const read = async (tab: string, user: AuthUser, path = 'parts') => {
  const response = await app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/${path}`, headers: { authorization: `Bearer ${user.sub}` } })
  return { status: response.statusCode, body: response.json(), text: response.body }
}
// What an older app sends to set a picture: the form it posts first. The route only refuses it now (routes/superTabs.ts).
const upload = async (tab: string, bytes: Uint8Array, name = 'me.png', mime = 'image/png', user = owner, asAgentId?: string) => {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime }), name)
  const encoded = new Request('http://upload.test', { method: 'POST', body: form })
  const response = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/avatars${asAgentId ? `?asAgentId=${asAgentId}` : ''}`,
    headers: { authorization: `Bearer ${user.sub}`, 'content-type': encoded.headers.get('content-type')! }, payload: Buffer.from(await encoded.arrayBuffer()) })
  const body = response.json()
  return { status: response.statusCode, code: body.error?.code ?? body.code, message: body.error?.message as string | undefined }
}
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const image = (size: number, head: number[] = PNG) => { const bytes = new Uint8Array(size).map((_, i) => i % 251); bytes.set(head); return bytes }
// A picture already set, as the avatar commands set them before they were retired (2026-11-09): nothing sets one now, so the
// object goes in the store, in the folder its links are signed for (avatarLinks.ts), and its key on the member's part, which is
// what a read finds. The stores here read no cache, so a part written straight is what the next read sees.
const keepPicture = async (bucket: MemoryAttachmentStore, tab: string, bytes: Uint8Array = image(64), folder = 'super-tabs') => {
  const objectKey = `${folder}/${tab}/${randomUUID().replaceAll('-', '')}/avatar`
  await bucket.put(objectKey, { name: 'avatar', mime: 'image/png' }, Readable.from([Buffer.from(bytes)]), 1024 * 1024)
  return objectKey
}
const setPicture = async (tab: string, userId: string, objectKey: string) => {
  const row = await db.swarmMember.findUniqueOrThrow({ where: { tabId_key: { tabId: tab, key: userId } } })
  await db.swarmMember.update({ where: { id: row.id }, data: { version: row.version + 1, changedAt: new Date(), data: { ...row.data as object, avatar: { kind: 'upload', key: objectKey } } } })
}
async function swarm() {
  const tab = (await store.create(owner, randomUUID(), 'Office')).id
  const invitation = await run(tab, { type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  return tab
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`super_tab_profile_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db, Date.now, { store: files, prefix: 'super-tabs', publicBase: 'https://cdn.example.test', avatars: pictures }, { readCache: null })
  for (const user of [owner, peer, outsider]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`,
    email: user.email, autonomousEnv: user.autonomousEnv } })
  // The owner's own machine runs the agents, so acting as one needs no machine share.
  await db.machine.create({ data: { machineId: 'host', userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  app = Fastify()
  app.setErrorHandler(errorHandler)
  // External SSO is replaced with fixture accounts; every permission and transaction below is real.
  app.addHook('onRequest', async (request, reply) => {
    const user = [owner, peer, outsider].find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!user) return reply.code(401).send({ success: false })
    request.user = user
  })
  await app.register(superTabRoutes, { store, github: null })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

// Swarm v4 has no status, time zone, name, username or picture to set (2026-11-09), but Desktop and phone from the last 30 days still send them.
describe('the profile commands an older app still sends', () => {
  it('answers each as ignored, and nothing a member reads changes', async () => {
    const tab = await swarm()
    const before = (await read(tab, peer)).body.data.members
    for (const command of [{ type: 'member.status', status: { text: 'Heads down', emoji: '🎯' } }, { type: 'member.timeZone', timeZone: 'Asia/Ho_Chi_Minh' },
      { type: 'member.username', username: 'pilot' }, { type: 'member.name', name: 'Minh Nguyen' }] as unknown as Command[]) {
      expect((await run(tab, command)).result, command.type).toEqual({ ignored: true, note: RETIRED_NOTE })
    }
    expect((await read(tab, peer)).body.data.members).toEqual(before)
  })

  it('refuses a new picture in words, built in or uploaded, and the clearing of one still clears it', async () => {
    const tab = await swarm()
    await setPicture(tab, owner.sub, await keepPicture(pictures, tab))
    const refused = { code: 'AVATARS_RETIRED', status: 410, message: 'Pictures can’t be changed any more.' }
    await expect(run(tab, { type: 'member.avatar', avatar: { kind: 'preset', key: 'fox' } })).rejects.toMatchObject(refused)
    await expect(run(tab, { type: 'member.avatar', avatar: { kind: 'upload', id: 'avatar-1' } })).rejects.toMatchObject(refused)
    const mine = async () => ((await read(tab, peer)).body.data.members as Array<{ key: string; data: { avatar?: unknown } }>).find(m => m.key === owner.sub)!.data.avatar
    expect(await mine()).toEqual({ kind: 'upload' })
    await run(tab, { type: 'member.avatar', avatar: null })
    expect(await mine()).toBeUndefined()
    expect((await read(tab, peer)).body.data.derived?.avatars?.[`person:${owner.sub}`]).toBeUndefined()
  })

  it('refuses the picture it posts first in words, for everyone and for a Swarm that is not there, and keeps nothing', async () => {
    const tab = await swarm()
    const before = pictures.objects.size
    const refused = { status: 410, code: 'AVATARS_RETIRED', message: 'Pictures can’t be changed any more.' }
    for (const [where, user] of [[tab, owner], [tab, peer], [tab, outsider], [randomUUID(), owner]] as const) {
      expect(await upload(where, image(64), 'me.png', 'image/png', user), `${where} ${user.email}`).toEqual(refused)
    }
    expect(await upload(tab, image(1024 * 1024 + 1))).toEqual(refused)
    expect(pictures.objects.size).toBe(before)
  })
})

describe('a picture already set', () => {
  const HOUR = 3_600_000
  const linkFor = async (tab: string, reader: AuthUser, who: string) =>
    ((await read(tab, reader)).body.data.derived?.avatars ?? {})[who] as string | undefined

  it('is never sendable as a chat file', async () => {
    const tab = await swarm()
    const objectKey = await keepPicture(pictures, tab)
    const row = await db.superTabAttachment.create({ data: { id: randomUUID().replaceAll('-', '').slice(0, 24), tabId: tab, conversationId: '', actorKey: `person:${owner.sub}`,
      name: 'avatar', mime: 'image/png', size: 64, objectKey, purpose: 'avatar' } })
    await expect(run(tab, { type: 'message.send', conversationId: 'lead', text: '', replyTo: null, recipientIds: [], attachmentIds: [row.id] }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' })
  })

  it('reaches members only through a signed link that stops opening within an hour', async () => {
    const tab = await swarm()
    const objectKey = await keepPicture(pictures, tab)
    await setPicture(tab, owner.sub, objectKey)
    const first = await read(tab, peer)
    // The record says only that there is a picture; the bucket opens nothing without a signature, its path alone included.
    expect(first.body.data.members.find((m: { key: string }) => m.key === owner.sub).data.avatar).toEqual({ kind: 'upload' })
    expect(pictures.open(`https://avatars.example.test/${objectKey}`, Date.now())).toBeNull()
    const link = await linkFor(tab, peer, `person:${owner.sub}`)
    expect(link).toMatch(/^https:\/\/avatars\.example\.test\//)
    expect(pictures.open(link!, Date.now())).toEqual(Buffer.from(image(64)))
    // The same link for a while, so a picture is not fetched again on every poll.
    expect(await linkFor(tab, peer, `person:${owner.sub}`)).toBe(link)
    // A copied link stops opening once it is over.
    expect(pictures.open(link!, Date.now() + HOUR + 1)).toBeNull()
    const changes = await read(tab, peer, `changes?cursor=${first.body.data.cursor}`)
    expect(changes.body.data.derived.avatars[`person:${owner.sub}`]).toBe(link)
  })

  it('gives no link to someone outside the Swarm or removed from it', async () => {
    const tab = await swarm()
    await setPicture(tab, owner.sub, await keepPicture(pictures, tab))
    const kept = await linkFor(tab, peer, `person:${owner.sub}`)
    const stranger = await read(tab, outsider)
    expect(stranger.status).not.toBe(200)
    expect(stranger.text).not.toContain('avatars.example.test')
    await run(tab, { type: 'member.remove', userId: peer.sub })
    const removed = await read(tab, peer)
    expect(removed.status).not.toBe(200)
    expect(removed.text).not.toContain('avatars.example.test')
    // What they kept stops opening within the hour.
    expect(pictures.open(kept!, Date.now() + HOUR + 1)).toBeNull()
  })
})

// Prod has no avatar bucket (Ken, 2026-10-28): pictures go in the attachments bucket under avatars/ and are linked as chat
// files are, by signed links that stop opening (fileLinks.ts), so they keep working once the bucket is no longer public.
describe('a picture already set, in the attachments bucket', () => {
  const bucket = new MemoryAttachmentStore()
  let shared: SuperTabStore
  let reads: FastifyInstance
  beforeAll(async () => {
    shared = new SuperTabStore(db, Date.now, { store: bucket, prefix: 'super-tabs', publicBase: 'https://cdn.example.test',
      avatars: new SharedAvatarStore(bucket), avatarPrefix: 'avatars' }, { readCache: null })
    reads = Fastify()
    reads.setErrorHandler(errorHandler)
    reads.addHook('onRequest', async request => { request.user = [owner, peer].find(u => `Bearer ${u.sub}` === request.headers.authorization) })
    await reads.register(superTabRoutes, { store: shared, github: null })
    await reads.ready()
  })
  afterAll(async () => { await reads?.close() })
  const linkFor = async (tab: string) => {
    const response = await reads.inject({ method: 'GET', url: `/api/super-tabs/${tab}/parts`, headers: { authorization: `Bearer ${peer.sub}` } })
    return response.json().data.derived?.avatars?.[`person:${owner.sub}`] as string | undefined
  }

  it('is read by a signed link that stops opening, and a replaced one by the new picture\'s', async () => {
    const tab = (await shared.create(owner, randomUUID(), 'Shared bucket')).id
    const invitation = await shared.execute(owner, tab, { operationId: randomUUID(), command: { type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' } })
    await shared.execute(peer, tab, { operationId: randomUUID(), command: { type: 'invite.accept', inviteId: invitation.result.inviteId as string } })
    const first = await keepPicture(bucket, tab, image(64), 'avatars')
    await setPicture(tab, owner.sub, first)
    expect(first).toMatch(new RegExp(`^avatars/${tab}/[0-9a-f]{32}/avatar$`))
    const firstLink = (await linkFor(tab))!
    expect(firstLink).toMatch(new RegExp(`^https://storage\\.memory\\.test/${first}\\?expires=\\d+&signature=`))
    expect(bucket.open(firstLink)).toEqual(Buffer.from(image(64)))
    expect(bucket.open(firstLink, Number(new URL(firstLink).searchParams.get('expires')))).toBeNull()
    const second = await keepPicture(bucket, tab, image(96), 'avatars')
    await setPicture(tab, owner.sub, second)
    expect(bucket.open((await linkFor(tab))!)).toEqual(Buffer.from(image(96)))
  })
})

// Reactions are gone (anh Dee, 2026-11-09): nothing stores, counts or shows one (reactions.ts). An agent's still acknowledges a
// message, so it settles that agent's delivery (integration/superTabs.test.ts), and is refused where the agent cannot see.
describe('reactions', () => {
  const post = async (tab: string, text = 'Shipped the fix') =>
    (await run(tab, { type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [] })).result.messageId as string
  const react = (tab: string, messageId: string, on: boolean, user = owner, emoji: 'tada' | 'heart' = 'tada') =>
    run(tab, { type: 'message.react', conversationId: 'lead', messageId, emoji, on }, user)
  const page = async (tab: string, user = owner, conversationId = 'lead') =>
    (await read(tab, user, `conversations/${conversationId}/messages`)).body.data as { messages: Array<{ id: string; reactions: unknown[] }>; reactionSeq: number }

  it('answers a person\'s reaction as ignored, anyone\'s, and stores and moves nothing', async () => {
    const tab = await swarm()
    const messageId = await post(tab)
    const before = await page(tab, peer)
    // As a retired command: before anything is read, so a reader outside the Swarm is answered alike and learns nothing.
    for (const [on, user] of [[true, owner], [true, peer], [false, peer], [true, outsider]] as const) {
      expect((await react(tab, messageId, on, user)).result).toEqual({ ignored: true, note: RETIRED_NOTE })
    }
    expect(await db.superTabReaction.count({ where: { tabId: tab } })).toBe(0)
    expect(await page(tab, peer)).toEqual(before)
  })

  it('shows no reaction stored before, on any page', async () => {
    const tab = await swarm()
    const messageId = await post(tab)
    await db.superTabReaction.create({ data: { id: `${messageId}-r`, tabId: tab, conversationId: 'lead', messageId, actorKind: 'person', actorId: peer.sub, emoji: 'heart' } })
    expect((await page(tab, owner)).messages.find(m => m.id === messageId)!.reactions).toEqual([])
  })

  const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
  const agentIn = async (tab: string, conversationId: string, name: string, lead = false) =>
    (await run(tab, { type: 'agent.add', conversationId, machineId: 'host', harnessId: randomUUID(), name, configuration: config, lead })).result.agentId as string
  const agentReact = (tab: string, conversationId: string, messageId: string, agentId: string, emoji: 'eyes' | 'check' | 'rocket', on = true) =>
    run(tab, { type: 'message.react', conversationId, messageId, emoji, on }, owner, agentId)

  it('keeps an agent\'s reaction nowhere and shows it to nobody', async () => {
    const tab = await swarm()
    // Kai coordinates: the project chat holds only its coordinator among agents (#2207).
    const builder = await agentIn(tab, 'lead', 'Kai', true)
    const messageId = await post(tab, 'Kai, please add avatars.')
    const before = await page(tab, peer)
    for (const emoji of ['eyes', 'check'] as const) expect((await agentReact(tab, 'lead', messageId, builder, emoji)).result).toMatchObject({ changed: true })
    expect(await db.superTabReaction.count({ where: { tabId: tab } })).toBe(0)
    expect(await page(tab, peer)).toEqual(before)
  })

  it('privacy: refuses an agent\'s reaction where it takes no part, and on another agent\'s private notice', async () => {
    const tab = await swarm()
    const { projectId, conversationId } = (await run(tab, { type: 'project.create', name: 'Secret', visibility: 'private', brief: '' })).result as
      { projectId: string; conversationId: string }
    await run(tab, { type: 'project.sharing', projectId, visibility: 'private', memberIds: [owner.sub] })
    await agentIn(tab, conversationId, 'Secret PM', true)
    const secret = (await run(tab, { type: 'message.send', conversationId, text: 'Ship the secret.', replyTo: null, recipientIds: [] })).result.messageId as string
    // Both agents share a task, as the project chat holds only its coordinator among agents (#2207).
    const group = (await run(tab, { type: 'conversation.create', title: 'Avatars', brief: 'Add avatars.', checks: [] })).result.conversationId as string
    const builder = await agentIn(tab, group, 'Kai')
    await expect(agentReact(tab, conversationId, secret, builder, 'eyes')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    const lead = await agentIn(tab, group, 'River', true)
    const notice = (await run(tab, { type: 'message.send', conversationId: group, text: 'Your skill changed.', replyTo: null, recipientIds: [lead],
      agentOnly: true }, owner, lead)).result.messageId as string
    await expect(agentReact(tab, group, notice, builder, 'eyes')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await agentReact(tab, group, notice, lead, 'eyes')
    expect(await db.superTabReaction.count({ where: { tabId: tab } })).toBe(0)
  })
})

describe('the ship moment', () => {
  const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
  // The task's own thread says it merged, in place of the Shipped line (taskLine.ts; plain chat, Dee, 11-03).
  it('replies Merged in the task\'s thread when its merge is recorded, once on a retry, waking nobody', async () => {
    const tab = await swarm()
    await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: randomUUID(), name: 'River', configuration: config, lead: true })
    // Asked for in the owner's own message, whose thread is the task's (#2925).
    const asked = (await run(tab, { type: 'message.send', conversationId: 'lead', text: 'Can we have avatars?', replyTo: null, recipientIds: [] }))
      .result.messageId as string
    const group = (await run(tab, { type: 'conversation.create', title: 'Avatars', brief: 'Add avatars.', requestMessageId: asked,
      checks: [{ description: 'Tests pass', independent: false }] })).result.conversationId as string
    const builder = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'host', harnessId: randomUUID(), name: 'Kai',
      configuration: config, lead: false })).result.agentId as string
    await run(tab, { type: 'work.assign', conversationId: group, agentId: builder })
    const state = (await store.read(owner, tab)).state
    const work = state.conversations.find(c => c.id === group)!
    await run(tab, { type: 'work.check', conversationId: group, assignmentId: work.assignment!.id, checkId: work.checks[0]!.id, passed: true,
      evidence: 'npm test: 12 passed' }, owner, builder)
    const operationId = randomUUID()
    const done: Command = { type: 'work.status', conversationId: group, assignmentId: work.assignment!.id, status: 'done',
      result: 'Review passed: https://github.com/example/app/pull/7' }
    await run(tab, done, owner, builder, operationId)
    await run(tab, done, owner, builder, operationId)
    const merged: Command = { type: 'conversation.merged', conversationId: group, pullRequestUrl: 'https://github.com/example/app/pull/7' }
    const mergeId = randomUUID()
    await run(tab, merged, owner, undefined, mergeId)
    await run(tab, merged, owner, undefined, mergeId)
    const rows = await db.superTabMessage.findMany({ where: { tabId: tab, conversationId: 'lead' } })
    expect(rows.filter(m => (m.source as { kind?: string } | null)?.kind === 'ship')).toEqual([])
    expect(rows.filter(m => (m.source as { kind?: string } | null)?.kind === 'task-line')).toEqual([])
    const merges = rows.filter(m => m.thread === asked && m.text.startsWith('Merged'))
    expect(merges).toEqual([expect.objectContaining({ text: 'Merged: PR #7. Ships in the next release.', recipientIds: [] })])
    expect(await db.superTabDelivery.count({ where: { tabId: tab, messageId: { in: [merges[0]!.id] } } })).toBe(0)
  })
})
