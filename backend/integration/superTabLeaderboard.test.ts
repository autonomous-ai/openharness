import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
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
async function scene(before?: (state: SuperTabState) => void) {
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
  before?.(state)
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

  it('names people by their profile name, else their email, and scores last week for the arrow', async () => {
    const s = await scene()
    await db.user.update({ where: { id: peer.sub }, data: { name: 'Peer Person' } })
    onTestFinished(() => db.user.update({ where: { id: peer.sub }, data: { name: null } }).then(() => undefined))
    const { body } = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead`)
    expect(score(body, peer.sub)).toMatchObject({ displayName: 'Peer Person', points: 3, prevWeekPoints: 3 })
    expect(score(body, owner.sub).displayName).toBe('owner')
  })

  it('details what each person shipped, a dormant group\'s too, and never a private chat\'s title', async () => {
    const s = await scene()
    const now = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead`, peer)
    expect(score(now.body, peer.sub).details).toEqual({ shipped: [{ title: 'Fresh', prUrl: PR, mergedAt: NOW - HOUR }], unblocked: [], lent: [], brought: [] })
    expect(JSON.stringify(now.body.data)).not.toMatch(/Peer and PM|Hidden/)
    const last = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&week=${WEEK - WEEK_MS}`, peer)
    expect(score(last.body, peer.sub).details.shipped).toEqual([{ title: 'Old', prUrl: PR, mergedAt: WEEK - 2 * 86_400_000 }])
  })

  describe('a rolling period', () => {
    it('sums a shipped request by its exact time and says which period', async () => {
      const s = await scene()
      const seven = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&period=7d`, peer)
      expect(seven.status).toBe(200)
      expect(seven.body.data.period).toEqual({ name: '7d', start: NOW + 1 - WEEK_MS, end: NOW })
      // The dormant group shipped 2 days before this week began: inside the 7 days up to now, whichever week that was.
      expect(score(seven.body, peer.sub)).toMatchObject({ shipped: { count: 2 }, prevWeekPoints: 0 })
      const thirty = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&period=30d`, peer)
      expect(score(thirty.body, peer.sub)).toMatchObject({ shipped: { count: 2 }, prevWeekPoints: null })
      expect(thirty.body.data.goal.lastWeek).toBeNull()
      expect(JSON.stringify(thirty.body.data)).not.toMatch(/Peer and PM|Hidden/)
      const day = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&period=24h`, peer)
      expect(score(day.body, peer.sub).shipped.count).toBe(1)
    })

    it('reads Lent and verdicts stored in parts: an older week once, days and hours beside it, and no other read carries the days', async () => {
      const s = await scene(state => {
        const day = Math.floor(NOW / 86_400_000) * 86_400_000
        state.machines = [{ machineId: 'peer-mac', name: 'Peer Mac', contributorId: peer.sub, membershipGeneration: state.people.find(p => p.id === peer.sub)!.generation, generation: 'g1',
          cwd: '/repo', engines: ['claude'], maxAgents: 2, paused: false, lent: [{ week: WEEK - WEEK_MS, busyMs: 20 * HOUR }], lentDays: [{ day, projectId: 'lead', busyMs: 10 * HOUR }] }]
        state.conversations.find(c => c.title === 'Fresh')!.ledger!.reviewHours = [{ hour: NOW - HOUR, engine: 'claude', model: 'opus', effort: 'high', count: 2 }]
        state.conversations.find(c => c.title === 'Fresh')!.ledger!.reviews = [{ week: WEEK - WEEK_MS, engine: 'claude', model: 'opus', effort: 'high', count: 3 }]
      })
      const url = `/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&period=30d`
      const first = await get(url, peer)
      expect(score(first.body, peer.sub).lent).toEqual({ machines: 1, agentMs: 30 * HOUR })
      // The machine the person brought, through the real read: its hours for others, nothing shipped on it, its week unread (#2444).
      expect(score(first.body, peer.sub).details.brought).toEqual([{ machineId: 'peer-mac', machineName: 'Peer Mac', shipped: 0, busyHours: 30,
        subscriptions: [{ engine: 'claude', usedPercent: null, resetsAt: null }] }])
      expect(first.body.data.byModel.find((m: { model: string }) => m.model === 'opus')).toMatchObject({ reviews: 5 })
      expect((await get(url, peer)).body.data).toEqual(first.body.data)
      // A week's read is as it was.
      const week = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&week=${WEEK - WEEK_MS}`, peer)
      expect(score(week.body, peer.sub).lent.agentMs).toBe(20 * HOUR)
      const parts = await get(`/api/super-tabs/${s.tabId}/parts`, peer)
      expect(JSON.stringify(parts.body.data)).not.toMatch(/lentDays|reviewHours/)
    })

    it('All projects sums what the reader may read: a private project counts for its reader, and nothing of it reaches anyone else', async () => {
      const s = await scene()
      const url = `/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&period=30d`
      // Peer's own request in the private project they cannot read.
      const asOwner = await get(`${url}&scope=all`, owner), asOutsider = await get(`${url}&scope=all`, outsider)
      expect(asOwner.body.data.allProjects).toBe(true)
      expect(score(asOwner.body, peer.sub).shipped.count).toBe(3)
      expect(score(asOutsider.body, peer.sub).shipped.count).toBe(2)
      expect(JSON.stringify(asOutsider.body.data)).not.toMatch(/Hidden|Secret/)
      expect(JSON.stringify(asOutsider.body.data)).not.toContain(s.secret)
      expect(asOwner.body.data.goal.thisWeek.shipped).toBe(3)
      // A private chat's ship record counts for no one, whatever the scope.
      expect(JSON.stringify(asOwner.body.data)).not.toMatch(/Peer and PM/)
      const one = await get(url, owner)
      expect(score(one.body, peer.sub).shipped.count).toBe(2)
      expect(one.body.data).not.toHaveProperty('allProjects')
    })

    it('All projects adds Lent earned on a private project only for who reads it', async () => {
      const s = await scene(state => {
        const secret = state.projects!.find(p => p.name === 'Secret')!
        state.machines = [{ machineId: 'peer-mac', name: 'Peer Mac', contributorId: peer.sub, membershipGeneration: state.people.find(p => p.id === peer.sub)!.generation, generation: 'g1',
          cwd: '/repo', engines: ['claude'], maxAgents: 2, paused: false, lentDays: [{ day: Math.floor(NOW / 86_400_000) * 86_400_000, projectId: secret.id, busyMs: 30 * HOUR }] }]
      })
      const url = `/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&period=30d&scope=all`
      expect(score((await get(url, owner)).body, peer.sub).lent).toEqual({ machines: 1, agentMs: 30 * HOUR })
      const outsiders = await get(url, outsider)
      expect(score(outsiders.body, peer.sub).lent).toEqual({ machines: 0, agentMs: 0 })
      expect(score(outsiders.body, peer.sub).details.lent).toEqual([])
    })

    it('All projects sums a Swarm from before projects, whose list is not stored', async () => {
      const s = await scene(state => {
        const secret = state.projects!.find(p => p.name === 'Secret')!
        state.conversations = state.conversations.filter(c => c.projectId !== secret.id)
        state.agents = state.agents.filter(a => state.conversations.some(c => c.agentIds.includes(a.id)))
        delete state.projects
      })
      const { status, body } = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&period=7d&scope=all`, peer)
      expect(status).toBe(200)
      expect(score(body, peer.sub).shipped.count).toBeGreaterThan(0)
    })

    it('All projects names a private project\'s PM only to who reads that project', async () => {
      const s = await scene(state => {
        const project = state.projects!.find(p => p.name === 'Secret')!
        const lead = state.conversations.find(c => c.id === project.leadConversationId)!
        const pm = { ...state.agents[0]!, id: 'secret-pm', harnessId: 'secret-pm-harness', name: 'Secret PM', displayName: 'Secret PM' }
        state.agents.push(pm)
        lead.leadId = pm.id
        lead.agentIds = [pm.id]
      })
      const url = `/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&period=7d&scope=all`
      expect(JSON.stringify((await get(url, owner)).body.data.agents)).toContain('Secret PM')
      expect(JSON.stringify((await get(url, outsider)).body.data)).not.toContain('Secret PM')
    })

    it('reads All projects\' dormant groups too, and refuses it for a week', async () => {
      const s = await scene(state => {
        const secret = state.conversations.find(c => c.title === 'Hidden')!
        Object.assign(secret, { dormant: true, lastActivityAt: new Date(NOW - 2 * HOUR).toISOString() })
      })
      const url = `/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&period=7d&scope=all`
      expect(score((await get(url, owner)).body, peer.sub).details.shipped.map((d: { title: string }) => d.title)).toContain('Hidden')
      expect((await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&scope=all`)).status).toBe(400)
    })

    it('answers the same whatever the reader asks twice', async () => {
      const s = await scene()
      const url = `/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&period=30d`
      expect((await get(url)).body.data).toEqual((await get(url)).body.data)
    })

    it('keeps a private project\'s board to its readers, refused as any other id is', async () => {
      const s = await scene()
      const secret = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=${s.secret}&period=7d`, outsider)
      const unknown = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=no-such-project&period=7d`, outsider)
      expect(secret.status).toBe(404)
      expect(unknown.status).toBe(404)
      expect(secret.body.error).toEqual(unknown.body.error)
    })

    it('refuses an unknown period, and a week and period together', async () => {
      const s = await scene()
      expect((await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&period=90d`)).status).toBe(400)
      expect((await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead&period=7d&week=${WEEK}`)).status).toBe(400)
    })

    it('still answers an older app that asks for a week, with no period in it', async () => {
      const s = await scene()
      const { status, body } = await get(`/api/super-tabs/${s.tabId}/leaderboard?projectId=lead`)
      expect(status).toBe(200)
      expect(body.data).toMatchObject({ week: WEEK })
      expect(body.data).not.toHaveProperty('period')
    })
  })

  it('leaves the ledger out of the groups every reader loads', async () => {
    const s = await scene()
    const { body } = await get(`/api/super-tabs/${s.tabId}/parts`, peer)
    const fresh = body.data.groups.find((g: { key: string }) => g.key === s.fresh)
    expect(fresh.data.requesterId).toBe(peer.sub)
    expect(fresh.data).not.toHaveProperty('ledger')
  })
})
