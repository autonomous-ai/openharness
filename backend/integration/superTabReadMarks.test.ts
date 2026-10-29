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
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import * as parts from '../src/superTabs/parts/index.js'
import { swarmTransaction } from '../src/superTabs/cache.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { HostReads } from '../src/superTabs/read/host.js'
import type { Conversation, SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, outsider as outsiderActor, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
let clock = NOW
const user = (actor: { userId: string; email: string }): AuthUser => ({ sub: actor.userId, email: actor.email, autonomousEnv: 'prod', role: 'user' })
const [owner, peer, outsider] = [ownerActor, peerActor, outsiderActor].map(user) as [AuthUser, AuthUser, AuthUser]
const MIGRATED = NOW - 60_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_read_marks_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const each of [owner, peer, outsider]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
  const store = new SuperTabStore(db, () => clock)
  app = Fastify()
  app.setErrorHandler(errorHandler)
  // External SSO is replaced with fixture accounts; every permission and write below is real.
  app.addHook('onRequest', async (request, reply) => {
    const found = [owner, peer, outsider].find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!found) return reply.code(401).send({ success: false })
    request.user = found
  })
  await app.register(superTabRoutes, { store, github: null, reads: new SwarmReads(store, { now: () => clock }),
    hosts: new HostReads(store, { now: () => clock }) })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm in parts: a public conversation with 100 messages, and a private project's conversation only its owner reads. */
async function scene() {
  const s = swarm(MIGRATED)
  s.join(peerActor)
  s.join(outsiderActor)
  const secret = s.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).projectId as string
  const web = s.group('Web')
  const secretGroup = s.group('Secret work', secret)
  s.edit(state => {
    state.conversations.find(c => c.id === web)!.lastMessageSequence = 100
    state.conversations.find(c => c.id === secretGroup)!.lastMessageSequence = 50
  })
  const tabId = `tab-${randomUUID()}`
  await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId } as SuperTabState, revision: 3 })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  return { tabId, web, secretGroup }
}

const call = async (method: 'GET' | 'POST', url: string, as: AuthUser, payload?: unknown) => {
  const response = await app.inject({ method, url, headers: { authorization: `Bearer ${as.sub}` }, ...(payload ? { payload } : {}) })
  return { status: response.statusCode, body: response.json() as { data: any; error?: { code: string } } }
}
const mark = (tabId: string, conversationId: string, sequence: number, as: AuthUser = owner, query = '') =>
  call('POST', `/api/super-tabs/${tabId}/conversations/${conversationId}/read${query}`, as, { sequence })
const firstLoad = async (tabId: string, as: AuthUser) => (await call('GET', `/api/super-tabs/${tabId}/parts`, as)).body.data
const marksOf = async (tabId: string, as: AuthUser) => (await firstLoad(tabId, as)).derived.readMarks as Record<string, number> | undefined

describe('read marks (one per person and conversation)', () => {
  it('keeps the person\'s mark and gives it back in their own read only', async () => {
    const s = await scene()
    expect(await mark(s.tabId, s.web, 40)).toMatchObject({ status: 200, body: { data: { sequence: 40 } } })
    expect(await marksOf(s.tabId, owner)).toEqual({ [s.web]: 40 })
    // Another reader of the same conversation never sees it: no read receipts.
    expect(await marksOf(s.tabId, peer)).toEqual({})
    await mark(s.tabId, s.web, 70, peer)
    expect(await marksOf(s.tabId, peer)).toEqual({ [s.web]: 70 })
    expect(await marksOf(s.tabId, owner)).toEqual({ [s.web]: 40 })
  })

  it('never moves a mark back, whichever device writes last', async () => {
    const s = await scene()
    await mark(s.tabId, s.web, 60)
    expect((await mark(s.tabId, s.web, 20)).body.data).toEqual({ sequence: 60 })
    expect(await marksOf(s.tabId, owner)).toEqual({ [s.web]: 60 })
    // Devices racing on a conversation read for the first time: the highest wins and one row is kept.
    const other = await scene()
    await Promise.all([30, 90, 45, 10, 80].map(n => mark(other.tabId, other.web, n)))
    expect(await marksOf(other.tabId, owner)).toEqual({ [other.web]: 90 })
    expect(await db.superTabReadMark.count({ where: { tabId: other.tabId } })).toBe(1)
  })

  it('stops at the conversation\'s newest message', async () => {
    const s = await scene()
    expect((await mark(s.tabId, s.web, 5_000)).body.data).toEqual({ sequence: 100 })
  })

  it('refuses a conversation the person cannot read, and stores nothing', async () => {
    const s = await scene()
    expect((await mark(s.tabId, s.secretGroup, 10, outsider)).status).toBe(404)
    expect((await mark(s.tabId, 'no-such-group', 10, outsider)).status).toBe(404)
    expect(await db.superTabReadMark.count({ where: { tabId: s.tabId } })).toBe(0)
  })

  it('stops sending a mark once the person can no longer read its conversation', async () => {
    const s = await scene()
    await mark(s.tabId, s.web, 30, peer)
    expect(await marksOf(s.tabId, peer)).toEqual({ [s.web]: 30 })
    // The conversation becomes the owner's alone, as a private chat is (read/views.ts canReadGroup).
    await swarmTransaction(db, async tx => {
      const current = (await parts.loadActive(tx, s.tabId, { groupIds: [s.web] })).groups.find(g => g.key === s.web)!
      const data = { ...structuredClone(current.data!), audience: { people: [{ id: owner.sub, generation: 0 }] } } as Conversation
      await guardedWrite(tx, s.tabId, { op: 'update', kind: 'group', key: s.web, seen: current.version, data }, clock)
    })
    expect(await marksOf(s.tabId, peer)).toEqual({})
    expect((await mark(s.tabId, s.web, 40, peer)).status).toBe(404)
  })

  it('keeps no marks for agents', async () => {
    const s = await scene()
    expect((await mark(s.tabId, s.web, 10, owner, '?asAgentId=some-agent')).status).toBe(400)
    expect(await db.superTabReadMark.count({ where: { tabId: s.tabId } })).toBe(0)
  })

  it('sends a later read only the marks that moved since its cursor', async () => {
    const s = await scene()
    clock = NOW
    await mark(s.tabId, s.secretGroup, 10)
    // The cursor overlaps the last 30 s (read/cursor.ts), so a mark is old news to a read a minute later.
    clock = NOW + 60_000
    const cursor = (await firstLoad(s.tabId, owner)).cursor as string
    const changes = async (at: number) => {
      clock = at
      return (await call('GET', `/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, owner)).body.data.derived.readMarks
    }
    expect(await changes(NOW + 61_000)).toEqual({})
    clock = NOW + 62_000
    await mark(s.tabId, s.web, 25)
    expect(await changes(NOW + 63_000)).toEqual({ [s.web]: 25 })
    clock = NOW
  })
})
