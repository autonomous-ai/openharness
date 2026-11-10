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
  store = new SuperTabStore(db, Date.now, { store: files, prefix: 'super-tabs', publicBase: 'https://cdn.example.test' }, { readCache: null })
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
