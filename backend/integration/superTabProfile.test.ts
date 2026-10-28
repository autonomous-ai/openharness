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
import { MemoryAttachmentStore, MemoryAvatarStore } from '../src/superTabs/attachments.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import type { Command } from '../src/superTabs/commands.js'

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
type Uploaded = { id: string }
const upload = async (tab: string, bytes: Uint8Array, name = 'me.png', mime = 'image/png', user = owner, asAgentId?: string) => {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime }), name)
  const encoded = new Request('http://upload.test', { method: 'POST', body: form })
  const response = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/avatars${asAgentId ? `?asAgentId=${asAgentId}` : ''}`,
    headers: { authorization: `Bearer ${user.sub}`, 'content-type': encoded.headers.get('content-type')! }, payload: Buffer.from(await encoded.arrayBuffer()) })
  const body = response.json()
  return { status: response.statusCode, code: body.error?.code ?? body.code, avatar: body.data?.avatar as Uploaded }
}
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const image = (size: number, head: number[] = PNG) => { const bytes = new Uint8Array(size).map((_, i) => i % 251); bytes.set(head); return bytes }
const stored = async (id: string) => pictures.objects.get((await db.superTabAttachment.findUniqueOrThrow({ where: { id } })).objectKey)
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
  store = new SuperTabStore(db, Date.now, { store: files, prefix: 'super-tabs', publicBase: 'https://cdn.example.test', avatars: pictures })
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

describe('status line', () => {
  it('reaches members through first loads and changes, and nobody outside the Swarm', async () => {
    const tab = await swarm()
    const first = await read(tab, peer)
    expect(first.status).toBe(200)
    await run(tab, { type: 'member.status', status: { text: 'Heads down', emoji: '🎯' } })
    const changes = await read(tab, peer, `changes?cursor=${first.body.data.cursor}`)
    expect(changes.body.data.members.find((m: { key: string }) => m.key === owner.sub).data.status)
      .toEqual({ text: 'Heads down', emoji: '🎯', until: null })
    expect((await read(tab, peer)).body.data.members.find((m: { key: string }) => m.key === owner.sub).data.status.text).toBe('Heads down')
    const stranger = await read(tab, outsider)
    expect(stranger.status).not.toBe(200)
    expect(stranger.text).not.toContain('Heads down')
    await run(tab, { type: 'member.status', status: null })
    expect((await read(tab, peer)).body.data.members.find((m: { key: string }) => m.key === owner.sub).data.status).toBeUndefined()
  })

  it('answers a retried operation once, and a second writer does not undo the first', async () => {
    const tab = await swarm()
    const operationId = randomUUID()
    const command: Command = { type: 'member.status', status: { text: 'Coffee', emoji: '☕' } }
    await Promise.all([run(tab, command, owner, undefined, operationId), run(tab, command, owner, undefined, operationId),
      run(tab, { type: 'member.status', status: { text: 'Reviewing' } }, peer)])
    const members = (await read(tab, owner)).body.data.members as Array<{ key: string; data: { status?: { text: string } } }>
    expect(members.find(m => m.key === owner.sub)!.data.status!.text).toBe('Coffee')
    expect(members.find(m => m.key === peer.sub)!.data.status!.text).toBe('Reviewing')
  })
})

describe('avatar uploads', () => {
  it('stores a png, jpg or webp of at most 1 MB as the image its bytes are', async () => {
    const tab = await swarm()
    const png = await upload(tab, image(1024 * 1024))
    expect(png.status).toBe(200)
    // No link comes back: a picture is only ever reached through a member read's signed link.
    expect(png.avatar).toEqual({ id: expect.any(String) })
    expect(await stored(png.avatar.id)).toMatchObject({ contentType: 'image/png' })
    // A .png that is really a JPEG still shows, as what it is.
    const jpeg = await upload(tab, image(2048, [0xff, 0xd8, 0xff]), 'me.png', 'image/png', peer)
    expect(jpeg.status).toBe(200)
    expect(await stored(jpeg.avatar.id)).toMatchObject({ contentType: 'image/jpeg' })
    const webp = await upload(tab, image(64, [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]), 'me.webp', 'image/webp')
    expect(webp.status).toBe(200)
  })

  it('refuses a file over 1 MB, a gif, and a page or script that says it is an image', async () => {
    const tab = await swarm()
    const before = pictures.objects.size
    expect(await upload(tab, image(1024 * 1024 + 1))).toMatchObject({ status: 413, code: 'AVATAR_TOO_LARGE' })
    expect(await upload(tab, image(64, [...Buffer.from('GIF89a')]), 'me.gif', 'image/gif')).toMatchObject({ status: 415, code: 'AVATAR_TYPE' })
    expect(await upload(tab, new TextEncoder().encode('<html><script>alert(1)</script></html>'), 'me.png', 'image/png'))
      .toMatchObject({ status: 415, code: 'AVATAR_TYPE' })
    expect(await upload(tab, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'me.svg', 'image/svg+xml'))
      .toMatchObject({ status: 415, code: 'AVATAR_TYPE' })
    expect(pictures.objects.size).toBe(before)
  })

  it('is refused outside the Swarm and for a viewer', async () => {
    const tab = await swarm()
    expect((await upload(tab, image(64), 'me.png', 'image/png', outsider)).status).toBe(403)
    const viewing = (await store.create(owner, randomUUID(), 'Read only')).id
    const invitation = await run(viewing, { type: 'invite.create', email: peer.email, role: 'viewer', conversationId: 'lead' })
    await run(viewing, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
    expect(await upload(viewing, image(64), 'me.png', 'image/png', peer)).toMatchObject({ status: 403, code: 'READ_ONLY' })
  })

  it('is never sendable as a chat file', async () => {
    const tab = await swarm()
    const { avatar } = await upload(tab, image(64))
    await expect(run(tab, { type: 'message.send', conversationId: 'lead', text: '', replyTo: null, recipientIds: [], attachmentIds: [avatar.id] }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' })
  })
})

describe('setting avatars', () => {
  const HOUR = 3_600_000
  const avatarOf = async (tab: string, key: string) =>
    ((await read(tab, peer)).body.data.members as Array<{ key: string; data: { avatar?: unknown } }>).find(m => m.key === key)!.data.avatar
  const linkFor = async (tab: string, reader: AuthUser, who: string) =>
    ((await read(tab, reader)).body.data.derived?.avatars ?? {})[who] as string | undefined

  it('puts the person’s own upload on their member record, once', async () => {
    const tab = await swarm()
    const { avatar } = await upload(tab, image(64))
    await run(tab, { type: 'member.avatar', avatar: { kind: 'upload', id: avatar.id } })
    expect(await avatarOf(tab, owner.sub)).toEqual({ kind: 'upload' })
    await expect(run(tab, { type: 'member.avatar', avatar: { kind: 'upload', id: avatar.id } })).rejects.toMatchObject({ code: 'AVATAR_UNAVAILABLE' })
  })

  it('reaches members only through a signed link that stops opening within an hour', async () => {
    const tab = await swarm()
    const { avatar } = await upload(tab, image(64))
    await run(tab, { type: 'member.avatar', avatar: { kind: 'upload', id: avatar.id } })
    const first = await read(tab, peer)
    // The record says only that there is a picture; the bucket opens nothing without a signature, its path alone included.
    expect(first.body.data.members.find((m: { key: string }) => m.key === owner.sub).data.avatar).toEqual({ kind: 'upload' })
    const objectKey = (await db.superTabAttachment.findUniqueOrThrow({ where: { id: avatar.id } })).objectKey
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
    const { avatar } = await upload(tab, image(64))
    await run(tab, { type: 'member.avatar', avatar: { kind: 'upload', id: avatar.id } })
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

  it('refuses someone else’s upload and a chat file', async () => {
    const tab = await swarm()
    const theirs = (await upload(tab, image(64), 'me.png', 'image/png', peer)).avatar
    await expect(run(tab, { type: 'member.avatar', avatar: { kind: 'upload', id: theirs.id } })).rejects.toMatchObject({ code: 'AVATAR_UNAVAILABLE' })
    const chat = await store.upload(owner, tab, 'lead', { name: 'shot.png', mime: 'image/png', body: (await import('node:stream')).Readable.from([Buffer.from(image(64))]) })
    await expect(run(tab, { type: 'member.avatar', avatar: { kind: 'upload', id: chat.attachment.id } })).rejects.toMatchObject({ code: 'AVATAR_UNAVAILABLE' })
    expect(await avatarOf(tab, owner.sub)).toBeUndefined()
  })

  it('lets only one of two commands racing for the same upload take it', async () => {
    const tab = await swarm()
    const { avatar } = await upload(tab, image(64))
    const results = await Promise.allSettled([1, 2].map(() => run(tab, { type: 'member.avatar', avatar: { kind: 'upload', id: avatar.id } })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(await db.superTabAttachment.findUnique({ where: { id: avatar.id } })).toMatchObject({ usedBy: expect.any(String) })
  })

  it('without a private avatar bucket, refuses uploads and still takes presets', async () => {
    const plain = new SuperTabStore(db, Date.now, { store: files, prefix: 'super-tabs', publicBase: 'https://cdn.example.test' })
    const tab = (await plain.create(owner, randomUUID(), 'No bucket')).id
    const { Readable } = await import('node:stream')
    await expect(plain.uploadAvatar(owner, tab, { body: Readable.from([Buffer.from(image(64))]) })).rejects.toMatchObject({ code: 'AVATARS_UNAVAILABLE', status: 503 })
    await plain.execute(owner, tab, { operationId: randomUUID(), command: { type: 'member.avatar', avatar: { kind: 'preset', key: 'fox' } } })
  })
})

describe('reactions', () => {
  const post = async (tab: string, text = 'Shipped the fix') =>
    (await run(tab, { type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [] })).result.messageId as string
  const react = (tab: string, messageId: string, on: boolean, user = owner, emoji: 'tada' | 'heart' = 'tada', operationId = randomUUID()) =>
    run(tab, { type: 'message.react', conversationId: 'lead', messageId, emoji, on }, user, undefined, operationId)
  const page = async (tab: string, user = owner) =>
    (await read(tab, user, 'conversations/lead/messages')).body.data.messages as Array<{ id: string; reactions: Array<{ emoji: string; count: number }> }>
  const countsOf = async (tab: string, messageId: string, user = owner) => (await page(tab, user)).find(m => m.id === messageId)!.reactions

  it('adds and removes idempotently, and bumps the group only on a change', async () => {
    const tab = await swarm()
    const messageId = await post(tab)
    const seq = async () => ((await read(tab, owner)).body.data.groups as Array<{ key: string; data: { reactionSeq?: number } }>)
      .find(g => g.key === 'lead')!.data.reactionSeq ?? 0
    expect((await react(tab, messageId, true)).result).toMatchObject({ changed: true })
    expect((await react(tab, messageId, true)).result).toMatchObject({ changed: false })
    expect(await countsOf(tab, messageId)).toEqual([{ emoji: 'tada', count: 1, by: [{ kind: 'person', id: owner.sub }] }])
    expect(await seq()).toBe(1)
    await react(tab, messageId, false)
    expect((await react(tab, messageId, false)).result).toMatchObject({ changed: false })
    expect(await countsOf(tab, messageId)).toEqual([])
    expect(await seq()).toBe(2)
  })

  it('keeps one row when the same reaction arrives twice at once, and counts two reactors racing', async () => {
    const tab = await swarm()
    const messageId = await post(tab)
    await Promise.all([react(tab, messageId, true), react(tab, messageId, true), react(tab, messageId, true, peer)])
    expect(await countsOf(tab, messageId)).toMatchObject([{ emoji: 'tada', count: 2 }])
    expect(await db.superTabReaction.count({ where: { tabId: tab, messageId } })).toBe(2)
  })

  it('answers a retried operation with its first result', async () => {
    const tab = await swarm()
    const messageId = await post(tab)
    const operationId = randomUUID()
    const first = await react(tab, messageId, true, owner, 'tada', operationId)
    expect((await react(tab, messageId, true, owner, 'tada', operationId)).result).toEqual(first.result)
  })

  it('drops a member who left from the counts, and refuses a reader outside the Swarm', async () => {
    const tab = await swarm()
    const messageId = await post(tab)
    await react(tab, messageId, true, peer, 'heart')
    await react(tab, messageId, true, owner, 'heart')
    await run(tab, { type: 'member.remove', userId: peer.sub })
    expect(await countsOf(tab, messageId)).toEqual([{ emoji: 'heart', count: 1, by: [{ kind: 'person', id: owner.sub }] }])
    await expect(react(tab, messageId, true, outsider)).rejects.toMatchObject({ status: 403 })
    await expect(react(tab, messageId, true, peer)).rejects.toMatchObject({ status: 403 })
  })

  it('tells a poll for new messages that reactions changed, so it reads the page again', async () => {
    const tab = await swarm()
    const messageId = await post(tab)
    const poll = async () => (await read(tab, peer, 'conversations/lead/messages?after=1000000')).body.data as { messages: unknown[]; reactionSeq: number }
    expect(await poll()).toEqual({ messages: [], next: null, reactionSeq: 0 })
    await react(tab, messageId, true)
    expect((await poll()).reactionSeq).toBe(1)
  })

  it('refuses a message from another conversation or another Swarm', async () => {
    const tab = await swarm()
    const other = await swarm()
    const elsewhere = await post(other)
    await expect(react(tab, elsewhere, true)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const group = (await run(tab, { type: 'conversation.create', title: 'Side', brief: 'Side work.', checks: [] })).result.conversationId as string
    const side = (await run(tab, { type: 'message.send', conversationId: group, text: 'here', replyTo: null, recipientIds: [] })).result.messageId as string
    await expect(react(tab, side, true)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('the ship moment', () => {
  const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
  it('posts one celebration in the project chat when linked work is Done, waking nobody', async () => {
    const tab = await swarm()
    await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: randomUUID(), name: 'River', configuration: config, lead: true })
    const group = (await run(tab, { type: 'conversation.create', title: 'Avatars', brief: 'Add avatars.',
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
      result: 'Merged https://github.com/example/app/pull/7' }
    await run(tab, done, owner, builder, operationId)
    await run(tab, done, owner, builder, operationId)
    const rows = await db.superTabMessage.findMany({ where: { tabId: tab, conversationId: 'lead' } })
    const ships = rows.filter(m => (m.source as { kind?: string } | null)?.kind === 'ship')
    expect(ships).toHaveLength(1)
    expect(ships[0]).toMatchObject({ text: '🎉 Shipped: Avatars, requested by owner, built by Kai. https://github.com/example/app/pull/7', recipientIds: [] })
    expect(await db.superTabDelivery.count({ where: { tabId: tab, messageId: ships[0]!.id } })).toBe(0)
  })
})
