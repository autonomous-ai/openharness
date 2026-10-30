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
import type { TokensByModel } from '../src/superTabs/costs/tokens.js'
import { reflectNightly } from '../src/lib/routingReflection.js'
import { poolRows } from './hostRows.test-support.js'

// The nightly routing reflection (Scholes's roadmap, piece 2, 10-30): at 23:00 in the project's zone the worker posts what its
// routed work cost and how it went, and asks its owner about routing changes. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '310000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '310000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR
const plan = [{ engine: 'claude', known: true, windows: [{ name: '5-hour', usedPercent: 10, resetsAt: null }] }]
const opus = (input: number): TokensByModel => ({ 'claude-opus-5-5': { input, output: 0, cacheRead: 0, cacheWrite: 0 } })
/** 17:00 in Vietnam on 2026-10-30, and 23:10 that evening. */
const AFTERNOON = Date.UTC(2026, 9, 30, 10, 0)
const NIGHT = Date.UTC(2026, 9, 30, 16, 10)
const GRID = 'deepseek/deepseek-v4.1-flash-1017'

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_reflection_test_${randomUUID().replaceAll('-', '_')}`)
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

/** A Swarm whose Lead routes "Ship the parser" (kind `parser`) to a worker, which ships it in 12 minutes on Opus for $4. */
async function swarm() {
  let now = AFTERNOON
  const store = new SuperTabStore(db, () => now, null)
  const tab = (await store.create(owner, randomUUID(), 'Reflection', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string) => store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  for (const [machineId, name] of [['lead-host', 'Lead Mac'], ['test-host', 'Worker Mac']]) {
    await execute({ type: 'machine.contribute', machineId: machineId!, name: name!, cwd: '/repo', engines: ['claude'], maxAgents: 4 }, host)
  }
  const generations = new Map<string, string>()
  for (const machineId of ['lead-host', 'test-host']) generations.set(machineId, (await poolRows(store, host, machineId)).find(p => p.tabId === tab)!.machine.generation)
  const harness = { lead: randomUUID(), worker: randomUUID() }
  const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'lead-host', harnessId: harness.lead, name: 'Lead',
    configuration: config, lead: true })).result.agentId)
  const group = String((await execute({ type: 'conversation.create', title: 'Secret parser plan', brief: 'Implement it',
    checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
  const worker = String((await execute({ type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: harness.worker, name: 'Worker',
    configuration: config, lead: false })).result.agentId)
  const beat = async (tokens: TokensByModel) => {
    for (const [machineId, running] of [['lead-host', [harness.lead]], ['test-host', [harness.worker]]] as const) {
      await store.observeMachine(host, tab, machineId, { generation: generations.get(machineId)!, resources: { cpuPercent: 10, memoryTotalBytes: 32e9,
        memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS',
        gpuPercent: null }, quotas: plan, tools: {}, runningHarnessIds: [...running], stoppedHarnessIds: [],
        ...machineId === 'test-host' ? { harnessTokens: { [harness.worker]: tokens }, harnessProgress: { [harness.worker]: now } } : {} })
    }
  }
  /** Routes, assigns and ships the parser task: its evidence row is what makes the project a candidate. */
  const ship = async () => {
    await beat(opus(0))
    const decision = { assessment: { difficulty: 'medium', risk: 'low', why: 'Parser work.', size: 'medium', kind: 'parser' },
      candidates: [{ id: 'c0', kind: 'member', agentId: worker, machineId: 'test-host', engine: 'claude', model: 'opus', effort: 'high',
        quality: 3, cost: 3, title: 'Worker', label: 'Worker' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    const routeDecisionId = String((await execute({ type: 'route.record', conversationId: group, decision } as Command, host, lead)).result.routeDecisionId)
    const assignmentId = String((await execute({ type: 'work.assign', conversationId: group, agentId: worker, routeDecisionId } as Command, host, lead)).result.assignmentId)
    now += 12 * MINUTE
    const checkId = (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!.checks[0]!.id
    await execute({ type: 'work.check', conversationId: group, assignmentId, checkId, passed: true, evidence: 'npm test, 0 failures' } as Command, host, worker)
    await execute({ type: 'work.status', conversationId: group, assignmentId, status: 'done', result: 'Shipped.', tokens: opus(1_000_000) } as Command, host, worker)
  }
  /** A task of `projectId` whose grid attempt failed and stepped up to Sonnet, as their route decisions keep them. */
  const stepUpFromGrid = async (projectId = 'lead', title = 'Secret grid task') => {
    const id = String((await execute({ type: 'conversation.create', projectId, title, brief: '', checks: [] })).result.conversationId)
    await seed(id, { grid: true, at: now - 3 * HOUR })
    await seed(id, { stepUp: true, at: now - HOUR })
    return id
  }
  const seed = (conversationId: string, o: { grid?: boolean; stepUp?: boolean; at: number; outcome?: string }) => db.superTabRouteDecision.create({ data: {
    id: randomUUID(), tabId: tab, conversationId, assignmentId: randomUUID(), outcome: o.outcome ?? 'done', createdAt: new Date(o.at), final: { kind: 'member' },
    record: { assessment: { kind: 'parser' }, ...o.stepUp ? { stepUp: { attempt: 2, reason: 'Its first review said Ready no.' } } : {} },
    run: o.grid ? { machineId: 'test-host', harnessId: 'h', engine: 'claude', model: 'opus', effort: 'low', grid: GRID, billing: 'own-hardware',
      startedAt: o.at, start: {}, endedAt: o.at + HOUR, end: {} }
      : { machineId: 'test-host', harnessId: 'h', engine: 'claude', model: 'sonnet', effort: 'medium', billing: 'subscription', startedAt: o.at, start: {},
        endedAt: o.at + HOUR, end: { 'claude-sonnet-5-5': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } } } })
  const reports = async (conversationId = 'lead') => (await db.superTabMessage.findMany({ where: { tabId: tab, conversationId } }))
    .filter(m => (m.source as { kind?: unknown } | null)?.kind === 'routing-reflection')
  return { store, tab, execute, lead, group, ship, stepUpFromGrid, seed, reports,
    clock: { get now() { return now }, set now(value: number) { now = value } } }
}

describe('the nightly routing reflection', () => {
  it('posts a seeded day once in the project chat at 23:00, under the Lead, and asks the owner each proposal once', async () => {
    const f = await swarm()
    await f.ship()
    await f.stepUpFromGrid()
    await f.stepUpFromGrid()
    f.clock.now = NIGHT - 3 * HOUR
    // Before 23:00 in Vietnam, nothing.
    await reflectNightly(db, f.store, f.clock.now)
    expect(await f.reports()).toEqual([])
    f.clock.now = NIGHT
    // Two passes at once, as two workers in a rolling deploy: one report.
    await Promise.all([reflectNightly(db, f.store, NIGHT), reflectNightly(db, f.store, NIGHT)])
    await reflectNightly(db, f.store, NIGHT + 15 * MINUTE)
    const [report, ...more] = await f.reports()
    expect(more).toEqual([])
    expect(report!.author).toMatchObject({ kind: 'agent', id: f.lead })
    expect(report!.recipientIds).toEqual([])
    const lines = report!.text.split('\n')
    expect(lines).toContain('Last day: 5 attempts, 1 shipped. Last 7 days: 5 attempts, 1 shipped.')
    expect(lines).toContain('- claude opus high, parser: 1 attempt, 1 shipped, median 12 min to ship, $4.00 per shipped change, no first review')
    expect(lines).toContain(`- claude ${GRID} low, parser: 2 attempts, 0 shipped, no first review`)
    expect(lines).toContain('- claude sonnet medium, parser: 2 attempts, 0 shipped, no first review, 2 step-ups')
    expect(lines).toContain('1. Start parser work on a subscription model instead of the grid: about 2 hours to ship a week. '
      + '2 of 2 parser tasks started on the grid stepped up after their grid attempt failed.')
    // Counts only: no task title, machine or person.
    for (const secret of ['Secret', 'Worker Mac', 'test-host', owner.email, host.email]) expect(report!.text).not.toContain(secret)
    const decisions = await db.superTabDecision.findMany({ where: { tabId: f.tab } })
    expect(decisions).toEqual([expect.objectContaining({ personId: owner.sub, askerAgentId: f.lead, conversationId: 'lead', assignmentId: null,
      question: 'Start parser work on a subscription model instead of the grid? Expected saving: about 2 hours to ship a week. '
        + '2 of 2 parser tasks started on the grid stepped up after their grid attempt failed.',
      options: ['Yes, change routing this way', 'No, keep routing as it is'], recommended: 0 })])
    expect(await f.store.postReflection(f.tab, 'lead', '2026-10-30')).toBe('already')
    // The next night, the same proposal still waits: it is not asked again.
    expect(await f.store.postReflection(f.tab, 'lead', '2026-10-31')).toBe('posted')
    expect(await db.superTabDecision.count({ where: { tabId: f.tab } })).toBe(1)
    expect((await f.reports()).at(-1)!.text).toContain("Still waiting for the owner's answer: 1.")
    // People read it; it is a notice for people, not a wake for the Lead.
    expect((await f.store.messages(host, f.tab, 'lead', {})).messages.map(m => m.id)).toContain(report!.id)
  })

  it('posts nothing for a day with no attempt, and skips a project with no routed work', async () => {
    const f = await swarm()
    const quiet = (await f.execute({ type: 'project.create', name: 'Quiet', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    await f.execute({ type: 'agent.add', conversationId: quiet.conversationId, machineId: 'lead-host', harnessId: randomUUID(), name: 'Quiet Lead',
      configuration: config, lead: true })
    await f.ship()
    // Two days later the evidence is still this week's, but the last day had no attempt.
    f.clock.now = NIGHT + 2 * DAY
    const pass = await reflectNightly(db, f.store, f.clock.now)
    expect(await f.reports()).toEqual([])
    expect(await f.reports(quiet.conversationId)).toEqual([])
    expect(pass.posted).toBe(0)
    expect(await f.store.postReflection(f.tab, 'lead', '2026-11-01')).toBe('empty')
    // The quiet project has no evidence, so no pass reads it; asked directly, it has nothing to say.
    expect(await f.store.postReflection(f.tab, quiet.projectId, '2026-11-01')).toBe('empty')
    expect(await db.superTabDecision.count({ where: { tabId: f.tab } })).toBe(0)
  })

  it('counts only its own project: never another project’s tasks, a private chat or the Leads conversation, and posts each where its people read it', async () => {
    const f = await swarm()
    await f.ship()
    // A private project of the owner's alone, with its own Lead and a stepped-up task.
    const hidden = (await f.execute({ type: 'project.create', name: 'Hidden', visibility: 'private', brief: '' })).result as { projectId: string; conversationId: string }
    const hiddenLead = String((await f.execute({ type: 'agent.add', conversationId: hidden.conversationId, machineId: 'lead-host', harnessId: randomUUID(),
      name: 'Hidden Lead', configuration: config, lead: true })).result.agentId)
    await f.stepUpFromGrid(hidden.projectId, 'Hidden grid task')
    await db.superTabModelEvidence.create({ data: { id: randomUUID(), tabId: f.tab, projectId: hidden.projectId, engine: 'claude', model: 'opus', kind: 'feature',
      week: new Date(Date.UTC(2026, 9, 26)), updatedAt: new Date(f.clock.now) } })
    // Attempts in a private chat and in the Leads conversation of this project's Swarm.
    const chat = String((await f.execute({ type: 'buddy.chat', projectId: 'lead' }, host)).result.conversationId)
    const leads = (await f.store.read(owner, f.tab)).state.leadsConversationId!
    for (const conversationId of [chat, leads, 'lead', hidden.conversationId]) await f.seed(conversationId, { at: f.clock.now - HOUR })
    f.clock.now = NIGHT
    const pass = await reflectNightly(db, f.store, NIGHT)
    expect(pass.failed).toBe(0)
    const [mine] = await f.reports(), [theirs] = await f.reports(hidden.conversationId)
    expect(mine!.text).toContain('Last day: 1 attempt, 1 shipped.')
    expect(mine!.text).not.toContain('step-up')
    expect(theirs!.text).toContain('Last day: 2 attempts, 0 shipped.')
    expect(theirs!.author).toMatchObject({ id: hiddenLead })
    // Someone outside the private project reads neither its chat nor its report; asking by another Swarm's id finds nothing.
    await expect(f.store.messages(host, f.tab, hidden.conversationId, {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(f.store.messages(host, f.tab, hidden.conversationId, { messageId: theirs!.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const other = await swarm()
    expect(await other.store.postReflection(other.tab, hidden.projectId, '2026-10-30')).toBe('skipped')
    expect(await f.store.postReflection(f.tab, 'no-such-project', '2026-10-30')).toBe('skipped')
    expect(await other.reports(hidden.conversationId)).toEqual([])
  })

  it('tries a failed report again on the next pass, and the other projects still get theirs', async () => {
    const f = await swarm()
    await f.ship()
    f.clock.now = NIGHT
    let failures = 1
    const flaky = { postReflection: async (...args: Parameters<SuperTabStore['postReflection']>) => {
      if (args[0] === f.tab && failures-- > 0) throw new Error('The database read timed out')
      return f.store.postReflection(...args)
    } }
    const warned: unknown[] = []
    expect(await reflectNightly(db, flaky, NIGHT, { warn: (...a: unknown[]) => { warned.push(a) } })).toMatchObject({ failed: 1 })
    expect(await f.reports()).toEqual([])
    expect(warned).toHaveLength(1)
    await reflectNightly(db, flaky, NIGHT + 15 * MINUTE)
    expect(await f.reports()).toHaveLength(1)
  })
})
