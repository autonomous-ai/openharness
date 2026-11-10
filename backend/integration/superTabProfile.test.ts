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

describe('a picture already set', () => {
  const HOUR = 3_600_000
  const linkFor = async (tab: string, reader: AuthUser, who: string) =>
    ((await read(tab, reader)).body.data.derived?.avatars ?? {})[who] as string | undefined

  it('is never sendable as a chat file', async () => {
    const tab = await swarm()
    const objectKey = await keepPicture(pictures, tab)
    const row = await db.superTabAttachment.create({ data: { id: randomUUID().replaceAll('-', '').slice(0, 24), tabId: tab, conversationId: '', actorKey: `person:${owner.sub}`,
      name: 'avatar', mime: 'image/png', size: 64, objectKey, purpose: 'avatar' } })
    // A person sends files in their own chat with their agent: only agents post in a project's channel (agentsOnly.test.ts).
    const chat = String((await run(tab, { type: 'agent.new', kind: 'regular', machineId: 'host', engine: 'codex', name: 'Ada', local: true })).result.conversationId)
    await expect(run(tab, { type: 'message.send', conversationId: chat, text: '', replyTo: null, recipientIds: [], attachmentIds: [row.id] }))
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

// anh Dee, 2026-11-10: with no editor left, a person's name in a Swarm follows their account's (personNames.ts nameFromAccount).
describe('a name that follows the account', () => {
  const nameOf = async (tab: string, key: string) =>
    ((await read(tab, peer)).body.data.members as Array<{ key: string; data: Record<string, unknown> }>).find(m => m.key === key)!.data
  const rename = (user: AuthUser, name: string | null) => db.user.update({ where: { id: user.sub }, data: { name } })

  it('shows the account name once the account is renamed, in every Swarm the person is in, and never the name chosen before', async () => {
    const [one, two] = [await swarm(), await swarm()]
    // A name chosen in one of them before, as `member.name` left it.
    const row = await db.swarmMember.findUniqueOrThrow({ where: { tabId_key: { tabId: one, key: owner.sub } } })
    await db.swarmMember.update({ where: { id: row.id }, data: { version: row.version + 1, changedAt: new Date(), data: { ...row.data as object, name: 'Ken (ops)' } } })
    await rename(owner, 'Ken Tran')
    // Earlier tests' Swarms are the owner's too: at least these two change, none fails.
    const renamed = await store.accountRenamed({ userId: owner.sub, autonomousEnv: owner.autonomousEnv })
    expect(renamed.changed).toBeGreaterThanOrEqual(2)
    expect(renamed.failed).toBe(0)
    for (const tab of [one, two]) {
      const member = await nameOf(tab, owner.sub)
      expect(member.name, tab).toBe('Ken Tran')
      expect(member, tab).not.toHaveProperty('chosenName')
    }
    // Asked again with nothing new, it writes nothing.
    expect(await store.accountRenamed({ userId: owner.sub, autonomousEnv: owner.autonomousEnv })).toEqual({ changed: 0, failed: 0 })
    await rename(owner, null)
  })

  it('takes the account name when the person joins, and when they create a Swarm', async () => {
    await rename(peer, 'Peer Person')
    await rename(owner, 'Owner Person')
    try {
      const tab = await swarm()
      expect((await nameOf(tab, peer.sub)).name).toBe('Peer Person')
      expect((await nameOf(tab, owner.sub)).name).toBe('Owner Person')
    } finally {
      await rename(peer, null)
      await rename(owner, null)
    }
  })

  it('brings every person of a Swarm to their account name in one pass, the one-time job\'s', async () => {
    const tab = await swarm()
    await rename(peer, 'Peer Again')
    expect(await store.followAccountNames(tab)).toBe(1)
    expect((await nameOf(tab, peer.sub)).name).toBe('Peer Again')
    expect(await store.followAccountNames(tab)).toBe(0)
    await rename(peer, null)
  })
})
