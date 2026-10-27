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
import { MemoryAttachmentStore } from '../src/superTabs/attachments.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import type { Command } from '../src/superTabs/commands.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
let app: FastifyInstance
const files = new MemoryAttachmentStore()
const owner: AuthUser = { sub: '200000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '200000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const outsider: AuthUser = { sub: '200000000000000000000003', email: 'outsider@example.com', autonomousEnv: 'prod', role: 'user' }
const run = (tab: string, command: Command, user = owner, asAgentId?: string, operationId = randomUUID()) =>
  store.execute(user, tab, { operationId, command }, asAgentId)
const read = async (tab: string, user: AuthUser, path = 'parts') => {
  const response = await app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/${path}`, headers: { authorization: `Bearer ${user.sub}` } })
  return { status: response.statusCode, body: response.json(), text: response.body }
}
type Uploaded = { id: string; url: string }
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
const objectKey = (url: string) => url.slice('https://cdn.example.test/'.length)
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
  store = new SuperTabStore(db, Date.now, { store: files, prefix: 'super-tabs', publicBase: 'https://cdn.example.test' })
  for (const user of [owner, peer, outsider]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`,
    email: user.email, autonomousEnv: user.autonomousEnv } })
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
    expect(png.avatar.url).toMatch(/^https:\/\/cdn\.example\.test\/super-tabs\//)
    expect(files.objects.get(objectKey(png.avatar.url))).toMatchObject({ contentType: 'image/png' })
    // A .png that is really a JPEG still shows, as what it is.
    const jpeg = await upload(tab, image(2048, [0xff, 0xd8, 0xff]), 'me.png', 'image/png', peer)
    expect(jpeg.status).toBe(200)
    expect(files.objects.get(objectKey(jpeg.avatar.url))).toMatchObject({ contentType: 'image/jpeg' })
    const webp = await upload(tab, image(64, [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]), 'me.webp', 'image/webp')
    expect(webp.status).toBe(200)
  })

  it('refuses a file over 1 MB, a gif, and a page or script that says it is an image', async () => {
    const tab = await swarm()
    const before = files.objects.size
    expect(await upload(tab, image(1024 * 1024 + 1))).toMatchObject({ status: 413, code: 'AVATAR_TOO_LARGE' })
    expect(await upload(tab, image(64, [...Buffer.from('GIF89a')]), 'me.gif', 'image/gif')).toMatchObject({ status: 415, code: 'AVATAR_TYPE' })
    expect(await upload(tab, new TextEncoder().encode('<html><script>alert(1)</script></html>'), 'me.png', 'image/png'))
      .toMatchObject({ status: 415, code: 'AVATAR_TYPE' })
    expect(await upload(tab, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'me.svg', 'image/svg+xml'))
      .toMatchObject({ status: 415, code: 'AVATAR_TYPE' })
    expect(files.objects.size).toBe(before)
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
