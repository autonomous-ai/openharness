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
import { poolRows, rosterRows } from './hostRows.test-support.js'

// Nobody tidies a Swarm by hand: a worker idle for 15 minutes is stopped on its Lead's poll and its host is asked to close
// it. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '200000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '200000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MINUTE = 60_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_tidy_test_${randomUUID().replaceAll('-', '_')}`)
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

/** A Swarm whose Lead runs on one of host's machines and whose Swarm-started worker, on another, finished "Ship the parser". */
async function swarm() {
  let now = Date.parse('2026-10-27T08:00:00.000Z')
  const timed = new SuperTabStore(db, () => now)
  const tab = (await timed.create(owner, randomUUID(), 'Tidy', 'public')).id
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
  // As agent.started records it for a Swarm start (commands.ts); agent.add stands for a person's own session.
  const row = await db.swarmAgent.findFirstOrThrow({ where: { tabId: tab, key: worker } })
  await db.swarmAgent.update({ where: { id: row.id }, data: { data: { ...row.data as object,
    startedSession: { creationId: 'creation-1', sessionId: 'session-1', createdAt: new Date(now).toISOString() } } } })
  const assignmentId = String((await execute({ type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId)
  await execute({ type: 'work.cancel', conversationId: group, assignmentId, reason: 'Done elsewhere' })
  // Its host took the cancel notice, as a running host does.
  await db.superTabDelivery.updateMany({ where: { tabId: tab, agentId: worker, status: 'queued' }, data: { status: 'delivered' } })
  const observe = (machineId: string, running: string[], extra: Partial<MachineObservation> = {}) => timed.observeMachine(host, tab, machineId, {
    generation: generations.get(machineId)!, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9,
      diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: [], tools: {}, runningHarnessIds: running, stoppedHarnessIds: [], ...extra })
  const member = async () => (await timed.read(owner, tab)).state.agents.find(a => a.id === worker)!
  const lines = async () => (await db.superTabMessage.findMany({ where: { tabId: tab }, orderBy: { sequence: 'asc' } }))
    .filter(m => (m.source as { kind?: string } | null)?.kind === 'idle-stop')
  return { timed, tab, execute, lead, group, worker, harness, observe, member, lines,
    clock: { get now() { return now }, set now(value: number) { now = value } } }
}

describe('a worker left idle', () => {
  it('is stopped on its Lead\'s poll 15 minutes after its last activity, and its host is asked to close it', async () => {
    const f = await swarm()
    f.clock.now += 14 * MINUTE
    await f.observe('test-host', [f.harness.worker], { harnessUncommitted: { [f.harness.worker]: false } })
    await f.timed.deliveries(host, f.tab, f.lead)
    expect((await f.member()).workDecision).toBe('awaiting')
    f.clock.now += MINUTE + 1_000
    await f.observe('test-host', [f.harness.worker], { harnessUncommitted: { [f.harness.worker]: false } })
    await f.timed.deliveries(host, f.tab, f.lead)
    const member = await f.member()
    expect(member.workDecision).toBe('stop')
    expect((await rosterRows(f.timed, host, 'test-host')).find(r => r.agent.id === f.worker)!.agent).toMatchObject({ releaseId: member.releaseId })
    expect(await f.lines()).toEqual([expect.objectContaining({ conversationId: f.group, recipientIds: [], text: 'Worker stopped: no work for 15 minutes.' })])
    // A second poll finds it already stopping and writes nothing more.
    f.clock.now += MINUTE
    await f.timed.deliveries(host, f.tab, f.lead)
    expect(await f.lines()).toHaveLength(1)
  })

  it('is kept while its host reports uncommitted changes, or does not say', async () => {
    const f = await swarm()
    f.clock.now += 20 * MINUTE
    await f.observe('test-host', [f.harness.worker], { harnessUncommitted: { [f.harness.worker]: true } })
    await f.timed.deliveries(host, f.tab, f.lead)
    expect((await f.member()).workDecision).toBe('awaiting')
    f.clock.now += MINUTE
    await f.observe('test-host', [f.harness.worker])
    await f.timed.deliveries(host, f.tab, f.lead)
    expect((await f.member()).workDecision).toBe('awaiting')
  })

  it('is kept while a message waits for it', async () => {
    const f = await swarm()
    f.clock.now += 20 * MINUTE
    await f.observe('test-host', [f.harness.worker], { harnessUncommitted: { [f.harness.worker]: false } })
    // Written straight into the queue, as a delivery from a moment ago that its host has not picked up yet.
    await db.superTabDelivery.create({ data: { id: randomUUID(), tabId: f.tab, conversationId: f.group, messageId: randomUUID(), agentId: f.worker,
      machineId: 'test-host', machineOwnerId: host.sub, assignmentId: null, membershipGeneration: 'g', authorKind: 'person', authorId: owner.sub, authorGeneration: 'g' } })
    await f.timed.deliveries(host, f.tab, f.lead)
    expect((await f.member()).workDecision).toBe('awaiting')
  })

  it('is kept once the owner turned tidying off', async () => {
    const f = await swarm()
    await f.execute({ type: 'tab.tidy', enabled: false })
    f.clock.now += 20 * MINUTE
    await f.observe('test-host', [f.harness.worker], { harnessUncommitted: { [f.harness.worker]: false } })
    await f.timed.deliveries(host, f.tab, f.lead)
    expect((await f.member()).workDecision).toBe('awaiting')
  })
})
