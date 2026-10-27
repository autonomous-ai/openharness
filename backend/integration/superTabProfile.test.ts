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
