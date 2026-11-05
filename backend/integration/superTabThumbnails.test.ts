import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import sharp from 'sharp'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { MemoryAttachmentStore, MemoryAvatarStore, type Attachment, type Attachments } from '../src/superTabs/attachments.js'
import { thumbKeyOf } from '../src/superTabs/thumbnails.js'

// The thumbnailer's queue is full while this says so (thumbnails.ts thumbnailsBusy).
const queue = vi.hoisted(() => ({ busy: false }))
vi.mock('../src/superTabs/thumbnails.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/superTabs/thumbnails.js')>(), thumbnailsBusy: () => queue.busy }))
import { sweepUnsentAttachments } from '../src/lib/attachmentSweep.js'
import { PURGE_MARGIN_MS, purgeDeletedSwarms, purgeFiles } from '../src/superTabs/purge.js'
import { SWARM_DELETE_GRACE_MS } from '../src/superTabs/deletion.js'

// Task #3177: the server makes a thumbnail when a picture is uploaded; a chat draws it, the viewer opens the original, and
// whoever may read the original may read the thumbnail and nobody else.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '240000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '240000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_thumbnails_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, peer]) {
    await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  }
  await db.machine.create({ data: { machineId: 'mac', userId: owner.sub, apiKey: 'fixture-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
}, 120_000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** Noise, so a picture is large and its thumbnail clearly smaller. */
async function jpeg(width: number, height: number) {
  return sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer()
}
const gif = () => sharp(randomBytes(900 * 900 * 3), { raw: { width: 900, height: 900, channels: 3 } }).gif().toBuffer()
const BASE = 'https://cdn.example.test/'
const keyOf = (url: string) => url.slice(BASE.length)

async function swarm(now: () => number = Date.now) {
  const files = new MemoryAttachmentStore()
  const attachments: Attachments = { store: files, prefix: 'super-tabs', publicBase: 'https://cdn.example.test', avatars: new MemoryAvatarStore('https://avatars.example.test'), avatarPrefix: 'super-tabs' }
  const store = new SuperTabStore(db, now, attachments)
  const tab = (await store.create(owner, randomUUID(), 'Pictures', 'public')).id
  const execute = (command: Parameters<SuperTabStore['execute']>[2]['command'], user = owner) => store.execute(user, tab, { operationId: randomUUID(), command })
  await execute({ type: 'machine.contribute', machineId: 'mac', name: 'Mac', cwd: '/repo', engines: ['codex'], maxAgents: 8 })
  await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'mac', harnessId: randomUUID(), name: 'Lead', configuration: config, lead: true })
  const invitation = await execute({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  const upload = async (bytes: Buffer, name = 'photo.jpg', mime = 'image/jpeg') =>
    (await store.upload(owner, tab, 'lead', { name, mime, body: Readable.from([bytes]) })).attachment
  const send = async (attachment: Attachment) =>
    String((await execute({ type: 'message.send', conversationId: 'lead', text: '', replyTo: null, recipientIds: [], attachmentIds: [attachment.id] })).result.messageId)
  const read = async (messageId: string, user = owner) => (await store.messages(user, tab, 'lead', { messageId })).messages[0]!.attachments as unknown as Attachment[]
  return { files, attachments, store, tab, execute, upload, send, read }
}

describe('a picture uploaded through the form', () => {
  it('gets a thumbnail beside it, with both sizes in the answer', async () => {
    const f = await swarm()
    const original = await jpeg(2000, 1500)
    const file = await f.upload(original)
    expect(file).toMatchObject({ mime: 'image/jpeg', width: 2000, height: 1500, thumb: { width: 720, height: 540 } })
    expect(file.thumb!.size).toBeGreaterThan(0)
    expect(file.thumb!.size).toBeLessThan(original.byteLength * 0.8)
    // Beside the original: same folder and random segment.
    expect(keyOf(file.thumb!.url)).toBe(thumbKeyOf(keyOf(file.url)))
    expect(f.files.objects.get(keyOf(file.thumb!.url))).toMatchObject({ contentType: 'image/webp' })
    expect((await sharp(f.files.objects.get(keyOf(file.thumb!.url))!.bytes).metadata())).toMatchObject({ format: 'webp', width: 720, height: 540 })
    expect(f.files.objects.get(keyOf(file.url))!.bytes.equals(original)).toBe(true)
    // Each is linked, so a chat can draw either.
    expect(f.files.open(file.link!)).not.toBeNull()
    expect(f.files.open(file.thumb!.link!)!.byteLength).toBe(file.thumb!.size)
    expect(file.thumb!.expiresAt).toBe(file.expiresAt)
    // The row keeps what is needed to send it.
    expect((await db.superTabAttachment.findFirstOrThrow({ where: { id: file.id } })).image).toMatchObject({ width: 2000, height: 1500, thumb: { width: 720, height: 540 } })
  })

  it('travels with the message, which keeps no link of either, and is read with both links', async () => {
    const f = await swarm()
    const file = await f.upload(await jpeg(1800, 1200))
    const messageId = await f.send(file)
    const [read] = await f.read(messageId)
    expect(read).toMatchObject({ id: file.id, width: 1800, height: 1200, thumb: { url: file.thumb!.url, width: 720, height: 480, size: file.thumb!.size } })
    expect(f.files.open(read!.thumb!.link!)).not.toBeNull()
    const stored = (await db.superTabMessage.findFirstOrThrow({ where: { id: messageId } })).attachments as unknown as Array<Record<string, unknown>>
    expect(Object.keys(stored[0]!).sort()).toEqual(['height', 'id', 'mime', 'name', 'size', 'thumb', 'url', 'width'])
    expect(Object.keys(stored[0]!.thumb as object).sort()).toEqual(['height', 'size', 'url', 'width'])
  })

  it('gives a small picture its size and no thumbnail, and anything else neither', async () => {
    const f = await swarm()
    const small = await sharp(randomBytes(400 * 300 * 3), { raw: { width: 400, height: 300, channels: 3 } }).webp({ quality: 80 }).toBuffer()
    const smallFile = await f.upload(small, 'small.webp', 'image/webp')
    expect(smallFile).toMatchObject({ width: 400, height: 300 })
    expect(smallFile.thumb).toBeUndefined()
    const animated = await f.upload(await gif(), 'move.gif', 'image/gif')
    const text = await f.upload(Buffer.from('hello'), 'notes.txt', 'text/plain')
    for (const file of [animated, text]) {
      expect(file.thumb).toBeUndefined()
      expect(file.width).toBeUndefined()
      expect(file.height).toBeUndefined()
    }
    expect([...f.files.objects.keys()].filter(k => k.endsWith('.thumb.webp'))).toEqual([])
  })

  it('still uploads a picture that will not decode', async () => {
    const f = await swarm()
    const broken = (await jpeg(800, 600)).subarray(0, 400)
    const file = await f.upload(broken)
    expect(file).toMatchObject({ name: 'photo.jpg', size: 400 })
    expect(file.thumb).toBeUndefined()
    expect(f.files.objects.get(keyOf(file.url))!.bytes.equals(broken)).toBe(true)
  })

  it('keeps a file sent before thumbnails working: no facts, its original is linked as before', async () => {
    const f = await swarm()
    const file = await f.upload(Buffer.from('old'), 'old.txt', 'text/plain')
    const [read] = await f.read(await f.send(file))
    expect(read).toMatchObject({ id: file.id, name: 'old.txt' })
    expect(read!.link).toBeTruthy()
    expect(read!.thumb).toBeUndefined()
  })
})

describe('when thumbnails are backed up', () => {
  it('answers a form upload at once with the file and no thumbnail', async () => {
    const f = await swarm()
    queue.busy = true
    try {
      const original = await jpeg(2000, 1500)
      const file = await f.upload(original)
      expect(file).toMatchObject({ mime: 'image/jpeg', size: original.byteLength })
      expect(file.thumb).toBeUndefined()
      expect(f.files.objects.get(keyOf(file.url))!.bytes.equals(original)).toBe(true)
      expect([...f.files.objects.keys()].filter(k => k.endsWith('.thumb.webp'))).toEqual([])
    } finally { queue.busy = false }
  })

  it('completes a direct upload at once with the file and no thumbnail', async () => {
    const f = await swarm()
    const original = await jpeg(2400, 1600)
    const { upload } = await f.store.uploadLink(owner, f.tab, 'lead', { name: 'big.jpg', mime: 'image/jpeg', size: original.byteLength })
    expect(await f.files.receive(upload.url, upload.headers, original)).toBe(200)
    queue.busy = true
    try {
      const { attachment } = await f.store.completeUpload(owner, f.tab, upload.id)
      expect(attachment).toMatchObject({ name: 'big.jpg', size: original.byteLength })
      expect(attachment.thumb).toBeUndefined()
    } finally { queue.busy = false }
  })
})

describe('a picture uploaded straight to the bucket', () => {
  it('gets its thumbnail when the upload is completed', async () => {
    const f = await swarm()
    const original = await jpeg(2400, 1600)
    const { upload } = await f.store.uploadLink(owner, f.tab, 'lead', { name: 'big.jpg', mime: 'image/jpeg', size: original.byteLength })
    expect(await f.files.receive(upload.url, upload.headers, original)).toBe(200)
    const { attachment } = await f.store.completeUpload(owner, f.tab, upload.id)
    expect(attachment).toMatchObject({ width: 2400, height: 1600, thumb: { width: 720, height: 480 } })
    expect(f.files.objects.has(keyOf(attachment.thumb!.url))).toBe(true)
    // Answered again after a lost answer: the same facts.
    expect((await f.store.completeUpload(owner, f.tab, upload.id)).attachment).toMatchObject({ width: 2400, thumb: { width: 720 } })
    const [read] = await f.read(await f.send(attachment))
    expect(read).toMatchObject({ width: 2400, height: 1600, thumb: { width: 720, height: 480 } })
  })
})

describe('who can open a thumbnail', () => {
  it('is whoever can open the original: a member gets both links, a removed member neither', async () => {
    const f = await swarm()
    const file = await f.upload(await jpeg(1600, 1200))
    const messageId = await f.send(file)
    const [asPeer] = await f.read(messageId, peer)
    expect(f.files.open(asPeer!.link!)).not.toBeNull()
    expect(f.files.open(asPeer!.thumb!.link!)).not.toBeNull()
    const fresh = await f.store.fileLink(peer, f.tab, 'lead', messageId, file.id)
    expect(f.files.open(fresh.attachment.thumb!.link!)).not.toBeNull()

    await f.execute({ type: 'member.remove', userId: peer.sub })
    await expect(f.store.messages(peer, f.tab, 'lead', { messageId })).rejects.toBeTruthy()
    const refused = await f.store.fileLink(peer, f.tab, 'lead', messageId, file.id).catch(error => error as { code?: string })
    expect(refused).toMatchObject({ code: expect.any(String) })
    expect(JSON.stringify(refused)).not.toContain('thumb')
    // The links the member kept stop opening within their lifetime, the thumbnail's with the original's.
    expect(f.files.open(asPeer!.thumb!.link!, asPeer!.thumb!.expiresAt!)).toBeNull()
  })

  it('is not made for anyone once the Swarm is deleted', async () => {
    const f = await swarm()
    const file = await f.upload(await jpeg(1600, 1200))
    const messageId = await f.send(file)
    await f.execute({ type: 'swarm.delete', name: 'Pictures' })
    await expect(f.store.fileLink(owner, f.tab, 'lead', messageId, file.id)).rejects.toBeTruthy()
  })
})

describe('removing a stored picture removes its thumbnail', () => {
  it('goes with the original in the unsent-file sweep', async () => {
    const f = await swarm()
    const kept = await f.upload(await jpeg(1600, 1200))
    const dropped = await f.upload(await jpeg(1600, 1200))
    await f.send(kept)
    for (const file of [kept, dropped]) await db.superTabAttachment.update({ where: { id: file.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } })
    await sweepUnsentAttachments(db, f.attachments, new Date(), { chunk: 10, chunks: 2, pauseMs: 0 })
    expect(f.files.objects.has(keyOf(dropped.url))).toBe(false)
    expect(f.files.objects.has(keyOf(dropped.thumb!.url))).toBe(false)
    expect(f.files.objects.has(keyOf(kept.url))).toBe(true)
    expect(f.files.objects.has(keyOf(kept.thumb!.url))).toBe(true)
  })

  it('goes with the original when a deleted Swarm is purged', async () => {
    let now = 1_800_000_000_000
    const f = await swarm(() => now)
    const file = await f.upload(await jpeg(1600, 1200))
    await f.send(file)
    await f.execute({ type: 'swarm.delete', name: 'Pictures' })
    expect(f.files.objects.has(keyOf(file.thumb!.url))).toBe(true)
    await purgeDeletedSwarms(db, purgeFiles(f.attachments), now + SWARM_DELETE_GRACE_MS + PURGE_MARGIN_MS)
    expect(f.files.objects.has(keyOf(file.url))).toBe(false)
    expect(f.files.objects.has(keyOf(file.thumb!.url))).toBe(false)
  })
})
