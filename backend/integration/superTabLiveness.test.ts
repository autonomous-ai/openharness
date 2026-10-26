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
import * as parts from '../src/superTabs/parts/index.js'
import { poolRows } from './hostRows.test-support.js'
import { beforeFirstWrite } from './interleave.test-support.js'
import { SwarmReads } from '../src/superTabs/read/service.js'

// Work never sits with a dead owner: an active assignment whose agent died, stalled or hit a limit becomes lost within
// minutes, its old agent is fenced off, and the Lead is woken to hand it on. A fresh loopback replica set, created here.
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
async function swarm({ legacy = false } = {}) {
  let now = 10_000_000
  const timed = new SuperTabStore(db, () => now)
  const tab = (await timed.create(owner, randomUUID(), 'Liveness', legacy ? undefined : 'public')).id
  if (legacy) await dropProjects(tab)
  const execute = (command: Command, user = owner, asAgentId?: string) => timed.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  for (const [machineId, name] of [['lead-host', 'Lead Mac'], ['test-host', 'Worker Mac']]) {
    await execute({ type: 'machine.contribute', machineId: machineId!, name: name!, cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
  }
  const generations = new Map<string, string>()
  for (const machineId of ['lead-host', 'test-host']) generations.set(machineId, (await poolRows(timed, host, machineId)).find(p => p.tabId === tab)!.machine.generation)
  const harness = { lead: randomUUID(), worker: randomUUID(), other: randomUUID() }
  const add = async (conversationId: string, machineId: string, harnessId: string, name: string, lead = false) => String((await execute({ type: 'agent.add',
    conversationId, machineId, harnessId, name, configuration: config, lead })).result.agentId)
  const lead = await add('lead', 'lead-host', harness.lead, 'Lead', true)
  const group = String((await execute({ type: 'conversation.create', title: 'Ship the parser', brief: 'Implement it',
    checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
  const worker = await add(group, 'test-host', harness.worker, 'Worker')
  const assignmentId = String((await execute({ type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId)
  const observe = (machineId: string, running: string[], extra: Partial<MachineObservation> = {}) => timed.observeMachine(host, tab, machineId, {
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
  /** What the Lead's host receives now (this poll is also the Lead's wake-up path), with each row's text. */
  const leadInbox = async () => {
    const rows = await timed.deliveries(host, tab, lead)
    const messages = await db.superTabMessage.findMany({ where: { id: { in: rows.map(r => r.messageId) } } })
    return rows.map(r => messages.find(m => m.id === r.messageId)!)
  }
  const lostRows = async () => (await db.superTabMessage.findMany({ where: { tabId: tab }, orderBy: { sequence: 'asc' } }))
    .filter(m => (m.source as { kind?: string } | null)?.kind === 'work-lost')
  return { timed, tab, execute, lead, group, worker, assignmentId, harness, observe, beat, name, assignment, leadInbox, lostRows, add,
    clock: { get now() { return now }, set now(value: number) { now = value } } }
}

/** A Swarm created before projects existed. */
async function dropProjects(tab: string) {
  await db.$transaction(async tx => {
    const current = await parts.loadAll(tx, tab)
    const state = parts.reassemble(current)
    delete state.projects
    const version = Math.max(current.head.version, ...[...current.members, ...current.agents, ...current.groups, ...current.machines,
      ...current.starts, ...current.progress].map(p => p.version)) + 1
    for (const model of [tx.swarmHead, tx.swarmMember, tx.swarmAgent, tx.swarmGroup, tx.swarmMachine, tx.swarmStart, tx.swarmProgress] as unknown as
      Array<{ deleteMany(args: unknown): Promise<unknown> }>) await model.deleteMany({ where: { tabId: tab } })
    await parts.insertParts(tx, { ...parts.split(state, { tabId: tab, version, now: Date.now(), visibilityEpoch: current.visibilityEpoch }),
      sequenceBase: current.sequenceBase })
  })
}

describe('work that loses its owner', () => {
  // Final review, Important 3: routing keeps a lost task's worker out after the task is cancelled, from the mark on the agent.
  it('marks its worker in the same write that loses it, and the mark outlives a cancel in first loads and change reads', async () => {
    const f = await swarm()
    const reads = new SwarmReads(f.timed, { now: () => f.clock.now })
    await f.beat(f.clock.now)
    const { cursor } = await reads.firstLoad(owner, f.tab)
    f.clock.now += 2 * MINUTE + 5_000
    await f.observe('lead-host', [f.harness.lead])
    const lostAt = f.clock.now
    expect((await f.assignment()).status).toBe('lost')
    const [agentRow, groupRow] = [await db.swarmAgent.findFirst({ where: { tabId: f.tab, key: f.worker } }), await db.swarmGroup.findFirst({ where: { tabId: f.tab, key: f.group } })]
    // One commit stamps every part it writes alike: the worker's part was written with the lost task's.
    expect(agentRow!.changedAt.getTime()).toBe(groupRow!.changedAt.getTime())
    expect((agentRow!.data as { lostTask?: unknown }).lostTask).toBeDefined()
    f.clock.now += MINUTE
    await f.execute({ type: 'work.cancel', conversationId: f.group, assignmentId: f.assignmentId, reason: 'Not needed' })
    const mark = { conversationId: f.group, assignmentId: f.assignmentId, reason: 'its machine Worker Mac has been offline for 2 minutes', at: lostAt }
    const changed = await reads.changes(owner, f.tab, cursor)
    expect(changed.reload).toBe(false)
    expect('agents' in changed && changed.agents.find(a => a.key === f.worker)).toMatchObject({ data: { lostTask: mark } })
    expect((await reads.firstLoad(owner, f.tab)).agents.find(a => a.key === f.worker)!.data.lostTask).toEqual(mark)
  })

  it('is lost when its machine has been offline for 2 minutes, found by another machine\'s report', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const silent = f.clock.now
    // Only the Lead's machine keeps reporting. The time checks run on its reports, at most every 30 seconds.
    f.clock.now = silent + 90_000
    await f.observe('lead-host', [f.harness.lead])
    expect((await f.assignment()).status).toBe('working')
    f.clock.now = silent + 2 * MINUTE + 5_000
    await f.observe('lead-host', [f.harness.lead])
    expect(await f.assignment()).toMatchObject({ status: 'lost', lost: { reason: 'its machine Worker Mac has been offline for 2 minutes' } })
  })

  it('is not lost when a fresh report from its machine commits between the time checks\' read and their write', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    f.clock.now += 2 * MINUTE + 5_000
    // The Lead's poll reads the worker's machine as silent; just before it writes the loss, that machine reports.
    let raced = false
    const racing = new SuperTabStore(beforeFirstWrite(db, async () => {
      if (raced) return
      raced = true
      await f.observe('test-host', [f.harness.worker], { harnessProgress: { [f.harness.worker]: f.clock.now } })
    }), () => f.clock.now)
    await racing.deliveries(host, f.tab, f.lead)
    expect(raced).toBe(true)
    expect((await f.assignment()).status).toBe('working')
    expect(await f.lostRows()).toEqual([])
  })

  it('is lost at once when the host reports its session stopped, and the Lead is woken with who, why and the last result', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    await f.execute({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'working',
      result: 'Parser half done, pushed to https://github.com/example/project/pull/7' }, host, f.worker)
    f.clock.now += 3 * MINUTE
    await f.observe('test-host', [], { stoppedHarnessIds: [f.harness.worker] })
    expect(await f.assignment()).toMatchObject({ status: 'lost', lost: { reason: 'its session on Worker Mac stopped' } })
    const wake = (await f.leadInbox()).find(m => (m.source as { kind?: string }).kind === 'work-lost')!
    expect(wake.conversationId).toBe(f.group)
    expect(wake.text).toBe(`${await f.name(f.worker)} lost its task`+' "Ship the parser": its session on Worker Mac stopped. Last progress 3 minutes ago. '
      + 'Last result: Parser half done, pushed to https://github.com/example/project/pull/7. Assign it to another agent now, or cancel it.')
  })

  it('is lost at once when its agent hits a usage limit', async () => {
    const f = await swarm()
    await f.execute({ type: 'agent.alert', agentId: f.worker, alert: 'limit', active: true, resetAt: new Date(f.clock.now + 30 * MINUTE).toISOString() }, host, f.worker)
    expect(await f.assignment()).toMatchObject({ status: 'lost', lost: { reason: `it hit a usage limit until ${new Date(f.clock.now + 30 * MINUTE).toISOString().slice(11, 16)} UTC` } })
    expect((await f.leadInbox()).some(m => (m.source as { kind?: string }).kind === 'work-lost')).toBe(true)
  })

  it('is lost when its lease runs out with no progress, though its machine keeps reporting', async () => {
    const f = await swarm()
    const assigned = f.clock.now
    // The session is listed as running, but its screen has not changed for over half an hour.
    for (let minute = 1; minute <= 4; minute++) {
      f.clock.now = assigned + minute * MINUTE
      await f.beat(assigned - 31 * MINUTE)
    }
    f.clock.now = assigned + 5 * MINUTE
    await f.beat(assigned - 31 * MINUTE)
    expect(await f.lostRows()).toEqual([])
    await f.leadInbox()
    expect((await f.assignment()).status).toBe('working')
    f.clock.now = assigned + 5 * MINUTE + 1
    await f.leadInbox()
    expect(await f.assignment()).toMatchObject({ status: 'lost', lost: { reason: 'no progress for 5 minutes' } })
  })

  it('gives a session still running but quiet (a long silent test run) 30 minutes from its last progress', async () => {
    const f = await swarm()
    const progress = f.clock.now
    for (let minute = 1; minute <= 30; minute++) {
      f.clock.now = progress + minute * MINUTE
      await f.beat(progress)
      await f.leadInbox()
    }
    expect((await f.assignment()).status).toBe('working')
    f.clock.now = progress + 30 * MINUTE + 1
    await f.beat(progress)
    expect(await f.assignment()).toMatchObject({ status: 'lost', lost: { reason: 'no progress for 30 minutes' } })
  })

  it('keeps its lease while the host reports progress, an older host reports it running, or the agent reports', async () => {
    const f = await swarm()
    for (let minute = 1; minute <= 12; minute++) {
      f.clock.now += MINUTE
      // Minutes 1-4: screen changes; 5-8: an older host that sends no progress; 9-12: only the agent's own status.
      if (minute <= 4) await f.beat(f.clock.now - 10_000)
      else if (minute <= 8) await f.beat()
      else {
        await f.execute({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'working', result: `Minute ${minute}` }, host, f.worker)
        await f.observe('lead-host', [f.harness.lead])
        await f.observe('test-host', [f.harness.worker], { harnessProgress: {} })
      }
      await f.leadInbox()
      expect((await f.assignment()).status).toBe('working')
    }
    expect((await f.assignment()).leaseUntil).toBe(f.clock.now + 5 * MINUTE)
  })

  it('fences the old agent once lost: its status, checks and done are refused and it is told its task moved', async () => {
    const f = await swarm()
    const check = (await f.timed.read(owner, f.tab)).state.conversations.find(c => c.id === f.group)!.checks[0]!.id
    await f.observe('test-host', [], { stoppedHarnessIds: [f.harness.worker] })
    for (const command of [
      { type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'working', result: null },
      { type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'done', result: 'Shipped' },
      { type: 'work.check', conversationId: f.group, assignmentId: f.assignmentId, checkId: check, passed: true, evidence: 'Ran it' },
    ] as Command[]) await expect(f.execute(command, host, f.worker)).rejects.toMatchObject({ code: 'ASSIGNMENT_LOST' })
    const told = await f.timed.deliveries(host, f.tab, f.worker)
    const notice = (await db.superTabMessage.findMany({ where: { id: { in: told.map(d => d.messageId) } } }))
      .find(m => (m.source as { kind?: string }).kind === 'work-lost')!
    expect(notice.text).toBe('Your task "Ship the parser" moved: its session on Worker Mac stopped. Stop working on it; your status and results for it are no longer accepted.')
  })

  it('lets the Lead assign the lost work to another agent, and keeps the old one fenced', async () => {
    const f = await swarm()
    await f.observe('test-host', [], { stoppedHarnessIds: [f.harness.worker] })
    const other = await f.add(f.group, 'test-host', f.harness.other, 'Other')
    const next = String((await f.execute({ type: 'work.assign', conversationId: f.group, agentId: other })).result.assignmentId)
    expect(await f.assignment()).toMatchObject({ id: next, agentId: other, status: 'working' })
    await expect(f.execute({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'working', result: null }, host, f.worker))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_LOST' })
    await f.execute({ type: 'work.status', conversationId: f.group, assignmentId: next, status: 'working', result: 'Taking over' }, host, other)
  })

  it('lets the Lead cancel lost work', async () => {
    const f = await swarm()
    await f.observe('test-host', [], { stoppedHarnessIds: [f.harness.worker] })
    expect((await f.assignment()).status).toBe('lost')
    await f.execute({ type: 'work.cancel', conversationId: f.group, assignmentId: f.assignmentId, reason: 'Not needed any more' }, host, f.lead)
    expect((await f.assignment()).status).toBe('cancelled')
  })

  it('wakes the Lead of an older Swarm without stored projects, once', async () => {
    const f = await swarm({ legacy: true })
    expect((await f.timed.read(owner, f.tab)).state.projects).toBeUndefined()
    await f.observe('test-host', [], { stoppedHarnessIds: [f.harness.worker] })
    await f.observe('test-host', [], { stoppedHarnessIds: [f.harness.worker] })
    expect(await f.lostRows()).toHaveLength(2)
    expect((await f.leadInbox()).filter(m => (m.source as { kind?: string }).kind === 'work-lost')).toHaveLength(1)
  })
})

describe('a start that never runs', () => {
  it('fails 3 minutes after dispatch, naming its machine, and tells the Lead in its group', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Small task.' },
      candidates: [{ id: 'c0', kind: 'new', machineId: 'test-host', engine: 'codex', model: 'fixture-model', effort: 'high',
        quality: 2, cost: 2, title: 'New agent', label: 'New agent' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    const routeDecisionId = String((await f.execute({ type: 'route.record', conversationId: 'lead', decision } as Command, host, f.lead)).result.routeDecisionId)
    const request = { conversationId: 'lead', machineId: 'test-host', engine: 'codex', model: 'fixture-model', effort: 'high', name: 'Builder',
      cwd: '/repo', worktree: false, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const startId = String((await f.execute({ type: 'agent.start', request, routeDecisionId } as Command, host, f.lead)).result.startId)
    // The start's own machine dispatches and confirms it.
    const onMachine = (command: Command) => f.timed.execute(host, f.tab, { operationId: randomUUID(), command }, undefined, 'test-host')
    await onMachine({ type: 'agent.startDispatch', startId })
    const dispatched = f.clock.now
    f.clock.now = dispatched + 3 * MINUTE
    await f.leadInbox()
    expect((await f.timed.read(owner, f.tab)).state.starts!.find(s => s.id === startId)!.error).toBeNull()
    f.clock.now = dispatched + 3 * MINUTE + 1
    const told = (await f.leadInbox()).find(m => (m.source as { kind?: string }).kind === 'start-timeout')!
    expect(told).toMatchObject({ conversationId: 'lead', text: 'Could not start Builder: Worker Mac did not start it within 3 minutes.' })
    await expect(onMachine({ type: 'agent.started', startId, harnessId: randomUUID(), configuration: config }))
      .rejects.toMatchObject({ code: 'START_FAILED' })
  })
})
