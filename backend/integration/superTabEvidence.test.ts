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
import { DAY_MS, weekStart } from '../src/superTabs/leaderboard/week.js'
import { EVIDENCE_RETENTION_MS, readEvidence } from '../src/superTabs/evidence/store.js'
import { poolRows } from './hostRows.test-support.js'
import { groupProject } from '../src/superTabs/projects.js'
import { sweepSwarms } from '../src/superTabs/sweeps.js'

// Evidence routing (Ken, 2026-10-29): each Swarm keeps per model and kind of job what its attempts cost and how they went.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '300000000000000000000011', email: 'evidence-owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '300000000000000000000013', email: 'evidence-host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MINUTE = 60_000
const plan = [{ engine: 'claude', known: true, windows: [{ name: '5-hour', usedPercent: 10, resetsAt: null }] }]
const opus = (input: number, output: number): TokensByModel => ({ 'claude-opus-5-5': { input, output, cacheRead: 0, cacheWrite: 0 } })
const TASK_TEXT = 'Replace the zebra-quartz parser'
const T0 = Date.UTC(2026, 9, 6, 9)

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_evidence_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  for (const machineId of ['ev-lead-host', 'ev-test-host']) {
    await db.machine.create({ data: { machineId, userId: host.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    await db.machineShare.create({ data: { machineId, ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
  }
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm whose Lead routes groups that own backend code to workers on host's second machine. */
async function swarm() {
  let now = T0
  const store = new SuperTabStore(db, () => now, null)
  const tab = (await store.create(owner, randomUUID(), 'Evidence', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string) => store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  for (const [machineId, name] of [['ev-lead-host', 'Lead Mac'], ['ev-test-host', 'Worker Mac']]) {
    await execute({ type: 'machine.contribute', machineId: machineId!, name: name!, cwd: '/repo', engines: ['claude'], maxAgents: 8 }, host)
  }
  const generations = new Map<string, string>()
  for (const machineId of ['ev-lead-host', 'ev-test-host']) generations.set(machineId, (await poolRows(store, host, machineId)).find(p => p.tabId === tab)!.machine.generation)
  const leadHarness = randomUUID(), workers = new Map<string, { agentId: string; harness: string }>()
  const add = async (conversationId: string, machineId: string, harnessId: string, name: string, lead = false) => String((await execute({ type: 'agent.add',
    conversationId, machineId, harnessId, name, configuration: config, lead })).result.agentId)
  const lead = await add('lead', 'ev-lead-host', leadHarness, 'Lead', true)
  const observe = (machineId: string, running: string[], extra: Partial<MachineObservation> = {}) => store.observeMachine(host, tab, machineId, {
    generation: generations.get(machineId)!, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9,
      diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: plan, tools: {}, runningHarnessIds: running, stoppedHarnessIds: [], ...extra })
  /** Both machines report; each worker's session with these totals. */
  const beat = async (tokens: TokensByModel) => {
    await observe('ev-lead-host', [leadHarness])
    const harnesses = [...workers.values()].map(w => w.harness)
    await observe('ev-test-host', harnesses, { harnessTokens: Object.fromEntries(harnesses.map(h => [h, tokens])),
      harnessProgress: Object.fromEntries(harnesses.map(h => [h, now])) })
  }
  /** A group that owns backend code, reviewed by an independent check, with its own worker. */
  const group = async (title = TASK_TEXT) => {
    const id = String((await execute({ type: 'conversation.create', title, task: { goal: TASK_TEXT, changes: TASK_TEXT, constraints: 'None',
      owns: ['backend/src/parser'] }, checks: [{ description: 'Reviewed', independent: true }] } as Command)).result.conversationId)
    const harness = randomUUID()
    workers.set(id, { agentId: await add(id, 'ev-test-host', harness, `Worker ${workers.size}`), harness })
    return id
  }
  const worker = (id: string) => workers.get(id)!.agentId
  const route = async (id: string) => {
    const decision = { assessment: { difficulty: 'medium', risk: 'low', why: 'Parser work.', size: 'medium', kind: 'parser' },
      candidates: [{ id: 'c0', kind: 'member', agentId: worker(id), machineId: 'ev-test-host', engine: 'claude', model: 'opus', effort: 'high',
        quality: 3, cost: 3, title: 'Worker', label: 'Worker' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    return String((await execute({ type: 'route.record', conversationId: id, decision } as Command, host, lead)).result.routeDecisionId)
  }
  const assign = async (id: string) => String((await execute({ type: 'work.assign', conversationId: id, agentId: worker(id), routeDecisionId: await route(id) } as Command,
    host, lead)).result.assignmentId)
  /** The owner gives the review's verdict. */
  const review = async (id: string, assignmentId: string, passed: boolean) => {
    const checkId = (await store.read(owner, tab)).state.conversations.find(c => c.id === id)!.checks[0]!.id
    await execute({ type: 'work.check', conversationId: id, assignmentId, checkId, passed, evidence: 'rev abc' } as Command)
  }
  const done = (id: string, assignmentId: string, tokens?: TokensByModel) =>
    execute({ type: 'work.status', conversationId: id, assignmentId, status: 'done', result: 'Shipped.', ...(tokens ? { tokens } : {}) } as Command, host, worker(id))
  const merged = (id: string, pr: string, extra: Record<string, unknown> = {}) =>
    execute({ type: 'conversation.merged', conversationId: id, pullRequestUrl: pr, ...extra } as Command)
  const evidence = (since = T0 - DAY_MS) => readEvidence(db, tab, since)
  return { store, tab, execute, lead, group, worker, beat, assign, review, done, merged, evidence,
    clock: { get now() { return now }, set now(value: number) { now = value } } }
}

describe('a Swarm\'s evidence per model and kind of job', () => {
  it('counts a finished attempt once under its model and kind: first review, rework, ship, tokens and cost', async () => {
    const f = await swarm(), g = await f.group()
    await f.beat(opus(1_000, 0))
    const a = await f.assign(g)
    await f.review(g, a, false)
    await f.review(g, a, true)
    f.clock.now += 30 * MINUTE
    await f.done(g, a, opus(1_001_000, 100_000))
    const read = await f.evidence()
    expect(read.models).toHaveLength(1)
    expect(read.models[0]).toMatchObject({ engine: 'claude', model: 'opus', kind: 'backend', attempts: 1, firstReviews: 1, firstReviewPassed: 0,
      firstReviewPassRate: 0, reworkRounds: 1, shipped: 1, averageMinutesToShip: 30, tokensInput: 1_000_000, tokensOutput: 100_000,
      tokensKnown: 1, costKnown: 1, costUnknown: 0, spend: 0, recent: [false] })
    // 1,000,000 input at $4 and 100,000 output at $20 per million.
    expect(read.models[0]!.apiCost).toBeCloseTo(6, 6)
    expect(read.models[0]!.costPerShipped).toBeCloseTo(6, 6)
    const state = (await f.store.read(owner, f.tab)).state
    const projectId = groupProject(state, state.conversations.find(c => c.id === g)!).id
    expect(read.weeks).toEqual([expect.objectContaining({ projectId, engine: 'claude', model: 'opus', kind: 'backend', week: weekStart(T0), attempts: 1 })])
  })

  // Review of #2173: each row keeps its project, so the report can show a reader only the projects they see; Swarm-wide totals
  // are the sum over projects.
  it('sums every project by default, reads only the projects asked for, and merges their last ten by time', async () => {
    const f = await swarm(), week = weekStart(T0)
    const row = (projectId: string, attempts: number) => db.superTabModelEvidence.create({ data: { id: `${f.tab}-${projectId}`, tabId: f.tab, projectId,
      engine: 'claude', model: 'opus', kind: 'backend', week: new Date(week), attempts, shipped: attempts, updatedAt: new Date(T0) } })
    const recent = (projectId: string, results: Array<[number, boolean]>) => db.superTabModelRecent.create({ data: { id: `${f.tab}-r-${projectId}`, tabId: f.tab,
      projectId, engine: 'claude', model: 'opus', kind: 'backend', results: results.map(([at, passed], i) => ({ a: `${projectId}-${i}`, at, passed })), updatedAt: new Date(T0) } })
    await row('p1', 2)
    await row('p2', 5)
    await recent('p1', [[1, true], [3, true], [5, true], [7, true], [9, true], [11, true]])
    await recent('p2', [[2, false], [4, false], [6, false], [8, false], [10, false], [12, false]])
    const all = await f.evidence()
    expect(all.models.map(m => [m.attempts, m.shipped])).toEqual([[7, 7]])
    expect(all.models[0]!.recent).toEqual([true, false, true, false, true, false, true, false, true, false])
    expect(all.weeks.map(w => [w.projectId, w.attempts])).toEqual([['p1', 2], ['p2', 5]])
    const one = await readEvidence(db, f.tab, T0 - DAY_MS, ['p1'])
    expect(one.models.map(m => [m.attempts, m.recent.length])).toEqual([[2, 6]])
    expect(one.weeks.map(w => w.projectId)).toEqual(['p1'])
    expect((await readEvidence(db, f.tab, T0 - DAY_MS, [])).models).toEqual([])
  })

  it('prunes every Swarm\'s rows past 180 days in the hourly sweep, with no write in that Swarm', async () => {
    const f = await swarm(), other = await swarm(), now = T0 + 400 * DAY_MS
    const cut = weekStart(now - EVIDENCE_RETENTION_MS)
    for (const tabId of [f.tab, other.tab]) {
      for (const [name, week] of [['old', cut - 7 * DAY_MS], ['kept', cut]] as const) {
        await db.superTabModelEvidence.create({ data: { id: `${tabId}-sweep-${name}`, tabId, projectId: 'p1', engine: 'claude', model: 'opus', kind: 'docs',
          week: new Date(week), attempts: 1, updatedAt: new Date(week) } })
      }
      for (const [name, at] of [['old', now - EVIDENCE_RETENTION_MS - DAY_MS], ['kept', now - EVIDENCE_RETENTION_MS + DAY_MS]] as const) {
        await db.superTabModelRecent.create({ data: { id: `${tabId}-sweep-r-${name}`, tabId, projectId: 'p1', engine: 'claude', model: `opus-${name}`, kind: 'docs',
          results: [], updatedAt: new Date(at) } })
      }
    }
    const result = await sweepSwarms(db, now)
    expect(result.evidenceExpired).toBeGreaterThanOrEqual(4)
    for (const tabId of [f.tab, other.tab]) {
      expect((await db.superTabModelEvidence.findMany({ where: { tabId, id: { startsWith: `${tabId}-sweep` } } })).map(r => r.id)).toEqual([`${tabId}-sweep-kept`])
      expect((await db.superTabModelRecent.findMany({ where: { tabId, id: { startsWith: `${tabId}-sweep` } } })).map(r => r.id)).toEqual([`${tabId}-sweep-r-kept`])
    }
  })

  it('moves the ship to the recorded merge and counts a fix after merge, without counting the attempt twice', async () => {
    const f = await swarm(), g = await f.group()
    await f.beat(opus(0, 0))
    const a = await f.assign(g)
    await f.review(g, a, true)
    f.clock.now += 60 * MINUTE
    await f.done(g, a, opus(10, 1))
    // The merge recorded later, at 40 minutes: the request shipped then.
    await f.merged(g, 'https://github.com/o/r/pull/1', { mergedAt: new Date(T0 + 40 * MINUTE).toISOString() })
    expect((await f.evidence()).models[0]).toMatchObject({ attempts: 1, shipped: 1, averageMinutesToShip: 40, fixesAfterMerge: 0, recent: [true] })
    const fix = await f.group('Follow-up')
    f.clock.now += 3 * DAY_MS
    await f.merged(fix, 'https://github.com/o/r/pull/2', { fixes: 'https://github.com/o/r/pull/1' })
    expect((await f.evidence()).models[0]).toMatchObject({ attempts: 1, shipped: 1, fixesAfterMerge: 1 })
  })

  it('counts a cancelled attempt\'s cost against its model, and ships only the attempt that shipped', async () => {
    const f = await swarm(), g = await f.group()
    await f.beat(opus(0, 0))
    const first = await f.assign(g)
    await f.beat(opus(1_000_000, 0))
    await f.execute({ type: 'work.cancel', conversationId: g, assignmentId: first, reason: 'Again.' } as Command, host, f.lead)
    const second = await f.assign(g)
    await f.review(g, second, true)
    await f.done(g, second, opus(1_500_000, 0))
    expect((await f.evidence()).models[0]).toMatchObject({ attempts: 2, shipped: 1, firstReviews: 1, costKnown: 2, costUnknown: 0 })
    // Cost per shipped change is all attempts' cost over what shipped: $4 + $2.
    expect((await f.evidence()).models[0]!.costPerShipped).toBeCloseTo(6, 6)
  })

  it('adds up attempts that finish at the same moment in different groups', async () => {
    const f = await swarm(), groups = [await f.group(), await f.group(), await f.group()]
    await f.beat(opus(0, 0))
    const attempts = []
    for (const g of groups) {
      attempts.push(await f.assign(g))
      await f.review(g, attempts.at(-1)!, true)
    }
    await Promise.all(groups.map((g, i) => f.done(g, attempts[i]!, opus(100, 10))))
    expect((await f.evidence()).models[0]).toMatchObject({ attempts: 3, shipped: 3 })
  })

  it('keeps the last ten first reviews, newest last', async () => {
    const f = await swarm()
    await f.beat(opus(0, 0))
    for (let i = 0; i < 12; i++) {
      const g = await f.group()
      const a = await f.assign(g)
      await f.review(g, a, i % 3 !== 0)
      if (i % 3 === 0) await f.review(g, a, true)
      f.clock.now += MINUTE
      await f.done(g, a)
      await f.execute({ type: 'agent.release', agentId: f.worker(g), decision: 'stop' } as Command, host, f.lead)
    }
    // Attempts 0, 3, 6 and 9 failed; the last ten are attempts 2 to 11.
    expect((await f.evidence()).models[0]!.recent).toEqual([true, false, true, true, false, true, true, false, true, true])
  })

  it('deletes rows older than 180 days on the next write, and reads only its own Swarm\'s rows', async () => {
    const f = await swarm(), other = await swarm()
    const old = (tabId: string, week: number, id: string) => db.superTabModelEvidence.create({ data: { id, tabId, projectId: 'p1', engine: 'claude', model: 'opus',
      kind: 'docs', week: new Date(week), attempts: 5, updatedAt: new Date(week) } })
    const stale = weekStart(T0 - EVIDENCE_RETENTION_MS) - 7 * DAY_MS, kept = weekStart(T0 - EVIDENCE_RETENTION_MS) + 7 * DAY_MS
    await old(f.tab, stale, `stale-${f.tab}`)
    await old(f.tab, kept, `kept-${f.tab}`)
    await db.superTabModelRecent.create({ data: { id: `recent-${f.tab}`, tabId: f.tab, projectId: 'p1', engine: 'claude', model: 'opus', kind: 'docs',
      results: [{ a: 'x', at: stale, passed: true }], updatedAt: new Date(T0 - EVIDENCE_RETENTION_MS - DAY_MS) } })
    const g = await f.group()
    await f.beat(opus(0, 0))
    const a = await f.assign(g)
    await f.review(g, a, true)
    await f.done(g, a)
    expect(await db.superTabModelEvidence.count({ where: { id: `stale-${f.tab}` } })).toBe(0)
    expect(await db.superTabModelEvidence.count({ where: { id: `kept-${f.tab}` } })).toBe(1)
    expect(await db.superTabModelRecent.count({ where: { id: `recent-${f.tab}` } })).toBe(0)
    const read = await f.evidence(T0 - EVIDENCE_RETENTION_MS)
    expect(read.models.map(m => [m.kind, m.attempts])).toEqual([['backend', 1], ['docs', 5]])
    expect((await other.evidence(0)).models).toEqual([])
  })

  it('never keeps a person, an agent or task text in a row', async () => {
    const f = await swarm(), g = await f.group()
    await f.beat(opus(0, 0))
    const a = await f.assign(g)
    await f.review(g, a, false)
    await f.review(g, a, true)
    await f.done(g, a, opus(10, 1))
    await f.merged(g, 'https://github.com/o/r/pull/9')
    const rows = JSON.stringify([...await db.superTabModelEvidence.findMany({ where: { tabId: f.tab } }), ...await db.superTabModelRecent.findMany({ where: { tabId: f.tab } }),
      ...(await db.superTabRouteDecision.findMany({ where: { tabId: f.tab } })).map(r => r.evidence)])
    expect(rows).toContain('"attempts":1')
    const state = (await f.store.read(owner, f.tab)).state
    const secrets = [TASK_TEXT, 'zebra', owner.email, host.email, owner.sub, host.sub, f.lead, f.worker(g), 'Worker 0', 'Lead Mac', 'Worker Mac',
      ...state.agents.map(agent => agent.harnessId), 'ev-test-host', 'rev abc', 'Parser work']
    for (const secret of secrets) expect(rows, secret).not.toContain(secret)
  })
})
