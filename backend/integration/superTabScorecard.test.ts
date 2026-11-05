import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { scorecardCache, scorecardPass } from '../src/superTabs/scorecard/job.js'
import { scorecardId } from '../src/superTabs/scorecard/rows.js'
import type { ScorecardFigures } from '../src/superTabs/scorecard/figures.js'
import { planDatabase, profiled } from './plans.test-support.js'

let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
const owner: AuthUser = { sub: '320000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const outsider: AuthUser = { sub: '320000000000000000000002', email: 'outsider@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MIN = 60_000, HOUR = 60 * MIN
/** 2026-11-05 in Vietnam, the project's default zone: 11-04 17:00 UTC to 11-05 17:00 UTC. */
const START = Date.UTC(2026, 10, 4, 17)
const END = START + 24 * HOUR
const at = (hours: number) => START + hours * HOUR
let now = at(0)

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_scorecard_test'))
  for (const user of [owner, outsider]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'host', userId: owner.sub, apiKey: 'fixture-host', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  const store = new SuperTabStore(db, () => now, null)
  app = Fastify()
  app.setErrorHandler(errorHandler)
  app.addHook('onRequest', async (request, reply) => {
    const found = [owner, outsider].find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!found) return reply.code(401).send({ success: false })
    request.user = found
  })
  await app.register(superTabRoutes, { store, github: null, reads: new SwarmReads(store, { now: () => now }) })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm's day: the owner asks twice and corrects the PM once; one task ships, one waits all evening, the PM posts an ack. */
async function day() {
  const store = new SuperTabStore(db, () => now, null)
  const tab = (await store.create(owner, randomUUID(), 'Scorecard', 'public')).id
  // Rows are stamped by the database's clock: each command's rows get the fixture's time instead.
  const execute = async (command: Command, asAgentId?: string) => {
    const began = new Date()
    const { result } = await store.execute(owner, tab, { operationId: randomUUID(), command }, asAgentId)
    await db.superTabMessage.updateMany({ where: { tabId: tab, createdAt: { gte: began } }, data: { createdAt: new Date(now) } })
    return result
  }
  await execute({ type: 'machine.contribute', machineId: 'host', name: 'Mac', cwd: '/repo', engines: ['claude'], maxAgents: 4 } as Command)
  const pm = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: randomUUID(), name: 'River', configuration: config,
    lead: true } as Command)).agentId)
  const post = async (text: string, extra: Record<string, unknown> = {}, asAgentId?: string) =>
    String((await execute({ type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [], ...extra } as Command, asAgentId)).messageId)

  now = at(1)
  const ask = await post('Please add a scorecard.')
  now = at(1) + 10 * MIN
  const answer = await post('I will open a task for it now.', { answers: ask }, pm)
  now = at(2)
  const task = String((await execute({ type: 'conversation.create', title: 'Scorecard', brief: 'Build it.', checks: [] } as Command)).conversationId)
  const worker = String((await execute({ type: 'agent.add', conversationId: task, machineId: 'host', harnessId: randomUUID(), name: 'Tally', configuration: config,
    lead: false } as Command)).agentId)
  now = at(3)
  const assignmentId = String((await execute({ type: 'work.assign', conversationId: task, agentId: worker } as Command)).assignmentId)
  await db.superTabRouteDecision.create({ data: { id: randomUUID(), tabId: tab, conversationId: task, createdAt: new Date(at(3)), record: {} } })
  now = at(4)
  await execute({ type: 'message.send', conversationId: task, text: 'On it.', replyTo: null, recipientIds: [] } as Command, pm)
  now = at(5)
  await execute({ type: 'work.status', conversationId: task, assignmentId, status: 'done', result: 'Shipped.' } as Command, worker)
  now = at(6)
  await execute({ type: 'conversation.create', title: 'Waits all evening', brief: 'Nobody takes it.', checks: [] } as Command)
  now = at(7)
  await post('Can you also check the phone?')
  now = at(8)
  await post('No, I asked for it daily.', { replyTo: answer })
  return { store, tab }
}

describe('the nightly scorecard', () => {
  it('stores each project\'s day once, from the Swarm\'s records, on indexed reads', async () => {
    const f = await day()
    await listNamedIndexes(db)
    now = END + 31 * MIN
    const cache = scorecardCache()
    let pass!: Awaited<ReturnType<typeof scorecardPass>>
    const entries = await profiled(db, async () => { pass = await scorecardPass(db, db, now, undefined, cache) })
    // 11-05 and 11-04, which had nothing: both stored; a later pass stores neither again.
    expect(pass).toMatchObject({ stored: 2, failed: 0, capped: 0 })
    expect(await scorecardPass(db, db, now + 15 * MIN, undefined, cache)).toMatchObject({ stored: 0, failed: 0 })
    expect(await scorecardPass(db, db, now + 15 * MIN, undefined, scorecardCache())).toMatchObject({ stored: 0, already: 2 })

    const row = await db.superTabScorecard.findUnique({ where: { id: scorecardId(f.tab, 'lead', '2026-11-05') } })
    expect(row).toMatchObject({ tabId: f.tab, projectId: 'lead', on: '2026-11-05', timeZone: 'Asia/Ho_Chi_Minh' })
    expect(row!.figures as unknown as ScorecardFigures).toMatchObject({
      asksShipped: 1, askToShipMedianMinutes: 180,
      unansweredAsks: 1, oldestUnansweredAskMinutes: 17 * 60,
      // 02:00-03:00 the task waited for its agent; from 06:00 the second one waits to midnight.
      idleMinutes: 60 + 18 * 60,
      corrections: 1, routeDecisions: 1, ackPosts: 1, agentPosts: 2, lostLeftAlone: 0,
    })
    const empty = await db.superTabScorecard.findUnique({ where: { id: scorecardId(f.tab, 'lead', '2026-11-04') } })
    expect(empty!.figures).toMatchObject({ asksShipped: 0, idleMinutes: 0 })

    // Every read of the pass is served by an index.
    const collections = ['SuperTabMessage', 'SwarmGroup', 'SwarmStart', 'SuperTabRouteDecision', 'SuperTabDelivery', 'SuperTabScorecard']
    expect(entries.filter(e => e.ns.endsWith('.SuperTabMessage')).length).toBeGreaterThan(0)
    const scans = entries.filter(e => collections.some(c => e.ns.endsWith(`.${c}`)) && /COLLSCAN/.test(String(e.planSummary)))
    expect(scans.map(e => ({ ns: e.ns, plan: e.planSummary }))).toEqual([])
  })

  it('serves a project\'s days to who reads it, and to nobody else', async () => {
    const f = await day()
    now = END + 31 * MIN
    await scorecardPass(db, db, now)
    const read = (user: AuthUser) => app.inject({ method: 'GET', url: `/api/super-tabs/${f.tab}/scorecard?projectId=lead`,
      headers: { authorization: `Bearer ${user.sub}` } })
    const mine = await read(owner)
    expect(mine.statusCode).toBe(200)
    const body = mine.json() as { data?: { days: Array<{ on: string }> }; days?: Array<{ on: string }> }
    expect((body.data ?? body).days!.map(d => d.on)).toEqual(['2026-11-05', '2026-11-04'])
    expect((await read(outsider)).statusCode).toBeGreaterThanOrEqual(403)
  })
})
