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
import { runTimeCheckPass, timeCheckSwarms } from '../src/superTabs/timeChecks.js'
import { poolRows, rosterRows } from './hostRows.test-support.js'

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
  const execute = (command: Command, user = owner, asAgentId?: string) => timed.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  for (const [machineId, name] of [['lead-host', 'Lead Mac'], ['test-host', 'Worker Mac']]) {
    await execute({ type: 'machine.contribute', machineId: machineId!, name: name!, cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
  }
  const generations = new Map<string, string>()
  for (const machineId of ['lead-host', 'test-host']) generations.set(machineId, (await poolRows(timed, host, machineId)).find(p => p.tabId === tab)!.machine.generation)
  const harness = { lead: randomUUID(), worker: randomUUID() }
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
  /** Only the worker's machine reports, its screen changing: the PM's host is down and never polls. */
  const workerBeat = () => observe('test-host', [harness.worker], { harnessProgress: { [harness.worker]: now } })
  const rows = async (kind: string) => (await db.superTabMessage.findMany({ where: { tabId: tab }, orderBy: { sequence: 'asc' } }))
    .filter(m => (m.source as { kind?: string } | null)?.kind === kind)
  return { timed, tab, execute, lead, group, worker, assignmentId, harness, observe, workerBeat, rows,
    clock: { get now() { return now }, set now(value: number) { now = value } } }
}

describe('the time checks with the PM down', () => {
  it('tell the PM of a task that went quiet, once, with no PM poll', async () => {
    const f = await swarm()
    const posted = f.clock.now
    await f.execute({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'working', result: 'Started' }, host, f.worker)
    for (const minutes of [10, 20, 29]) {
      f.clock.now = posted + minutes * MINUTE
      await f.workerBeat()
      await f.timed.runTimeChecks(f.tab)
    }
    expect(await f.rows('work-stalled')).toEqual([])
    f.clock.now = posted + 30 * MINUTE
    await f.workerBeat()
    expect(await f.timed.runTimeChecks(f.tab)).toBeGreaterThan(0)
    const stalled = await f.rows('work-stalled')
    expect(stalled).toEqual([expect.objectContaining({ conversationId: 'lead', recipientIds: [f.lead] })])
    expect(stalled[0]!.text).toContain('"Ship the parser": quiet, ')
    for (const minutes of [31, 45]) {
      f.clock.now = posted + minutes * MINUTE
      await f.workerBeat()
      await f.timed.runTimeChecks(f.tab)
    }
    expect(await f.rows('work-stalled')).toHaveLength(1)
  })

  it('tell the PM of an agent left idle for 15 minutes, once, with no PM poll', async () => {
    const f = await swarm()
    await f.execute({ type: 'work.cancel', conversationId: f.group, assignmentId: f.assignmentId, reason: 'Done elsewhere' })
    // Its host took the cancel notice, as a running host does.
    await db.superTabDelivery.updateMany({ where: { tabId: f.tab, agentId: f.worker, status: 'queued' }, data: { status: 'delivered' } })
    f.clock.now += 14 * MINUTE
    await f.workerBeat()
    await f.timed.runTimeChecks(f.tab)
    expect(await f.rows('idle')).toEqual([])
    f.clock.now += MINUTE + 1_000
    await f.workerBeat()
    await f.timed.runTimeChecks(f.tab)
    expect(await f.rows('idle')).toEqual([expect.objectContaining({ conversationId: 'lead', recipientIds: [f.lead], text: 'Worker has had no open task for 15 minutes.' })])
    f.clock.now += 10 * MINUTE
    await f.workerBeat()
    await f.timed.runTimeChecks(f.tab)
    expect(await f.rows('idle')).toHaveLength(1)
  })

  it('lose the task of a worker whose machine went silent, and tell the PM, with no report and no PM poll', async () => {
    const f = await swarm()
    await f.workerBeat()
    f.clock.now += 2 * MINUTE + 5_000
    // No machine reports from here on: the worker's machine died, and the PM's host is down too.
    await f.timed.runTimeChecks(f.tab)
    expect((await f.timed.read(owner, f.tab)).state.conversations.find(c => c.id === f.group)!.assignment!.status).toBe('lost')
    expect((await f.rows('work-lost')).map(r => r.text)).toContainEqual(expect.stringContaining('Worker lost its task "Ship the parser"'))
  })

  it('are no longer run by the PM\'s poll', async () => {
    const f = await swarm()
    await f.execute({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'working', result: 'Started' }, host, f.worker)
    f.clock.now += 31 * MINUTE
    await f.workerBeat()
    await f.timed.deliveries(host, f.tab, f.lead)
    expect(await f.rows('work-stalled')).toEqual([])
    expect((await f.timed.read(owner, f.tab)).state.conversations.find(c => c.id === f.group)!.liveness).toBeUndefined()
  })
})

describe('the worker\'s pass', () => {
  it('runs the checks of each Swarm active in the last week, and leaves a deleted one alone', async () => {
    const f = await swarm(), quiet = await swarm()
    await f.execute({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'working', result: 'Started' }, host, f.worker)
    f.clock.now += 31 * MINUTE
    await f.workerBeat()
    expect(await timeCheckSwarms(db, f.clock.now)).toEqual(expect.arrayContaining([f.tab, quiet.tab]))
    await db.superTab.update({ where: { id: quiet.tab }, data: { deletedAt: new Date(f.clock.now) } })
    const pass = await runTimeCheckPass(db, f.timed, f.clock.now)
    expect(pass.failed).toBe(0)
    expect(await f.rows('work-stalled')).toHaveLength(1)
    expect(await quiet.rows('work-stalled')).toEqual([])
    // A week later nothing there is read again.
    expect(await timeCheckSwarms(db, f.clock.now + 8 * 24 * 60 * MINUTE)).not.toContain(f.tab)
  })
})

describe('what the PM owes', () => {
  const owedOf = async (f: Awaited<ReturnType<typeof swarm>>) => {
    const head = await db.swarmHead.findFirstOrThrow({ where: { tabId: f.tab } })
    return ((head.data as { projects?: Array<{ owed?: unknown }> }).projects ?? [])[0]?.owed
  }
  const pmRow = async (f: Awaited<ReturnType<typeof swarm>>, agentId = f.lead) =>
    (await rosterRows(f.timed, host, agentId === f.lead ? 'lead-host' : 'test-host')).find(r => r.tabId === f.tab && 'agent' in r && r.agent.id === agentId) as Record<string, unknown>

  it('is the oldest message a person sent it that it has not answered, until it answers, and only its own host row carries it', async () => {
    const f = await swarm()
    // An agent's message to the PM is never an ask it owes a person.
    await f.execute({ type: 'message.send', conversationId: f.group, text: 'Halfway there.', replyTo: null, recipientIds: [f.lead] } as Command, host, f.worker)
    await f.timed.runTimeChecks(f.tab)
    expect(await owedOf(f)).toBeUndefined()
    const asked = f.clock.now
    const sent = await f.execute({ type: 'message.send', conversationId: 'lead', text: 'Where is my parser?', replyTo: null, recipientIds: [] } as Command)
    f.clock.now += MINUTE
    await f.execute({ type: 'message.send', conversationId: 'lead', text: 'And the docs?', replyTo: null, recipientIds: [] } as Command)
    f.clock.now += MINUTE
    await f.timed.runTimeChecks(f.tab)
    const messageId = String(sent.result.messageId)
    expect(await owedOf(f)).toEqual({ messageId, since: asked })
    expect((await pmRow(f)).owed).toEqual({ messageId, since: asked, restartAfterMs: 20 * MINUTE })
    expect((await pmRow(f, f.worker)).owed).toBeNull()
    // Readers never see it: it may name a message in a person's private chat with the PM.
    expect((await f.timed.read(owner, f.tab)).state.projects![0]).not.toHaveProperty('owed')
    await f.execute({ type: 'message.send', conversationId: 'lead', text: 'Parser ships today.', replyTo: null, recipientIds: [], answers: messageId } as Command, host, f.lead)
    await f.timed.runTimeChecks(f.tab)
    expect((await owedOf(f) as { messageId: string; since: number }).since).toBe(asked + MINUTE)
  })
})
