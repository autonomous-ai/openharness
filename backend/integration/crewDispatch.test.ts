import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SEED_RULES, type ProjectRules } from '../src/superTabs/policy.js'
import { DISPATCH_RETRY_MS, SuperTabStore } from '../src/superTabs/store.js'
import { noteChange, swarmTransaction } from '../src/superTabs/cache.js'
import type { Command } from '../src/superTabs/commands.js'
import type { Agent, Conversation } from '../src/superTabs/model.js'
import { planDatabase } from './plans.test-support.js'
import { poolRows } from './hostRows.test-support.js'
import { logger } from '../src/utils/logger.js'

// The Swarm hands the next task to a free crew member by itself (task #3400). A fresh loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
const NOW = Date.parse('2026-11-05T15:00:00Z')
const owner: AuthUser = { sub: '410000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  ({ replica, db } = await planDatabase('crew_dispatch_test'))
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'owner-mac', userId: owner.sub, apiKey: 'fixture-owner-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machine.create({ data: { machineId: 'team-mac', userId: owner.sub, apiKey: 'fixture-team-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm with a PM and the crew [lanes] (name -> lane), and the tasks [owns] (title -> one owned path), in that order. */
async function swarm(lanes: Record<string, string | null>, owns: Record<string, string>, dispatch = false, pmMachine = 'owner-mac') {
  let clock = NOW
  const store = new SuperTabStore(db, () => clock, null, { dispatch })
  /** Moves this Swarm's server clock on. */
  const advance = (ms: number) => { clock += ms }
  const tab = (await store.create(owner, randomUUID(), 'Crew', 'public')).id
  const execute = (command: Command, asAgentId?: string) => store.execute(owner, tab, { operationId: randomUUID(), command }, asAgentId)
  const add = async (name: string, lead = false) => String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: lead ? pmMachine : 'owner-mac',
    harnessId: randomUUID(), name, configuration: config, lead })).result.agentId)
  const pm = await add('PM', true)
  const crew: Record<string, string> = {}
  for (const [name, lane] of Object.entries(lanes)) {
    crew[name] = await add(name)
    // Marked as #3397's crew.add marks it, until that command lands.
    await editAgent(tab, crew[name]!, agent => ({ ...agent, crew: { role: 'Engineer', ...lane ? { lane } : {}, at: NOW, by: owner.sub } }))
  }
  const tasks: Record<string, string> = {}
  for (const [title, path] of Object.entries(owns)) {
    tasks[title] = String((await execute({ type: 'conversation.create', title, checks: [],
      task: { goal: `${title}.`, changes: 'The change.', constraints: 'None.', owns: [path] } })).result.conversationId)
  }
  /** Who holds each task now, by name, from what is stored. */
  const holders = async () => {
    const names = Object.fromEntries(Object.entries(crew).map(([name, id]) => [id, name]))
    return Object.fromEntries(await Promise.all(Object.entries(tasks).map(async ([title, id]) => {
      const group = await readGroup(tab, id)
      const holder = group.assignment && !['lost', 'stopped', 'cancelled'].includes(group.assignment.status) ? names[group.assignment.agentId] ?? group.assignment.agentId : null
      return [title, holder]
    })))
  }
  return { store, tab, pm, crew, tasks, execute, holders, advance }
}

/** Writes a part outside the store as every writer does (cacheOn.test-support.ts): a new version, and the Swarm's stamp moved. */
async function editAgent(tabId: string, agentId: string, edit: (agent: Agent) => Agent) {
  await swarmTransaction(db, async tx => {
    const row = await tx.swarmAgent.findUniqueOrThrow({ where: { tabId_key: { tabId, key: agentId } } })
    await tx.swarmAgent.update({ where: { id: row.id }, data: { version: row.version + 1, changedAt: new Date(),
      data: edit(row.data as unknown as Agent) as unknown as Prisma.InputJsonValue } })
    noteChange(tx, tabId, 'main')
  })
}
async function editGroup(tabId: string, groupId: string, edit: (group: Conversation) => Conversation) {
  await swarmTransaction(db, async tx => {
    const row = await tx.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId, key: groupId } } })
    await tx.swarmGroup.update({ where: { id: row.id }, data: { version: row.version + 1, changedAt: new Date(),
      data: edit(row.data as unknown as Conversation) as unknown as Prisma.InputJsonValue } })
    noteChange(tx, tabId, 'main')
  })
}
async function readGroup(tabId: string, groupId: string): Promise<Conversation> {
  return (await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId, key: groupId } } })).data as unknown as Conversation
}

describe('the crew dispatch pass', () => {
  const save = (s: Awaited<ReturnType<typeof swarm>>, revision: number, change: Partial<ProjectRules>) => s.execute({
    type: 'rules.set', projectId: 'lead', baseRevision: revision, rules: { ...structuredClone(SEED_RULES), ...change }, summary: 'Project dispatch policy',
  })

  /** Two projects, so a broken lead policy cannot hide a healthy project's work. */
  async function twoProjects() {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/a.ts' })
    const other = String((await s.execute({ type: 'project.create', name: 'Phone', visibility: 'public', brief: '' })).result.projectId)
    const head = (await db.swarmHead.findUniqueOrThrow({ where: { tabId_key: { tabId: s.tab, key: 'head' } } })).data as unknown as { projects: { id: string; leadConversationId: string }[] }
    const chat = head.projects.find(p => p.id === other)!.leadConversationId
    await s.execute({ type: 'agent.add', conversationId: chat, machineId: 'owner-mac', harnessId: randomUUID(), name: 'Phone PM', configuration: config, lead: true })
    const worker = String((await s.execute({ type: 'agent.add', conversationId: chat, machineId: 'owner-mac', harnessId: randomUUID(), name: 'Phone worker', configuration: config, lead: false })).result.agentId)
    await s.execute({ type: 'crew.add', agentId: worker, lane: 'mobile', role: 'Engineer' })
    const phone = String((await s.execute({ type: 'conversation.create', projectId: other, title: 'Phone', checks: [], task: { goal: 'Phone.', changes: 'Change.', constraints: 'None.', owns: ['mobile/a.dart'] } })).result.conversationId)
    const fast = { ...structuredClone(SEED_RULES), dispatch: { ...SEED_RULES.dispatch, nudgeAfterMs: 60_000, returnAfterMs: 120_000 } }
    await save(s, 0, fast)
    await s.execute({ type: 'rules.set', projectId: other, baseRevision: 0, rules: fast, summary: 'Fast phone clock' })
    const corrupt = () => db.superTabProjectRules.updateMany({ where: { tabId: s.tab, projectId: 'lead' }, data: { rules: { ...fast, dispatch: { ...fast.dispatch, maxHanded: 0 } } } })
    return { ...s, other, worker, phone, corrupt }
  }

  it('isolates invalid project rules from another project’s dispatch', async () => {
    const s = await twoProjects()
    await s.corrupt()
    const errors = vi.spyOn(logger, 'error')
    try {
      expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
      expect((await readGroup(s.tab, s.tasks.Api!)).assignment).toBeNull()
      expect((await readGroup(s.tab, s.phone)).assignment?.agentId).toBe(s.worker)
      expect(errors.mock.calls).toContainEqual([expect.any(String), expect.anything(), expect.objectContaining({ tabId: s.tab, projectId: 'lead' })])
    } finally { errors.mockRestore() }
  })

  it('keeps host reports and the lead sweep working when one project’s rules are invalid', async () => {
    const s = await twoProjects()
    await s.execute({ type: 'machine.contribute', machineId: 'owner-mac', name: 'Mac', cwd: '/repo', engines: ['claude'], maxAgents: 8 })
    await s.execute({ type: 'work.assign', conversationId: s.tasks.Api!, agentId: s.crew.Ash! })
    await s.execute({ type: 'work.assign', conversationId: s.phone, agentId: s.worker })
    const pool = (await poolRows(s.store, owner, 'owner-mac')).find(p => p.tabId === s.tab)!.machine
    const agents = (await db.swarmAgent.findMany({ where: { tabId: s.tab } })).map(row => row.data as unknown as Agent)
    await s.corrupt()
    s.advance(60_000)
    const report = () => s.store.observeMachine(owner, s.tab, 'owner-mac', { generation: pool.generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null }, quotas: [], tools: {},
      runningHarnessIds: agents.map(a => a.harnessId), stoppedHarnessIds: [] })
    await report()
    const messages = (await s.store.messages(owner, s.tab, s.phone, {}, s.worker)).messages
    expect(messages.filter(m => (m.source as { kind?: string })?.kind === 'crew-nudge')).toHaveLength(1)
    s.advance(3 * 3_600_000)
    await report()
    await s.store.runTimeChecks(s.tab)
    expect((await readGroup(s.tab, s.phone)).assignment?.status).toBe('lost')
    expect((await readGroup(s.tab, s.tasks.Api!)).assignment?.status).toBe('working')
    expect((await readGroup(s.tab, s.tasks.Api!)).assignment?.nudgedAt).toBeUndefined()
  })

  it('lets a review step open under invalid rules but refuses new tasks with a repair instruction', async () => {
    const s = await twoProjects()
    await s.corrupt()
    const step = await s.execute({ type: 'conversation.create', title: 'Review', brief: 'Review the change.', reviewOf: s.tasks.Api!, step: 'Review', checks: [] })
    expect((await readGroup(s.tab, String(step.result.conversationId))).reviewOf).toBe(s.tasks.Api)
    await expect(s.execute({ type: 'conversation.create', title: 'New task', brief: 'A new task.', checks: [] })).rejects.toMatchObject({
      code: 'RULES_INVALID', message: expect.stringMatching(/lead.*repair.*rules/i),
    })
  })

  it('uses custom lanes for crew, work.lane, stamps and dispatch while another project retains mobile', async () => {
    const s = await swarm({ Ash: null }, { Board: 'devices/main.c' })
    await save(s, 0, { lanes: [{ name: 'firmware', owns: ['devices/'] }] })
    expect((await readGroup(s.tab, s.tasks.Board!)).handOutLane).toBe('firmware')
    await s.execute({ type: 'crew.add', agentId: s.crew.Ash!, lane: 'Firmware', role: 'Engineer' })
    await s.execute({ type: 'work.lane', conversationId: s.tasks.Board!, lane: 'FIRMWARE' })
    expect((await readGroup(s.tab, s.tasks.Board!)).lane).toBe('firmware')
    await expect(s.execute({ type: 'crew.add', agentId: s.crew.Ash!, lane: 'mobile' })).rejects.toMatchObject({ code: 'LANE_UNKNOWN' })
    await expect(s.execute({ type: 'work.lane', conversationId: s.tasks.Board!, lane: 'mobile' })).rejects.toMatchObject({ code: 'LANE_UNKNOWN' })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
    expect(await s.holders()).toEqual({ Board: 'Ash' })
    const other = await swarm({ Birch: 'mobile' }, { Phone: 'mobile/lib/app.dart' })
    expect(await other.store.dispatchCrew(other.tab)).toMatchObject({ assigned: 1 })
    expect(await other.holders()).toEqual({ Phone: 'Birch' })
  })

  it('does not dispatch removed lanes even with old crew marks', async () => {
    const s = await swarm({ Ash: 'mobile', Birch: null }, { Phone: 'mobile/lib/app.dart' })
    await s.execute({ type: 'work.lane', conversationId: s.tasks.Phone!, lane: 'mobile' })
    await save(s, 0, { lanes: [{ name: 'firmware', owns: ['devices/'] }] })
    expect((await readGroup(s.tab, s.tasks.Phone!)).handOutLane).toBeNull()
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 0 })
    expect(await s.holders()).toEqual({ Phone: null })
  })

  it('rechecks project lane policy inside an automatic assignment', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    const store = s.store as unknown as { pushOriginFor: (...args: unknown[]) => Promise<unknown> }
    vi.spyOn(store, 'pushOriginFor').mockImplementationOnce(async () => {
      await save(s, 0, { lanes: [] })
      return undefined
    })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 0, skipped: { DISPATCH_STALE: 1 } })
    expect(await s.holders()).toEqual({ Api: null })
  })

  it('rechecks a reduced handed-work cap inside an automatic assignment', async () => {
    const s = await swarm({ Ash: 'backend' }, { First: 'backend/src/a.ts', Next: 'backend/src/b.ts' })
    await s.execute({ type: 'work.assign', conversationId: s.tasks.First!, agentId: s.crew.Ash! })
    const id = (await readGroup(s.tab, s.tasks.First!)).assignment!.id
    await s.execute({ type: 'work.status', conversationId: s.tasks.First!, assignmentId: id, status: 'review', result: 'Ready at abc1234.' }, s.crew.Ash)
    const store = s.store as unknown as { pushOriginFor: (...args: unknown[]) => Promise<unknown> }
    vi.spyOn(store, 'pushOriginFor').mockImplementationOnce(async () => {
      await save(s, 0, { dispatch: { ...SEED_RULES.dispatch, maxHanded: 1 } })
      return undefined
    })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 0, skipped: { DISPATCH_STALE: 1 } })
    expect(await s.holders()).toEqual({ First: 'Ash', Next: null })
  })

  it('honors periodic project cadence while direct work events bypass it', async () => {
    const s = await swarm({ Ash: 'backend' }, { First: 'backend/a.ts', Next: 'backend/b.ts', Third: 'backend/c.ts' })
    await save(s, 0, { dispatch: { ...SEED_RULES.dispatch, everyMs: 60_000 } })
    expect(await s.store.dispatchCrew(s.tab, true)).toMatchObject({ assigned: 1 })
    const first = (await readGroup(s.tab, s.tasks.First!)).assignment!.id
    await s.execute({ type: 'work.status', conversationId: s.tasks.First!, assignmentId: first, status: 'review', result: 'Ready at abc1234.' }, s.crew.Ash)
    s.advance(30_000)
    expect(await s.store.dispatchCrew(s.tab, true)).toMatchObject({ assigned: 0 })
    s.advance(30_000)
    expect(await s.store.dispatchCrew(s.tab, true)).toMatchObject({ assigned: 1 })
    const next = (await readGroup(s.tab, s.tasks.Next!)).assignment!.id
    await s.execute({ type: 'work.status', conversationId: s.tasks.Next!, assignmentId: next, status: 'review', result: 'Ready at abc1234.' }, s.crew.Ash)
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
    expect(await s.holders()).toEqual({ First: 'Ash', Next: 'Ash', Third: 'Ash' })
  })

  it('upgrades a pending periodic pass when a work event arrives', async () => {
    const s = await swarm({ Ash: 'backend' }, { First: 'backend/a.ts', Next: 'backend/b.ts' })
    await save(s, 0, { dispatch: { ...SEED_RULES.dispatch, everyMs: 60_000 } })
    const automatic = new SuperTabStore(db, () => NOW, null, { dispatch: true })
    await automatic.dispatchCrew(s.tab, true)
    const id = (await readGroup(s.tab, s.tasks.First!)).assignment!.id
    await s.execute({ type: 'work.status', conversationId: s.tasks.First!, assignmentId: id, status: 'review', result: 'Ready at abc1234.' }, s.crew.Ash)
    const schedule = automatic as unknown as { dispatchSoon(tabId: string, periodic: boolean): void }
    const passes = vi.spyOn(automatic, 'dispatchCrew')
    schedule.dispatchSoon(s.tab, true)
    await vi.waitFor(() => expect(passes.mock.results.length).toBe(1), { timeout: 5_000, interval: 100 })
    await passes.mock.results[0]!.value
    expect((await readGroup(s.tab, s.tasks.Next!)).assignment).toBeNull()
    schedule.dispatchSoon(s.tab, true)
    await automatic.execute(owner, s.tab, { operationId: randomUUID(), command: { type: 'work.queue', conversationId: s.tasks.Next!, after: null } })
    await vi.waitFor(async () => expect((await readGroup(s.tab, s.tasks.Next!)).assignment?.agentId).toBe(s.crew.Ash), { timeout: 5_000, interval: 100 })
  })

  it('uses each project’s progress clock without changing another project’s seed', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/a.ts' })
    const other = String((await s.execute({ type: 'project.create', name: 'Phone', visibility: 'public', brief: '' })).result.projectId)
    const projects = (await db.swarmHead.findUniqueOrThrow({ where: { tabId_key: { tabId: s.tab, key: 'head' } } })).data as unknown as { projects: { id: string; leadConversationId: string }[] }
    const chat = projects.projects.find(p => p.id === other)!.leadConversationId
    const mobile = String((await s.execute({ type: 'agent.add', conversationId: chat, machineId: 'owner-mac', harnessId: randomUUID(), name: 'Phone worker', configuration: config, lead: false })).result.agentId)
    await s.execute({ type: 'crew.add', agentId: mobile, lane: 'mobile', role: 'Engineer' })
    const phone = String((await s.execute({ type: 'conversation.create', projectId: other, title: 'Phone', checks: [], task: { goal: 'Phone.', changes: 'Change.', constraints: 'None.', owns: ['mobile/a.dart'] } })).result.conversationId)
    await save(s, 0, { lanes: [{ name: 'firmware', owns: ['backend/'] }], dispatch: { ...SEED_RULES.dispatch, nudgeAfterMs: 60_000, returnAfterMs: 120_000 } })
    await s.execute({ type: 'work.assign', conversationId: s.tasks.Api!, agentId: s.crew.Ash! })
    await s.execute({ type: 'work.assign', conversationId: phone, agentId: mobile })
    s.advance(60_000)
    await s.store.runTimeChecks(s.tab)
    const messages = (await s.store.messages(owner, s.tab, s.tasks.Api!, {}, s.crew.Ash)).messages
    expect(messages.filter(m => (m.source as { kind?: string })?.kind === 'crew-nudge')).toHaveLength(1)
    s.advance(60_000)
    await s.store.runTimeChecks(s.tab)
    expect((await readGroup(s.tab, s.tasks.Api!)).assignment?.status).toBe('lost')
    expect((await readGroup(s.tab, phone)).assignment?.status).toBe('working')
    expect((await readGroup(s.tab, phone)).handOutLane).toBe('mobile')
  })

  // Task #3964: the store reads the project's machine rules for a start, an assignment and the dispatch pass.
  it('follows the project\'s machine rules from its record in a start, an assignment and the dispatch pass', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    await save(s, 0, { machines: [{ machineIds: ['owner-mac'], why: 'This Mac takes no new work for now', noEngines: ['claude'] }] })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 0 })
    await expect(s.execute({ type: 'work.assign', conversationId: s.tasks.Api!, agentId: s.crew.Ash! }, s.pm))
      .rejects.toMatchObject({ code: 'MACHINE_RULE', message: 'This Mac takes no new work for now' })
    await s.execute({ type: 'machine.contribute', machineId: 'owner-mac', name: 'Owner Mac', cwd: '/swarm', scope: 'swarm', engines: ['claude', 'codex'], maxAgents: 4 })
    const generation = (await poolRows(s.store, owner, 'owner-mac')).find(p => p.tabId === s.tab)!.machine.generation
    await s.store.observeMachine(owner, s.tab, 'owner-mac', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 64e9, memoryUsedBytes: 4e9,
      diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Desktop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: [], tools: { git: true }, runningHarnessIds: [], stoppedHarnessIds: [] })
    const request = (engine: string) => ({ conversationId: s.tasks.Api!, machineId: 'owner-mac', engine, name: 'Builder', cwd: '/swarm/lead', worktree: false,
      requirements: { memoryBytes: 1e9, diskBytes: 1e9, maxCpuPercent: 90, tools: [], devices: [], quotaRequired: false } })
    await expect(s.execute({ type: 'agent.start', request: request('claude') })).rejects.toMatchObject({ code: 'MACHINE_RULE' })
    expect((await s.execute({ type: 'agent.start', request: request('codex') })).result.startId).toBeTruthy()
    // Cleared by the people who set it: the member takes the task again.
    await save(s, 1, { machines: [] })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
    expect(await s.holders()).toEqual({ Api: 'Ash' })
  })

  // Security review 1 of #3964: a record broken elsewhere still applies the machine rules it holds that pass.
  it('applies the machine rules of a record that fails the schema elsewhere, to an assignment', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    const rule = { machineIds: ['owner-mac'], why: 'This Mac takes no new work for now', noEngines: ['claude' as const] }
    await save(s, 0, { machines: [rule] })
    await db.superTabProjectRules.updateMany({ where: { tabId: s.tab, projectId: 'lead' },
      data: { rules: { ...structuredClone(SEED_RULES), dispatch: { ...SEED_RULES.dispatch, maxHanded: 0 }, machines: [rule] } } })
    await expect(s.execute({ type: 'work.assign', conversationId: s.tasks.Api!, agentId: s.crew.Ash! }, s.pm))
      .rejects.toMatchObject({ code: 'MACHINE_RULE', message: 'This Mac takes no new work for now' })
  })

  it('hands a free member its pinned task first, then its lane\'s top task, as the PM, through work.assign', async () => {
    const s = await swarm({ Ash: 'backend', Birch: 'desktop' }, { Api: 'backend/src/a.ts', Store: 'backend/src/b.ts', Board: 'desktop/lib/c.dart' })
    await editGroup(s.tab, s.tasks.Store!, group => ({ ...group, pin: { agentId: s.crew.Ash!, why: 'ci', at: NOW } }))
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 2 })
    expect(await s.holders()).toEqual({ Api: null, Store: 'Ash', Board: 'Birch' })
    // The assignment is an ordinary one, made by the project's PM, and it cleared the pin.
    const store = await readGroup(s.tab, s.tasks.Store!)
    expect(store.pin).toBeUndefined()
    const notice = (await s.store.messages(owner, s.tab, s.tasks.Store!, {})).messages.find(m => m.author.id === s.pm)
    expect(notice).toBeDefined()
    // A second pass finds nobody free and changes nothing.
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 0 })
    expect(await s.holders()).toEqual({ Api: null, Store: 'Ash', Board: 'Birch' })
  })

  it('assigns once when two passes race, from two servers: one task to the member, never two, never one task twice', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts', Store: 'backend/src/b.ts' })
    const other = new SuperTabStore(db, () => NOW)
    await Promise.all([s.store.dispatchCrew(s.tab), other.dispatchCrew(s.tab), s.store.dispatchCrew(s.tab)])
    expect(await s.holders()).toEqual({ Api: 'Ash', Store: null })

    const t = await swarm({ Cedar: 'backend', Dune: 'backend' }, { Api: 'backend/src/a.ts' })
    await Promise.all([t.store.dispatchCrew(t.tab), new SuperTabStore(db, () => NOW).dispatchCrew(t.tab)])
    const held = Object.values(await t.holders())
    expect(held).toHaveLength(1)
    expect(['Cedar', 'Dune']).toContain(held[0])
  })

  it('leaves never-assigned work to the PM route in a project without crew', async () => {
    const s = await swarm({}, { Api: 'backend/src/a.ts' })
    await s.execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'Plain', configuration: config, lead: false })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 0 })
    expect(await s.holders()).toEqual({ Api: null })
  })

  it('assigns as a PM that runs in a Harness Team account, with no one\'s sign-in', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    // The PM's machine becomes a Team account's: an ordinary sign-in may no longer speak as its agents (store.ts notTeamMachine).
    await db.machine.updateMany({ where: { machineId: 'owner-mac', userId: owner.sub }, data: { sessionKind: 'team' } })
    try {
      expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
      expect(await s.holders()).toEqual({ Api: 'Ash' })
    } finally {
      await db.machine.updateMany({ where: { machineId: 'owner-mac', userId: owner.sub }, data: { sessionKind: null } })
    }
  })

  it('runs by itself a second after a write that opens a task for a project worker', async () => {
    const s = await swarm({ Ash: 'backend' }, {}, true)
    const id = String((await s.execute({ type: 'conversation.create', title: 'Api', checks: [],
      task: { goal: 'Api.', changes: 'The change.', constraints: 'None.', owns: ['backend/src/a.ts'] } })).result.conversationId)
    await vi.waitFor(async () => expect((await readGroup(s.tab, id)).assignment?.agentId).toBe(s.crew.Ash), { timeout: 5_000, interval: 200 })

    // A progress note frees nobody: no pass is scheduled by it. Handing over for review schedules one.
    await vi.waitFor(() => expect(s.store.dispatchScheduled(s.tab)).toBe(false), { timeout: 5_000, interval: 100 })
    const assignmentId = (await readGroup(s.tab, id)).assignment!.id
    await s.execute({ type: 'work.status', conversationId: id, assignmentId, status: 'working', result: 'Halfway.' }, s.crew.Ash)
    expect(s.store.dispatchScheduled(s.tab)).toBe(false)
    await s.execute({ type: 'work.status', conversationId: id, assignmentId, status: 'review', result: 'Ready at abc1234.' }, s.crew.Ash)
    // Nothing waits to be handed out: the pass would find nothing, and its whole-Swarm read is not taken (#3661).
    expect(s.store.dispatchScheduled(s.tab)).toBe(false)
    // A task for the member its Ready freed: one pass.
    await s.execute({ type: 'conversation.create', title: 'Web', checks: [],
      task: { goal: 'Web.', changes: 'The change.', constraints: 'None.', owns: ['backend/src/b.ts'] } })
    expect(s.store.dispatchScheduled(s.tab)).toBe(true)

    // Every worker busy: a new task waits for the sweep, and no write schedules a pass (#3661).
    const busy = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' }, true)
    await vi.waitFor(async () => expect(await busy.holders()).toEqual({ Api: 'Ash' }), { timeout: 5_000, interval: 200 })
    await vi.waitFor(() => expect(busy.store.dispatchScheduled(busy.tab)).toBe(false), { timeout: 5_000, interval: 100 })
    await busy.execute({ type: 'conversation.create', title: 'Web', checks: [],
      task: { goal: 'Web.', changes: 'The change.', constraints: 'None.', owns: ['backend/src/b.ts'] } })
    expect(busy.store.dispatchScheduled(busy.tab)).toBe(false)

    // With only a PM, no write schedules one.
    const plain = await swarm({}, {}, true)
    await plain.execute({ type: 'conversation.create', title: 'Api', checks: [],
      task: { goal: 'Api.', changes: 'The change.', constraints: 'None.', owns: ['backend/src/a.ts'] } })
    expect(plain.store.dispatchScheduled(plain.tab)).toBe(false)
  })

  it('automatically recovers lost work without any crew', async () => {
    const s = await swarm({}, { Api: 'backend/src/a.ts' }, true)
    const old = String((await s.execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'Old', configuration: config, lead: false })).result.agentId)
    const plain = String((await s.execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'Plain', configuration: config, lead: false })).result.agentId)
    const id = s.tasks.Api!
    await s.execute({ type: 'work.assign', conversationId: id, agentId: old })
    await editGroup(s.tab, id, group => ({ ...group, assignment: { ...group.assignment!, status: 'lost', lost: { reason: 'its session stopped', at: NOW } },
      lostAttempt: { id: group.assignment!.id, agentId: old } }))
    await s.execute({ type: 'work.queue', conversationId: id, after: null })
    await vi.waitFor(async () => expect((await readGroup(s.tab, id)).assignment?.agentId).toBe(plain), { timeout: 5_000, interval: 200 })
  })

  it('does not assign a worker stopped while the pass read GitHub', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    const store = s.store as unknown as { pushOriginFor: (...args: unknown[]) => Promise<unknown> }
    vi.spyOn(store, 'pushOriginFor').mockImplementationOnce(async () => {
      await editAgent(s.tab, s.crew.Ash!, agent => ({ ...agent, workDecision: 'stop' }))
      return undefined
    })
    await s.store.dispatchCrew(s.tab)
    expect(await s.holders()).toEqual({ Api: null })
  })

  it('assigns nothing as a PM whose grant no longer holds, waits a little, and assigns once its access is back', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    // The PM's machine row is gone (removed, or billing ended): the agent path refuses it (store.ts grantHolds).
    const row = await db.machine.findFirstOrThrow({ where: { machineId: 'owner-mac', userId: owner.sub } })
    await db.machine.delete({ where: { id: row.id } })
    try {
      const first = await s.store.dispatchCrew(s.tab)
      expect(first.assigned).toBe(0)
      expect(Object.keys(first.skipped)).toEqual(['HOST_UNAVAILABLE'])
      expect(await s.holders()).toEqual({ Api: null })
      // Its PM is not tried again at once, by this pass or the sweep's check.
      expect(await s.store.dispatchCrew(s.tab)).toEqual({ assigned: 0, skipped: {} })
    } finally {
      await db.machine.create({ data: { machineId: 'owner-mac', userId: owner.sub, apiKey: 'fixture-owner-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    }
    // Its access is back, in the same round of the same task: the next try after the short wait assigns it.
    s.advance(DISPATCH_RETRY_MS)
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
    expect(await s.holders()).toEqual({ Api: 'Ash' })
  })

  it('never has a Team-account PM assign a member outside a Team account', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' }, false, 'team-mac')
    // The PM runs in a Harness Team account on its own machine (its record says so); Ash runs in the main account.
    await editAgent(s.tab, s.pm, agent => ({ ...agent, teamAccount: true }))
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 0 })
    expect(await s.holders()).toEqual({ Api: null })
  })

  it('assigns once the Swarm resumes, after a pause that came while the pass read GitHub', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    const store = s.store as unknown as { pushOriginFor: (...args: unknown[]) => Promise<unknown> }
    vi.spyOn(store, 'pushOriginFor').mockImplementationOnce(async () => {
      await s.execute({ type: 'tab.pause', paused: true })
      return undefined
    })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 0 })
    expect(await s.holders()).toEqual({ Api: null })
    // Resumed in the same round, with no time passing: the pause left nothing behind.
    await s.execute({ type: 'tab.pause', paused: false })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
    expect(await s.holders()).toEqual({ Api: 'Ash' })
  })

  it('does not assign a task postponed while the pass read GitHub', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    // Between the pass's read and its write: a person moves the task to tomorrow.
    const store = s.store as unknown as { pushOriginFor: (...args: unknown[]) => Promise<unknown> }
    vi.spyOn(store, 'pushOriginFor').mockImplementationOnce(async () => {
      await s.execute({ type: 'work.queue', conversationId: s.tasks.Api!, notBefore: '2026-11-07', hold: { kind: 'requester' } })
      return undefined
    })
    await s.store.dispatchCrew(s.tab)
    expect(await s.holders()).toEqual({ Api: null })
  })

  it('assigns a task again after it was redefined, not the first round\'s receipt', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
    const first = (await readGroup(s.tab, s.tasks.Api!)).assignment!.id
    await s.execute({ type: 'work.status', conversationId: s.tasks.Api!, assignmentId: first, status: 'done', result: 'Shipped at abc1234.' }, s.crew.Ash)
    await s.execute({ type: 'work.define', conversationId: s.tasks.Api!, checks: [],
      task: { goal: 'Api, second round.', changes: 'More.', constraints: 'None.', owns: ['backend/src/a.ts'] } })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
    const second = (await readGroup(s.tab, s.tasks.Api!)).assignment!
    expect(second.id).not.toBe(first)
    expect(second.status).toBe('working')
  })

  // Swarm v3 (task #4120, the PM's ruling): Team-written code goes only to the project owner's own agent, as Ash is here.
  it('gives Team-written code to the project owner\'s own agent', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts', Store: 'backend/src/b.ts' })
    await editGroup(s.tab, s.tasks.Api!, group => ({ ...group, teamWritten: true }))
    const done = await s.store.dispatchCrew(s.tab)
    expect(done.assigned).toBe(1)
    expect(await s.holders()).toEqual({ Api: 'Ash', Store: null })
  })
})
