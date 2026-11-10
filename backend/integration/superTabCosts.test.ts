import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import type { MachineObservation } from '../src/superTabs/machines.js'
import type { TokensByModel } from '../src/superTabs/costs/tokens.js'
import { poolRows } from './hostRows.test-support.js'
import { storeAssignment, storeStatus } from './storedWork.test-support.js'
import { profiledReads } from './profiledReads.test-support.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'

// Each attempt keeps what it ran on, how it was paid and its tokens on its route decision, however it ends (Dee, 2026-10-29).
// A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '300000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '300000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const plan = [{ engine: 'claude', known: true, windows: [{ name: '5-hour', usedPercent: 10, resetsAt: null }] }]
const opus = (input: number, output: number): TokensByModel => ({ 'claude-opus-5-5': { input, output, cacheRead: 0, cacheWrite: 0 } })

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_costs_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  for (const machineId of ['lead-host', 'test-host']) {
    await db.machine.create({ data: { machineId, userId: host.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    await db.machineShare.create({ data: { machineId, ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
  }
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm whose Lead routes "Ship the parser" (kind `parser`) to a worker on another of host's machines. */
async function swarm() {
  let now = 10_000_000
  const store = new SuperTabStore(db, () => now, null)
  const tab = (await store.create(owner, randomUUID(), 'Costs', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string) => store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  for (const [machineId, name] of [['lead-host', 'Lead Mac'], ['test-host', 'Worker Mac']]) {
    await execute({ type: 'machine.contribute', machineId: machineId!, name: name!, cwd: '/repo', engines: ['claude'], maxAgents: 4 }, host)
  }
  const generations = new Map<string, string>()
  for (const machineId of ['lead-host', 'test-host']) generations.set(machineId, (await poolRows(store, host, machineId)).find(p => p.tabId === tab)!.machine.generation)
  const harness = { lead: randomUUID(), worker: randomUUID() }
  // Added by the host, whose machines they run on: an agent is its own person's, on their own computer (task #4120).
  const add = async (conversationId: string, machineId: string, harnessId: string, name: string, lead = false) => String((await execute({ type: 'agent.add',
    conversationId, machineId, harnessId, name, configuration: config, lead }, host)).result.agentId)
  const lead = await add('lead', 'lead-host', harness.lead, 'Lead', true)
  const group = String((await execute({ type: 'conversation.create', title: 'Ship the parser', brief: 'Implement it',
    checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
  const worker = await add(group, 'test-host', harness.worker, 'Worker')
  const observe = (machineId: string, running: string[], extra: Partial<MachineObservation> = {}) => store.observeMachine(host, tab, machineId, {
    generation: generations.get(machineId)!, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9,
      diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: plan, tools: {}, runningHarnessIds: running, stoppedHarnessIds: [], ...extra })
  /** Both machines report; the worker's with its session's totals. */
  const beat = async (tokens: TokensByModel) => {
    await observe('lead-host', [harness.lead])
    await observe('test-host', [harness.worker], { harnessTokens: { [harness.worker]: tokens }, harnessProgress: { [harness.worker]: now } })
  }
  const route = async (kind = 'parser') => {
    const decision = { assessment: { difficulty: 'medium', risk: 'low', why: 'Parser work.', size: 'medium', kind },
      candidates: [{ id: 'c0', kind: 'member', agentId: worker, machineId: 'test-host', engine: 'claude', model: 'opus', effort: 'high',
        quality: 3, cost: 3, title: 'Worker', label: 'Worker' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    return String((await execute({ type: 'route.record', conversationId: group, decision } as Command, host, lead)).result.routeDecisionId)
  }
  /** The worker's attempt on [routeDecisionId], done, with its session's totals at [start] and [end], as work.assign and its
   *  Done stored it before Swarm v4 (both gone, 2026-11-10). */
  const finished = async (routeDecisionId: string, start: TokensByModel, end: TokensByModel) => {
    const { id: assignmentId } = await storeAssignment(db, tab, group, worker, now)
    await storeStatus(db, tab, group, 'done', 'Shipped.')
    await db.superTabRouteDecision.update({ where: { id: routeDecisionId }, data: { assignmentId, final: { kind: 'member', agentId: worker, machineId: 'test-host' },
      outcome: 'done', outcomeAt: new Date(now), run: { machineId: 'test-host', harnessId: harness.worker, engine: 'claude', model: 'opus', effort: 'high',
        billing: 'subscription', startedAt: now, start, endedAt: now, end } } })
  }
  const decision = (id: string) => db.superTabRouteDecision.findUniqueOrThrow({ where: { id } })
  return { store, tab, execute, lead, group, worker, harness, observe, beat, route, finished, decision,
    clock: { get now() { return now }, set now(value: number) { now = value } } }
}

describe('a machine’s session totals', () => {
  it('never shows the machine’s raw token counts to a reader', async () => {
    const f = await swarm()
    await f.beat(opus(10, 1))
    const machine = (await f.store.read(owner, f.tab)).state.machines!.find(m => m.machineId === 'test-host')!
    expect(machine.observation).toBeDefined()
    expect(machine.observation).not.toHaveProperty('harnessTokens')
    const stored = await db.swarmMachine.findFirstOrThrow({ where: { tabId: f.tab, key: 'test-host' } })
    expect((stored.data as { contribution: { observation: { harnessTokens?: unknown } } }).contribution.observation.harnessTokens).toEqual({ [f.harness.worker]: opus(10, 1) })
  })
})

describe('route decision reads', () => {
  // Review of #2106: members read only the summary, never an attempt's session totals.
  it('never carry an attempt’s run or its token totals, over HTTP or to the Lead, while the summary still has them', async () => {
    const f = await swarm()
    await f.beat(opus(1_000_000, 100_000))
    const id = await f.route()
    await f.finished(id, opus(1_000_000, 100_000), opus(1_000_000, 100_000))
    expect((await f.decision(id)).run).toMatchObject({ start: opus(1_000_000, 100_000) })
    const app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async (request, reply) => {
      const user = [owner, host].find(u => `Bearer ${u.sub}` === request.headers.authorization)
      if (!user) return reply.code(401).send({ success: false })
      request.user = user
    })
    await app.register(superTabRoutes, { store: f.store })
    await app.ready()
    try {
      const get = async (url: string, user = owner) => {
        const response = await app.inject({ url, headers: { authorization: `Bearer ${user.sub}` } })
        expect(response.statusCode, url).toBe(200)
        return response.json().data
      }
      const list = await get(`/api/super-tabs/${f.tab}/route-decisions`)
      const one = await get(`/api/super-tabs/${f.tab}/route-decisions/${id}`)
      const lead = [...await f.store.routeDecisions(host, f.tab, f.lead), await f.store.routeDecision(host, f.tab, id, f.lead)]
      for (const decision of [...list, one, ...lead]) {
        expect(decision).toMatchObject({ id, outcome: 'done' })
        expect(decision).not.toHaveProperty('run')
        expect(JSON.stringify(decision)).not.toMatch(/cacheRead|1000000/)
      }
      expect((await get(`/api/super-tabs/${f.tab}/costs?days=7`)).totals).toMatchObject({ attempts: 1 })
    } finally { await app.close() }
  })
})

describe('costs and a project\'s GitHub access, read through the read cache (task #2596)', () => {
  /** The part collections' reads MongoDB served while `run` ran, as superTabCache.test.ts counts them. */
  const partReads = <T>(run: () => Promise<T>) => profiledReads(db, /\.Swarm(Head|Member|Agent|Group|Machine|Start|Progress)$/, run)

  it('reads no part at a stamp that did not move, and answers what a read straight from Mongo answers', async () => {
    const f = await swarm()
    await f.beat(opus(1000, 100))
    await f.finished(await f.route(), opus(1000, 100), opus(7000, 1200))
    const direct = new SuperTabStore(db, () => f.clock.now, null, { readCache: null })
    for (const [name, read] of [['costs', (store: SuperTabStore) => store.costSummary(owner, f.tab, 7)],
      ['github', (store: SuperTabStore) => store.projectRepository(owner, f.tab, 'lead')]] as const) {
      await read(f.store)
      const again = await partReads(() => read(f.store))
      expect(again.reads, name).toBe(0)
      expect(again.value, name).toEqual(await read(direct))
    }
    expect((await f.store.costSummary(owner, f.tab, 7)).totals).toMatchObject({ attempts: 1 })
  })
})

describe('a route decision as stored (task #2488)', () => {
  // As production's routes were on 2026-11-03: every engine on every machine, 13 candidates with labels of ~540 characters and
  // 47 exclusions of 5 reasons, ~20 KB a row. The pick is kept whole, of the others who and where they are and their titles (task
  // #2769), and each reason once; readers get every candidate and exclusion back.
  it('keeps the pick whole and each exclusion reason once, and reads back every candidate and exclusion', async () => {
    const f = await swarm()
    const long = (text: string, size: number) => `${text} ${'·'.repeat(Math.max(0, size - text.length - 1))}`
    const fit = { status: 'fits', coverage: 1.5, effectiveCost: 3, expiring: 0, spend: { '5-hour': 30, weekly: 4 }, account: 'k'.repeat(64) }
    const candidates = [
      { id: 'c0', kind: 'member', agentId: f.worker, machineId: 'test-host', engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3,
        title: 'Worker · Claude opus high · Worker Mac', label: long('Worker · strength 3, cost 3 · fits: weekly 4% of 69%', 540), fit },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `c${i + 1}`, kind: 'new', machineId: 'test-host', engine: 'claude', model: `model-${i}`, effort: 'high',
        quality: 2, cost: 2, title: `New agent · Claude model-${i} high · Worker Mac`, label: long(`New agent · strength 2, cost 2 · candidate ${i}`, 540), fit })),
    ]
    const reasons = Array.from({ length: 5 }, (_, i) => long(`Reason ${i}: Machine is offline or unreachable, or its engine is suspended.`, 100))
    const excluded = Array.from({ length: 47 }, (_, i) => ({ title: long(`New agent · Codex default default · machine-${i}`, 80), reason: reasons[i % 5]! }))
    const decision = { assessment: { difficulty: 'medium', risk: 'low', why: 'Parser work.', size: 'medium', kind: 'parser' },
      candidates, excluded, floor: 1, notes: false, pick: 'c0', via: 'order', p: null, belowFloor: false, why: 'First by strength.' }
    const id = String((await f.execute({ type: 'route.record', conversationId: f.group, decision } as Command, host, f.lead)).result.routeDecisionId)
    const [sizes] = (await db.$runCommandRaw({ aggregate: 'SuperTabRouteDecision', pipeline: [{ $match: { _id: id } },
      { $project: { stored: { $bsonSize: '$record' }, sent: { $bsonSize: { $literal: decision } } } }], cursor: {} }) as
      { cursor: { firstBatch: Array<{ stored: number; sent: number }> } }).cursor.firstBatch
    expect(sizes!.sent).toBeGreaterThan(19_000)
    expect(sizes!.stored, JSON.stringify(sizes)).toBeLessThan(sizes!.sent * 0.6)
    for (const read of [await f.store.routeDecision(owner, f.tab, id), await f.store.routeDecision(host, f.tab, id, f.lead)]) {
      const record = read.record as unknown as typeof decision
      expect(record.candidates.map(c => c.id)).toEqual(candidates.map(c => c.id))
      expect(record.candidates.map(c => c.label)).toEqual([candidates[0]!.label, ...Array(12).fill(undefined)])
      expect(record.candidates[0]).toEqual(candidates[0])
      expect(record.candidates.slice(1)).toEqual(candidates.slice(1).map(({ label: _l, quality: _q, cost: _c, fit: _f, ...c }) => c))
      expect(record.excluded).toHaveLength(47)
      expect(new Set(record.excluded.map(e => JSON.stringify(e)))).toEqual(new Set(excluded.map(e => JSON.stringify(e))))
      expect(read).not.toHaveProperty('record.unavailable')
    }
  })
})
