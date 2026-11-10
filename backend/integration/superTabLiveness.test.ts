import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient, type Prisma, type SuperTabDelivery } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore, type Polled, type SuperTabStoreHooks } from '../src/superTabs/store.js'
import { SWEEP_EVERY_MS } from '../src/superTabs/liveness.js'
import { DOWN_REMOVE_MS } from '../src/superTabs/closedAgents.js'
import { stableId } from '../src/superTabs/model.js'
import type { Command } from '../src/superTabs/commands.js'
import type { MachineObservation } from '../src/superTabs/machines.js'
import * as parts from '../src/superTabs/parts/index.js'
import { poolRows, rosterRows } from './hostRows.test-support.js'
import { beforeFirstWrite } from './interleave.test-support.js'
import { profiledReads } from './profiledReads.test-support.js'

// A machine's reports and the delivery polls of its agents: what a Swarm's time checks still decide (a start that never runs), the
// polls' costs, and what a report does to an agent closed or reopened on its machine. Swarm v4 loses no task and nudges no worker
// (task loss, leases and review waits were tested here until then). A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '200000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '200000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MINUTE = 60_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_liveness_test_${randomUUID().replaceAll('-', '_')}`)
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

/** A Swarm whose Lead runs on one of host's machines and whose worker runs on another, assigned "Ship the parser". */
/** [lent]: its agents are the owner's, lent through the host's machine share, as before Swarm v3; such an agent takes no new work
 *  on another person's computer now (task #4120), so the task is left unassigned. */
async function swarm({ client = db, hooks, engines = ['codex'], lent = false }: { client?: PrismaClient; hooks?: SuperTabStoreHooks; engines?: string[]; lent?: boolean } = {}) {
  let now = 10_000_000
  const timed = new SuperTabStore(client, () => now, null, hooks)
  const tab = (await timed.create(owner, randomUUID(), 'Liveness', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string) => timed.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  for (const [machineId, name] of [['lead-host', 'Lead Mac'], ['test-host', 'Worker Mac']]) {
    await execute({ type: 'machine.contribute', machineId: machineId!, name: name!, cwd: '/repo', engines, maxAgents: 4 }, host)
  }
  const generations = new Map<string, string>()
  for (const machineId of ['lead-host', 'test-host']) generations.set(machineId, (await poolRows(timed, host, machineId)).find(p => p.tabId === tab)!.machine.generation)
  const harness = { lead: randomUUID(), worker: randomUUID(), other: randomUUID() }
  // Added by the machines' own person: an agent runs on its person's own computer, as them (Swarm v3, task #4120).
  const add = async (conversationId: string, machineId: string, harnessId: string, name: string, lead = false) => String((await execute({ type: 'agent.add',
    conversationId, machineId, harnessId, name, configuration: config, lead }, lent ? owner : host)).result.agentId)
  const lead = await add('lead', 'lead-host', harness.lead, 'Lead', true)
  const group = String((await execute({ type: 'conversation.create', title: 'Ship the parser', brief: 'Implement it',
    checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
  const worker = await add(group, 'test-host', harness.worker, 'Worker')
  const assignmentId = lent ? '' : String((await execute({ type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId)
  const observe = (machineId: string, running: string[], extra: Partial<MachineObservation> = {}, store = timed) => store.observeMachine(host, tab, machineId, {
    generation: generations.get(machineId)!, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9,
      diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: [], tools: {}, runningHarnessIds: running, stoppedHarnessIds: [], ...extra })
  /** Both machines report: the Lead's alive, the worker's listing its session with its screen last changed at `progressAt`
   *  (none: an older host that sends no progress). */
  const beat = async (progressAt?: number) => {
    await observe('lead-host', [harness.lead])
    await observe('test-host', [harness.worker], progressAt === undefined ? {} : { harnessProgress: { [harness.worker]: progressAt } })
  }
  /** The member name people and the Lead read for an agent. */
  const name = async (agentId: string) => (await timed.read(owner, tab)).state.agents.find(a => a.id === agentId)!.displayName
  const assignment = async () => (await timed.read(owner, tab)).state.conversations.find(c => c.id === group)!.assignment!
  /** What the Lead's host receives now (this poll is also the Lead's wake-up path), with each row's text, and what it hears in a
   *  digest (noticeDigest.ts): gathered for one, or named by one. Those of no digest of its own come first, in the order written. */
  const leadInbox = async () => {
    // The worker's time checks run every 30 s (timeChecks.ts): one runs before each poll here.
    await timed.runTimeChecks(tab)
    const rows = await timed.deliveries(host, tab, lead)
    const digest = await db.superTabDelivery.findMany({ where: { tabId: tab, agentId: lead, status: { in: ['gathered', 'digested'] } }, orderBy: { createdAt: 'asc' } })
    const ids = [...rows, ...digest].map(r => r.messageId)
    const messages = await db.superTabMessage.findMany({ where: { id: { in: ids } } })
    return ids.map(id => messages.find(m => m.id === id)!).filter(m => (m.source as { kind?: string } | null)?.kind !== 'notice-digest')
  }
  return { timed, tab, execute, lead, group, worker, assignmentId, harness, observe, beat, name, assignment, leadInbox, add,
    clock: { get now() { return now }, set now(value: number) { now = value } } }
}

/** Three messages of a person to the Lead, in the order of their conversation. The ids of the messages. */
async function threeMessagesToTheLead(f: Awaited<ReturnType<typeof swarm>>): Promise<string[]> {
  const ids: string[] = []
  for (const text of ['Parser?', 'Renderer?', 'Exporter?']) {
    ids.push(String((await f.execute({ type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [] })).result.messageId))
  }
  return ids
}

/** A client that records the key of every SwarmGroup row a read returns. */
function recordingGroups() {
  const keys: string[] = []
  const client = db.$extends({ query: { swarmGroup: { async $allOperations({ args, query }) {
    const rows = await query(args)
    for (const row of Array.isArray(rows) ? rows as Array<{ key?: unknown }> : []) if (typeof row?.key === 'string') keys.push(row.key)
    return rows
  } } } }) as unknown as PrismaClient
  return { client, keys }
}

// Review of #2275: the review-capacity notice took the command's own message id, which the Ready for review row already had,
// so the real write hit a duplicate key and rolled the whole status back: no Builder could hand over during a quota shortage.
describe('a Ready for review while no new agent can start', () => {
  it('saves the hand-over and tells the project chat once, through the store\'s write', async () => {
    const f = await swarm({ engines: ['codex', 'claude'] })
    const window = [{ name: 'weekly', usedPercent: 100, resetsAt: new Date(f.clock.now + 3 * 86_400_000).toISOString() }]
    // Both engines out on every machine (project instructions, phase 4: the notice speaks only when neither can start).
    const outForDays = ['claude', 'codex'].map(engine => ({ engine, known: true, windows: window }))
    await f.observe('lead-host', [f.harness.lead], { quotas: outForDays })
    await f.observe('test-host', [f.harness.worker], { quotas: outForDays })
    const status = (status: 'review' | 'working', result: string) =>
      f.execute({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status, result }, host, f.worker)
    const handed = await status('review', 'Ready for review: PR #7 at 4f9c2e1')
    expect((await f.assignment()).status).toBe('review')
    const rows = await db.superTabMessage.findMany({ where: { tabId: f.tab }, orderBy: { sequence: 'asc' } })
    const notices = rows.filter(m => (m.source as { kind?: string } | null)?.kind === 'review-capacity')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.text).toMatch(/^No new agent can start: no machine this project may use can run Claude Code or Codex now/)
    // The command's own row stays the hand-over.
    expect(rows.find(m => m.id === handed.result.messageId)!.text).toContain('Ready for review: PR #7 at 4f9c2e1')
    const project = (await f.timed.read(owner, f.tab)).state.projects![0]!
    expect(project.reviewCapacity).toEqual({ any: 'out' })
    // Handed over again, the cause is the same: said once.
    await status('working', 'Fixing')
    await status('review', 'Ready for review: PR #7 at 5a0d3f2')
    expect((await db.superTabMessage.findMany({ where: { tabId: f.tab } })).filter(m => (m.source as { kind?: string } | null)?.kind === 'review-capacity')).toHaveLength(1)
  })
})

describe('a machine\'s report', () => {
  /** `n` conversations whose work finished but that are not yet quiet, each with a long brief: copies of a real one. */
  async function finishedGroups(f: Awaited<ReturnType<typeof swarm>>, n: number) {
    const first = String((await f.execute({ type: 'conversation.create', title: 'Finished', brief: 'b'.repeat(2000),
      checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
    const { id: _id, ...row } = (await db.swarmGroup.findFirst({ where: { tabId: f.tab, key: first } }))!
    const assignment = { id: 'finished', agentId: f.worker, status: 'done', result: 'Shipped', configuration: config,
      execution: { machineId: 'test-host', harnessId: f.harness.worker, machineOwnerId: host.sub } }
    const keys = Array.from({ length: n }, (_, i) => `finished-${String(i).padStart(2, '0')}`)
    await db.swarmGroup.createMany({ data: keys.map((key, i) => ({ ...row, id: `${f.tab}:${key}`, key, ordinal: row.ordinal + i + 1,
      agentIds: [...row.agentIds, f.worker], workFinished: true,
      data: { ...row.data as object, id: key, title: key, agentIds: [...row.agentIds, f.worker], assignment } as Prisma.InputJsonValue })) })
    return keys
  }

  it('never reads a finished conversation, only the running work and Lead conversations its checks read', async () => {
    const recorded = recordingGroups()
    const f = await swarm({ client: recorded.client })
    const finished = await finishedGroups(f, 30)
    recorded.keys.length = 0
    // The first report of this store runs the time checks too (liveness.ts SWEEP_EVERY_MS).
    await f.beat(f.clock.now)
    expect(recorded.keys).toContain(f.group)
    expect(recorded.keys.filter(key => finished.includes(key))).toEqual([])
    // The report still did its work: both machines' readings are stored, and the worker keeps its task.
    expect((await f.assignment()).status).toBe('working')
    const machines = (await f.timed.read(owner, f.tab)).state.machines!
    expect(machines.map(m => m.observation?.receivedAt)).toEqual([f.clock.now, f.clock.now])
  })

  it('reports a machine of a Swarm whose head stored no Leads conversation, as every Swarm made now', async () => {
    const f = await swarm()
    const head = (await db.swarmHead.findFirst({ where: { tabId: f.tab } }))!
    expect(head.data).not.toHaveProperty('leadsConversationId')
    await f.beat(f.clock.now)
    expect((await f.timed.read(owner, f.tab)).state.machines!.map(m => m.observation?.receivedAt)).toEqual([f.clock.now, f.clock.now])
  })

  it('credits no Lent hours to a worker that is in a private chat (leaderboard/lent.ts)', async () => {
    const f = await swarm()
    const lent = async () => (await db.swarmMachine.findFirst({ where: { tabId: f.tab, key: 'test-host' } }))!.data as
      { contribution?: { lent?: Array<{ busyMs?: number }> } }
    // Control: the worker's work is for someone else (the owner asked), so two readings credit it.
    await f.observe('test-host', [f.harness.worker])
    f.clock.now += 15_000
    await f.observe('test-host', [f.harness.worker])
    expect((await lent()).contribution?.lent?.[0]?.busyMs).toBe(15_000)
    const chat = String((await f.execute({ type: 'conversation.create', title: 'Peer and PM', brief: '', checks: [] })).result.conversationId)
    await f.execute({ type: 'conversation.agent', conversationId: chat, agentId: f.worker, present: true, lead: false })
    const row = (await db.swarmGroup.findFirst({ where: { tabId: f.tab, key: chat } }))!
    const generation = (await f.timed.read(owner, f.tab)).state.people.find(p => p.id === owner.sub)!.generation
    await db.swarmGroup.update({ where: { id: row.id }, data: { data: { ...row.data as object, audience: { people: [{ id: owner.sub, generation }] } } } })
    f.clock.now += 15_000
    await f.observe('test-host', [f.harness.worker])
    expect((await lent()).contribution?.lent?.[0]?.busyMs).toBe(15_000)
  })
})

// A report never reads its projects' report progress (projectUpdates.ts): only commands and native events note reports.
describe('machine reports and report progress', () => {
  it('reads no report progress and writes none, also when the worker\'s machine goes silent', async () => {
    const f = await swarm()
    await f.execute({ type: 'message.send', conversationId: f.group, text: 'Parser done', replyTo: null, recipientIds: [] })
    // Nothing marks a work group for a report any more (task #3593), so no report progress exists to read or write.
    const before = await db.swarmProgress.findFirst({ where: { tabId: f.tab, deleted: false } })
    expect(before).toBeNull()
    const { reads } = await profiledReads(db, /\.SwarmProgress$/, async () => {
      // The tab's first report, so it runs the liveness sweep too.
      await f.observe('test-host', [f.harness.worker])
      // The worker's machine is silent past its grace: the Swarm's other machine reports, and the sweep runs again.
      f.clock.now += 2 * MINUTE + 5_000
      await f.observe('lead-host', [f.harness.lead])
    })
    expect(reads).toBe(0)
    // Swarm v4 loses no task on a report: it is the worker's own person who stops it.
    expect((await f.assignment()).status).toBe('working')
    expect(await db.swarmProgress.findFirst({ where: { tabId: f.tab, deleted: false } })).toBeNull()
  })
})

describe('a start that never runs', () => {
  /** The Lead starts "Builder" on Worker Mac for a second task, and Worker Mac launches it. A task: no agent but its coordinator
   *  starts into the project chat (#2207). */
  const launch = async (f: Awaited<ReturnType<typeof swarm>>, dispatch = true) => {
    const group = String((await f.execute({ type: 'conversation.create', title: 'Write the docs', brief: 'Document it',
      checks: [{ description: 'Read', independent: false }] })).result.conversationId)
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Small task.' },
      candidates: [{ id: 'c0', kind: 'new', machineId: 'test-host', engine: 'codex', model: 'fixture-model', effort: 'high',
        quality: 2, cost: 2, title: 'New agent', label: 'New agent' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    const routeDecisionId = String((await f.execute({ type: 'route.record', conversationId: group, decision } as Command, host, f.lead)).result.routeDecisionId)
    const request = { conversationId: group, machineId: 'test-host', engine: 'codex', model: 'fixture-model', effort: 'high', name: 'Builder',
      cwd: '/repo', worktree: false, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const startId = String((await f.execute({ type: 'agent.start', request, routeDecisionId } as Command, host, f.lead)).result.startId)
    // The start's own machine dispatches and confirms it.
    const onMachine = (command: Command) => f.timed.execute(host, f.tab, { operationId: randomUUID(), command }, undefined, 'test-host')
    if (dispatch) await onMachine({ type: 'agent.startDispatch', startId })
    return { group, startId, onMachine }
  }

  it('waits while its own machine reports it preparing, shows the Lead it is preparing, and fails it after 15 minutes', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const { group, startId } = await launch(f)
    const dispatched = f.clock.now
    const ownerState = async () => (await f.timed.read(owner, f.tab)).state
    // Another machine cannot keep it waiting, and a machine keeps only its own launched starts in its report.
    await f.observe('lead-host', [f.harness.lead], { preparingStartIds: [startId] })
    await f.observe('test-host', [f.harness.worker], { preparingStartIds: [startId, 'someone-elses-start'] })
    const machines = (await ownerState()).machines!
    expect(machines.find(m => m.machineId === 'lead-host')!.observation!.preparingStartIds).toEqual([])
    expect(machines.find(m => m.machineId === 'test-host')!.observation!.preparingStartIds).toEqual([startId])
    for (const minutes of [3, 8, 14]) {
      f.clock.now = dispatched + minutes * MINUTE + 1
      // Its machine reports first: this jump spans many of its 15-second beats.
      await f.observe('test-host', [f.harness.worker], { preparingStartIds: [startId] })
      await f.observe('lead-host', [f.harness.lead])
      expect((await f.leadInbox()).filter(m => (m.source as { kind?: string }).kind === 'start-timeout')).toEqual([])
      expect(await f.timed.start(host, f.tab, startId, f.lead)).toMatchObject({ error: null, preparing: true })
      expect((await ownerState()).starts!.find(s => s.id === startId)).toMatchObject({ error: null, preparing: true })
    }
    f.clock.now = dispatched + 15 * MINUTE + 1
    await f.observe('test-host', [f.harness.worker], { preparingStartIds: [startId] })
    await f.observe('lead-host', [f.harness.lead])
    const told = (await f.leadInbox()).find(m => (m.source as { kind?: string }).kind === 'start-timeout')!
    expect(told).toMatchObject({ conversationId: group, text: 'Could not start Builder on fixture-model: its machine was still preparing it after 15 minutes.' })
    expect((await f.timed.start(host, f.tab, startId, f.lead)).error).toBe('Worker Mac was still preparing it after 15 minutes')
    expect((await ownerState()).starts!.find(s => s.id === startId)!.error).toBe('Its machine was still preparing it after 15 minutes.')
    expect((await ownerState()).starts!.find(s => s.id === startId)).not.toHaveProperty('preparing')
  })

  // Task #2441: the server refused this machine's own report for the start (its daemon log said why, nobody else did), and the
  // start waited out the 3 minutes. Its machine now says so in its reading, and the start fails at once, with the reason.
  const REFUSAL = 'This start does not belong to this machine contribution.'
  it('fails a start its own machine reports refused, at once, with the refusal\'s reason', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const { group, startId, onMachine } = await launch(f)
    await f.observe('test-host', [f.harness.worker], { refusedStarts: [{ startId, reason: REFUSAL }] })
    expect((await f.timed.start(host, f.tab, startId, f.lead)).error).toBe(`Worker Mac refused it: ${REFUSAL}`)
    const told = (await f.leadInbox()).find(m => (m.source as { kind?: string }).kind === 'start-timeout')!
    expect(told).toMatchObject({ conversationId: group })
    expect(told.text).toMatch(/^Could not start Builder on fixture-model: its machine could not prepare or launch it\./)
    await expect(onMachine({ type: 'agent.started', startId, harnessId: randomUUID(), configuration: config }))
      .rejects.toMatchObject({ code: 'START_FAILED' })
  })

  it('fails an undispatched start its machine reports refused', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const { startId } = await launch(f, false)
    await f.observe('test-host', [f.harness.worker], { refusedStarts: [{ startId, reason: REFUSAL }] })
    expect((await f.timed.start(host, f.tab, startId, f.lead)).error).toBe(`Worker Mac refused it: ${REFUSAL}`)
  })

  it('is not failed by another machine\'s report, never rewrites a decided start, and no reader reads the refusals', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const { startId, onMachine } = await launch(f)
    const refused = { refusedStarts: [{ startId, reason: REFUSAL }] }
    await f.observe('lead-host', [f.harness.lead], refused)
    expect((await f.timed.start(host, f.tab, startId, f.lead)).error).toBeNull()
    const harnessId = randomUUID()
    await onMachine({ type: 'agent.started', startId, harnessId, configuration: config })
    await f.observe('test-host', [f.harness.worker, harnessId], refused)
    expect(await f.timed.start(host, f.tab, startId, f.lead)).toMatchObject({ error: null, harnessId })
    for (const reader of [owner, host]) {
      for (const machine of (await f.timed.read(reader, f.tab)).state.machines ?? []) expect(machine.observation ?? {}).not.toHaveProperty('refusedStarts')
    }
  })

  // The time checks run in the worker (timeChecks.ts) and on any other machine's report (store.ts).
  it.each([
    ['the worker\'s time checks', (racing: SuperTabStore, f: Awaited<ReturnType<typeof swarm>>) => racing.runTimeChecks(f.tab)],
    ['another machine\'s report', (racing: SuperTabStore, f: Awaited<ReturnType<typeof swarm>>) => f.observe('lead-host', [f.harness.lead], {}, racing)],
  ])('is not failed by %s that read its machine silent while that machine reported it preparing', async (_, sweep) => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const { startId } = await launch(f)
    f.clock.now += 4 * MINUTE
    await f.observe('test-host', [f.harness.worker], { preparingStartIds: [startId] })
    await f.observe('lead-host', [f.harness.lead])
    // Past MACHINE_FRESH_MS: the time checks read Worker Mac as silent; just before they write, it reports again.
    f.clock.now += 46_000
    let raced = false
    const racing = new SuperTabStore(beforeFirstWrite(db, async () => {
      if (raced) return
      raced = true
      await f.observe('test-host', [f.harness.worker], { preparingStartIds: [startId] })
    }), () => f.clock.now)
    await sweep(racing, f)
    expect(raced).toBe(true)
    expect((await f.timed.read(owner, f.tab)).state.starts!.find(s => s.id === startId)).toMatchObject({ error: null, preparing: true })
    expect((await db.superTabMessage.findMany({ where: { tabId: f.tab } })).filter(m => (m.source as { kind?: string } | null)?.kind === 'start-timeout')).toEqual([])
  })
})

describe('a task that stalls', () => {
  type Swarm = Awaited<ReturnType<typeof swarm>>
  /** The rows that woke the Lead for stalled tasks, each with the tasks it listed. */
  const stalledRows = async (f: Swarm) => (await db.superTabMessage.findMany({ where: { tabId: f.tab }, orderBy: { sequence: 'asc' } }))
    .filter(m => (m.source as { kind?: string } | null)?.kind === 'work-stalled')
  const liveness = async (f: Swarm, group = f.group) => (await f.timed.read(owner, f.tab)).state.conversations.find(c => c.id === group)!.liveness
  /** Both machines report, the worker's first with its screen changing (a clock jump spans many beats), then the Lead polls:
   *  its time checks run there. */
  const tick = async (f: Swarm, at: number) => {
    f.clock.now = at
    await f.observe('test-host', [f.harness.worker], { harnessProgress: { [f.harness.worker]: at } })
    await f.observe('lead-host', [f.harness.lead])
    return f.leadInbox()
  }
  /** A second task, with nobody on it yet, that the Lead routes and starts "Builder" for on Worker Mac. */
  const started = async (f: Swarm) => {
    const group = String((await f.execute({ type: 'conversation.create', title: 'Write the docs', brief: 'Document it',
      checks: [{ description: 'Read', independent: false }] })).result.conversationId)
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Small task.' },
      candidates: [{ id: 'c0', kind: 'new', machineId: 'test-host', engine: 'codex', model: 'fixture-model', effort: 'high',
        quality: 2, cost: 2, title: 'New agent', label: 'New agent' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    const routeDecisionId = String((await f.execute({ type: 'route.record', conversationId: group, decision } as Command, host, f.lead)).result.routeDecisionId)
    const request = { conversationId: group, machineId: 'test-host', engine: 'codex', model: 'fixture-model', effort: 'high', name: 'Builder',
      cwd: '/repo', worktree: false, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const startId = String((await f.execute({ type: 'agent.start', request, routeDecisionId } as Command, host, f.lead)).result.startId)
    return { group, startId }
  }

  it('is orphaned when its start fails, the Lead woken once by the failure notice, and stays so once the start is no longer loaded', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const { group, startId } = await started(f)
    // Its own machine reports the failure.
    await f.timed.execute(host, f.tab, { operationId: randomUUID(), command: { type: 'agent.startFailed', startId, error: 'Could not prepare the worktree' } as Command }, undefined, 'test-host')
    for (const minutes of [1, 15]) await tick(f, f.clock.now + minutes * MINUTE)
    expect(await liveness(f, group)).toMatchObject({ state: 'orphaned', why: 'start-failed' })
    const told = (await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: group } })).filter(m => m.text.startsWith('Could not start Builder'))
    expect(told).toHaveLength(1)
    expect(await stalledRows(f)).toEqual([])
  })

  it('is orphaned when a machine\'s report times its launched start out, and stays so once the start has ended', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const { group, startId } = await started(f)
    await f.timed.execute(host, f.tab, { operationId: randomUUID(), command: { type: 'agent.startDispatch', startId } as Command }, undefined, 'test-host')
    // Only the worker's machine reports: its time checks fail the start.
    f.clock.now += 3 * MINUTE + 1_000
    await f.observe('test-host', [f.harness.worker], { harnessProgress: { [f.harness.worker]: f.clock.now } })
    expect((await f.timed.read(owner, f.tab)).state.starts!.find(s => s.id === startId)!.error).not.toBeNull()
    expect(await liveness(f, group)).toMatchObject({ state: 'orphaned', why: 'start-failed' })
    await tick(f, f.clock.now + 5 * MINUTE)
    expect(await liveness(f, group)).toMatchObject({ state: 'orphaned', why: 'start-failed' })
    expect(await stalledRows(f)).toEqual([])
  })

})

/** Counts every Prisma operation a store makes through this client, as "Model.operation". */
function counting() {
  const ops: string[] = []
  const client = db.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
    ops.push(`${model}.${operation}`)
    return query(args)
  } } } }) as unknown as PrismaClient
  return { client, ops }
}

// Every running agent's host polls its deliveries each second (a production backend went to 5 pods on this, 2026-10-27):
// with nothing waiting the answer must cost one indexed read, and the Swarm is loaded only for the time checks, every 30 s.
describe('the delivery poll of an agent with nothing waiting', () => {
  it('reads one row, not the Swarm, until 30 seconds after its last full poll', async () => {
    const counted = counting()
    const f = await swarm({ client: counted.client })
    expect(await f.timed.deliveries(host, f.tab, f.lead)).toEqual([])
    counted.ops.length = 0
    f.clock.now += 29_999
    expect(await f.timed.deliveries(host, f.tab, f.lead)).toEqual([])
    expect(counted.ops).toEqual(['SuperTabDelivery.aggregateRaw'])
    counted.ops.length = 0
    f.clock.now += 1
    expect(await f.timed.deliveries(host, f.tab, f.lead)).toEqual([])
    // The Swarm's groups load through their indexes (parts/load.ts).
    expect(counted.ops).toContain('SwarmGroup.aggregateRaw')
  })

  it('sends the Lead no update request for work changes: its inbox stays empty five minutes on (#3593)', async () => {
    const f = await swarm()
    await f.leadInbox()
    f.clock.now += 5 * MINUTE
    expect(await f.leadInbox()).toEqual([])
  })

  it('delivers a message on the very next poll, within a second of the last one', async () => {
    const counted = counting()
    const f = await swarm({ client: counted.client })
    await f.timed.deliveries(host, f.tab, f.lead)
    f.clock.now += 1_000
    const sent = await f.execute({ type: 'message.send', conversationId: 'lead', text: 'Status?', replyTo: null, recipientIds: [] })
    f.clock.now += 1_000
    const rows = await f.timed.deliveries(host, f.tab, f.lead)
    expect(rows.map(d => d.messageId)).toEqual([sent.result.messageId])
  })

  // Behind a load balancer each poll may land on another pod: a memory of the last full poll per pod made every pod run its
  // own full polls, so the one-row answer held only as often as a host met the same pod twice (stability roadmap 2.4).
  it('answers from one indexed read on another server once any server ran the full poll, when they share the memory', async () => {
    const counted = counting()
    const shared = new Map<string, Polled>()
    const polls = { get: async (key: string) => shared.get(key), set: async (key: string, polled: Polled) => { shared.set(key, polled) } }
    const f = await swarm({ client: counted.client, hooks: { polls } })
    const other = new SuperTabStore(counted.client, () => f.clock.now, null, { polls })
    expect(await f.timed.deliveries(host, f.tab, f.lead)).toEqual([])
    counted.ops.length = 0
    f.clock.now += 1_000
    expect(await other.deliveries(host, f.tab, f.lead)).toEqual([])
    expect(counted.ops).toEqual(['SuperTabDelivery.aggregateRaw'])
  })

  it('runs the full checked poll each time while the shared memory cannot be read or written, and still answers', async () => {
    const counted = counting()
    const down = async () => { throw new Error('Redis unreachable') }
    const f = await swarm({ client: counted.client, hooks: { polls: { get: down, set: down } } })
    expect(await f.timed.deliveries(host, f.tab, f.lead)).toEqual([])
    counted.ops.length = 0
    f.clock.now += 1_000
    expect(await f.timed.deliveries(host, f.tab, f.lead)).toEqual([])
    // The Swarm's groups load through their indexes (parts/load.ts).
    expect(counted.ops).toContain('SwarmGroup.aggregateRaw')
    // A stranger still meets the authority checks, never a remembered answer.
    await expect(f.timed.deliveries(owner, f.tab, f.lead)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('never answers a caller who is not the agent\'s host from another caller\'s quiet poll, before or after it fails', async () => {
    const f = await swarm()
    await f.timed.deliveries(host, f.tab, f.lead)
    f.clock.now += 1_000
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.timed.deliveries(owner, f.tab, f.lead)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
  })
})

// A delivery its host cannot type yet (a permission prompt, a draft, an idle wait) stays claimed and held, possibly for hours,
// while the host polls each second (Diego, 10-28): the poll answers it from one indexed read while nothing it relied on moved.
describe('the delivery poll of an agent with a held delivery', () => {
  // The open deliveries, then the grant the host speaks for its agent under, read outside the Swarm (store.ts grantHolds):
  // its machine and, lent by host to owner here (an agent from before Swarm v3), the contributor and the share.
  const HELD_READS = ['SuperTabDelivery.aggregateRaw', 'Machine.findFirst', 'User.findUnique', 'MachineShare.findUnique']
  /** A person's message to the Lead, read by a full poll, claimed and held by its host. */
  const held = async (f: Awaited<ReturnType<typeof swarm>>) => {
    const sent = await f.execute({ type: 'message.send', conversationId: 'lead', text: 'Status?', replyTo: null, recipientIds: [] })
    const [row] = await f.timed.deliveries(host, f.tab, f.lead)
    expect(row!.messageId).toBe(sent.result.messageId)
    await f.timed.delivery(host, f.tab, f.lead, row!.id, { type: 'claim', claimId: 'claim-1' })
    await f.timed.delivery(host, f.tab, f.lead, row!.id, { type: 'hold', claimId: 'claim-1', reason: 'team_waiting_user' })
    return row!
  }

  it('answers the next poll without loading the Swarm: its open deliveries and its host\'s grant, each one indexed read', async () => {
    const counted = counting()
    const f = await swarm({ client: counted.client, lent: true })
    const row = await held(f)
    f.clock.now += 1_000
    await f.timed.deliveries(host, f.tab, f.lead)
    counted.ops.length = 0
    f.clock.now += 1_000
    const rows = await f.timed.deliveries(host, f.tab, f.lead)
    expect(counted.ops).toEqual(HELD_READS)
    expect(rows.map(r => [r.id, r.status, r.holdReason])).toEqual([[row.id, 'claimed', 'team_waiting_user']])
  })

  // Spec 2026-11-02 poll cost, Part 3.4: a host asks about its journal's entries; the answer is the delivery's own row.
  it('answers a receipt from its row and the machine, loading no Swarm parts', async () => {
    const counted = counting()
    const f = await swarm({ client: counted.client })
    const sent = await f.execute({ type: 'message.send', conversationId: f.group, text: 'Status?', replyTo: null, recipientIds: [f.worker] })
    const row = (await f.timed.deliveries(host, f.tab, f.worker)).find(r => r.messageId === sent.result.messageId)!
    counted.ops.length = 0
    expect(await f.timed.deliveryReceipt(host, f.tab, f.worker, row.id)).toEqual({ id: row.id, status: 'queued' })
    expect(counted.ops.filter(op => /^Swarm(Head|Member|Agent|Group|Machine|Start|Progress)\./.test(op))).toEqual([])
  })

  it('answers a worker\'s held delivery from the same reads', async () => {
    const counted = counting()
    const f = await swarm({ client: counted.client, lent: true })
    const sent = await f.execute({ type: 'message.send', conversationId: f.group, text: 'Status?', replyTo: null, recipientIds: [f.worker] })
    const full = await f.timed.deliveries(host, f.tab, f.worker)
    const row = full.find(r => r.messageId === sent.result.messageId)!
    await f.timed.delivery(host, f.tab, f.worker, row.id, { type: 'claim', claimId: 'claim-1' })
    await f.timed.delivery(host, f.tab, f.worker, row.id, { type: 'hold', claimId: 'claim-1', reason: 'team_waiting_draft' })
    counted.ops.length = 0
    f.clock.now += 1_000
    const rows = await f.timed.deliveries(host, f.tab, f.worker)
    expect(counted.ops).toEqual(HELD_READS)
    // Its assignment's delivery is open beside it, as the full poll found.
    expect(rows.map(r => r.id)).toEqual(full.map(r => r.id))
    expect(rows.find(r => r.id === row.id)!.holdReason).toBe('team_waiting_draft')
  })

  it('reads in full once another delivery arrives, and returns both', async () => {
    const f = await swarm()
    const row = await held(f)
    f.clock.now += 1_000
    const next = await f.execute({ type: 'message.send', conversationId: 'lead', text: 'And now?', replyTo: null, recipientIds: [] })
    f.clock.now += 1_000
    expect((await f.timed.deliveries(host, f.tab, f.lead)).map(r => r.messageId)).toEqual([row.messageId, next.result.messageId])
  })

  /** Another open delivery beside `row`, written alone, as a write that changes no Swarm part would: the stamp stays. A listed
   *  row also says whether it waits for its agent's turn end (turnEnd.ts), which is not stored. */
  const beside = (row: SuperTabDelivery & { waitsForTurnEnd?: boolean }, changes: Partial<SuperTabDelivery> = {}) => db.superTabDelivery.create({ data: {
    ...withoutListFields(row), id: randomUUID(), messageId: randomUUID(), status: 'queued', claimId: null, holdReason: null, holdSince: null,
    createdAt: new Date(row.createdAt.getTime() + 1), updatedAt: undefined, ...changes } })

  const withoutListFields = ({ waitsForTurnEnd: _waits, ...stored }: SuperTabDelivery & { waitsForTurnEnd?: boolean }): SuperTabDelivery => stored

  it('reads in full for a delivery the last full poll never saw, even with the stamp unchanged', async () => {
    const f = await swarm()
    const row = await held(f)
    f.clock.now += 1_000
    const added = await beside(row)
    expect((await f.timed.deliveries(host, f.tab, f.lead)).map(r => r.id)).toEqual([row.id, added.id])
  })

  it('never returns an open delivery the full poll did not let reach the agent', async () => {
    const f = await swarm()
    const row = await held(f)
    const stale = await beside(row, { membershipGeneration: 'an-earlier-membership' })
    f.clock.now += 1_000
    expect((await f.timed.deliveries(host, f.tab, f.lead)).map(r => r.id)).toEqual([row.id])
    f.clock.now += 1_000
    expect((await f.timed.deliveries(host, f.tab, f.lead)).map(r => r.id)).not.toContain(stale.id)
  })

  // A Swarm write is what revokes a member, an agent or a conversation's audience: it moves the stamp the held answer was read at.
  it('stops returning an agent\'s held delivery on the next poll once it leaves the conversation', async () => {
    const f = await swarm()
    const helper = await f.add(f.group, 'test-host', f.harness.other, 'Helper')
    await f.execute({ type: 'message.send', conversationId: f.group, text: 'Status?', replyTo: null, recipientIds: [helper] })
    const [row] = await f.timed.deliveries(host, f.tab, helper)
    await f.timed.delivery(host, f.tab, helper, row!.id, { type: 'claim', claimId: 'claim-1' })
    await f.timed.delivery(host, f.tab, helper, row!.id, { type: 'hold', claimId: 'claim-1', reason: 'team_waiting_draft' })
    f.clock.now += 1_000
    await f.execute({ type: 'conversation.agent', conversationId: f.group, agentId: helper, present: false, lead: false })
    f.clock.now += 1_000
    expect(await f.timed.deliveries(host, f.tab, helper)).toEqual([])
  })

  it('reads in full after any Swarm write, even one that sends the agent nothing', async () => {
    const counted = counting()
    const f = await swarm({ client: counted.client })
    const row = await held(f)
    f.clock.now += 1_000
    await f.execute({ type: 'tab.rename', name: 'Renamed' })
    counted.ops.length = 0
    f.clock.now += 1_000
    expect((await f.timed.deliveries(host, f.tab, f.lead)).map(r => r.id)).toEqual([row.id])
    expect(counted.ops).toContain('SwarmGroup.aggregateRaw')
  })

  // What no Swarm write records (a machine share revoked, a machine gone) is read on every poll.
  it('refuses on the next poll once its host\'s machine share is revoked', async () => {
    const f = await swarm({ lent: true })
    await held(f)
    const share = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'lead-host' } })
    await db.machineShare.update({ where: { machineId: 'lead-host' }, data: { emails: [] } })
    try {
      f.clock.now += 1_000
      await expect(f.timed.deliveries(host, f.tab, f.lead)).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
    } finally {
      await db.machineShare.update({ where: { machineId: 'lead-host' }, data: { emails: share.emails } })
    }
  })

  // #2022: deliveries tied in their creation time stay in their conversation's order, in the held answer too.
  it('returns tied held deliveries in their conversation\'s order, without loading the Swarm', async () => {
    const counted = counting()
    const f = await swarm({ client: counted.client })
    const expectedIds = await threeMessagesToTheLead(f)
    const first = (await f.timed.deliveries(host, f.tab, f.lead)).filter(row => expectedIds.includes(row.messageId))
    expect(first).toHaveLength(3)
    await f.timed.delivery(host, f.tab, f.lead, first[0]!.id, { type: 'claim', claimId: 'claim-1' })
    await f.timed.delivery(host, f.tab, f.lead, first[0]!.id, { type: 'hold', claimId: 'claim-1', reason: 'team_waiting_user' })
    // The Lead's alone, so it reads their order (people do not read them).
    const page = (await f.timed.messages(host, f.tab, 'lead', {}, f.lead)).messages.filter(row => expectedIds.includes(row.id))
    f.clock.now += 1_000
    await f.timed.deliveries(host, f.tab, f.lead)
    // Stored later sequence first, so insertion order cannot stand in for the tie-break; no Swarm write, so the stamp stays.
    const tiedAt = new Date('2026-10-28T00:00:00.000Z')
    const stored = await db.superTabDelivery.findMany({ where: { tabId: f.tab, messageId: { in: expectedIds } } })
    await db.superTabDelivery.deleteMany({ where: { tabId: f.tab, messageId: { in: expectedIds } } })
    for (const id of [...page.map(row => row.id)].reverse()) {
      await db.superTabDelivery.create({ data: { ...stored.find(row => row.messageId === id)!, createdAt: tiedAt } })
    }
    counted.ops.length = 0
    f.clock.now += 1_000
    const held = (await f.timed.deliveries(host, f.tab, f.lead)).filter(row => expectedIds.includes(row.messageId))
    expect(counted.ops).not.toContain('SwarmGroup.aggregateRaw')
    expect(held.map(row => row.messageId)).toEqual(page.map(row => row.id))
  })

  it('never answers a team session from its person\'s held answer: the team session meets its own checks', async () => {
    const f = await swarm()
    await held(f)
    f.clock.now += 1_000
    const team: AuthUser = { ...host, harnessSessionId: 'team-elsewhere', harnessSessionKind: 'team', harnessComputerId: 'elsewhere' }
    await expect(f.timed.deliveries(team, f.tab, f.lead)).rejects.toMatchObject({ code: 'TEAM_SESSION_LIMITED' })
  })
})

// Hosts read an idle agent's deliveries only every 30 s once the server pushes (stability roadmap 2.4): each new one is
// announced to the machine its agent runs on, once its write commits, so the host reads it at once.
describe('the push for a new delivery', () => {
  it('keeps several messages batched for one recipient in conversation order, including equal timestamps', async () => {
    const f = await swarm()
    const expectedIds = await threeMessagesToTheLead(f)
    const first = (await f.timed.deliveries(host, f.tab, f.lead)).filter(row => expectedIds.includes(row.messageId))
    expect(first).toHaveLength(3)
    expect(new Set(first.map(row => row.messageId))).toEqual(new Set(expectedIds))
    // The Lead's alone, so it reads their order (people do not read them).
    const page = (await f.timed.messages(host, f.tab, 'lead', {}, f.lead)).messages.filter(row => expectedIds.includes(row.id))
    expect(page).toHaveLength(3)
    // In conversation order.
    expect(page[1]!.sequence).toBeGreaterThan(page[0]!.sequence)
    expect(page[2]!.sequence).toBeGreaterThan(page[1]!.sequence)
    expect(first.map(row => row.messageId)).toEqual(page.map(row => row.id))

    // Make the tie explicit, and store the rows later sequence first so insertion order cannot stand in for it, then read again.
    const tiedAt = new Date('2026-10-28T00:00:00.000Z')
    const stored = await db.superTabDelivery.findMany({ where: { tabId: f.tab, messageId: { in: expectedIds } } })
    await db.superTabDelivery.deleteMany({ where: { tabId: f.tab, messageId: { in: expectedIds } } })
    for (const id of [...page.map(row => row.id)].reverse()) {
      await db.superTabDelivery.create({ data: { ...stored.find(row => row.messageId === id)!, createdAt: tiedAt } })
    }
    const again = (await f.timed.deliveries(host, f.tab, f.lead)).filter(row => expectedIds.includes(row.messageId))
    expect(again.map(row => row.createdAt)).toEqual([tiedAt, tiedAt, tiedAt])
    expect(again.map(row => row.messageId)).toEqual(page.map(row => row.id))
  })

  const announcing = () => {
    const waiting: Array<{ machineId: string; tabId: string; agentId: string }> = []
    return { waiting, hooks: { deliveriesWaiting: (w: { machineId: string; tabId: string; agentId: string }) => { waiting.push(w) } } }
  }

  it('names the machine, Swarm and agent of a message\'s recipient once it is written', async () => {
    const { waiting, hooks } = announcing()
    const f = await swarm({ hooks })
    waiting.length = 0
    await f.execute({ type: 'message.send', conversationId: f.group, text: 'Status?', replyTo: null, recipientIds: [f.worker] })
    expect(waiting).toEqual([{ machineId: 'test-host', tabId: f.tab, agentId: f.worker }])
  })

  // The host reads as soon as it hears: a push heard before the commit would find nothing and wait 30 s for the next read.
  it('is heard only once its write has committed', async () => {
    let open = 0
    const client = new Proxy(db, { get(target, key, receiver) {
      if (key !== '$transaction') return Reflect.get(target, key, receiver)
      return async (body: unknown, options: unknown) => {
        open++
        try { return await (target.$transaction as (b: unknown, o: unknown) => Promise<unknown>)(body, options) } finally { open-- }
      }
    } }) as PrismaClient
    const heard: number[] = []
    const f = await swarm({ client, hooks: { deliveriesWaiting: () => { heard.push(open) } } })
    heard.length = 0
    await f.execute({ type: 'message.send', conversationId: f.group, text: 'Status?', replyTo: null, recipientIds: [f.worker] })
    expect(heard).toEqual([0])
  })

  // Spec 2026-11-02 poll cost, Part 3.2: a held delivery is read only every 30 s, so ending it must say so at once.
  // Final review, Important 4: a host holds a claimed delivery locally for 30 s before it says `hold`.
  it('tells the machine when a claimed delivery, not yet held, is answered by its agent', async () => {
    const { waiting, hooks } = announcing()
    const f = await swarm({ hooks })
    const sent = await f.execute({ type: 'message.send', conversationId: f.group, text: 'Status?', replyTo: null, recipientIds: [f.worker] })
    const row = (await f.timed.deliveries(host, f.tab, f.worker)).find(r => r.messageId === sent.result.messageId)!
    await f.timed.delivery(host, f.tab, f.worker, row.id, { type: 'claim', claimId: 'claim-1' })
    waiting.length = 0
    await f.execute({ type: 'message.send', conversationId: f.group, text: 'Done.', replyTo: sent.result.messageId as string, recipientIds: [] }, host, f.worker)
    expect(waiting).toContainEqual({ machineId: 'test-host', tabId: f.tab, agentId: f.worker })
  })

  // Cleo, reviewing #2632: each agent reply answers a delivery, and each machine told reads that agent's list.
  describe('ending deliveries tells only the machines holding what ended', () => {
    const claimedFor = async (f: Awaited<ReturnType<typeof swarm>>, agentId: string, text: string, claimId: string) => {
      const sent = await f.execute({ type: 'message.send', conversationId: f.group, text, replyTo: null, recipientIds: [agentId] })
      const row = (await f.timed.deliveries(host, f.tab, agentId)).find(r => r.messageId === sent.result.messageId)!
      await f.timed.delivery(host, f.tab, agentId, row.id, { type: 'claim', claimId })
      return sent.result.messageId as string
    }

    it('an agent answering one delivery tells its own machine, not another agent\'s holding a claim', async () => {
      const { waiting, hooks } = announcing()
      const f = await swarm({ hooks })
      const forWorker = await claimedFor(f, f.worker, 'For the worker', 'claim-worker')
      await claimedFor(f, f.lead, 'For the lead', 'claim-lead')
      waiting.length = 0
      await f.execute({ type: 'message.send', conversationId: f.group, text: 'Done.', replyTo: forWorker, recipientIds: [f.lead] }, host, f.worker)
      expect(waiting).toContainEqual({ machineId: 'test-host', tabId: f.tab, agentId: f.worker })
      // The reply, naming the Lead (#2963), waits for the Lead's digest (#3387): no host is told of it, nor again for the claim it holds.
      expect(waiting.filter(w => w.agentId === f.lead)).toHaveLength(0)
    })

    /** A conversation with no task in it, so its agent may leave and it may be archived, with a claimed delivery of the worker's. */
    const asideWithClaim = async (f: Awaited<ReturnType<typeof swarm>>) => {
      const other = (await f.execute({ type: 'conversation.create', title: 'Aside', brief: 'On the side', checks: [] })).result.conversationId as string
      await f.execute({ type: 'conversation.agent', conversationId: other, agentId: f.worker, present: true, lead: false })
      const aside = await f.execute({ type: 'message.send', conversationId: other, text: 'Aside', replyTo: null, recipientIds: [f.worker] })
      const row = (await f.timed.deliveries(host, f.tab, f.worker)).find(r => r.messageId === aside.result.messageId)!
      await f.timed.delivery(host, f.tab, f.worker, row.id, { type: 'claim', claimId: 'claim-worker' })
      return other
    }

    it('an agent leaving a conversation tells its machine, not another\'s', async () => {
      const { waiting, hooks } = announcing()
      const f = await swarm({ hooks })
      const other = await asideWithClaim(f)
      await claimedFor(f, f.lead, 'For the lead', 'claim-lead')
      waiting.length = 0
      await f.execute({ type: 'conversation.agent', conversationId: other, agentId: f.worker, present: false, lead: false })
      expect(waiting).toContainEqual({ machineId: 'test-host', tabId: f.tab, agentId: f.worker })
      expect(waiting).not.toContainEqual({ machineId: 'lead-host', tabId: f.tab, agentId: f.lead })
    })

    it('a conversation archived tells those holding its deliveries, not one holding another conversation\'s', async () => {
      const { waiting, hooks } = announcing()
      const f = await swarm({ hooks })
      const other = await asideWithClaim(f)
      await claimedFor(f, f.lead, 'For the lead', 'claim-lead')
      waiting.length = 0
      await f.execute({ type: 'conversation.archive', conversationId: other, archived: true })
      expect(waiting).toContainEqual({ machineId: 'test-host', tabId: f.tab, agentId: f.worker })
      expect(waiting).not.toContainEqual({ machineId: 'lead-host', tabId: f.tab, agentId: f.lead })
    })

    it('nothing ended tells nobody', async () => {
      const { waiting, hooks } = announcing()
      const f = await swarm({ hooks })
      const other = (await f.execute({ type: 'conversation.create', title: 'Empty', brief: 'On the side', checks: [] })).result.conversationId as string
      await f.execute({ type: 'conversation.agent', conversationId: other, agentId: f.worker, present: true, lead: false })
      await claimedFor(f, f.lead, 'For the lead', 'claim-lead')
      waiting.length = 0
      await f.execute({ type: 'conversation.agent', conversationId: other, agentId: f.worker, present: false, lead: false })
      expect(waiting).toEqual([])
    })
  })

  it('tells the machine when a held delivery is answered by its agent', async () => {
    const { waiting, hooks } = announcing()
    const f = await swarm({ hooks })
    const sent = await f.execute({ type: 'message.send', conversationId: f.group, text: 'Status?', replyTo: null, recipientIds: [f.worker] })
    const row = (await f.timed.deliveries(host, f.tab, f.worker)).find(r => r.messageId === sent.result.messageId)!
    await f.timed.delivery(host, f.tab, f.worker, row.id, { type: 'claim', claimId: 'claim-1' })
    await f.timed.delivery(host, f.tab, f.worker, row.id, { type: 'hold', claimId: 'claim-1', reason: 'team_waiting_draft' })
    waiting.length = 0
    await f.execute({ type: 'message.send', conversationId: f.group, text: 'Done.', replyTo: sent.result.messageId as string, recipientIds: [] }, host, f.worker)
    expect(waiting).toContainEqual({ machineId: 'test-host', tabId: f.tab, agentId: f.worker })
  })

  it('tells the machine when a terminal request waits for its agent', async () => {
    const heard: Array<{ machineId: string; tabId: string; agentId: string }> = []
    const f = await swarm({ hooks: { terminalWaiting: w => { heard.push(w) } } })
    await f.execute({ type: 'agent.screen', agentId: f.worker, scrollback: 50 })
    expect(heard).toEqual([{ machineId: 'test-host', tabId: f.tab, agentId: f.worker }])
  })
})

// Diego's review of 10-28, item 1: every write of the full poll is the Lead's, so a worker's poll only reads. Through the
// read cache, with no transaction: 20 workers were 40 whole-Swarm loads, clones and empty commits a minute. Each test holds
// the Swarm in the cache first, as every reader of a busy Swarm finds it; a miss reads it once for all of them.
describe('a worker\'s delivery poll', () => {
  const counting = () => {
    const opened = { count: 0 }
    const client = new Proxy(db, { get(target, key, receiver) {
      if (key !== '$transaction') return Reflect.get(target, key, receiver)
      return (body: unknown, options: unknown) => {
        opened.count++
        return (target.$transaction as (b: unknown, o: unknown) => Promise<unknown>)(body, options)
      }
    } }) as PrismaClient
    return { opened, client }
  }

  it('opens no transaction and returns the worker\'s open deliveries', async () => {
    const { opened, client } = counting()
    const f = await swarm({ client })
    const sent = await f.execute({ type: 'message.send', conversationId: f.group, text: 'Status?', replyTo: null, recipientIds: [f.worker] })
    await f.timed.readLoad(host, f.tab)
    opened.count = 0
    const rows = await f.timed.deliveries(host, f.tab, f.worker)
    expect(opened.count).toBe(0)
    expect(rows.map(r => r.messageId)).toContain(sent.result.messageId)
    expect(rows.every(r => r.agentId === f.worker)).toBe(true)
  })

  it('still runs the Lead\'s poll in one transaction', async () => {
    const { opened, client } = counting()
    const f = await swarm({ client })
    await f.timed.readLoad(host, f.tab)
    opened.count = 0
    await f.timed.deliveries(host, f.tab, f.lead)
    expect(opened.count).toBe(1)
  })
})

describe('an agent closed on its machine', () => {
  const agents = async (f: Awaited<ReturnType<typeof swarm>>) => (await f.timed.read(owner, f.tab)).state.agents
  const ids = async (f: Awaited<ReturnType<typeof swarm>>) => (await agents(f)).map(a => a.id)
  type Fixture = Awaited<ReturnType<typeof swarm>>
  /** Both machines report every 5 seconds for `seconds`; the worker host lists `running` and `stopped`. */
  const reports = async (f: Fixture, seconds: number, running: string[], stopped: string[] = [], store?: SuperTabStore) => {
    for (let t = 0; t < seconds; t += 5) {
      f.clock.now += 5_000
      await f.observe('lead-host', [f.harness.lead])
      await f.observe('test-host', running, { stoppedHarnessIds: stopped }, store)
    }
  }
  const closing = async (f: Fixture) => (await rosterRows(f.timed, host, 'test-host')).filter(r => r.tabId === f.tab && 'closeSession' in r)

  it('leaves the list when its machine keeps reporting its session stopped, never on the first report', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const idle = await f.add(f.group, 'test-host', f.harness.other, 'Idle one')
    expect(await ids(f)).toContain(idle)
    await reports(f, 5, [f.harness.worker], [f.harness.other])
    expect(await ids(f)).toContain(idle)
    await reports(f, 20, [f.harness.worker], [f.harness.other])
    expect(await ids(f)).toContain(idle)
    await reports(f, 10, [f.harness.worker], [f.harness.other])
    expect(await ids(f)).toEqual([f.lead, f.worker])
    const group = (await f.timed.read(owner, f.tab)).state.conversations.find(c => c.id === f.group)!
    expect(group.agentIds).not.toContain(idle)
  })

  it('has its host close the session it leaves (security reviews of #2569)', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const idle = await f.add(f.group, 'test-host', f.harness.other, 'Idle one')
    await reports(f, 40, [f.harness.worker], [f.harness.other])
    expect(await ids(f)).not.toContain(idle)
    expect(await closing(f)).toEqual([expect.objectContaining({ agent: expect.objectContaining({ id: idle, harnessId: f.harness.other }) })])
    await f.execute({ type: 'agent.sessionClosed', agentId: idle, harnessId: f.harness.other } as Command, host)
    expect(await closing(f)).toEqual([])
  })

  it('keeps an agent that holds a task, which no report loses, and removes it once the Lead cancels the task', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    f.clock.now += MINUTE
    await f.observe('lead-host', [f.harness.lead])
    await f.observe('test-host', [], { stoppedHarnessIds: [f.harness.worker] })
    expect(await f.assignment()).not.toMatchObject({ status: 'lost' })
    expect((await f.leadInbox()).some(m => (m.source as { kind?: string }).kind === 'work-lost')).toBe(false)
    await reports(f, 60, [], [f.harness.worker])
    expect(await f.assignment()).not.toMatchObject({ status: 'lost' })
    expect(await ids(f)).toContain(f.worker)
    await f.execute({ type: 'work.cancel', conversationId: f.group, assignmentId: f.assignmentId, reason: 'Not needed' })
    await reports(f, 10, [], [f.harness.worker])
    expect(await ids(f)).toEqual([f.lead])
  })

  it('stays when it was kept, and shows as down; a coordinator or a running session stays too', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const kept = await f.add(f.group, 'test-host', f.harness.other, 'Kept one')
    await f.execute({ type: 'agent.release', agentId: kept, decision: 'keep' })
    await reports(f, 60, [f.harness.worker], [f.harness.other])
    // The Lead's session is in its machine's stopped list; the worker's is running.
    for (let i = 0; i < 12; i++) {
      f.clock.now += 5_000
      await f.observe('lead-host', [], { stoppedHarnessIds: [f.harness.lead] })
      await f.observe('test-host', [f.harness.worker], { stoppedHarnessIds: [f.harness.other] })
    }
    expect((await ids(f)).sort()).toEqual([f.lead, f.worker, kept].sort())
    expect((await agents(f)).find(a => a.id === kept)).toMatchObject({ workDecision: 'keep', downSince: expect.any(String) })
  })

  it('stays when its session is in both lists, as a host resuming it reports', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    await reports(f, 60, [f.harness.worker], [f.harness.worker])
    expect(await ids(f)).toContain(f.worker)
  })

  it('stays when a stop was asked for: its host closes it and takes it out', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const idle = await f.add(f.group, 'test-host', f.harness.other, 'Idle one')
    await f.execute({ type: 'agent.release', agentId: idle, decision: 'stop' })
    await reports(f, 60, [f.harness.worker], [f.harness.other])
    expect(await ids(f)).toContain(idle)
    expect(await closing(f)).toEqual([])
  })

  it('stays when its host lists it stopped for a moment and then running again, as after a restart', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const idle = await f.add(f.group, 'test-host', f.harness.other, 'Idle one')
    await reports(f, 25, [f.harness.worker], [f.harness.other])
    await reports(f, 5, [f.harness.worker, f.harness.other])
    await reports(f, 25, [f.harness.worker], [f.harness.other])
    expect(await ids(f)).toContain(idle)
  })

  it('leaves after 15 minutes down while its machine keeps reporting without it, never on the first report after silence', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const idle = await f.add(f.group, 'test-host', f.harness.other, 'Idle one')
    await f.observe('test-host', [f.harness.worker, f.harness.other])
    // Down from here, in no stopped list: the host just does not list it. Reports come every 15 seconds.
    const report = async (seconds = 15) => {
      f.clock.now += seconds * 1000
      await f.observe('lead-host', [f.harness.lead])
      await f.observe('test-host', [f.harness.worker])
    }
    for (let i = 0; i < 24; i++) await report()
    expect(await ids(f)).toContain(idle)
    // Silent past 15 minutes, then back: not removed on the report that ends the silence, nor soon after.
    await report(15 * 60)
    await report()
    expect(await ids(f)).toContain(idle)
    // The full report that follows (at least every two minutes) removes it.
    for (let i = 0; i < 10; i++) await report()
    expect(await ids(f)).not.toContain(idle)
    expect(await ids(f)).toContain(f.worker)
    expect(await closing(f)).toHaveLength(1)
  })

  it('removes nobody by time while its machine lists no session running (a fault in its listing)', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const idle = await f.add(f.group, 'test-host', f.harness.other, 'Idle one')
    await reports(f, 20 * 60, [])
    expect(await ids(f)).toContain(idle)
  })

  // A session its machine lists stopped takes no task at all (closedAgents.ts sessionClosed, task #2744); one it has only
  // stopped listing can still be assigned while the report that removes it after DOWN_REMOVE_MS is being written.
  it('does not lose an assignment that lands while it is being removed (the report retries against it)', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const idle = await f.add(f.group, 'test-host', f.harness.other, 'Idle one')
    const second = String((await f.execute({ type: 'conversation.create', title: 'Second', brief: 'More', checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
    await reports(f, DOWN_REMOVE_MS / 1000, [f.harness.worker])
    let raced = false
    const racing = new SuperTabStore(beforeFirstWrite(db, async () => {
      if (raced) return
      raced = true
      await f.execute({ type: 'work.assign', conversationId: second, agentId: idle })
    }), () => f.clock.now)
    await reports(f, 10, [f.harness.worker], [], racing)
    expect(raced).toBe(true)
    const state = (await f.timed.read(owner, f.tab)).state
    const group = state.conversations.find(c => c.id === second)!
    expect(group.assignment).toMatchObject({ agentId: idle })
    expect(state.agents.map(a => a.id)).toContain(idle)
    expect(group.agentIds).toContain(idle)
    expect(await closing(f)).toEqual([])
  })
})

// Huy, 2026-11-02 (task #2131, after #2569): once a closed agent left the list, reopening its session left it outside the Swarm until
// someone added it from Desktop. The removal keeps a record in its machine's part, and that machine's own report brings it back.
describe('a session reopened after its agent was removed', () => {
  const state = async (f: Awaited<ReturnType<typeof swarm>>) => (await f.timed.read(owner, f.tab)).state
  const machinePart = async (f: { tab: string }, machineId: string) => (await db.swarmMachine.findFirstOrThrow({ where: { tabId: f.tab, key: machineId } })).data as { removedSessions?: Array<Record<string, any>> }
  /** A Swarm with an idle agent of a role, in the task's group, that its machine's report just removed. */
  async function removed(over: Record<string, unknown> = {}, lent = false) {
    const f = await swarm({ lent })
    await f.beat(f.clock.now)
    const idle = await f.add(f.group, 'test-host', f.harness.other, 'Idle one')
    const row = await db.swarmAgent.findFirstOrThrow({ where: { tabId: f.tab, key: idle } })
    await db.swarmAgent.update({ where: { id: row.id }, data: { data: { ...row.data as object, roleName: 'Reviewer', ...over } } })
    // A session listed stopped leaves once it has stayed so, by a machine that keeps reporting (closedAgents.ts STOPPED_REMOVE_MS).
    for (let seconds = 0; seconds < 35; seconds += 5) {
      f.clock.now += 5_000
      await f.observe('lead-host', [f.harness.lead])
      await f.observe('test-host', [f.harness.worker], { stoppedHarnessIds: [f.harness.other] })
    }
    expect((await state(f)).agents.map(a => a.id)).not.toContain(idle)
    return { ...f, idle }
  }
  const resume = (f: Awaited<ReturnType<typeof removed>>) => { f.clock.now += MINUTE; return f.observe('test-host', [f.harness.worker, f.harness.other]) }
  const patchRecord = async (f: Awaited<ReturnType<typeof removed>>, change: (record: Record<string, any>) => void) => {
    const row = await db.swarmMachine.findFirstOrThrow({ where: { tabId: f.tab, key: 'test-host' } })
    const data = structuredClone(row.data) as { removedSessions: Array<Record<string, any>> }
    change(data.removedSessions[0]!)
    await db.swarmMachine.update({ where: { id: row.id }, data: { data: data as object } })
  }

  it('is listed again with its group, role and configuration, once, and its record goes', async () => {
    const f = await removed()
    await resume(f)
    const read = await state(f), back = read.agents.find(a => a.id === f.idle)!
    expect(back).toMatchObject({ harnessId: f.harness.other, machineId: 'test-host', name: 'Idle one', roleName: 'Reviewer', configuration: config })
    expect(back.downSince).toBeUndefined()
    expect(read.conversations.find(c => c.id === f.group)!.agentIds).toContain(f.idle)
    expect((await machinePart(f, 'test-host')).removedSessions ?? []).toEqual([])
    await resume(f)
    expect((await state(f)).agents.filter(a => a.id === f.idle)).toHaveLength(1)
  })

  // Reviews of #2207 (Cleo, Orion, Luna, Echo): a report closed and reopened sessions with no row, so an agent could come back to
  // read its chats unrecorded. Each chat it leaves or rejoins says so, written as the agent, waking nobody.
  it('says in its group that it left when its session closed, and that it rejoined when the session reopened', async () => {
    const f = await removed()
    const said = async () => (await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: f.group }, orderBy: { sequence: 'asc' } }))
      .filter(m => m.text.startsWith('"Idle one"')).map(m => [m.text, m.recipientIds])
    expect(await said()).toEqual([['"Idle one" left: its session closed.', []]])
    await resume(f)
    expect(await said()).toEqual([['"Idle one" left: its session closed.', []], ['"Idle one" rejoined: its session reopened.', []]])
    // A report that changes nothing says nothing again.
    await resume(f)
    expect(await said()).toHaveLength(2)
  })

  it('stays out while the report does not list it running', async () => {
    const f = await removed()
    f.clock.now += MINUTE
    await f.observe('test-host', [f.harness.worker])
    expect((await state(f)).agents.map(a => a.id)).not.toContain(f.idle)
    expect((await machinePart(f, 'test-host')).removedSessions).toHaveLength(1)
  })

  it('comes back only from its own machine: another machine\'s report leaves it out, and a stranger\'s is refused', async () => {
    const f = await removed()
    f.clock.now += MINUTE
    await f.observe('lead-host', [f.harness.lead, f.harness.other])
    expect((await state(f)).agents.map(a => a.id)).not.toContain(f.idle)
    expect((await machinePart(f, 'test-host')).removedSessions).toHaveLength(1)
    const generation = (await poolRows(f.timed, host, 'test-host')).find(p => p.tabId === f.tab)!.machine.generation
    await expect(f.timed.observeMachine(owner, f.tab, 'test-host', { generation, tools: [], quotas: [], resources: {} as never,
      runningHarnessIds: [f.harness.other], stoppedHarnessIds: [] } as never)).rejects.toBeTruthy()
    expect((await state(f)).agents.map(a => a.id)).not.toContain(f.idle)
    expect((await machinePart(f, 'test-host')).removedSessions).toHaveLength(1)
  })

  it('no command brings it back: nothing a person or an agent sends names the record', async () => {
    const f = await removed()
    await expect(f.execute({ type: 'agent.rejoin', machineId: 'test-host', harnessId: f.harness.other } as unknown as Command)).rejects.toBeTruthy()
    expect((await state(f)).agents.map(a => a.id)).not.toContain(f.idle)
  })

  it('is told only to its own machine\'s host, and is in no person\'s read', async () => {
    const f = await removed()
    expect((await poolRows(f.timed, host, 'test-host')).find(p => p.tabId === f.tab)).toMatchObject({ removedHarnessIds: [f.harness.other] })
    expect((await poolRows(f.timed, host, 'lead-host')).find(p => p.tabId === f.tab)!.removedHarnessIds ?? []).toEqual([])
    expect(JSON.stringify(await state(f))).not.toContain('removedSessions')
    expect(JSON.stringify(await f.timed.read(host, f.tab))).not.toContain('removedSessions')
  })

  it('keeps no record of an agent someone asked to stop, or a confidential one', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const stop = await f.add(f.group, 'test-host', f.harness.other, 'Stop one')
    await f.execute({ type: 'agent.release', agentId: stop, decision: 'stop' })
    f.clock.now += MINUTE
    await f.observe('lead-host', [f.harness.lead])
    await f.observe('test-host', [f.harness.worker], { stoppedHarnessIds: [f.harness.other] })
    expect((await machinePart(f, 'test-host')).removedSessions ?? []).toEqual([])
    const secret = await removed({ confidential: true })
    expect((await machinePart(secret, 'test-host')).removedSessions ?? []).toEqual([])
  })

  it('keeps no record of a session that reads a private chat, though nothing marked it confidential', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const idle = await f.add(f.group, 'test-host', f.harness.other, 'Idle one')
    const group = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.group } })
    await db.swarmGroup.update({ where: { id: group.id }, data: { data: { ...group.data as object, audience: { kind: 'people', people: [{ id: owner.sub }] } } } })
    for (let seconds = 0; seconds < 35; seconds += 5) {
      f.clock.now += 5_000
      await f.observe('lead-host', [f.harness.lead])
      await f.observe('test-host', [f.harness.worker], { stoppedHarnessIds: [f.harness.other] })
    }
    expect((await state(f)).agents.map(a => a.id)).not.toContain(idle)
    expect((await machinePart(f, 'test-host')).removedSessions ?? []).toEqual([])
  })

  it.each([
    ['a machine owner who is not the report\'s', (r: Record<string, any>) => { r.agent.machineOwnerId = 'someone-else' }],
    ['a contributor no longer in the Swarm', (r: Record<string, any>) => { r.agent.contributorId = 'someone-else' }],
    ['its contributor left and came back', (r: Record<string, any>) => { r.agent.membershipGeneration = 'an-older-one' }],
    ['its project gone', (r: Record<string, any>) => { r.agent.projectId = 'no-such-project' }],
    ['a harness that does not match', (r: Record<string, any>) => { r.agent.harnessId = 'other-session' }],
  ])('is not restored with %s, and its record goes', async (_, change) => {
    const f = await removed()
    await patchRecord(f, change)
    await resume(f)
    expect((await state(f)).agents.map(a => a.id)).not.toContain(f.idle)
    expect((await machinePart(f, 'test-host')).removedSessions ?? []).toEqual([])
  })

  // A session lent through another person's machine share (before Swarm v3) never comes back to work on that computer: it is not
  // its person's own (task #4120), whatever its share grant says now.
  it('is not restored when it was lent through another person\'s share, and its record goes', async () => {
    const f = await removed({}, true)
    await resume(f)
    expect((await state(f)).agents.map(a => a.id)).not.toContain(f.idle)
    expect((await machinePart(f, 'test-host')).removedSessions ?? []).toEqual([])
  })

  it('does not come back into an archived group, a private chat, or one that is gone; it is listed all the same', async () => {
    const f = await removed()
    const open = String((await f.execute({ type: 'conversation.create', title: 'Open one', brief: 'b', checks: [] })).result.conversationId)
    await patchRecord(f, r => { r.groupIds = [f.group, open, 'no-such-group'] })
    await f.execute({ type: 'conversation.archive', conversationId: open, archived: true })
    const group = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.group } })
    await db.swarmGroup.update({ where: { id: group.id }, data: { data: { ...group.data as object, audience: { people: [] } } } })
    await resume(f)
    const read = await db.swarmGroup.findMany({ where: { tabId: f.tab, key: { in: [f.group, open] } } })
    for (const row of read) expect((row.data as { agentIds: string[] }).agentIds).not.toContain(f.idle)
    expect((await state(f)).agents.map(a => a.id)).toContain(f.idle)
  })

  it('leaves one added by hand meanwhile as it is, and one registered in another Swarm out', async () => {
    const f = await removed()
    const again = await f.add(f.group, 'test-host', f.harness.other, 'Added by hand')
    expect(again).toBe(f.idle)
    await resume(f)
    expect((await state(f)).agents.find(a => a.id === f.idle)!.name).toBe('Added by hand')
    expect((await machinePart(f, 'test-host')).removedSessions ?? []).toEqual([])

    const moved = await removed()
    const elsewhere = await swarm()
    await elsewhere.add(elsewhere.group, 'test-host', moved.harness.other, 'Elsewhere now')
    await resume(moved)
    expect((await state(moved)).agents.map(a => a.id)).not.toContain(moved.idle)
    expect((await machinePart(moved, 'test-host')).removedSessions ?? []).toEqual([])
  })

  // Rowan's review of #2569: the removal now also orders its host to close the session.
  it('stays open when it comes back before its host closed it: the close order goes with the record', async () => {
    const f = await removed()
    expect((await poolRows(f.timed, host, 'test-host')).length).toBeGreaterThan(0)
    const closing = () => db.swarmMachine.findFirstOrThrow({ where: { tabId: f.tab, key: 'test-host' } }).then(row => (row.data as { closingSessions: Array<{ harnessId: string }> }).closingSessions)
    expect((await closing()).map(c => c.harnessId)).toContain(f.harness.other)
    await resume(f)
    expect((await state(f)).agents.map(a => a.id)).toContain(f.idle)
    expect((await closing()).map(c => c.harnessId)).not.toContain(f.harness.other)
  })

  it('rejoins after its host closed it, once the session is opened again', async () => {
    const f = await removed()
    const row = await db.swarmMachine.findFirstOrThrow({ where: { tabId: f.tab, key: 'test-host' } })
    await db.swarmMachine.update({ where: { id: row.id }, data: { data: { ...row.data as object, closingSessions: [] } } })
    await resume(f)
    expect((await state(f)).agents.map(a => a.id)).toContain(f.idle)
  })

  it('never past a hold: a session its Team account is held for stays out, and the hold stands', async () => {
    const f = await removed()
    const row = await db.swarmMachine.findFirstOrThrow({ where: { tabId: f.tab, key: 'test-host' } })
    const data = structuredClone(row.data) as { closingSessions: Array<Record<string, unknown>> }
    for (const close of data.closingSessions) if (close.harnessId === f.harness.other) Object.assign(close, { heldFor: 'lead', since: f.clock.now })
    await db.swarmMachine.update({ where: { id: row.id }, data: { data: data as object } })
    await resume(f)
    expect((await state(f)).agents.map(a => a.id)).not.toContain(f.idle)
    const after = (await db.swarmMachine.findFirstOrThrow({ where: { tabId: f.tab, key: 'test-host' } })).data as { closingSessions: Array<Record<string, unknown>>; removedSessions?: unknown[] }
    expect(after.closingSessions.find(c => c.harnessId === f.harness.other)).toMatchObject({ heldFor: 'lead' })
    expect(after.removedSessions ?? []).toEqual([])
  })

  // Security review 1 of #2601: the record every Swarm registering this session writes (sessionScope.ts bindSession).
  it.each([
    ['withdrawn from this Swarm', (tab: string) => ({ releasedTabIds: [tab] })],
    ['being stopped', () => ({ stopReleaseId: 'release-1' })],
    ['tied to another private project', () => ({ privateScope: 'another-scope' })],
  ])('stays out of a session %s, and its record goes', async (_, fields) => {
    const f = await removed()
    const row = await db.superTab.findUniqueOrThrow({ where: { id: f.tab }, select: { autonomousEnv: true } })
    const scope = stableId('swarm-session', row.autonomousEnv, host.sub, f.idle)
    await db.superTabSessionScope.upsert({ where: { id: scope }, create: { id: scope, scopeIds: [], ...fields(f.tab) }, update: fields(f.tab) })
    await resume(f)
    expect((await state(f)).agents.map(a => a.id)).not.toContain(f.idle)
    expect((await machinePart(f, 'test-host')).removedSessions ?? []).toEqual([])
  })

  it('goes after 30 days, and with its machine', async () => {
    const f = await removed()
    f.clock.now += 31 * 24 * 60 * MINUTE
    await f.observe('test-host', [f.harness.worker])
    expect((await machinePart(f, 'test-host')).removedSessions ?? []).toEqual([])
    const g = await removed()
    await g.execute({ type: 'machine.remove', machineId: 'test-host' }, host)
    expect((await machinePart(g, 'test-host')).removedSessions ?? []).toEqual([])
  })
})
