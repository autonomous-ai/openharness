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
import { assignmentRows, poolRows, rosterRows } from './hostRows.test-support.js'
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
async function swarm({ legacy = false, client = db }: { legacy?: boolean; client?: PrismaClient } = {}) {
  let now = 10_000_000
  const timed = new SuperTabStore(client, () => now)
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

  it('is not lost for a failing model when its host says the model recovered between the time checks\' read and their write', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    // An agent whose model alert is on before it has a task: the time checks, not the alert, would lose its next task.
    const group = String((await f.execute({ type: 'conversation.create', title: 'Second task', brief: 'Do it', checks: [{ description: 'Done', independent: false }] })).result.conversationId)
    const other = await f.add(group, 'test-host', f.harness.other, 'Other')
    await f.observe('test-host', [f.harness.worker, f.harness.other])
    await f.execute({ type: 'agent.alert', agentId: other, alert: 'model', active: true }, host, other)
    await f.execute({ type: 'work.assign', conversationId: group, agentId: other })
    // The Lead's poll reads the alert as on; just before it writes the loss, the host reports the model answering again.
    let raced = false
    const racing = new SuperTabStore(beforeFirstWrite(db, async () => {
      if (raced) return
      raced = true
      await f.execute({ type: 'agent.alert', agentId: other, alert: 'model', active: false }, host, other)
    }), () => f.clock.now)
    await racing.deliveries(host, f.tab, f.lead)
    expect(raced).toBe(true)
    expect((await f.timed.read(owner, f.tab)).state.conversations.find(c => c.id === group)!.assignment!.status).toBe('working')
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

  // Night shift: a task lost to a usage limit whose screen gave a reset time resumes in that same session after the reset.
  it('tells the worker\'s host when its lost task resumes, and gives it back to the same session after the reset', async () => {
    const f = await swarm()
    const resetAt = new Date(f.clock.now + 30 * MINUTE).toISOString(), lostAt = f.clock.now
    await f.execute({ type: 'agent.alert', agentId: f.worker, alert: 'limit', active: true, resetAt }, host, f.worker)
    const row = async () => (await rosterRows(f.timed, host, 'test-host')).find(t => t.tabId === f.tab && t.agent?.id === f.worker)!
    expect((await row()).resume).toEqual({ conversationId: f.group, assignmentId: f.assignmentId, lostAt, at: resetAt })
    const resume = () => f.execute({ type: 'work.resume', conversationId: f.group, assignmentId: f.assignmentId, lostAt }, host, f.worker)
    await expect(resume()).rejects.toThrow('Its usage limit has not reset yet.')
    f.clock.now += 30 * MINUTE
    await resume()
    expect(await f.assignment()).toMatchObject({ id: f.assignmentId, agentId: f.worker, status: 'working' })
    expect((await row()).resume).toBeNull()
    expect((await f.leadInbox()).map(m => m.text)).toContain(`${await f.name(f.worker)} resumed its task after its usage limit reset.`)
  })

  // #1757 review, 2: a receipt replays the first answer, so it never says who holds the task now; the host's assignment
  // rows do (cli superTabs/limitResume.ts reads them before typing).
  it('replays a resume whose answer was lost even after a takeover, while its host\'s assignment rows no longer list it', async () => {
    const f = await swarm()
    const lostAt = f.clock.now
    await f.execute({ type: 'agent.alert', agentId: f.worker, alert: 'limit', active: true, resetAt: new Date(f.clock.now + 30 * MINUTE).toISOString() }, host, f.worker)
    f.clock.now += 30 * MINUTE
    const resume = { operationId: `limit-resume-${f.assignmentId}-${lostAt}`, command: { type: 'work.resume', conversationId: f.group, assignmentId: f.assignmentId, lostAt } as Command }
    const listed = async () => (await assignmentRows(f.timed, host, 'test-host')).some(a => a.tabId === f.tab && a.assignmentId === f.assignmentId && a.harnessId === f.harness.worker)
    await f.timed.execute(host, f.tab, resume, f.worker)
    expect(await listed()).toBe(true)
    // Its answer never reached the host. The Product Manager cancels the task and hands it to another agent.
    await f.execute({ type: 'work.cancel', conversationId: f.group, assignmentId: f.assignmentId, reason: 'Moving it on' })
    const other = await f.add(f.group, 'test-host', f.harness.other, 'Other')
    await f.execute({ type: 'work.assign', conversationId: f.group, agentId: other })
    expect((await f.timed.execute(host, f.tab, resume, f.worker)).result).toEqual({})
    expect(await listed()).toBe(false)
  })

  it('does not resume a task handed to another agent before the reset, and its host is no longer asked to', async () => {
    const f = await swarm()
    const lostAt = f.clock.now
    await f.execute({ type: 'agent.alert', agentId: f.worker, alert: 'limit', active: true, resetAt: new Date(f.clock.now + 30 * MINUTE).toISOString() }, host, f.worker)
    const other = await f.add(f.group, 'test-host', f.harness.other, 'Other')
    const handedOn = String((await f.execute({ type: 'work.assign', conversationId: f.group, agentId: other })).result.assignmentId)
    const row = async () => (await rosterRows(f.timed, host, 'test-host')).find(t => t.tabId === f.tab && t.agent?.id === f.worker)!
    expect((await row()).resume).toBeNull()
    f.clock.now += 30 * MINUTE
    await expect(f.execute({ type: 'work.resume', conversationId: f.group, assignmentId: f.assignmentId, lostAt }, host, f.worker))
      .rejects.toThrow('This task was handed on or closed, so it does not resume.')
    expect(await f.assignment()).toMatchObject({ id: handedOn, agentId: other, status: 'working' })
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

// After a release every machine went offline for about 2 minutes while its CLI updated: 16 tasks were lost, their agents came
// back, and every assignment to the same agent was refused as busy for good, even after the Lead cancelled the lost task.
describe('an agent whose task was lost', () => {
  type Fixture = Awaited<ReturnType<typeof swarm>>
  /** The worker's machine goes silent for over 2 minutes; the loss is found by the Lead machine's report or by the Lead's poll. */
  async function loseByOffline(f: Fixture, foundBy: 'report' | 'poll' = 'report') {
    await f.beat(f.clock.now)
    f.clock.now += 2 * MINUTE + 5_000
    if (foundBy === 'report') await f.observe('lead-host', [f.harness.lead])
    else await f.leadInbox()
    expect((await f.assignment()).status).toBe('lost')
  }
  const backOnline = async (f: Fixture) => { f.clock.now += MINUTE; await f.beat(f.clock.now) }
  const runOf = (agentId: string) => db.superTabRun.findUnique({ where: { id: agentId } })
  const pending = (tabId: string, assignmentId: string) => db.superTabDelivery.findMany({ where: { tabId, assignmentId, status: { in: ['queued', 'claimed', 'uncertain'] } } })
  /** What an older server left behind when a task was lost outside a command: the agent's run record, and the lost task's
   *  deliveries still pending (one claimed, the rest queued), which the loss on this server has already cancelled. */
  async function leftBehind(f: Fixture, assignmentId = f.assignmentId, tabId = f.tab) {
    await db.superTabRun.upsert({ where: { id: f.worker },
      create: { id: f.worker, tabId, assignmentId, machineId: 'test-host', harnessId: f.harness.worker }, update: { tabId, assignmentId } })
    const rows = await db.superTabDelivery.findMany({ where: { tabId, assignmentId } })
    await db.superTabDelivery.updateMany({ where: { tabId, assignmentId }, data: { status: 'queued' } })
    if (rows[0]) await db.superTabDelivery.update({ where: { id: rows[0].id }, data: { status: 'claimed' } })
    return rows.length
  }

  it.each(['report', 'poll'] as const)('takes work again once its machine is back, the loss found by a %s', async foundBy => {
    const f = await swarm()
    expect(await pending(f.tab, f.assignmentId)).not.toEqual([])
    await loseByOffline(f, foundBy)
    // The loss frees the agent and drops what was still queued for the lost task.
    expect(await runOf(f.worker)).toBeNull()
    expect(await pending(f.tab, f.assignmentId)).toEqual([])
    await backOnline(f)
    const next = String((await f.execute({ type: 'work.assign', conversationId: f.group, agentId: f.worker })).result.assignmentId)
    expect(await f.assignment()).toMatchObject({ id: next, agentId: f.worker, status: 'working' })
    expect(await runOf(f.worker)).toMatchObject({ tabId: f.tab, assignmentId: next })
  })

  it('takes the Lead\'s explicit assignment with a reason, while the mark that keeps routing away from it stays', async () => {
    const f = await swarm()
    await loseByOffline(f)
    await backOnline(f)
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Small task.' },
      candidates: [{ id: 'c0', kind: 'new', machineId: 'test-host', engine: 'codex', model: 'fixture-model', effort: 'high',
        quality: 2, cost: 2, title: 'New agent', label: 'New agent' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    const routeDecisionId = String((await f.execute({ type: 'route.record', conversationId: f.group, decision } as Command, host, f.lead)).result.routeDecisionId)
    await f.execute({ type: 'work.assign', conversationId: f.group, agentId: f.worker, routeDecisionId,
      overrideReason: 'Its machine is back and it has the context.' } as Command, host, f.lead)
    expect(await f.assignment()).toMatchObject({ agentId: f.worker, status: 'working' })
    expect((await f.timed.read(owner, f.tab)).state.agents.find(a => a.id === f.worker)!.lostTask).toMatchObject({ assignmentId: f.assignmentId })
  })

  it('takes work again after the Lead cancels its lost task, though an older server left it marked running', async () => {
    const f = await swarm()
    await loseByOffline(f)
    await leftBehind(f)
    await f.execute({ type: 'work.cancel', conversationId: f.group, assignmentId: f.assignmentId, reason: 'Not needed any more' }, host, f.lead)
    expect(await runOf(f.worker)).toBeNull()
    await backOnline(f)
    await f.execute({ type: 'work.assign', conversationId: f.group, agentId: f.worker })
    expect(await f.assignment()).toMatchObject({ agentId: f.worker, status: 'working' })
  })

  it('is assigned past a record an older server left for its lost task, which is then replaced, its old deliveries dropped', async () => {
    const f = await swarm()
    await loseByOffline(f)
    expect(await leftBehind(f)).toBeGreaterThan(0)
    expect(await pending(f.tab, f.assignmentId)).not.toEqual([])
    await backOnline(f)
    const next = String((await f.execute({ type: 'work.assign', conversationId: f.group, agentId: f.worker })).result.assignmentId)
    expect(await runOf(f.worker)).toMatchObject({ tabId: f.tab, assignmentId: next })
    // The lost task's old instructions never reach the worker after its new assignment.
    expect(await pending(f.tab, f.assignmentId)).toEqual([])
    expect(await pending(f.tab, next)).not.toEqual([])
  })

  it('has records left for ended work removed on the Lead\'s poll, keeping those for active work and stopping agents', async () => {
    const f = await swarm()
    const second = String((await f.execute({ type: 'conversation.create', title: 'Write the docs', brief: 'Document it',
      checks: [{ description: 'Read', independent: false }] })).result.conversationId)
    // Its work runs on the Lead's machine, which keeps reporting, so it stays active while the worker's machine goes silent.
    const other = await f.add(second, 'lead-host', f.harness.other, 'Other')
    const active = String((await f.execute({ type: 'work.assign', conversationId: second, agentId: other })).result.assignmentId)
    await loseByOffline(f)
    await leftBehind(f)
    const stopping = await db.superTabRun.create({ data: { id: randomUUID(), tabId: f.tab, assignmentId: `release-${randomUUID()}`, machineId: 'test-host', harnessId: randomUUID() } })
    const live = await pending(f.tab, active)
    expect(live).not.toEqual([])
    await f.leadInbox()
    expect(await runOf(f.worker)).toBeNull()
    expect(await pending(f.tab, f.assignmentId)).toEqual([])
    expect(await pending(f.tab, active)).toEqual(live)
    expect(await runOf(other)).toMatchObject({ assignmentId: active })
    expect(await runOf(stopping.id)).not.toBeNull()
    // Removing them again changes nothing.
    await f.leadInbox()
    expect(await runOf(other)).toMatchObject({ assignmentId: active })
  })

  it('keeps the record of an assignment that commits between the Lead\'s poll reading the Swarm and removing stale records', async () => {
    const f = await swarm()
    await loseByOffline(f)
    await leftBehind(f)
    await backOnline(f)
    // The poll reads the old record as stale; just before it removes it, the Lead's assignment replaces it with a live one.
    let next = ''
    const racing = new SuperTabStore(beforeFirstWrite(db, async () => {
      if (next) return
      next = String((await f.execute({ type: 'work.assign', conversationId: f.group, agentId: f.worker })).result.assignmentId)
    }), () => f.clock.now)
    await racing.deliveries(host, f.tab, f.lead)
    expect(next).not.toBe('')
    expect(await runOf(f.worker)).toMatchObject({ tabId: f.tab, assignmentId: next })
    expect(await f.assignment()).toMatchObject({ id: next, status: 'working' })
  })

  it('stays busy while it works in another Swarm, whose record is never removed from this one', async () => {
    const f = await swarm()
    await loseByOffline(f)
    await backOnline(f)
    // The same session is a member of a second Swarm and holds active work there, which this Swarm cannot read.
    const elsewhere = await swarm()
    // It is that Swarm's worker: its record there is this agent's.
    await db.superTabRun.delete({ where: { id: elsewhere.worker } })
    await leftBehind(f, elsewhere.assignmentId, elsewhere.tab)
    const theirs = await pending(elsewhere.tab, elsewhere.assignmentId)
    expect(theirs).not.toEqual([])
    await expect(f.execute({ type: 'work.assign', conversationId: f.group, agentId: f.worker })).rejects.toMatchObject({ code: 'AGENT_BUSY' })
    await f.leadInbox()
    expect(await runOf(f.worker)).toMatchObject({ tabId: elsewhere.tab })
    expect(await pending(elsewhere.tab, elsewhere.assignmentId)).toEqual(theirs)
  })
})

describe('a start that never runs', () => {
  /** The Lead starts "Builder" on Worker Mac, and Worker Mac launches it. */
  const launch = async (f: Awaited<ReturnType<typeof swarm>>) => {
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
    return { startId, onMachine }
  }

  it('fails 3 minutes after dispatch, naming its machine, and tells the Lead in its group', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const { startId, onMachine } = await launch(f)
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

  it('waits while its own machine reports it preparing, shows the Lead it is preparing, and fails it after 15 minutes', async () => {
    const f = await swarm()
    await f.beat(f.clock.now)
    const { startId } = await launch(f)
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
    expect(told).toMatchObject({ conversationId: 'lead', text: 'Could not start Builder: Worker Mac was still preparing it after 15 minutes.' })
    expect((await ownerState()).starts!.find(s => s.id === startId)).not.toHaveProperty('preparing')
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
    expect(counted.ops).toEqual(['SuperTabDelivery.findFirst'])
    counted.ops.length = 0
    f.clock.now += 1
    expect(await f.timed.deliveries(host, f.tab, f.lead)).toEqual([])
    expect(counted.ops).toContain('SwarmGroup.findMany')
  })

  it('still runs the Lead\'s time checks: the five-minute update request arrives once 30 seconds have passed', async () => {
    const f = await swarm()
    await f.leadInbox()
    f.clock.now += 5 * MINUTE
    const told = await f.leadInbox()
    expect(told.map(m => (m.source as { kind?: string }).kind)).toEqual(['update-request'])
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

  it('never answers a caller who is not the agent\'s host from another caller\'s quiet poll, before or after it fails', async () => {
    const f = await swarm()
    await f.timed.deliveries(host, f.tab, f.lead)
    f.clock.now += 1_000
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.timed.deliveries(owner, f.tab, f.lead)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
  })
})

describe('the morning digest', () => {
  // #1772 review: every open decision counts, however many there are, and private ones never crowd out shared ones.
  it('counts every decision waiting, past 200, and is not crowded out by newer private ones', async () => {
    const f = await swarm()
    const projectId = (await f.timed.read(owner, f.tab)).state.projects![0]!.id
    await f.execute({ type: 'project.digest', projectId, time: '03:00', timeZone: 'UTC' })
    const secret = String((await f.execute({ type: 'conversation.create', title: 'Salaries', brief: '', checks: [], audience: { personIds: [owner.sub] } } as Command)).result.conversationId)
    const asked = (conversationId: string, count: number, from: number) => Array.from({ length: count }, (_, i) => ({ id: randomUUID(), tabId: f.tab,
      batchId: 'batch', projectId, conversationId, assignmentId: null, personId: owner.sub, askerAgentId: f.lead, question: `Question ${i}?`,
      options: ['Yes', 'No'], recommended: 0, unblocks: 'Work', createdAt: new Date(from + i) }))
    const digestText = async () => {
      f.clock.now += 24 * 60 * 60_000
      await f.leadInbox()
      return (await db.superTabMessage.findMany({ where: { tabId: f.tab }, orderBy: { sequence: 'desc' } })).find(m => (m.source as { kind?: string } | null)?.kind === 'digest-request')!.text
    }
    // One shared decision, older than 200 private ones.
    await db.superTabDecision.createMany({ data: [...asked(f.group, 1, 1_000), ...asked(secret, 200, 5_000)] })
    f.clock.now = 3 * 60 * 60_000 - 24 * 60 * 60_000
    expect(await digestText()).toMatch(/\nDecisions waiting:\n- #1 Ship the parser: 1 for owner@example\.com$/)
    await db.superTabDecision.createMany({ data: asked(f.group, 200, 10_000) })
    expect(await digestText()).toMatch(/\nDecisions waiting:\n- #1 Ship the parser: 201 for owner@example\.com$/)
  })

  it('lists a decision still waiting in a conversation that has gone quiet', async () => {
    const f = await swarm()
    const projectId = (await f.timed.read(owner, f.tab)).state.projects![0]!.id
    await f.execute({ type: 'project.digest', projectId, time: '03:00', timeZone: 'UTC' })
    await f.execute({ type: 'decision.ask', conversationId: f.group, personId: owner.sub,
      questions: [{ question: 'Keep the old parser?', options: ['Keep it', 'Drop it'], recommended: 1, unblocks: 'The cleanup' }] }, host, f.lead)
    // Ordinary loads no longer read it (sweeps.ts puts quiet conversations to sleep), and it has been quiet since before the
    // digest's day, so nothing it shipped brings it back.
    await db.swarmGroup.updateMany({ where: { tabId: f.tab, key: f.group }, data: { dormant: true, lastActivityAt: new Date(0) } })
    f.clock.now = 3 * 60 * 60_000 + 2 * 24 * 60 * 60_000
    await f.leadInbox()
    const digest = (await db.superTabMessage.findMany({ where: { tabId: f.tab } })).find(m => (m.source as { kind?: string } | null)?.kind === 'digest-request')!
    expect(digest.text).toMatch(/\nDecisions waiting:\n- #1 Ship the parser: 1 for owner@example\.com$/)
  })

  it('lists the decisions waiting, by conversation and person, never their questions', async () => {
    const f = await swarm()
    const projectId = (await f.timed.read(owner, f.tab)).state.projects![0]!.id
    await f.execute({ type: 'project.digest', projectId, time: '03:00', timeZone: 'UTC' })
    const question = (text: string) => ({ question: text, options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' })
    await f.execute({ type: 'decision.ask', conversationId: f.group, personId: owner.sub, questions: [question('Secret launch plan?'), question('Price it?')] }, host, f.lead)
    f.clock.now = 3 * 60 * 60_000
    await f.leadInbox()
    const digest = (await db.superTabMessage.findMany({ where: { tabId: f.tab } })).find(m => (m.source as { kind?: string } | null)?.kind === 'digest-request')!
    expect(digest.text).toMatch(/\nDecisions waiting:\n- #1 Ship the parser: 2 for owner@example\.com$/)
    expect(digest.text).not.toMatch(/Secret launch plan|Price it|Behind a flag/)
  })

  it('is sent once when two of the Lead\'s polls run at the same moment', async () => {
    const f = await swarm()
    const projectId = (await f.timed.read(owner, f.tab)).state.projects![0]!.id
    await f.execute({ type: 'project.digest', projectId, time: '03:00', timeZone: 'UTC' })
    f.clock.now = 3 * 60 * 60_000
    await Promise.all([f.leadInbox(), f.leadInbox()])
    expect((await db.superTabMessage.findMany({ where: { tabId: f.tab } })).filter(m => (m.source as { kind?: string } | null)?.kind === 'digest-request')).toHaveLength(1)
  })

  it('lists work that shipped and was archived before the digest (#1757 review, 4)', async () => {
    const f = await swarm()
    const projectId = (await f.timed.read(owner, f.tab)).state.projects![0]!.id
    await f.execute({ type: 'project.digest', projectId, time: '03:00', timeZone: 'UTC' })
    const checkId = (await f.timed.read(owner, f.tab)).state.conversations.find(c => c.id === f.group)!.checks[0]!.id
    await f.execute({ type: 'work.check', conversationId: f.group, assignmentId: f.assignmentId, checkId, passed: true, evidence: 'Verified' })
    await f.execute({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'done',
      result: 'Merged https://github.com/example/project/pull/9' }, host, f.worker)
    await f.execute({ type: 'conversation.archive', conversationId: f.group, archived: true })
    // Overnight the sweep puts it to sleep (sweeps.ts sleepQuietGroups, once its Lead acknowledged its reports): ordinary
    // loads no longer read it.
    await db.swarmGroup.updateMany({ where: { tabId: f.tab, key: f.group }, data: { dormant: true } })
    expect((await f.timed.read(owner, f.tab)).state.conversations.some(c => c.id === f.group)).toBe(false)
    f.clock.now = 3 * 60 * 60_000
    await f.leadInbox()
    const digest = (await db.superTabMessage.findMany({ where: { tabId: f.tab } })).find(m => (m.source as { kind?: string } | null)?.kind === 'digest-request')!
    expect(digest.text.split('\n\n')[1]).toBe('Shipped:\n- #1 Ship the parser: https://github.com/example/project/pull/9')
  })

  it('wakes the Lead once at the project\'s local time with what its work is doing, and again the next day', async () => {
    const f = await swarm()
    const projectId = (await f.timed.read(owner, f.tab)).state.projects![0]!.id
    // The swarm's clock starts at 02:46 UTC.
    await f.execute({ type: 'project.digest', projectId, time: '03:00', timeZone: 'UTC' })
    const digests = async () => (await db.superTabMessage.findMany({ where: { tabId: f.tab }, orderBy: { sequence: 'asc' } }))
      .filter(m => (m.source as { kind?: string } | null)?.kind === 'digest-request')
    await f.leadInbox()
    expect(await digests()).toEqual([])
    f.clock.now = 3 * 60 * 60_000
    const inbox = await f.leadInbox()
    await f.leadInbox()
    // The same poll's time checks ran first: 13 minutes without progress lost the task, so the digest names it held up.
    expect((await digests()).map(m => m.text.split('\n\n')[1])).toEqual([`Blocked:\n- #1 Ship the parser: lost (${await f.name(f.worker)}): no progress for 13 minutes`])
    expect(inbox.map(m => m.id)).toContain((await digests())[0]!.id)
    f.clock.now += 24 * 60 * 60_000
    await f.leadInbox()
    expect(await digests()).toHaveLength(2)
  })
})
