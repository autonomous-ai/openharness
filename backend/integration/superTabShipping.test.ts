import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
const START = Date.UTC(2026, 10, 11, 12)
const clock = { now: START }
const THIS = () => weekStart(clock.now)
const W = WEEK_MS
const user = (name: string): AuthUser => ({ sub: `${name}-id`, email: `${name}@example.com`, autonomousEnv: 'prod', role: 'user' })
const [owner, ann, bob, cy, outsider] = ['owner', 'ann', 'bob', 'cy', 'outsider'].map(user) as [AuthUser, AuthUser, AuthUser, AuthUser, AuthUser]
const tokens = [owner, ann, bob, cy, outsider]
/** This run's machines: a database that outlives a run (a developer's) never mixes two runs' Swarms into a machine's reads. */
const RUN = randomUUID().slice(0, 8)
const MAC = { ann: `mac-ann-${RUN}`, bob: `mac-bob-${RUN}`, cy: `mac-cy-${RUN}`, owner: `mac-owner-${RUN}`, elsewhere: `mac-elsewhere-${RUN}` }

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
interface Reading { agentId: string; name: string; from: number; weeks: Array<{ week: number } & Counts> }
/** An agent's name as the scene gives it: its id with a capital. */
const nameOf = (agentId: string) => agentId[0]!.toUpperCase() + agentId.slice(1)

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
    machineIds: [MAC.ann, MAC.bob, MAC.cy], format: 2, state: { version: 2 } } })
  const project = (id: string, visibility: 'public' | 'private', url: string | null, members: string[] = []) => ({ id, name: id, ownerId: owner.sub, visibility,
    members: members.map(m => ({ id: m, generation: 'g' })), ...url === undefined ? {} : { repository: { machineId: MAC.ann, cwd: '/x', repositoryUrl: url } } })
  await db.swarmHead.create({ data: { id: `${tabId}:head`, tabId, key: 'head', version: 1, changedAt: new Date(clock.now), ordinal: 0,
    data: { name: 'Lampos', projects: [project('web', 'public', 'https://github.com/acme/web'), project('api', 'public', 'git@github.com:acme/api.git'),
      project('secret', 'private', 'https://github.com/acme/secret', [owner.sub]), project('docs', 'public', null), { ...project('plain', 'public', null), repository: undefined }] } } })
  await db.swarmMember.createMany({ data: [memberRow(tabId, owner), memberRow(tabId, ann, 'Ann Lee'), memberRow(tabId, bob), memberRow(tabId, cy)] })
  await db.swarmAgent.createMany({ data: [agentRow(tabId, 'atlas', 'Atlas', ann, MAC.ann), agentRow(tabId, 'nova', 'Nova', ann, MAC.ann),
    agentRow(tabId, 'gone', 'Gone', ann, MAC.ann, true), agentRow(tabId, 'orion', 'Orion', bob, MAC.bob), agentRow(tabId, 'echo', 'Echo', cy, MAC.cy)] })
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
const row = (agentId: string, weeks: Array<{ week: number } & Counts>, from = THIS() - W, name = nameOf(agentId)): Reading => ({ agentId, name, from, weeks })

beforeAll(async () => { tab = await scene() })
beforeEach(() => { clock.now = START })

describe('what a daemon is told to read', () => {
  it('names the person\'s agents on that machine and the repositories of the projects they read, once each', async () => {
    const { status, body } = await targets(MAC.ann)
    expect(status).toBe(200)
    expect(body.data.swarms).toEqual([{ tabId: tab, repositories: ['acme/api', 'acme/web'],
      agents: [{ id: 'atlas', name: 'Atlas', from: THIS() - 4 * W }, { id: 'nova', name: 'Nova', from: THIS() - 4 * W }] }])
  })

  it('tells a person of a private project\'s repository only when they read the project', async () => {
    const mine = await targets(MAC.ann, ann)
    expect(mine.body.data.swarms[0].repositories).not.toContain('acme/secret')
    await db.swarmAgent.create({ data: agentRow(tab, 'owl', 'Owl', owner, MAC.owner) })
    await db.superTab.update({ where: { id: tab }, data: { machineIds: [MAC.ann, MAC.bob, MAC.cy, MAC.owner] } })
    const theirs = await targets(MAC.owner, owner)
    expect(theirs.body.data.swarms[0].repositories).toEqual(['acme/api', 'acme/secret', 'acme/web'])
    await db.swarmAgent.delete({ where: { id: `${tab}:owl` } })
    await db.superTab.update({ where: { id: tab }, data: { machineIds: [MAC.ann, MAC.bob, MAC.cy] } })
  })

  // As the Swarm decides who reads a project (projects.ts personReadsProject): a listing or an ownership from an earlier membership is
  // not this one's. Someone removed and invited back reads none of what they read before, its repository's name too. A project
  // that says no visibility is not public.
  it('tells a person who came back of no private project they read or owned at an earlier membership', async () => {
    const t = await scene()
    const head = await db.swarmHead.findUniqueOrThrow({ where: { id: `${t}:head` } })
    const data = head.data as { projects: Array<Record<string, unknown>> }
    const earlier = (id: string, url: string, extra: Record<string, unknown>) => ({ id, name: id, ownerId: owner.sub, visibility: 'private',
      members: [], repository: { machineId: MAC.ann, cwd: '/x', repositoryUrl: url }, ...extra })
    data.projects.push(earlier('listed', 'https://github.com/acme/listed', { members: [{ id: ann.sub, generation: 'before' }] }),
      earlier('owned', 'https://github.com/acme/owned', { ownerId: ann.sub, ownerGeneration: 'before' }),
      earlier('now', 'https://github.com/acme/now', { members: [{ id: ann.sub, generation: 'g' }] }),
      earlier('mine', 'https://github.com/acme/mine', { ownerId: ann.sub, ownerGeneration: 'g' }),
      earlier('unsure', 'https://github.com/acme/unsure', { visibility: undefined }))
    await db.swarmHead.update({ where: { id: head.id }, data: { data: data as never } })
    const told = async () => (await targets(MAC.ann, ann)).body.data.swarms.find((s: { tabId: string }) => s.tabId === t)?.repositories
    expect(await told()).toEqual(['acme/api', 'acme/mine', 'acme/now', 'acme/web'])
    // Without a member row (a removal whose index has not caught up), nothing: as for every project the Swarm decides.
    await db.swarmMember.update({ where: { id: `${t}:${ann.sub}` }, data: { deleted: true } })
    expect(await told()).toBeUndefined()
  })

  // A Personal Swarm's project made from a pane's folder has no address to clone, only the GitHub repository Desktop named for it
  // (project.github): its ships count as a cloned project's do, and a private one only for its readers, as every project. A name in
  // another case than another project's address is that repository, read once.
  it('names the GitHub repository a project was given when its folder has no address', async () => {
    const t = await scene()
    const head = await db.swarmHead.findUniqueOrThrow({ where: { id: `${t}:head` } })
    const data = head.data as { projects: Array<Record<string, unknown>> }
    const named = (id: string, githubRepository: string, extra: Record<string, unknown> = {}) => ({ id, name: id, ownerId: owner.sub, visibility: 'public',
      members: [], repository: { machineId: MAC.ann, cwd: `/panes/${id}`, repositoryUrl: null }, githubRepository, ...extra })
    data.projects.push(named('pane', 'acme/pane'), named('bare', 'acme/bare', { repository: undefined }), named('again', 'Acme/Web'),
      named('hidden', 'acme/hidden', { visibility: 'private' }))
    await db.swarmHead.update({ where: { id: head.id }, data: { data: data as never } })
    expect((await targets(MAC.ann, ann)).body.data.swarms.find((s: { tabId: string }) => s.tabId === t)?.repositories)
      .toEqual(['acme/api', 'acme/bare', 'acme/pane', 'acme/web'])
  })

  it('tells nothing of another person\'s agents, another machine, a removed agent or a Swarm the person is not in', async () => {
    expect((await targets(MAC.bob, ann)).body.data.swarms).toEqual([])
    expect((await targets(MAC.ann, bob)).body.data.swarms).toEqual([])
    expect((await targets(MAC.ann, outsider)).body.data.swarms).toEqual([])
    expect((await targets(MAC.elsewhere, ann)).body.data.swarms).toEqual([])
    expect((await targets(MAC.ann)).body.data.swarms[0].agents.map((a: { id: string }) => a.id)).not.toContain('gone')
  })

  it('starts a reading where the last one is settled', async () => {
    const t = await scene()
    await report(MAC.ann, [row('atlas', [{ week: THIS(), P2: 1 }])], ann, t)
    const { body } = await get(`/api/super-tabs/hosts/${MAC.ann}/shipping`)
    const mine = body.data.swarms.find((s: { tabId: string }) => s.tabId === t).agents
    expect(mine).toEqual([{ id: 'atlas', name: 'Atlas', from: THIS() - W }, { id: 'nova', name: 'Nova', from: THIS() - 4 * W }])
  })
})

describe('a report', () => {
  it('is counted in the weekly and the all-time board, by the points of each agent', async () => {
    const t = await scene()
    // Atlas shipped a P1 and a P2 this week (weighs 6); Nova a P3 last week (1); Bob's Orion a P0 this week (8).
    expect((await report(MAC.ann, [row('atlas', [{ week: THIS(), P1: 1, P2: 1 }]), row('nova', [{ week: THIS() - W, P3: 1 }])], ann, t)).body.data).toEqual({ applied: 2, skipped: 0, capped: 0 })
    expect((await report(MAC.bob, [row('orion', [{ week: THIS(), P0: 1 }])], bob, t)).body.data).toEqual({ applied: 1, skipped: 0, capped: 0 })

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
    await report(MAC.ann, [once], ann, t)
    await report(MAC.ann, [once], ann, t)
    expect((await board('?all=1', ann, t)).body.data.people[0]).toMatchObject({ agentsShipping: 1, points: 3 })
    // Both of this week's issues were reverted, and last week's stays.
    await report(MAC.ann, [row('atlas', [{ week: THIS() - W, P3: 1 }])], ann, t)
    expect((await board('', ann, t)).body.data.people).toEqual([])
    expect((await board('?all=1', ann, t)).body.data.people[0]).toMatchObject({ agentsShipping: 1, points: 1 })
    expect(await db.swarmShipping.count({ where: { tabId: t, agentId: 'atlas', week: THIS() } })).toBe(0)
  })

  it('is skipped for an agent that is not the sender\'s, not on that machine, or not there', async () => {
    const t = await scene()
    const reading = row('atlas', [{ week: THIS(), P0: 1 }])
    expect((await report(MAC.ann, [reading], bob, t)).body.data).toEqual({ applied: 0, skipped: 1, capped: 0 })
    expect((await report(MAC.bob, [reading], ann, t)).body.data).toEqual({ applied: 0, skipped: 1, capped: 0 })
    expect((await report(MAC.ann, [row('gone', [{ week: THIS(), P0: 1 }]), row('nobody', [{ week: THIS(), P0: 1 }])], ann, t)).body.data).toEqual({ applied: 0, skipped: 2, capped: 0 })
    expect((await board('?all=1', ann, t)).body.data.people).toEqual([])
  })

  it('is refused for a Swarm the sender is not in, in the one answer a missing one gets', async () => {
    const t = await scene()
    const refused = await report(MAC.ann, [row('atlas', [{ week: THIS(), P0: 1 }])], outsider, t)
    const missing = await report(MAC.ann, [row('atlas', [{ week: THIS(), P0: 1 }])], ann, 'tab-missing')
    expect([refused.status, missing.status]).toEqual([404, 404])
    expect(refused.body.error).toEqual(missing.body.error)
  })

  it('is refused when it cannot be right: a week that is no Monday, one ahead, a week before the reading started, counts over the cap, none named', async () => {
    const t = await scene()
    const bad = async (agents: unknown[]) => (await report(MAC.ann, agents, ann, t)).status
    expect(await bad([row('atlas', [{ week: THIS() + 1, P0: 1 }])])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS() + W, P0: 1 }])])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS() - W, P0: 1 }], THIS() - W + 1)])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS() - 20 * W, P0: 1 }], THIS() - 20 * W)])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS() - 2 * W, P0: 1 }], THIS() - W)])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS(), P0: 1001 }])])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS(), P0: -1 }])])).toBe(400)
    expect(await bad([row('atlas', [{ week: THIS(), P0: 1 }, { week: THIS(), P1: 1 }])])).toBe(400)
    expect(await bad([])).toBe(400)
    expect(await bad(Array.from({ length: 51 }, (_, i) => row(`a${i}`, [])))).toBe(400)
    expect(await bad([{ agentId: 'atlas', failed: 'NOT_A_CODE' }])).toBe(400)
    expect(await db.swarmShipping.count({ where: { tabId: t } })).toBe(0)
  })

  it('keeps five weeks of rows, every week in the all-time row, and starts the next reading where a revert can still land', async () => {
    const t = await scene()
    for (let i = 0; i < 8; i++) {
      clock.now = START + i * W
      const read = i === 0 ? row('atlas', [{ week: THIS(), P3: 1 }], THIS() - 4 * W) : row('atlas', [{ week: THIS() - W, P3: 1 }, { week: THIS(), P3: 1 }])
      expect((await report(MAC.ann, [read], ann, t)).body.data.applied).toBe(1)
    }
    const weeks = (await db.swarmShipping.findMany({ where: { tabId: t, agentId: 'atlas' }, orderBy: { week: 'asc' } })).map(r => r.week)
    expect(weeks).toEqual([0, ...[3, 4, 5, 6, 7].map(i => weekStart(Date.UTC(2026, 10, 11, 12)) + i * W)])
    // Eight weeks of one P3 each: weighs 8 over all time, and 1 in the week.
    expect((await board('?all=1', ann, t)).body.data.people[0]).toMatchObject({ agentsShipping: 1, points: 2.8 })
    expect((await board('', ann, t)).body.data.people[0]).toMatchObject({ agentsShipping: 1, points: 1 })
    const { body } = await get(`/api/super-tabs/hosts/${MAC.ann}/shipping`)
    expect(body.data.swarms.find((s: { tabId: string }) => s.tabId === t).agents[0].from).toBe(THIS() - W)
  })

  it('counts a long backfill once, and never again for a week the reading has settled', async () => {
    const t = await scene()
    const backfill = row('atlas', [{ week: THIS() - 4 * W, P2: 3 }, { week: THIS() - 2 * W, P2: 1 }, { week: THIS(), P3: 1 }], THIS() - 4 * W)
    await report(MAC.ann, [backfill], ann, t)
    await report(MAC.ann, [backfill], ann, t)
    // 3 and 1 P2 and a P3 weigh 6 + 2 + 1 = 9: three points.
    expect((await board('?all=1', ann, t)).body.data.people[0]).toMatchObject({ points: 3 })
    // A stale reading from before the settled week cannot change what is settled.
    await report(MAC.ann, [row('atlas', [{ week: THIS() - 4 * W, P0: 9 }, { week: THIS(), P3: 1 }], THIS() - 4 * W)], ann, t)
    expect((await board('?all=1', ann, t)).body.data.people[0]).toMatchObject({ points: 3 })
  })
})

describe('a failed reading', () => {
  it('is shown to its person alone, and cleared by the next good report', async () => {
    const t = await scene()
    await report(MAC.ann, [row('atlas', [{ week: THIS(), P2: 1 }])], ann, t)
    expect((await report(MAC.ann, [{ agentId: 'atlas', failed: 'GH_SIGNED_OUT' }, { agentId: 'nova', failed: 'RATE_LIMITED' }], ann, t)).body.data).toEqual({ applied: 2, skipped: 0, capped: 0 })
    const own = (await board('', ann, t)).body.data
    expect(own.failures).toEqual([{ machineId: MAC.ann, code: 'GH_SIGNED_OUT' }, { machineId: MAC.ann, code: 'RATE_LIMITED' }])
    expect((await board('', bob, t)).body.data.failures).toEqual([])
    // The numbers it had stay.
    expect(own.people[0]).toMatchObject({ personId: ann.sub, points: 1.4 })
    await report(MAC.ann, [row('atlas', [{ week: THIS(), P2: 1 }]), row('nova', [])], ann, t)
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
    await report(MAC.ann, [row('atlas', [{ week: THIS(), P2: 1 }])], ann, t)
    await report(MAC.bob, [row('orion', [{ week: THIS(), P2: 1 }])], bob, t)
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
    for (const t of [gone, kept]) await report(MAC.ann, [row('atlas', [{ week: THIS(), P2: 1 }])], ann, t)
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
      await db.swarmAgent.create({ data: agentRow(t, `bulk${i}`, `Bulk${i}`, ann, MAC.ann) })
      await db.swarmShipping.createMany({ data: [{ id: `${t}:bulk${i}:${THIS() - 2 * W}`, tabId: t, agentId: `bulk${i}`, week: THIS() - 2 * W, personId: ann.sub, shipped: [0, 0, 1, 0, 0] }] })
    }
    await report(MAC.ann, [row('atlas', [{ week: THIS(), P2: 1 }])], ann, t)
    const entries = await profiled(db, async () => {
      await board('', ann, t)
      await board('?all=1', ann, t)
      await report(MAC.ann, [row('atlas', [{ week: THIS(), P1: 1 }])], ann, t)
      await targets(MAC.ann)
    })
    const shipping = entries.filter(e => e.ns.endsWith('.SwarmShipping'))
    expect(shipping.length).toBeGreaterThan(0)
    for (const entry of shipping) {
      expect(entry.planSummary ?? '', JSON.stringify(entry.command)).toMatch(/IXSCAN|EXPRESS|IDHACK|EOF/)
      // Thirty other rows of the Swarm sit in another week: a read that did not use the week's index would examine them.
      expect(entry.docsExamined ?? 0, JSON.stringify(entry.command)).toBeLessThanOrEqual(Math.max(entry.nreturned ?? 0, 3))
    }
    // The Swarm's own collections it reads (access, agents, heads, names) go by index too: never a scan.
    const around = entries.filter(e => /\.(SuperTab|SwarmAgent|SwarmHead|SwarmMember)$/.test(e.ns))
    expect(new Set(around.map(e => e.ns.split('.').at(-1)))).toEqual(new Set(['SuperTab', 'SwarmAgent', 'SwarmHead', 'SwarmMember']))
    for (const entry of around) expect(entry.planSummary ?? '', JSON.stringify(entry.command)).toMatch(/IXSCAN|EXPRESS|IDHACK/)
    expect(reads(entries, 'SwarmShipping', ['tabId', 'week']).length).toBeGreaterThan(0)
    expect(plan(reads(entries, 'SwarmShipping', ['tabId', 'week'])).every(p => /IXSCAN/.test(p.plan ?? ''))).toBe(true)
  })
})

describe('trying to break it', () => {
  const points = async (t: string, query = '?all=1', as: AuthUser = ann) => (await board(query, as, t)).body.data.people.find((p: { personId: string }) => p.personId === ann.sub)?.points

  it('cuts a week that claims more than an agent can have shipped, highest priorities first, and says so', async () => {
    const t = await scene()
    const farm = row('atlas', [{ week: THIS(), P0: 500, P3: 500 }])
    expect((await report(MAC.ann, [farm], ann, t)).body.data).toEqual({ applied: 1, skipped: 0, capped: 1 })
    // 12 hotfixes weigh 96 and 4 chores fill the 100: a week is worth ten points at most.
    expect(await db.swarmShipping.findUnique({ where: { id: `${t}:atlas:${THIS()}` } })).toMatchObject({ shipped: [12, 0, 0, 4, 0] })
    expect(await points(t, '')).toBe(10)
    expect((await report(MAC.ann, [farm], ann, t)).body.data.capped).toBe(1)
    expect(await points(t)).toBe(10)
  })

  it('rewards a second agent\'s first ship above the first agent\'s tenth, whatever the weeks', async () => {
    const t = await scene()
    const ships = (n: number) => row('atlas', [{ week: THIS(), P3: n }])
    await report(MAC.ann, [ships(9)], ann, t)
    const nine = await points(t)
    await report(MAC.ann, [ships(10)], ann, t)
    const tenth = await points(t) - nine
    await report(MAC.ann, [ships(10), row('nova', [{ week: THIS(), P3: 1 }])], ann, t)
    expect([nine, Math.round(tenth * 10) / 10, Math.round(await points(t) - nine - tenth)]).toEqual([3, 0.2, 1])
  })

  it('keeps a deleted agent\'s history on the board and takes no more reports for it', async () => {
    const t = await scene()
    await report(MAC.ann, [row('atlas', [{ week: THIS(), P2: 1 }])], ann, t)
    await db.swarmAgent.update({ where: { id: `${t}:atlas` }, data: { deleted: true } })
    expect(await points(t, '')).toBe(1.4)
    expect(await points(t)).toBe(1.4)
    expect((await report(MAC.ann, [row('atlas', [])], ann, t)).body.data).toEqual({ applied: 0, skipped: 1, capped: 0 })
    expect(await points(t)).toBe(1.4)
    expect((await targets(MAC.ann)).body.data.swarms.find((x: { tabId: string }) => x.tabId === t).agents.map((a: { id: string }) => a.id)).toEqual(['nova'])
  })

  it('keeps two people\'s agents of one name apart: each is credited for what it reported itself', async () => {
    const t = await scene()
    await db.swarmAgent.create({ data: agentRow(t, 'atlas-bob', 'Atlas', bob, MAC.bob) })
    await report(MAC.ann, [row('atlas', [{ week: THIS(), P2: 1 }])], ann, t)
    await report(MAC.bob, [row('atlas-bob', [{ week: THIS(), P2: 3 }], THIS() - W, 'Atlas')], bob, t)
    const people = (await board('', cy, t)).body.data.people
    expect(people.map((p: { personId: string; points: number }) => [p.personId, p.points])).toEqual([[bob.sub, 2.4], [ann.sub, 1.4]])
    // Ann cannot report Bob's agent as hers, nor name it.
    expect((await report(MAC.ann, [row('atlas-bob', [{ week: THIS(), P2: 9 }], THIS() - W, 'Atlas')], ann, t)).body.data.skipped).toBe(1)
    expect((await board('', cy, t)).body.data.people.map((p: { points: number }) => p.points)).toEqual([2.4, 1.4])
  })

  it('shares a rank between people with the same points, as shown', async () => {
    const t = await scene()
    await report(MAC.ann, [row('atlas', [{ week: THIS(), P2: 2 }])], ann, t)
    await report(MAC.bob, [row('orion', [{ week: THIS(), P1: 1 }])], bob, t)
    expect((await board('', cy, t)).body.data.people.map((p: { personId: string; rank: number; points: number }) => [p.personId, p.rank, p.points]))
      .toEqual([[ann.sub, 1, 2], [bob.sub, 1, 2]])
  })

  it('keeps the weeks before a rename: the new name\'s reading cannot unmake what carried the old one', async () => {
    const t = await scene()
    await report(MAC.ann, [row('atlas', [{ week: THIS() - 2 * W, P2: 4 }, { week: THIS() - W, P2: 2 }, { week: THIS(), P2: 1 }], THIS() - 4 * W)], ann, t)
    expect(await points(t)).toBe(3.7)
    // Renamed: its reading under the new label found nothing last week, which its issues never carried.
    const renamed = row('atlas', [{ week: THIS(), P2: 1 }], THIS() - W, 'Atlas Prime')
    await report(MAC.ann, [renamed], ann, t)
    await report(MAC.ann, [renamed], ann, t)
    expect(await points(t)).toBe(3.7)
    expect((await targets(MAC.ann)).body.data.swarms.find((x: { tabId: string }) => x.tabId === t).agents[0]).toEqual({ id: 'atlas', name: 'Atlas', from: THIS() })
    // The same name in another case is no rename.
    await report(MAC.ann, [row('atlas', [{ week: THIS(), P2: 1 }], THIS(), 'ATLAS PRIME')], ann, t)
    expect(await db.swarmShipping.findUnique({ where: { id: `${t}:atlas:0` } })).toMatchObject({ settled: THIS(), name: 'ATLAS PRIME' })
  })

  it('catches up after lost reports: the next reading starts where the settled weeks end', async () => {
    const t = await scene()
    await report(MAC.ann, [row('atlas', [{ week: THIS(), P2: 1 }], THIS() - 4 * W)], ann, t)
    // Three weeks go by without a report arriving.
    clock.now += 3 * W
    const from = (await targets(MAC.ann)).body.data.swarms.find((x: { tabId: string }) => x.tabId === t).agents[0].from
    expect(from).toBe(THIS() - 4 * W)
    expect((await report(MAC.ann, [row('atlas', [{ week: THIS() - 3 * W, P2: 1 }, { week: THIS() - 2 * W, P2: 2 }, { week: THIS() - W, P2: 2 }, { week: THIS(), P2: 1 }], from)], ann, t)).body.data.applied).toBe(1)
    expect(await points(t)).toBe(3.5)
  })

  it('leaves a week open to a revert for an hour past its seventh day, so a reading begun before midnight still lands', async () => {
    const t = await scene()
    const base = THIS(), monday = base + W
    const settledAfter = async (now: number) => {
      clock.now = now
      await report(MAC.ann, [row('atlas', [{ week: THIS(), P2: 1 }], THIS())], ann, t)
      return (await targets(MAC.ann)).body.data.swarms.find((x: { tabId: string }) => x.tabId === t).agents[0].from
    }
    // Sunday 23:59 and Monday 00:01: the week before is still open; at 01:01 it is final.
    expect(await settledAfter(monday - 60_000)).toBe(base - W)
    expect(await settledAfter(monday + 60_000)).toBe(base - W)
    expect(await settledAfter(monday + 61 * 60_000)).toBe(base)
  })

  it('cannot be undone by an old copy of a report for what is settled, and the next real report mends the open weeks', async () => {
    const t = await scene()
    const first = row('atlas', [{ week: THIS() - 4 * W, P2: 5 }, { week: THIS(), P2: 1 }], THIS() - 4 * W)
    await report(MAC.ann, [first], ann, t)
    clock.now += 2 * W
    const real = row('atlas', [{ week: THIS() - W, P2: 3 }, { week: THIS(), P2: 1 }], THIS() - W)
    await report(MAC.ann, [real], ann, t)
    const settled = await points(t)
    // The copy of the first report arrives late: the settled weeks stay, the open ones read as that copy left them.
    await report(MAC.ann, [row('atlas', [{ week: THIS() - 4 * W, P2: 9 }], THIS() - 4 * W)], ann, t)
    expect(await points(t)).toBeLessThan(settled)
    expect(await points(t)).toBeGreaterThan(2)
    await report(MAC.ann, [real], ann, t)
    expect(await points(t)).toBe(settled)
  })

  it('is not moved by a report for a week the server has not reached, whatever a clock says', async () => {
    const t = await scene()
    expect((await report(MAC.ann, [row('atlas', [{ week: THIS() + W, P0: 1 }], THIS() + W)], ann, t)).status).toBe(400)
    expect(await db.swarmShipping.count({ where: { tabId: t } })).toBe(0)
  })
})

describe('what the review of this pull request found', () => {
  const points = async (t: string, query = '?all=1', as: AuthUser = ann) => (await board(query, as, t)).body.data.people.find((p: { personId: string }) => p.personId === as.sub)?.points

  it('keeps the open weeks of an agent that was away, whatever another agent\'s reports sweep, and counts them once when it returns', async () => {
    const t = await scene(), base = THIS()
    // Atlas reports its week and the week before; its machine then goes quiet while Bob's Orion keeps reporting for six weeks.
    await report(MAC.ann, [row('atlas', [{ week: base - W, P2: 2 }, { week: base, P2: 3 }])], ann, t)
    expect(await points(t)).toBe(3.2)
    for (let i = 1; i <= 6; i++) {
      clock.now = START + i * W
      await report(MAC.bob, [row('orion', [{ week: THIS(), P3: 1 }])], bob, t)
    }
    const atlasRows = async () => (await db.swarmShipping.findMany({ where: { tabId: t, agentId: 'atlas' }, orderBy: { week: 'asc' } })).map(r => r.week)
    expect(await atlasRows()).toEqual([0, base - W, base])
    // It comes back: the next reading starts where it was settled, and the two weeks it had are counted once.
    const from = (await targets(MAC.ann)).body.data.swarms.find((x: { tabId: string }) => x.tabId === t).agents[0].from
    expect(from).toBe(base - W)
    await report(MAC.ann, [row('atlas', [{ week: base - W, P2: 2 }, { week: base, P2: 3 }], from)], ann, t)
    expect(await points(t)).toBe(3.2)
    expect(await atlasRows()).toEqual([0])
  })

  it('lands a report whose reading began 8 weeks before the Monday it was told on, now that Monday has passed', async () => {
    const t = await scene(), base = THIS()
    await report(MAC.ann, [row('atlas', [{ week: base, P2: 1 }])], ann, t)
    clock.now = base + 40 * W - 60_000
    const from = (await targets(MAC.ann)).body.data.swarms.find((x: { tabId: string }) => x.tabId === t).agents[0].from
    expect(from).toBe(base + 31 * W)
    clock.now += 120_000
    expect((await report(MAC.ann, [row('atlas', [], from)], ann, t)).status).toBe(200)
    expect((await report(MAC.ann, [row('atlas', [], from - W)], ann, t)).status).toBe(400)
  })

  it('shows a failure to the person it was reported for, for six hours after it was last reported', async () => {
    const t = await scene()
    await report(MAC.ann, [{ agentId: 'atlas', failed: 'GH_SIGNED_OUT' }], ann, t)
    expect((await board('', ann, t)).body.data.failures).toEqual([{ machineId: MAC.ann, code: 'GH_SIGNED_OUT' }])
    clock.now += 6 * 3_600_000 - 1
    expect((await board('', ann, t)).body.data.failures.length).toBe(1)
    clock.now += 2
    expect((await board('', ann, t)).body.data.failures).toEqual([])
    // Reported again, it is shown again; and a row that changed hands shows for whoever reports it now.
    await db.swarmShipping.update({ where: { id: `${t}:atlas:0` }, data: { personId: bob.sub } })
    await report(MAC.ann, [{ agentId: 'atlas', failed: 'RATE_LIMITED' }], ann, t)
    expect((await board('', ann, t)).body.data.failures).toEqual([{ machineId: MAC.ann, code: 'RATE_LIMITED' }])
    expect((await board('', bob, t)).body.data.failures).toEqual([])
  })

  it('takes the first reading of a whole machine in one go: 50 agents of five weeks', async () => {
    const t = await scene()
    await db.swarmAgent.createMany({ data: Array.from({ length: 50 }, (_, i) => agentRow(t, `big${i}`, `Big${i}`, ann, MAC.ann)) })
    const weeks = (i: number) => [4, 3, 2, 1, 0].map(back => ({ week: THIS() - back * W, P2: 1 + ((i + back) % 3) }))
    const began = performance.now()
    const answer = await report(MAC.ann, Array.from({ length: 50 }, (_, i) => row(`big${i}`, weeks(i), THIS() - 4 * W)), ann, t)
    const ms = Math.round(performance.now() - began)
    expect(answer.body.data).toEqual({ applied: 50, skipped: 0, capped: 0 })
    expect(await db.swarmShipping.count({ where: { tabId: t } })).toBe(50 * 6)
    process.stderr.write(`first report of 50 agents x 5 weeks: ${ms} ms\n`)
    expect(ms).toBeLessThan(10_000)
  })
})

describe('a Swarm of 10,000 agents', () => {
  it('sums in one pass, lists the first 200 people and the reader below them, and says how long it took', async () => {
    const t = `tab-${randomUUID()}`, PEOPLE = 500, PER = 20
    const ids = Array.from({ length: PEOPLE }, (_, i) => `big-${i}-id`)
    await db.superTab.create({ data: { id: t, ownerId: ids[0]!, autonomousEnv: 'prod', memberIds: [...ids, ann.sub, cy.sub], invitedEmails: [], machineIds: [], format: 2, state: { version: 2 } } })
    await db.swarmMember.createMany({ data: ids.map((id, i) => ({ id: `${t}:${id}`, tabId: t, key: id, version: 1, changedAt: new Date(clock.now), ordinal: i,
      data: { id, email: `big${i}@example.com`, role: 'member', generation: 'g' } })) })
    // 500 people with 20 agents each, every agent shipping something; Cy, who reads, has one agent that shipped one chore: last.
    const rows = [...ids.flatMap((personId, p) => Array.from({ length: PER }, (_, a) => ({ personId, agentId: `a${p}-${a}`, shipped: [0, 0, 1 + ((p + a) % 5), 0, 0] }))),
      { personId: cy.sub, agentId: 'cy-1', shipped: [0, 0, 0, 1, 0] }]
    for (let from = 0; from < rows.length; from += 2_000) {
      await db.swarmShipping.createMany({ data: rows.slice(from, from + 2_000).flatMap(r => [
        { id: `${t}:${r.agentId}:${THIS()}`, tabId: t, agentId: r.agentId, week: THIS(), personId: r.personId, shipped: r.shipped },
        { id: `${t}:${r.agentId}:0`, tabId: t, agentId: r.agentId, week: 0, personId: r.personId, shipped: r.shipped, settled: THIS() - W }]) })
    }
    const timed = async (query: string, as: AuthUser) => { const began = performance.now(); const { status, body } = await board(query, as, t); return { status, body, ms: Math.round(performance.now() - began) } }
    await timed('', cy)
    const week = await timed('', cy), all = await timed('?all=1', cy), other = await timed('', ann)
    process.stderr.write(`10,000 agents (500 people): week ${week.ms} ms, all time ${all.ms} ms, ${JSON.stringify(week.body.data).length} bytes\n`)
    for (const { status, body } of [week, all]) {
      expect(status).toBe(200)
      expect(body.data.people.length).toBe(201)
      expect(body.data.people[0].rank).toBe(1)
      expect(body.data.people[200]).toMatchObject({ personId: cy.sub, rank: 501, agentsShipping: 1, points: 1 })
    }
    // A reader who is not ranked sees the first 200 and no row of their own.
    expect(other.body.data.people.length).toBe(200)
    // The limit is 100 ms (AGENTS.md): measured at 50 to 110 ms on a Mac at load 11 to 25 under nice, and well below on a quiet one. This
    // only catches a read that has stopped being one pass, without failing on a busy runner.
    expect(week.ms).toBeLessThan(250)
    expect(all.ms).toBeLessThan(250)
  }, 120_000)
})
