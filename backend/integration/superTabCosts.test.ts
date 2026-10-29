import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import type { MachineObservation } from '../src/superTabs/machines.js'
import type { TokensByModel } from '../src/superTabs/costs/tokens.js'
import { poolRows } from './hostRows.test-support.js'

// Each attempt keeps what it ran on, how it was paid and its tokens on its route decision, however it ends (Dee, 2026-10-29).
// A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '300000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '300000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MINUTE = 60_000
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
  const add = async (conversationId: string, machineId: string, harnessId: string, name: string, lead = false) => String((await execute({ type: 'agent.add',
    conversationId, machineId, harnessId, name, configuration: config, lead })).result.agentId)
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
  const assign = async (routeDecisionId: string) => String((await execute({ type: 'work.assign', conversationId: group, agentId: worker, routeDecisionId } as Command,
    host, lead)).result.assignmentId)
  const finish = async (assignmentId: string) => {
    const checkId = (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!.checks[0]!.id
    await execute({ type: 'work.check', conversationId: group, assignmentId, checkId, passed: true, evidence: 'npm test, 0 failures' } as Command, host, worker)
    await execute({ type: 'work.status', conversationId: group, assignmentId, status: 'done', result: 'Shipped.' } as Command, host, worker)
  }
  const decision = (id: string) => db.superTabRouteDecision.findUniqueOrThrow({ where: { id } })
  return { store, tab, execute, lead, group, worker, harness, observe, beat, route, assign, finish, decision,
    clock: { get now() { return now }, set now(value: number) { now = value } } }
}

describe('an attempt’s record on its route decision', () => {
  it('keeps the kind, what ran, how it was paid and the session totals at its start and end, and closes done', async () => {
    const f = await swarm()
    await f.beat(opus(1000, 100))
    const id = await f.route()
    const assignmentId = await f.assign(id)
    const started = f.clock.now
    expect((await f.decision(id)).run).toEqual({ machineId: 'test-host', harnessId: f.harness.worker, engine: 'claude', model: 'opus', effort: 'high',
      billing: 'subscription', startedAt: started, start: opus(1000, 100) })
    f.clock.now += MINUTE
    await f.beat(opus(5000, 900))
    await f.finish(assignmentId)
    const row = await f.decision(id)
    expect(row).toMatchObject({ assignmentId, outcome: 'done', record: { assessment: { kind: 'parser' } },
      run: { startedAt: started, start: opus(1000, 100), endedAt: f.clock.now, end: opus(5000, 900) } })
  })

  it('closes lost when its machine goes silent, and stays lost when the task is handed on', async () => {
    const f = await swarm()
    await f.beat(opus(10, 1))
    const id = await f.route()
    await f.assign(id)
    await f.beat(opus(70, 7))
    const silent = f.clock.now
    f.clock.now = silent + 2 * MINUTE + 5_000
    await f.observe('lead-host', [f.harness.lead])
    expect(await f.decision(id)).toMatchObject({ outcome: 'lost', outcomeAt: new Date(f.clock.now), run: { end: opus(70, 7), endedAt: f.clock.now } })
    // Handing it on keeps it lost: the hand-over is a new attempt with its own decision.
    await f.observe('test-host', [f.harness.worker])
    const next = await f.route()
    expect((await f.decision(id)).outcome).toBe('lost')
    await f.assign(next)
    expect((await f.decision(next)).run).toMatchObject({ startedAt: f.clock.now })
  })

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

describe('the cost summary', () => {
  it('shows a finished attempt by engine, model, effort and kind with its tokens, API-equivalent cost and spend', async () => {
    const f = await swarm()
    await f.beat(opus(1_000_000, 100_000))
    const assignmentId = await f.assign(await f.route('parser'))
    // Twelve minutes of work, its machine reporting every minute as it does every 15 seconds.
    for (let minute = 0; minute < 12; minute++) {
      f.clock.now += MINUTE
      await f.beat(opus(3_000_000, 600_000))
    }
    await f.finish(assignmentId)
    const summary = await f.store.costSummary(owner, f.tab, 7)
    // 2M input at $4 and 0.5M output at $20 per million: $18, on a plan, so nothing spent per token.
    expect(summary.rows).toEqual([expect.objectContaining({ engine: 'claude', model: 'opus', effort: 'high', kind: 'parser', attempts: 1, shipped: 1,
      outcomes: { done: 1 }, billing: { subscription: 1 }, medianMinutesToShip: 12, tokensKnown: 1,
      tokens: { input: 2_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 }, apiCost: 18, spend: 0, costKnown: 1, costPerShipped: 18 })])
    expect(summary).toMatchObject({ days: 7, truncated: false, prices: [{ model: 'claude-opus-5-5' }] })
    // The Lead reads it too, as its own agent.
    expect((await f.store.costSummary(host, f.tab, 7, f.lead)).totals).toMatchObject({ attempts: 1, apiCost: 18 })
    // Past the period, nothing.
    f.clock.now += 8 * 24 * 60 * MINUTE
    expect((await f.store.costSummary(owner, f.tab, 7)).rows).toEqual([])
  })
})
