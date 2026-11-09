import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { purgeSwarm } from '../src/superTabs/purge.js'
import { Shipping } from '../src/superTabs/shipping/service.js'
import { WEEK_MS, weekStart } from '../src/superTabs/shipping/week.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// The v4 leaderboard (docs/plans/2026-11-09-swarm-v4-leaderboard.md): daemons report what each person's agents shipped, read
// from GitHub with that person's own gh, and the board ranks people by how many of their agents ship. A fresh loopback replica
// set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
const clock = { now: Date.UTC(2026, 10, 11, 12) }
const THIS = () => weekStart(clock.now)
const W = WEEK_MS
const user = (name: string): AuthUser => ({ sub: `${name}-id`, email: `${name}@example.com`, autonomousEnv: 'prod', role: 'user' })
const [owner, ann, bob, cy, outsider] = ['owner', 'ann', 'bob', 'cy', 'outsider'].map(user) as [AuthUser, AuthUser, AuthUser, AuthUser, AuthUser]
const tokens = [owner, ann, bob, cy, outsider]

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_shipping_test'))
  const store = new SuperTabStore(db, () => clock.now)
  app = Fastify()
  app.setErrorHandler(errorHandler)
  app.addHook('onRequest', async (request, reply) => {
    const found = tokens.find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!found) return reply.code(401).send({ success: false })
    request.user = found
  })
  await app.register(superTabRoutes, { store, github: null, reads: new SwarmReads(store, { now: () => clock.now }), shipping: new Shipping(db, { now: () => clock.now }) })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

let tab = ''
type Counts = { P0?: number; P1?: number; P2?: number; P3?: number; none?: number }
interface Reading { agentId: string; from: number; weeks: Array<{ week: number } & Counts> }

const agentRow = (tabId: string, id: string, name: string, person: AuthUser, machineId: string, deleted = false) => ({ id: `${tabId}:${id}`, tabId, key: id,
  version: 1, changedAt: new Date(clock.now), deleted, ordinal: 1, machineId, machineOwnerId: person.sub, contributorId: person.sub,
  data: { id, name: `session-${id}`, displayName: name, machineId, machineOwnerId: person.sub, contributorId: person.sub } })
const memberRow = (tabId: string, person: AuthUser, name?: string) => ({ id: `${tabId}:${person.sub}`, tabId, key: person.sub, version: 1, changedAt: new Date(clock.now),
  ordinal: 1, data: { id: person.sub, email: person.email, role: 'member', generation: 'g', ...name ? { name } : {} } })

/** A Swarm in parts: owner, ann (a named person), bob and cy members, an outsider not in it; Ann's Atlas and Nova on her Mac, Bob's
 *  Orion on his, Cy's Echo on a Mac of his; a public project with a repository, one with an ssh address, a private one only the owner
 *  reads, and one with none. */
async function scene(): Promise<string> {
  const tabId = `tab-${randomUUID()}`
  await db.superTab.create({ data: { id: tabId, ownerId: owner.sub, autonomousEnv: 'prod', memberIds: [owner, ann, bob, cy].map(u => u.sub), invitedEmails: [],
    machineIds: ['mac-ann', 'mac-bob', 'mac-cy'], format: 2, state: { version: 2 } } })
  const project = (id: string, visibility: 'public' | 'private', url: string | null, members: string[] = []) => ({ id, name: id, ownerId: owner.sub, visibility,
    members: members.map(m => ({ id: m, generation: 'g' })), ...url === undefined ? {} : { repository: { machineId: 'mac-ann', cwd: '/x', repositoryUrl: url } } })
  await db.swarmHead.create({ data: { id: `${tabId}:head`, tabId, key: 'head', version: 1, changedAt: new Date(clock.now), ordinal: 0,
    data: { name: 'Lampos', projects: [project('web', 'public', 'https://github.com/acme/web'), project('api', 'public', 'git@github.com:acme/api.git'),
      project('secret', 'private', 'https://github.com/acme/secret', [owner.sub]), project('docs', 'public', null), { ...project('plain', 'public', null), repository: undefined }] } } })
  await db.swarmMember.createMany({ data: [memberRow(tabId, owner), memberRow(tabId, ann, 'Ann Lee'), memberRow(tabId, bob), memberRow(tabId, cy)] })
  await db.swarmAgent.createMany({ data: [agentRow(tabId, 'atlas', 'Atlas', ann, 'mac-ann'), agentRow(tabId, 'nova', 'Nova', ann, 'mac-ann'),
    agentRow(tabId, 'gone', 'Gone', ann, 'mac-ann', true), agentRow(tabId, 'orion', 'Orion', bob, 'mac-bob'), agentRow(tabId, 'echo', 'Echo', cy, 'mac-cy')] })
  return tabId
}
const get = async (url: string, as: AuthUser = ann) => {
  const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${as.sub}` } })
  return { status: response.statusCode, body: response.json() as { data: any; error?: { code: string; message: string } } }
}
const post = async (url: string, body: unknown, as: AuthUser = ann) => {
  const response = await app.inject({ method: 'POST', url, payload: body as object, headers: { authorization: `Bearer ${as.sub}` } })
  return { status: response.statusCode, body: response.json() as { data: any; error?: { code: string; message: string } } }
}
const report = (machineId: string, agents: unknown[], as: AuthUser = ann, tabId = tab) => post(`/api/super-tabs/hosts/${machineId}/shipping`, { tabId, agents }, as)
const targets = (machineId: string, as: AuthUser = ann) => get(`/api/super-tabs/hosts/${machineId}/shipping`, as)
const board = (query = '', as: AuthUser = ann, tabId = tab) => get(`/api/super-tabs/${tabId}/shipping${query}`, as)
const row = (agentId: string, weeks: Array<{ week: number } & Counts>, from = THIS() - W): Reading => ({ agentId, from, weeks })

beforeAll(async () => { tab = await scene() })

describe('what a daemon is told to read', () => {
  it('names the person\'s agents on that machine and the repositories of the projects they read, once each', async () => {
    const { status, body } = await targets('mac-ann')
    expect(status).toBe(200)
    expect(body.data.swarms).toEqual([{ tabId: tab, repositories: ['acme/api', 'acme/web'],
      agents: [{ id: 'atlas', name: 'Atlas', from: THIS() - 4 * W }, { id: 'nova', name: 'Nova', from: THIS() - 4 * W }] }])
  })

  it('tells a person of a private project\'s repository only when they read the project', async () => {
    const mine = await targets('mac-ann', ann)
    expect(mine.body.data.swarms[0].repositories).not.toContain('acme/secret')
    await db.swarmAgent.create({ data: agentRow(tab, 'owl', 'Owl', owner, 'mac-owner') })
    const theirs = await targets('mac-owner', owner)
    expect(theirs.body.data.swarms[0].repositories).toEqual(['acme/api', 'acme/secret', 'acme/web'])
    await db.swarmAgent.delete({ where: { id: `${tab}:owl` } })
  })

  it('tells nothing of another person\'s agents, another machine, a removed agent or a Swarm the person is not in', async () => {
    expect((await targets('mac-bob', ann)).body.data.swarms).toEqual([])
    expect((await targets('mac-ann', bob)).body.data.swarms).toEqual([])
    expect((await targets('mac-ann', outsider)).body.data.swarms).toEqual([])
    expect((await targets('mac-elsewhere', ann)).body.data.swarms).toEqual([])
    expect((await targets('mac-ann')).body.data.swarms[0].agents.map((a: { id: string }) => a.id)).not.toContain('gone')
  })

  it('starts a reading where the last one is settled', async () => {
    const t = await scene()
    await report('mac-ann', [row('atlas', [{ week: THIS(), P2: 1 }])], ann, t)
    const { body } = await get('/api/super-tabs/hosts/mac-ann/shipping')
    const mine = body.data.swarms.find((s: { tabId: string }) => s.tabId === t).agents
    expect(mine).toEqual([{ id: 'atlas', name: 'Atlas', from: THIS() - W }, { id: 'nova', name: 'Nova', from: THIS() - 4 * W }])
  })
})

describe('a report', () => {
  it('is counted in the weekly and the all-time board, by the points of each agent', async () => {
    const t = await scene()
    // Atlas shipped a P1 and a P2 this week (weighs 6); Nova a P3 last week (1); Bob's Orion a P0 this week (8).
    expect((await report('mac-ann', [row('atlas', [{ week: THIS(), P1: 1, P2: 1 }]), row('nova', [{ week: THIS() - W, P3: 1 }])], ann, t)).body.data).toEqual({ applied: 2, skipped: 0 })
    expect((await report('mac-bob', [row('orion', [{ week: THIS(), P0: 1 }])], bob, t)).body.data).toEqual({ applied: 1, skipped: 0 })

    const week = (await board('', cy, t)).body.data
    expect(week.week).toBe(THIS())
    expect(week.people).toEqual([
      { personId: bob.sub, displayName: 'bob', agentsShipping: 1, level: 1, points: 2.8, rank: 1 },
      { personId: ann.sub, displayName: 'Ann Lee', agentsShipping: 1, level: 1, points: 2.4, rank: 2 }])
    const all = (await board('?all=1', cy, t)).body.data
    expect(all.week).toBeNull()
    expect(all.people).toEqual([
      { personId: ann.sub, displayName: 'Ann Lee', agentsShipping: 2, level: 2, points: 3.4, rank: 1 },
      { personId: bob.sub, displayName: 'bob', agentsShipping: 1, level: 1, points: 2.8, rank: 2 }])
    const last = (await board(`?week=${THIS() - W}`, cy, t)).body.data
    expect(last.people.map((p: { personId: string; points: number }) => [p.personId, p.points])).toEqual([[ann.sub, 1]])
  })

  it('is a set: sent twice it changes nothing, and a week it leaves out becomes zero (a revert)', async () => {
    const t = await scene()
    const once = row('atlas', [{ week: THIS(), P1: 2 }, { week: THIS() - W, P3: 1 }])
    await report('mac-ann', [once], ann, t)
    await report('mac-ann', [once], ann, t)
    expect((await board('?all=1', ann, t)).body.data.people[0]).toMatchObject({ agentsShipping: 1, points: 3 })
    // Both of this week's issues were reverted, and last week's stays.
    await report('mac-ann', [row('atlas', [{ week: THIS() - W, P3: 1 }])], ann, t)
    expect((await board('', ann, t)).body.data.people).toEqual([])
    expect((await board('?all=1', ann, t)).body.data.people[0]).toMatchObject({ agentsShipping: 1, points: 1 })
    expect(await db.swarmShipping.count({ where: { tabId: t, agentId: 'atlas', week: THIS() } })).toBe(0)
  })

  it('is skipped for an agent that is not the sender\'s, not on that machine, or not there', async () => {
    const t = await scene()
    const reading = row('atlas', [{ week: THIS(), P0: 1 }])
    expect((await report('mac-ann', [reading], bob, t)).body.data).toEqual({ applied: 0, skipped: 1 })
    expect((await report('mac-bob', [reading], ann, t)).body.data).toEqual({ applied: 0, skipped: 1 })
    expect((await report('mac-ann', [row('gone', [{ week: THIS(), P0: 1 }]), row('nobody', [{ week: THIS(), P0: 1 }])], ann, t)).body.data).toEqual({ applied: 0, skipped: 2 })
    expect((await board('?all=1', ann, t)).body.data.people).toEqual([])
  })

  it('is refused for a Swarm the sender is not in, in the one answer a missing one gets', async () => {
    const t = await scene()
    const refused = await report('mac-ann', [row('atlas', [{ week: THIS(), P0: 1 }])], outsider, t)
    const missing = await report('mac-ann', [row('atlas', [{ week: THIS(), P0: 1 }])], ann, 'tab-missing')
    expect([refused.status, missing.status]).toEqual([404, 404])
    expect(refused.body.error).toEqual(missing.body.error)
  })

  it('is refused when it cannot be right: a week that is no Monday, one ahead, a week before the reading started, counts over the cap, none named', async () => {
    const t = await scene()
    const bad = async (agents: unknown[]) => (await report('mac-ann', agents, ann, t)).status
    expect(await bad([row('atlas', [{ week: THIS() + 1, P0: 1 }])])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS() + W, P0: 1 }])])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS() - W, P0: 1 }], THIS() - W + 1)])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS() - 20 * W, P0: 1 }], THIS() - 20 * W)])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS() - 2 * W, P0: 1 }], THIS() - W)])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS(), P0: 1001 }])])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS(), P0: -1 }])])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS(), P0: 1 }, { week: THIS(), P1: 1 }])])).toBe(400)
    expect(await bad([])).toBe(400)
    expect(await bad(Array.from({ length: 101 }, (_, i) => row(`a${i}`, [])))).toBe(400)
    expect(await bad([{ agentId: 'atlas', failed: 'NOT_A_CODE' }])).toBe(400)
    expect(await db.swarmShipping.count({ where: { tabId: t } })).toBe(0)
  })

  it('keeps five weeks of rows, every week in the all-time row, and starts the next reading where a revert can still land', async () => {
    const t = await scene()
    for (let i = 0; i < 8; i++) {
      clock.now = Date.UTC(2026, 10, 11, 12) + i * W
      const read = i === 0 ? row('atlas', [{ week: THIS(), P3: 1 }], THIS() - 4 * W) : row('atlas', [{ week: THIS() - W, P3: 1 }, { week: THIS(), P3: 1 }])
      expect((await report('mac-ann', [read], ann, t)).body.data.applied).toBe(1)
    }
    const weeks = (await db.swarmShipping.findMany({ where: { tabId: t, agentId: 'atlas' }, orderBy: { week: 'asc' } })).map(r => r.week)
    expect(weeks).toEqual([0, ...[3, 4, 5, 6, 7].map(i => weekStart(Date.UTC(2026, 10, 11, 12)) + i * W)])
    // Eight weeks of one P3 each: weighs 8 over all time, and 1 in the week.
    expect((await board('?all=1', ann, t)).body.data.people[0]).toMatchObject({ agentsShipping: 1, points: 2.8 })
    expect((await board('', ann, t)).body.data.people[0]).toMatchObject({ agentsShipping: 1, points: 1 })
    const { body } = await get('/api/super-tabs/hosts/mac-ann/shipping')
    expect(body.data.swarms.find((s: { tabId: string }) => s.tabId === t).agents[0].from).toBe(THIS() - W)
    clock.now = Date.UTC(2026, 10, 11, 12)
  })

  it('counts a long backfill once, and never again for a week the reading has settled', async () => {
    const t = await scene()
    const backfill = row('atlas', [{ week: THIS() - 4 * W, P2: 3 }, { week: THIS() - 2 * W, P2: 1 }, { week: THIS(), P3: 1 }], THIS() - 4 * W)
    await report('mac-ann', [backfill], ann, t)
    await report('mac-ann', [backfill], ann, t)
    // 3 and 1 P2 and a P3 weigh 6 + 2 + 1 = 9: three points.
    expect((await board('?all=1', ann, t)).body.data.people[0]).toMatchObject({ points: 3 })
    // A stale reading from before the settled week cannot change what is settled.
    await report('mac-ann', [row('atlas', [{ week: THIS() - 4 * W, P0: 9 }, { week: THIS(), P3: 1 }], THIS() - 4 * W)], ann, t)
    expect((await board('?all=1', ann, t)).body.data.people[0]).toMatchObject({ points: 3 })
  })
})

describe('a failed reading', () => {
  it('is shown to its person alone, and cleared by the next good report', async () => {
    const t = await scene()
    await report('mac-ann', [row('atlas', [{ week: THIS(), P2: 1 }])], ann, t)
    expect((await report('mac-ann', [{ agentId: 'atlas', failed: 'GH_SIGNED_OUT' }, { agentId: 'nova', failed: 'RATE_LIMITED' }], ann, t)).body.data).toEqual({ applied: 2, skipped: 0 })
    const own = (await board('', ann, t)).body.data
    expect(own.failures).toEqual([{ machineId: 'mac-ann', code: 'GH_SIGNED_OUT' }, { machineId: 'mac-ann', code: 'RATE_LIMITED' }])
    expect((await board('', bob, t)).body.data.failures).toEqual([])
    // The numbers it had stay.
    expect(own.people[0]).toMatchObject({ personId: ann.sub, points: 1.4 })
    await report('mac-ann', [row('atlas', [{ week: THIS(), P2: 1 }]), row('nova', [])], ann, t)
    expect((await board('', ann, t)).body.data.failures).toEqual([])
  })
})

describe('the board', () => {
  it('is for the Swarm\'s people: a stranger and an agent are told what a missing Swarm is told', async () => {
    const t = await scene()
    const stranger = await board('', outsider, t), missing = await board('', ann, 'tab-missing')
    expect([stranger.status, missing.status]).toEqual([404, 404])
    expect(stranger.body.error).toEqual(missing.body.error)
    expect((await board('?asAgentId=atlas', ann, t)).status).toBe(400)
  })

  it('lists people who left no more, and nothing of anyone who shipped nothing', async () => {
    const t = await scene()
    await report('mac-ann', [row('atlas', [{ week: THIS(), P2: 1 }])], ann, t)
    await report('mac-bob', [row('orion', [{ week: THIS(), P2: 1 }])], bob, t)
    await db.superTab.update({ where: { id: t }, data: { memberIds: [owner.sub, ann.sub, cy.sub] } })
    expect((await board('', ann, t)).body.data.people.map((p: { personId: string }) => p.personId)).toEqual([ann.sub])
    expect((await board('', cy, t)).body.data.people.length).toBe(1)
  })

  it('answers a Swarm with no shipping, and a deleted one, with nothing', async () => {
    const t = await scene()
    expect((await board('', ann, t)).body.data).toEqual({ week: THIS(), people: [], failures: [] })
    await db.superTab.update({ where: { id: t }, data: { memberIds: [], deletedAt: new Date(clock.now), purgeAt: new Date(clock.now + 86_400_000) } })
    expect((await board('', ann, t)).status).toBe(404)
  })

  it('reads this week or one of the three before it, and no other', async () => {
    const t = await scene()
    for (const week of [THIS(), THIS() - 3 * W]) expect((await board(`?week=${week}`, ann, t)).status).toBe(200)
    for (const week of [THIS() + W, THIS() - 4 * W, THIS() + 1, 0]) expect((await board(`?week=${week}`, ann, t)).status).toBe(400)
    expect((await board('?week=1&all=1', ann, t)).status).toBe(400)
  })
})

describe('a deleted Swarm\'s purge', () => {
  it('removes its shipping rows and no other Swarm\'s', async () => {
    const gone = await scene(), kept = await scene()
    for (const t of [gone, kept]) await report('mac-ann', [row('atlas', [{ week: THIS(), P2: 1 }])], ann, t)
    await db.superTab.update({ where: { id: gone }, data: { memberIds: [], deletedAt: new Date(clock.now), purgeAt: new Date(clock.now) } })
    expect(await purgeSwarm(db, gone, null, clock.now + 2 * 3_600_000)).toBe('purged')
    expect(await db.swarmShipping.count({ where: { tabId: gone } })).toBe(0)
    expect(await db.swarmShipping.count({ where: { tabId: kept } })).toBe(2)
  })
})

describe('the reads and writes of the board', () => {
  it('use their index and examine no row they do not return', async () => {
    const t = await scene()
    for (let i = 0; i < 30; i++) {
      await db.swarmAgent.create({ data: agentRow(t, `bulk${i}`, `Bulk${i}`, ann, 'mac-ann') })
      await db.swarmShipping.createMany({ data: [{ id: `${t}:bulk${i}:${THIS() - 2 * W}`, tabId: t, agentId: `bulk${i}`, week: THIS() - 2 * W, personId: ann.sub, shipped: [0, 0, 1, 0, 0], readAt: new Date(clock.now) }] })
    }
    await report('mac-ann', [row('atlas', [{ week: THIS(), P2: 1 }])], ann, t)
    const entries = await profiled(db, async () => {
      await board('', ann, t)
      await board('?all=1', ann, t)
      await report('mac-ann', [row('atlas', [{ week: THIS(), P1: 1 }])], ann, t)
      await targets('mac-ann')
    })
    const shipping = entries.filter(e => e.ns.endsWith('.SwarmShipping'))
    expect(shipping.length).toBeGreaterThan(0)
    for (const entry of shipping) {
      expect(entry.planSummary ?? '', JSON.stringify(entry.command)).toMatch(/IXSCAN|EXPRESS|IDHACK|EOF/)
      expect(entry.docsExamined ?? 0).toBeLessThanOrEqual(Math.max(entry.nreturned ?? 0, 1) + 2)
    }
    expect(reads(entries, 'SwarmShipping', ['tabId', 'week']).length).toBeGreaterThan(0)
    expect(plan(reads(entries, 'SwarmShipping', ['tabId', 'week'])).every(p => /IXSCAN/.test(p.plan ?? ''))).toBe(true)
  })
})
