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
import { SwarmReads } from '../src/superTabs/read/service.js'
import type { SuperTabState } from '../src/superTabs/model.js'
import { WEEK_MS, weekStart } from '../src/superTabs/leaderboard/week.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, outsider as outsiderActor, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
const user = (actor: { userId: string; email: string }): AuthUser => ({ sub: actor.userId, email: actor.email, autonomousEnv: 'prod', role: 'user' })
const [owner, peer, outsider] = [ownerActor, peerActor, outsiderActor].map(user) as [AuthUser, AuthUser, AuthUser]
const WEEK = weekStart(NOW), HOUR = 3_600_000
const PR = 'https://github.com/o/r/pull/9'

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_leaderboard_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const each of [owner, peer, outsider]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
  const store = new SuperTabStore(db)
  app = Fastify()
  app.setErrorHandler(errorHandler)
  // External SSO is replaced with fixture accounts; every permission and transaction below is real.
  app.addHook('onRequest', async (request, reply) => {
    const found = [owner, peer, outsider].find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!found) return reply.code(401).send({ success: false })
    request.user = found
  })
  await app.register(superTabRoutes, { store, github: null, reads: new SwarmReads(store, { now: () => NOW }) })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm in parts: peer's request shipped this week, peer's request shipped last week and gone dormant, a private chat
 *  that carries a ship record, a private project with its own shipped request, and the owner's work waiting on them. */
async function scene() {
  const s = swarm(NOW)
  s.join(peerActor)
  s.join(outsiderActor)
  const lead = s.add('lead-harness', 'lead', true)
  const secret = s.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).projectId as string
  const fresh = s.group('Fresh'), old = s.group('Old'), chat = s.group('Peer and PM'), hidden = s.group('Hidden', secret), waiting = s.group('Waiting')
  const worker = s.add('worker-harness', waiting)
  s.run({ type: 'work.assign', conversationId: waiting, agentId: worker })
  s.run({ type: 'work.status', conversationId: waiting, assignmentId: s.state.conversations.find(c => c.id === waiting)!.assignment!.id,
    status: 'needs_human', result: 'Flag?' }, { kind: 'agent', agentId: worker, machineOwnerId: `${owner.sub}-machine` })
  s.edit(state => {
    const done = { id: 'done', agentId: worker, status: 'done' as const, result: PR, configuration: state.agents[0]!.configuration,
      execution: { machineId: 'host', harnessId: 'h', machineOwnerId: owner.sub } }
    const ship = (id: string, shippedAt: number) => Object.assign(state.conversations.find(c => c.id === id)!,
      { requesterId: peer.sub, assignment: done, pullRequestUrls: [PR], ledger: { askedAt: shippedAt - 2 * HOUR, shippedAt } })
    ship(fresh, NOW - HOUR)
    ship(old, WEEK - 2 * 86_400_000)
    ship(chat, NOW - HOUR)
    ship(hidden, NOW - HOUR)
    const generation = state.people.find(p => p.id === peer.sub)!.generation
    state.conversations.find(c => c.id === chat)!.audience = { people: [{ id: peer.sub, generation }] }
    Object.assign(state.conversations.find(c => c.id === old)!, { dormant: true, lastActivityAt: new Date(WEEK - 2 * 86_400_000).toISOString() })
  })
  const tabId = `tab-${randomUUID()}`
  const state = { ...structuredClone(s.state), id: tabId } as SuperTabState
  await writeLegacySwarm(db, { state, revision: 50 })
  const report = await migrateSwarm(db, tabId, { now: () => NOW - 60_000 })
  if (!report.ok) throw new Error(report.error)
  return { tabId, lead, secret, fresh, old, chat, waiting }
}
const get = async (url: string, as: AuthUser = owner) => {
  const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${as.sub}` } })
  return { status: response.statusCode, body: response.json() as { data: any; error?: { code: string; message: string } } }
}
const score = (body: { data: { people: Array<{ personId: string }> } }, id: string) => body.data.people.find(p => p.personId === id) as any

describe('the leaderboard read', () => {
  it('counts this week\'s shipped request for its requester, never a private chat\'s', async () => {
    const s = await scene()
    const { status, body } = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead`, peer)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ projectId: 'lead', week: WEEK })
    expect(score(body, peer.sub)).toMatchObject({ points: 3, medal: 'gold', shipped: { count: 1, medianAskToShipMs: 2 * HOUR } })
    expect(body.data.goal.thisWeek.shipped).toBe(1)
    expect(JSON.stringify(body.data)).not.toContain(s.chat)
  })

  it('reads last week from the groups that went dormant since', async () => {
    const s = await scene()
    const { body } = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&week=${WEEK - WEEK_MS}`)
    expect(score(body, peer.sub).shipped.count).toBe(1)
    expect(body.data.goal.thisWeek.shipped).toBe(1)
  })

  it('shows who agents wait on as a count, with the conversation to answer in', async () => {
    const s = await scene()
    const { body } = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead`, outsider)
    expect(body.data.waiting).toEqual({ total: 1, people: [{ personId: owner.sub, count: 1, conversationIds: [s.waiting] }] })
  })

  it('keeps a private project\'s board to the people who read it', async () => {
    const s = await scene()
    expect((await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=${s.secret}`, outsider)).status).toBe(404)
    const own = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=${s.secret}`, owner)
    expect(own.body.data.people.map((p: { personId: string }) => p.personId)).toEqual([owner.sub])
  })

  it('is for people: an agent reading as itself is refused', async () => {
    const s = await scene()
    expect((await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&asAgentId=${s.lead}`)).status).toBe(400)
  })

  it('refuses a week that is not a Monday, or older than the weeks kept', async () => {
    const s = await scene()
    expect((await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&week=${WEEK + 1}`)).status).toBe(400)
    expect((await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&week=${WEEK - 5 * WEEK_MS}`)).status).toBe(400)
    expect((await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&week=${WEEK + WEEK_MS}`)).status).toBe(400)
  })

  it('leaves the ledger out of the groups every reader loads', async () => {
    const s = await scene()
    const { body } = await get(`/api/super-tabs/${s.tabId}/parts`, peer)
    const fresh = body.data.groups.find((g: { key: string }) => g.key === s.fresh)
    expect(fresh.data.requesterId).toBe(peer.sub)
    expect(fresh.data).not.toHaveProperty('ledger')
  })
})
