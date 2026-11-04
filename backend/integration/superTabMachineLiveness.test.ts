import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import type { MachineObservation } from '../src/superTabs/machines.js'
import { localReportMemory, type ReportMemory } from '../src/superTabs/machineReports.js'
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

/** A server that remembers no full report: every reading runs in full. */
const never: ReportMemory = { get: async () => undefined, set: async () => {}, sweepDue: async () => false }

async function swarm(memory: 'fast' | 'full' = 'fast') {
  const clock = { now: 10_000_000 }
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
    const cursor = (await f.reads.firstLoad(owner, f.tab) as { cursor: string }).cursor
    f.clock.now += 2 * MINUTE
    await f.beat(busier)
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
