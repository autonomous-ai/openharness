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
import type { StoredCreate } from '../src/superTabs/steps.test-support.js'
import type { MachineObservation } from '../src/superTabs/machines.js'
import { QUIET_CHECK_MS, runTimeCheckPass, timeCheckSwarms } from '../src/superTabs/timeChecks.js'
import { poolRows } from './hostRows.test-support.js'
import { plan, profiled, reads } from './plans.test-support.js'
import { storeAssignment, storeCreate } from './storedWork.test-support.js'

// Task #3385 (anh Dee's Swarm redesign, 11-05): the stall, idle and lost-task follow-ups run in the backend worker, so they
// keep running while the PM is down. Before, only the PM's own poll ran them: with the PM hung, five people's asks waited 3 to
// 10 hours and the board showed nothing working. Nothing here polls as the PM. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '200000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '200000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MINUTE = 60_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_time_checks_test_${randomUUID().replaceAll('-', '_')}`)
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

/** A Swarm whose PM runs on one of host's machines and whose worker, on another, is assigned "Ship the parser". */
async function swarm() {
  let now = Date.parse('2026-11-05T08:00:00.000Z')
  const timed = new SuperTabStore(db, () => now)
  const tab = (await timed.create(owner, randomUUID(), 'Time checks', 'public')).id
  const execute = (command: Command | StoredCreate, user = owner, asAgentId?: string) => command.type === 'conversation.create'
    ? storeCreate(db, tab, command, user, asAgentId) : timed.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  for (const [machineId, name] of [['lead-host', 'Lead Mac'], ['test-host', 'Worker Mac']]) {
    await execute({ type: 'machine.contribute', machineId: machineId!, name: name!, cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
  }
  const generations = new Map<string, string>()
  for (const machineId of ['lead-host', 'test-host']) generations.set(machineId, (await poolRows(timed, host, machineId)).find(p => p.tabId === tab)!.machine.generation)
  const harness = { lead: randomUUID(), worker: randomUUID() }
  // Added by the host, whose machines they run on: an agent is its own person's, on their own computer (task #4120).
  const add = async (conversationId: string, machineId: string, harnessId: string, name: string, lead = false) => String((await execute({ type: 'agent.add',
    conversationId, machineId, harnessId, name, configuration: config, lead }, host)).result.agentId)
  const lead = await add('lead', 'lead-host', harness.lead, 'Lead', true)
  const group = String((await execute({ type: 'conversation.create', title: 'Ship the parser', brief: 'Implement it',
    checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
  const worker = await add(group, 'test-host', harness.worker, 'Worker')
  await storeAssignment(db, tab, group, worker, now)
  const observe = (machineId: string, running: string[], extra: Partial<MachineObservation> = {}) => timed.observeMachine(host, tab, machineId, {
    generation: generations.get(machineId)!, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9,
      diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: [], tools: {}, runningHarnessIds: running, stoppedHarnessIds: [], ...extra })
  /** Only the worker's machine reports, its screen changing: the PM's host is down and never polls. */
  const workerBeat = () => observe('test-host', [harness.worker], { harnessProgress: { [harness.worker]: now } })
  const rows = async (kind: string) => (await db.superTabMessage.findMany({ where: { tabId: tab }, orderBy: { sequence: 'asc' } }))
    .filter(m => (m.source as { kind?: string } | null)?.kind === kind)
  return { timed, tab, execute, lead, group, worker, harness, observe, workerBeat, rows,
    clock: { get now() { return now }, set now(value: number) { now = value } } }
}

describe('the time checks with the PM down', () => {

  it('are no longer run by the PM\'s poll', async () => {
    const f = await swarm()
    f.clock.now += 31 * MINUTE
    await f.workerBeat()
    await f.timed.deliveries(host, f.tab, f.lead)
    expect(await f.rows('work-stalled')).toEqual([])
    expect((await f.timed.read(owner, f.tab)).state.conversations.find(c => c.id === f.group)!.liveness).toBeUndefined()
  })
})

// Swarm v4 (anh Dee 2026-11-09): every agent has one 1:1 chat with its person, an agent from before v4 too (agentChats.ts).
describe('every agent\'s 1:1 chat', () => {
  it('is opened by the checks for an agent that has none, once, for its person alone', async () => {
    const f = await swarm()
    const before = (await f.timed.read(owner, f.tab)).state
    expect(before.agents.find(a => a.id === f.worker)!.chatId).toBeUndefined()
    await f.timed.runTimeChecks(f.tab)
    const state = (await f.timed.read(host, f.tab)).state
    const chatId = state.agents.find(a => a.id === f.worker)!.chatId!
    expect(state.conversations.find(c => c.id === chatId)).toMatchObject({ kind: 'agent-chat', agentIds: [f.worker] })
    // Its person's alone: the Swarm's owner does not read it.
    expect((await f.timed.read(owner, f.tab)).state.conversations.some(c => c.id === chatId)).toBe(false)
    await f.timed.runTimeChecks(f.tab)
    expect((await f.timed.read(host, f.tab)).state.conversations.filter(c => c.kind === 'agent-chat' && c.agentIds.includes(f.worker))).toHaveLength(1)
  })
})

describe('the worker\'s pass', () => {
  it('runs the checks of each Swarm active in the last week, writes nothing (Swarm v4), and leaves a deleted one alone', async () => {
    const f = await swarm(), quiet = await swarm()
    f.clock.now += 31 * MINUTE
    await f.workerBeat()
    expect(await timeCheckSwarms(db, f.clock.now)).toEqual(expect.arrayContaining([f.tab, quiet.tab]))
    await db.superTab.update({ where: { id: quiet.tab }, data: { deletedAt: new Date(f.clock.now) } })
    const pass = await runTimeCheckPass(db, f.timed, f.clock.now)
    expect(pass.failed).toBe(0)
    // Swarm v4 (anh Dee, 2026-11-09): the checks run no v3 rule, so a quiet task is told to nobody.
    expect(pass.written).toBe(0)
    expect(await f.rows('work-stalled')).toEqual([])
    expect(await quiet.rows('work-stalled')).toEqual([])
    // A week later nothing there is read again.
    expect(await timeCheckSwarms(db, f.clock.now + 8 * 24 * 60 * MINUTE)).not.toContain(f.tab)
  })
})

// Review of #3213 (Wren, Important 2; AGENTS.md standard 4: a timer that wakes while nothing changed is a defect): a Swarm whose
// groups show no new activity is checked every few minutes, not every 30 s.
describe('the worker\'s pass on a quiet Swarm', () => {
  it('checks a Swarm again at once when its activity moved, and otherwise only every QUIET_CHECK_MS', async () => {
    const f = await swarm()
    const calls: string[] = []
    const counting = { runTimeChecks: async (tabId: string) => { if (tabId === f.tab) calls.push(tabId); return 0 } }
    const seen = new Map()
    await runTimeCheckPass(db, counting, f.clock.now, undefined, seen)
    await runTimeCheckPass(db, counting, f.clock.now + 30_000, undefined, seen)
    expect(calls).toHaveLength(1)
    f.clock.now += 60_000
    // The worker's post: only agents post in a project's channel (agentsOnly.test.ts).
    await f.execute({ type: 'message.send', conversationId: 'lead', text: 'Any news?', replyTo: null, recipientIds: [] } as Command, host, f.worker)
    await runTimeCheckPass(db, counting, f.clock.now, undefined, seen)
    expect(calls).toHaveLength(2)
    await runTimeCheckPass(db, counting, f.clock.now + QUIET_CHECK_MS - 1, undefined, seen)
    expect(calls).toHaveLength(2)
    await runTimeCheckPass(db, counting, f.clock.now + QUIET_CHECK_MS, undefined, seen)
    expect(calls).toHaveLength(3)
  })
})
