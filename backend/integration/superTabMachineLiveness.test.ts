import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { MACHINE_FRESH_MS, type MachineObservation } from '../src/superTabs/machines.js'
import { localReportMemory, type ReportMemory } from '../src/superTabs/machineReports.js'
import { clock as stamps } from '../src/superTabs/parts/index.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { poolRows } from './hostRows.test-support.js'
import { planDatabase } from './plans.test-support.js'

// Ken's machine-cap plan, 2026-11-04: every reading sent every poller the whole machine part, 397 MB an hour in GET changes, a
// cost that grows with the square of the machines. A client that asks now gets one line for a reading, and the part when its
// content changes. Clients of today get what they always got.
const owner: AuthUser = { sub: '510000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '510000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const outsider: AuthUser = { sub: '510000000000000000000004', email: 'outsider@example.com', autonomousEnv: 'prod', role: 'user' }
const MINUTE = 60_000
let replica: MongoMemoryReplSet
let db: PrismaClient

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_liveness_test'))
  for (const user of [owner, host, outsider]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'mac', userId: host.sub, apiKey: 'fixture-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machineShare.create({ data: { machineId: 'mac', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

// Only Date, with part stamps read from it too (parts/clock.ts holds the real Date.now), so a stamp and a cursor read one clock.
const clock = { get now() { return Date.now() }, set now(at: number) { vi.setSystemTime(at) } }
let start = Date.now(), stamped = 0
beforeEach(() => {
  start += 3_600_000
  vi.useFakeTimers({ toFake: ['Date'], now: start })
  vi.spyOn(stamps, 'next').mockImplementation(() => stamped = Math.max(Date.now(), stamped + 1))
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

/** A server that remembers no full report: every reading runs in full. */
const never: ReportMemory = { get: async () => undefined, set: async () => {}, sweepDue: async () => false }

async function swarm(memory: 'fast' | 'full' = 'fast') {
  const local = localReportMemory(() => clock.now)
  const reports: ReportMemory = memory === 'full' ? never : { get: (t, m) => local.get(t, m), set: (t, m, r) => local.set(t, m, r), sweepDue: async () => false }
  const store = new SuperTabStore(db, () => clock.now, null, { reports })
  const reads = new SwarmReads(store)
  const tab = (await store.create(owner, randomUUID(), 'Liveness', 'public')).id
  const execute = (command: Command, user = owner) => store.execute(user, tab, { operationId: randomUUID(), command })
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  await execute({ type: 'machine.contribute', machineId: 'mac', name: 'Mac', cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
  const generation = (await poolRows(store, host, 'mac')).find(p => p.tabId === tab)!.machine.generation
  const reading = (extra: Partial<MachineObservation> = {}): MachineObservation => ({ generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
    diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [], ...extra })
  const beat = (extra: Partial<MachineObservation> = {}) => store.observeMachine(host, tab, 'mac', reading(extra))
  // Two beats so the next can go the fast way when the memory allows it, then past the cursor's overlap.
  await beat()
  clock.now += 15_000
  await beat()
  clock.now += 5 * MINUTE
  await beat()
  const cursor = (await reads.firstLoad(owner, tab) as { cursor: string }).cursor
  clock.now += MINUTE
  const row = () => db.swarmMachine.findUniqueOrThrow({ where: { id: `${tab}:mac` } })
  const light = (as = owner, asAgentId?: string) => reads.changes(as, tab, cursor, asAgentId, { lightMachines: true }) as Promise<Record<string, unknown> & { machines: Array<{ key: string; deleted?: boolean; data?: { observation?: { receivedAt: number } } }>; machineReadings?: Array<{ key: string; version: number; receivedAt: number }> }>
  const today = () => reads.changes(owner, tab, cursor) as Promise<Record<string, unknown> & { machines: Array<{ key: string; data: { observation?: { receivedAt: number; resources: { cpuPercent: number } } } }> }>
  return { clock, store, reads, tab, execute, reading, beat, row, light, today }
}
const busier = { resources: { cpuPercent: 77, memoryTotalBytes: 32e9, memoryUsedBytes: 9e9, diskFreeBytes: 110e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 110e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null } }

describe.each(['fast', 'full'] as const)('a reading stored the %s way', memory => {
  it('reaches a client that asks as one line, with the machine\'s last reading, and no part', async () => {
    const f = await swarm(memory)
    const before = await f.row()
    await f.beat(busier)
    const after = await f.row()
    expect(after.changedAt).toEqual(before.changedAt)
    const changes = await f.light()
    expect(changes.machines).toEqual([])
    expect(changes.machineReadings).toEqual([{ key: 'mac', version: after.version, receivedAt: f.clock.now }])
  })

  it('reaches today\'s clients as the whole part, at a higher version, as ever', async () => {
    const f = await swarm(memory)
    const before = await f.row()
    await f.beat(busier)
    const changes = await f.today()
    expect(changes.machines.map(m => m.key)).toEqual(['mac'])
    expect(changes.machines[0]).toMatchObject({ version: before.version + 1 })
    expect(changes.machines[0]!.data.observation).toMatchObject({ receivedAt: f.clock.now, resources: { cpuPercent: 77 } })
    expect(changes).not.toHaveProperty('machineReadings')
  })

  it('still sends the whole part when what it says beyond the volatile fields changed', async () => {
    const f = await swarm(memory)
    await f.beat({ tools: { git: true } } as Partial<MachineObservation>)
    const changes = await f.light()
    expect(changes.machines.map(m => m.key)).toEqual(['mac'])
    expect(changes.machineReadings).toEqual([])
  })
})

describe('a client that asks', () => {
  it.each<[string, Partial<MachineObservation>]>([
    ['quotas', { quotas: [{ engine: 'codex', known: true, windows: [{ name: 'weekly', usedPercent: 10, resetsAt: null }] }] }],
    ['resources', busier],
  ])('gets a line for a change of %s alone', async (_field, extra) => {
    const f = await swarm()
    await f.beat(extra)
    const changes = await f.light()
    expect(changes.machines).toEqual([])
    expect(changes.machineReadings!.map(r => r.key)).toEqual(['mac'])
  })

  it('gets the whole part when a person changes the machine, and a later reading alone is a line again', async () => {
    const f = await swarm()
    await f.execute({ type: 'machine.contribute', machineId: 'mac', name: 'Mac', cwd: '/repo', engines: ['codex'], maxAgents: 6 }, host)
    const changes = await f.light()
    expect(changes.machines.map(m => m.key)).toEqual(['mac'])
    expect(changes.machineReadings).toEqual([])
    // Saving a machine again starts a new generation, whose first reading is content too. Then past the cursor's overlap.
    const generation = (await poolRows(f.store, host, 'mac')).find(p => p.tabId === f.tab)!.machine.generation
    await f.beat({ generation })
    f.clock.now += MINUTE
    const cursor = (await f.reads.firstLoad(owner, f.tab) as { cursor: string }).cursor
    f.clock.now += MINUTE
    await f.beat({ ...busier, generation })
    const next = await f.reads.changes(owner, f.tab, cursor, undefined, { lightMachines: true }) as { machines: unknown[]; machineReadings: Array<{ key: string }> }
    expect(next.machines).toEqual([])
    expect(next.machineReadings.map(r => r.key)).toEqual(['mac'])
  })

  it('reads the same time as a whole part says, so online and offline come out the same', async () => {
    const f = await swarm()
    await f.beat(busier)
    const line = (await f.light()).machineReadings![0]!
    const part = (await f.today()).machines[0]!
    expect(line.receivedAt).toBe(part.data.observation!.receivedAt)
    // A machine that stopped reporting has no new line, and what the client holds goes stale as a part would.
    f.clock.now += MINUTE
    const cursor = (await f.reads.firstLoad(owner, f.tab) as { cursor: string }).cursor
    f.clock.now += 5 * MINUTE
    const silent = await f.reads.changes(owner, f.tab, cursor, undefined, { lightMachines: true }) as { machines: unknown[]; machineReadings: unknown[] }
    expect(silent).toMatchObject({ machines: [], machineReadings: [] })
  })

  it('costs a small part of the whole part', async () => {
    const f = await swarm()
    await f.beat(busier)
    const line = JSON.stringify((await f.light()).machineReadings![0]), part = JSON.stringify((await f.today()).machines[0])
    console.log(`bytes per reading: whole part ${part.length}, line ${line.length}`)
    expect(line.length).toBeLessThan(part.length / 8)
  })
})

describe('the whole readings on demand', () => {
  it('gives a member every machine with its whole reading', async () => {
    const f = await swarm()
    await f.beat(busier)
    const { machines } = await f.reads.machineReadings(owner, f.tab) as { machines: Array<{ key: string; data: { observation: { receivedAt: number; resources: { cpuPercent: number } } } }> }
    expect(machines.map(m => m.key)).toEqual(['mac'])
    expect(machines[0]!.data.observation).toMatchObject({ receivedAt: f.clock.now, resources: { cpuPercent: 77 } })
  })

  it('reads nothing for someone outside the Swarm', async () => {
    const f = await swarm()
    await expect(f.reads.machineReadings(outsider, f.tab)).rejects.toThrow()
  })
})

// Task #3462: a crew member's wake is timed from the work that woke it to the first machine reading that shows its session
// running again, and the timing row is stored in its project chat for the daily scorecard.
describe('a crew wake timed by the machine report that shows it back (#3462)', () => {
  it('stores one timing row in the project chat, from the assignment to that reading', async () => {
    const sweeping: ReportMemory = { get: async () => undefined, set: async () => {}, sweepDue: async () => true }
    const store = new SuperTabStore(db, () => clock.now, null, { reports: sweeping })
    const tab = (await store.create(owner, randomUUID(), 'Crew', 'public')).id
    const execute = (command: Command, user = owner) => store.execute(user, tab, { operationId: randomUUID(), command })
    const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
    await execute({ type: 'machine.contribute', machineId: 'mac', name: 'Mac', cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
    const generation = (await poolRows(store, host, 'mac')).find(p => p.tabId === tab)!.machine.generation
    const beat = (running: string[]) => store.observeMachine(host, tab, 'mac', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9,
      memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS',
      gpuPercent: null }, quotas: [], tools: {}, runningHarnessIds: running, stoppedHarnessIds: [] })
    const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
    // Its machine's owner's own session: a member on another person's machine runs in its Team account, which the keeper keeps awake.
    const ada = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'mac', harnessId: 'h-ada', name: 'Ada', configuration: config,
      lead: false }, host)).result.agentId)
    await execute({ type: 'crew.add', agentId: ada, role: 'Engineer' })
    await beat(['h-ada'])
    // Asleep, as the keeper leaves it after an idle hour (crewKeep.ts, its own tests): its record says so, and its host closed
    // the session. Written straight to its stored record, as only the keeper's sweep sets it.
    const stored = await db.swarmAgent.findFirstOrThrow({ where: { tabId: tab, key: ada } })
    await db.swarmAgent.update({ where: { id: stored.id }, data: { data: { ...(stored.data as object), asleep: { since: clock.now } } } })
    clock.now += 60_000
    await beat([])
    // New work wakes it; its host reopens the session in place, and the next reading shows it running.
    const task = String((await execute({ type: 'conversation.create', title: 'Fix login', brief: 'Fix it', checks: [] })).result.conversationId)
    clock.now += 1_000
    const wokeAt = clock.now
    await execute({ type: 'work.assign', conversationId: task, agentId: ada })
    clock.now += 7_000
    await beat([])
    clock.now += 11_000
    const backAt = clock.now
    await beat(['h-ada'])
    clock.now += 30_000
    await beat(['h-ada'])
    const rows = (await db.superTabMessage.findMany({ where: { tabId: tab, conversationId: 'lead' } }))
      .filter(m => (m.source as { kind?: string } | null)?.kind === 'crew-timing')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.source).toMatchObject({ what: 'wake', agentId: ada, startedAt: wokeAt, runningAt: backAt })
    expect(rows[0]!.recipientIds).toEqual([])
  })
})

// Tester Q3, 2026-11-09: a post to an agent whose session is down stays queued, as it must, and its sender heard nothing. The result
// every CLI prints now says the agent is offline, and the post is read when it is back.
describe('a post to an agent whose session is down', () => {
  it('tells its sender the agent is offline, queues the post for it, and stops saying so once it is back', async () => {
    const store = new SuperTabStore(db, () => clock.now, null, { reports: never })
    const tab = (await store.create(owner, randomUUID(), 'Offline', 'public')).id
    const execute = (command: Command, user = owner) => store.execute(user, tab, { operationId: randomUUID(), command })
    const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
    await execute({ type: 'machine.contribute', machineId: 'mac', name: 'Mac', cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
    const generation = (await poolRows(store, host, 'mac')).find(p => p.tabId === tab)!.machine.generation
    const beat = (running: string[]) => store.observeMachine(host, tab, 'mac', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9,
      memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS',
      gpuPercent: null }, quotas: [], tools: {}, runningHarnessIds: running, stoppedHarnessIds: [] })
    const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
    // A task of its own, where the agent is a member a person can name.
    const task = String((await execute({ type: 'conversation.create', title: 'Fix login', brief: 'Fix it', checks: [] })).result.conversationId)
    const ada = String((await execute({ type: 'agent.add', conversationId: task, machineId: 'mac', harnessId: 'h-ada', name: 'Ada', configuration: config,
      lead: false }, host)).result.agentId)
    const adaName = async () => { const found = (await store.read(owner, tab)).state.agents.find(a => a.id === ada)!; return found.displayName ?? found.name }
    const post = (text: string, recipientIds = [ada]) => execute({ type: 'message.send', conversationId: task, text, replyTo: null, recipientIds })
    const queued = () => db.superTabDelivery.count({ where: { tabId: tab, agentId: ada, status: 'queued' } })
    const told = async () => `${await adaName()} is offline; it will read this when it is back.`
    await beat(['h-ada'])
    expect((await post('While you are up.')).result).not.toHaveProperty('offline')

    // Its machine goes silent: a reading that stale reads as down.
    clock.now += MACHINE_FRESH_MS + MINUTE
    const silent = await queued()
    expect((await post('While your machine is silent.')).result.offline).toBe(await told())
    expect(await queued()).toBe(silent + 1)

    // Back, then its session goes while the machine keeps reporting: the next reading does not list it.
    await beat(['h-ada'])
    expect((await post('Back.')).result).not.toHaveProperty('offline')
    clock.now += 15_000
    await beat([])
    const gone = await queued()
    expect((await post('While you are down.')).result.offline).toBe(await told())
    expect(await queued()).toBe(gone + 1)
    // A post that names no one says nothing of it.
    expect((await post('To nobody.', [])).result).not.toHaveProperty('offline')
  })
})
