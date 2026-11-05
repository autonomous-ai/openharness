import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stableId } from '../src/superTabs/model.js'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import type { TokensByModel } from '../src/superTabs/costs/tokens.js'
import { reflectNightly } from '../src/lib/routingReflection.js'
import { proposalTitle, reflectionMessageId } from '../src/superTabs/costs/reflection.js'
import { poolRows } from './hostRows.test-support.js'

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
    // The people's report: the Lead's own reminder of the same kind has the Lead as its recipient.
    .filter(m => (m.source as { kind?: unknown } | null)?.kind === 'routing-reflection' && !m.recipientIds.length)
  return { store, tab, execute, lead, group, ship, stepUpFromGrid, seed, reports,
    clock: { get now() { return now }, set now(value: number) { now = value } } }
}

describe('the nightly routing reflection', () => {
  it('never posts a report, and asks the owner each proposal once in two plain-language lines', async () => {
    const f = await swarm()
    await f.ship()
    for (let i = 0; i < 3; i++) await f.stepUpFromGrid()
    const messages = await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: 'lead' } })
    f.clock.now = NIGHT - 3 * HOUR
    // Before 23:00 in Vietnam, nothing.
    await reflectNightly(db, f.store, f.clock.now)
    expect(await f.reports()).toEqual([])
    f.clock.now = NIGHT
    await Promise.all([reflectNightly(db, f.store, NIGHT), reflectNightly(db, f.store, NIGHT)])
    await reflectNightly(db, f.store, NIGHT + 15 * MINUTE)
    expect(await f.reports()).toEqual([])
    expect(await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: 'lead' } })).toEqual(messages)
    const decisions = await db.superTabDecision.findMany({ where: { tabId: f.tab } })
    expect(decisions).toEqual([expect.objectContaining({ personId: owner.sub, askerAgentId: f.lead, conversationId: 'lead', assignmentId: null,
      question: 'Start parser work on a subscription model instead of the grid?\n'
        + 'Why: 3 of 3 parser tasks needed another model after their grid attempt failed. Only 3 tasks. This could save about 3 hours to ship a week.',
      options: ['Yes: the coordinator writes this into the Routing section of the instructions', 'No: keep routing as it is',
        'Not yet: ask again when there is more evidence'],
      // Three tasks are too few to recommend Yes (review of #2276).
      recommended: 2, kind: 'routing-reflection' })])
    for (const secret of ['Routing reflection:', 'Last day:', '\n- ', 'Secret', 'Worker Mac', 'test-host', owner.email, host.email]) {
      expect(decisions[0]!.question).not.toContain(secret)
    }
    expect((await f.store.decisions(owner, f.tab, 'open')).decisions.map(d => d.id)).toContain(decisions[0]!.id)
    expect(await f.store.postReflection(f.tab, 'lead', '2026-10-30')).toBe('empty')
    // The next night, the same proposal still waits: it is not asked again.
    expect(await f.store.postReflection(f.tab, 'lead', '2026-10-31')).toBe('empty')
    expect(await db.superTabDecision.count({ where: { tabId: f.tab } })).toBe(1)
    expect(await f.reports()).toEqual([])
    expect((await f.store.costSummary(host, f.tab, 7, f.lead)).totals).toMatchObject({ attempts: 7, shipped: 1 })
  })

  it('suppresses answered and written proposals without posting approval reminders', async () => {
    const f = await swarm()
    await f.ship()
    for (let i = 0; i < 3; i++) await f.stepUpFromGrid()
    const GRID_TITLE = 'Start parser work on a subscription model instead of the grid'
    const night = async (on: string, days: number) => {
      f.clock.now = NIGHT + days * DAY
      await f.seed(f.group, { at: f.clock.now - HOUR })
      const result = await f.store.postReflection(f.tab, 'lead', on)
      expect(await f.reports()).toEqual([])
      return result
    }
    expect(await night('2026-10-30', 0)).toBe('posted')
    const [first] = await db.superTabDecision.findMany({ where: { tabId: f.tab } })
    await f.execute({ type: 'decision.answer', decisionId: first!.id, choice: 1 })
    // The owner said No: the next night neither asks nor proposes it.
    expect(await night('2026-10-31', 1)).toBe('empty')
    expect(await db.superTabDecision.count({ where: { tabId: f.tab } })).toBe(1)
    // Fifteen days after that answer it is asked again.
    await db.superTabDecision.update({ where: { id: first!.id }, data: { answeredAt: new Date(NIGHT - 15 * DAY) } })
    expect(await night('2026-11-01', 2)).toBe('posted')
    const again = (await db.superTabDecision.findMany({ where: { tabId: f.tab, OR: [{ answeredAt: null }, { answeredAt: { isSet: false } }] } }))
    expect(again.map(d => proposalTitle(d.question))).toEqual([GRID_TITLE])
    // The owner says Yes: no list of approved changes, and no reminder to the coordinator, that night or after.
    f.clock.now = NIGHT + 2 * DAY + 2 * HOUR
    await f.execute({ type: 'decision.answer', decisionId: again[0]!.id, choice: 0 })
    const approved = await night('2026-11-02', 3)
    expect(approved).toBe('empty')
    const line = 'Parser work starts on a subscription model, not on the grid.'
    expect((await db.superTabMessage.findMany({ where: { tabId: f.tab, recipientIds: { has: f.lead } } }))
      .filter(m => (m.source as { kind?: string } | null)?.kind === 'routing-reflection')).toEqual([])
    expect((await db.superTabMessage.findMany({ where: { tabId: f.tab } })).filter(m => m.text.startsWith('Approved routing'))).toEqual([])
    // The coordinator writes its line into Routing, as the template's PM section says, naming the owner as who asked.
    const doc = await f.store.instructions(owner, f.tab, 'lead')
    await f.execute({ type: 'instructions.save', projectId: 'lead', baseRevision: doc.revision, text: `${doc.text.trimEnd()}\n- ${line}\n`,
      summary: `Routing: ${line}`, askedBy: owner.sub }, host, f.lead)
    const written = await night('2026-11-03', 4)
    expect(written).toBe('empty')
    await db.superTabDecision.update({ where: { id: again[0]!.id }, data: { answeredAt: new Date(NIGHT - 28 * DAY) } })
    const later = await night('2026-11-04', 5)
    expect(later).toBe('empty')
    expect(await db.superTabDecision.count({ where: { tabId: f.tab, OR: [{ answeredAt: null }, { answeredAt: { isSet: false } }] } })).toBe(0)
  })

  it('keeps at most three proposals open without notices, and expires them after 7 unanswered days', async () => {
    const f = await swarm()
    await f.ship()
    for (let i = 0; i < 3; i++) await f.stepUpFromGrid()
    const open = (title: string) => ({ id: randomUUID(), tabId: f.tab, batchId: 'earlier', projectId: 'lead', conversationId: 'lead', assignmentId: null,
      personId: owner.sub, askerAgentId: f.lead, question: `${title}? Expected saving: about $1.00 a week at API prices.`, options: ['Yes', 'No', 'Not yet'],
      recommended: 2, unblocks: 'If you say yes.', createdAt: new Date(NIGHT - 6 * DAY), kind: 'routing-reflection' })
    await db.superTabDecision.createMany({ data: ['ui', 'docs', 'tests'].map(kind => open(`Stop routing ${kind} work to claude opus high`)) })
    f.clock.now = NIGHT
    expect(await f.store.postReflection(f.tab, 'lead', '2026-10-30')).toBe('empty')
    expect(await db.superTabDecision.count({ where: { tabId: f.tab } })).toBe(3)
    expect(await f.reports()).toEqual([])
    // Two days on, the three are 8 days old. The owner also has 17 other open decisions from the Lead: 20 with the three, the
    // most one asker may hold. The three expire before they are counted, so the proposal is asked (delta review of #2276).
    await db.superTabDecision.createMany({ data: Array.from({ length: 17 }, (_, i) => ({ id: randomUUID(), tabId: f.tab, batchId: 'plain', projectId: 'lead',
      conversationId: 'lead', personId: owner.sub, askerAgentId: f.lead, question: `Question ${i}?`, options: ['Yes', 'No'], recommended: 0, unblocks: 'x',
      createdAt: new Date(NIGHT) })) })
    f.clock.now = NIGHT + 2 * DAY
    await f.seed(f.group, { at: f.clock.now - HOUR })
    expect(await f.store.postReflection(f.tab, 'lead', '2026-11-01')).toBe('posted')
    const proposals = () => db.superTabDecision.findMany({ where: { tabId: f.tab, kind: 'routing-reflection' } })
    expect((await proposals()).map(d => proposalTitle(d.question))).toEqual(['Start parser work on a subscription model instead of the grid'])
    expect(await f.reports()).toEqual([])
    // Unanswered for 8 days, it expires on a night with nothing to report too.
    f.clock.now = NIGHT + 10 * DAY
    expect(await f.store.postReflection(f.tab, 'lead', '2026-11-09')).toBe('empty')
    expect(await proposals()).toEqual([])
    expect(await db.superTabDecision.count({ where: { tabId: f.tab } })).toBe(17)
  })

  it('posts nothing for a day with no attempt, and skips a project with no routed work', async () => {
    const f = await swarm()
    const quiet = (await f.execute({ type: 'project.create', name: 'Quiet', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    await f.execute({ type: 'agent.add', conversationId: quiet.conversationId, machineId: 'lead-host', harnessId: randomUUID(), name: 'Quiet Lead',
      configuration: config, lead: true })
    await f.ship()
    // Two days later the evidence is still this week's, but the last day had no attempt.
    f.clock.now = NIGHT + 2 * DAY
    await reflectNightly(db, f.store, f.clock.now)
    expect(await f.reports()).toEqual([])
    expect(await f.reports(quiet.conversationId)).toEqual([])
    expect(await f.store.postReflection(f.tab, 'lead', '2026-11-01')).toBe('empty')
    // The quiet project has no evidence, so no pass reads it; asked directly, it has nothing to say.
    expect(await f.store.postReflection(f.tab, quiet.projectId, '2026-11-01')).toBe('empty')
    expect(await db.superTabDecision.count({ where: { tabId: f.tab } })).toBe(0)
  })

  it('keeps active nights without a proposal silent in every Swarm, preserving costs and old reports', async () => {
    for (const fixture of [await swarm(), await swarm()]) {
      await fixture.ship()
      const oldId = reflectionMessageId(fixture.tab, 'lead', '2026-10-29')
      await db.superTabMessage.create({ data: {
        id: oldId, tabId: fixture.tab, conversationId: 'lead', sequence: 1, author: { kind: 'agent', id: fixture.lead, name: 'Lead' },
        text: 'Routing reflection: an old report.', recipientIds: [], mentions: [],
        source: { kind: 'routing-reflection', projectId: 'lead', on: '2026-10-29' },
      } })
      const messages = await db.superTabMessage.findMany({ where: { tabId: fixture.tab } })
      const costs = await fixture.store.costSummary(host, fixture.tab, 7, fixture.lead)
      fixture.clock.now = NIGHT
      expect(await fixture.store.postReflection(fixture.tab, 'lead', '2026-10-29')).toBe('already')
      expect(await fixture.store.postReflection(fixture.tab, 'lead', '2026-10-30')).toBe('empty')
      expect(await db.superTabMessage.findMany({ where: { tabId: fixture.tab } })).toEqual(messages)
      expect(await db.superTabDecision.count({ where: { tabId: fixture.tab } })).toBe(0)
      expect((await fixture.store.costSummary(host, fixture.tab, 7, fixture.lead)).totals).toEqual(costs.totals)
      expect((await fixture.store.messages(owner, fixture.tab, 'lead', { messageId: oldId })).messages).toEqual([
        expect.objectContaining({ id: oldId, text: 'Routing reflection: an old report.' }),
      ])
    }
  })

  it('asks only about its own project, never another project, a private chat or the Leads conversation', async () => {
    const f = await swarm()
    await f.ship()
    // A private project of the owner's alone, with its own Lead and a stepped-up task.
    const hidden = (await f.execute({ type: 'project.create', name: 'Hidden', visibility: 'private', brief: '' })).result as { projectId: string; conversationId: string }
    const hiddenLead = String((await f.execute({ type: 'agent.add', conversationId: hidden.conversationId, machineId: 'lead-host', harnessId: randomUUID(),
      name: 'Hidden Lead', configuration: config, lead: true })).result.agentId)
    for (let attempt = 0; attempt < 3; attempt++) await f.stepUpFromGrid(hidden.projectId, 'Hidden grid task')
    await db.superTabModelEvidence.create({ data: { id: randomUUID(), tabId: f.tab, projectId: hidden.projectId, engine: 'claude', model: 'opus', kind: 'feature',
      week: new Date(Date.UTC(2026, 9, 26)), updatedAt: new Date(f.clock.now) } })
    // Attempts in a private chat and in the Leads conversation of this project's Swarm.
    const chat = String((await f.execute({ type: 'buddy.chat', projectId: 'lead' }, host)).result.conversationId)
    const leads = stableId(f.tab, 'leads')
    for (const conversationId of [chat, leads, 'lead', hidden.conversationId]) await f.seed(conversationId, { at: f.clock.now - HOUR })
    f.clock.now = NIGHT
    const pass = await reflectNightly(db, f.store, NIGHT)
    expect(pass.failed).toBe(0)
    expect(await f.reports()).toEqual([])
    expect(await f.reports(hidden.conversationId)).toEqual([])
    expect(await db.superTabDecision.findMany({ where: { tabId: f.tab } })).toEqual([expect.objectContaining({
      projectId: hidden.projectId, conversationId: hidden.conversationId, personId: owner.sub, askerAgentId: hiddenLead,
      question: expect.stringContaining('3 of 3 parser tasks'),
    })])
    await expect(f.store.messages(host, f.tab, hidden.conversationId, {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await f.store.decisions(host, f.tab, 'open')).decisions).toEqual([])
    const other = await swarm()
    expect(await other.store.postReflection(other.tab, hidden.projectId, '2026-10-30')).toBe('skipped')
    expect(await f.store.postReflection(f.tab, 'no-such-project', '2026-10-30')).toBe('skipped')
    expect(await other.reports(hidden.conversationId)).toEqual([])
  })

  it('retries a failed reflection while other projects still receive their Decisions without reports', async () => {
    const f = await swarm()
    await f.ship()
    // A second project of the same Swarm, with its own Lead and a day of routed work.
    const web = (await f.execute({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    await f.execute({ type: 'agent.add', conversationId: web.conversationId, machineId: 'lead-host', harnessId: randomUUID(), name: 'Web Lead',
      configuration: config, lead: true })
    for (let attempt = 0; attempt < 3; attempt++) await f.stepUpFromGrid(web.projectId, 'Web grid task')
    await db.superTabModelEvidence.create({ data: { id: randomUUID(), tabId: f.tab, projectId: web.projectId, engine: 'claude', model: 'opus', kind: 'feature',
      week: new Date(Date.UTC(2026, 9, 26)), updatedAt: new Date(f.clock.now) } })
    f.clock.now = NIGHT
    let failures = 1
    const flaky = { postReflection: async (...args: Parameters<SuperTabStore['postReflection']>) => {
      if (args[0] === f.tab && args[1] === 'lead' && failures-- > 0) throw new Error('The database read timed out')
      return f.store.postReflection(...args)
    } }
    const warned: unknown[] = []
    expect(await reflectNightly(db, flaky, NIGHT, { warn: (...a: unknown[]) => { warned.push(a) } })).toMatchObject({ failed: 1 })
    expect(await f.reports()).toEqual([])
    expect(await f.reports(web.conversationId)).toEqual([])
    expect(await db.superTabDecision.count({ where: { tabId: f.tab, projectId: web.projectId } })).toBe(1)
    expect(warned).toHaveLength(1)
    await reflectNightly(db, flaky, NIGHT + 15 * MINUTE)
    expect(await f.reports()).toEqual([])
  })
})
