import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore, type SwarmChanged } from '../src/superTabs/store.js'
import { localReportMemory, machineReportLine } from '../src/superTabs/machineReports.js'
import type { Command } from '../src/superTabs/commands.js'
import { poolRows } from './hostRows.test-support.js'

// A Swarm machine goes by the name its owner gave it in Machines (Dee, #2308: Mac 3 kept showing as Macs-Mac-Studio-2 in
// New Project). The server takes it from the owner's own account row, never from what a client sends. A fresh loopback
// replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
let pushes: SwarmChanged[] = []
const TEAM_COMPUTER = 'tttttttttttttttttttttttttttttttt'
const dee: AuthUser = { sub: '400000000000000000000001', email: 'dee@example.com', autonomousEnv: 'prod', role: 'user' }
const huy: AuthUser = { sub: '400000000000000000000002', email: 'huy@example.com', autonomousEnv: 'prod', role: 'user' }
const deeTeam: AuthUser = { ...dee, harnessSessionId: 'dee-team-session', harnessSessionKind: 'team', harnessComputerId: TEAM_COMPUTER }
const run = (tab: string, command: Command, user: AuthUser = dee) => store.execute(user, tab, { operationId: randomUUID(), command })
const reading = (generation: string) => ({ generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
  diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Desktop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
  quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] }) as Parameters<SuperTabStore['observeMachine']>[3]
const rename = (machineId: string, name: string | null) => db.machine.update({ where: { machineId }, data: { name } })
const contribute = (tab: string, machineId: string, name: string, user: AuthUser = dee, extra: Partial<Extract<Command, { type: 'machine.contribute' }>> = {}) =>
  run(tab, { type: 'machine.contribute', machineId, name, cwd: '/work', scope: 'swarm', engines: ['codex'], maxAgents: 3, ...extra }, user)
const nameIn = async (tab: string, machineId: string, user: AuthUser = dee) =>
  (await store.read(user, tab)).state.machines!.find(m => m.machineId === machineId)!.name
/** The machine's host reports once, as its own session. */
const report = async (tab: string, machineId: string, user: AuthUser = dee): Promise<'fast' | 'full'> => {
  const generation = (await poolRows(store, user, machineId)).find(p => p.tabId === tab)!.machine.generation
  machineReportLine(0)
  await store.observeMachine(user, tab, machineId, reading(generation))
  return machineReportLine(0).fast ? 'fast' : 'full'
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`super_tab_machine_names_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  // Sweeps never due, so a report takes the fast path whenever its reading alone changed (machineReports.ts).
  const memory = localReportMemory(Date.now)
  store = new SuperTabStore(db, Date.now, null, { reports: { get: (t, m) => memory.get(t, m), set: (t, m, r) => memory.set(t, m, r), sweepDue: async () => false },
    swarmChanged: change => pushes.push(change) })
  for (const user of [dee, huy]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: 'prod' } })
  const machine = (machineId: string, userId: string, computerId: string, sessionKind: string, hostMachineId?: string) => db.machine.create({ data: {
    machineId, userId, computerId, sessionKind, ...hostMachineId ? { hostMachineId } : {}, hostname: 'Macs-Mac-Studio-2.local',
    apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await machine('studio-2', dee.sub, 'ssssssssssssssssssssssssssssssss', 'computer')
  await machine('studio-2-team', dee.sub, TEAM_COMPUTER, 'team', 'studio-2')
  await machine('huy-mini', huy.sub, 'hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh', 'computer')
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})
beforeEach(async () => {
  // Seeded from the computer's hostname on its first connect (MachineService), as an account row is until its owner renames it.
  await rename('studio-2', 'Macs-Mac-Studio-2.local')
  await rename('studio-2-team', 'Macs-Mac-Studio-2 · Team')
  await rename('huy-mini', 'Huy Mini')
})

async function swarm() {
  const tab = (await store.create(dee, randomUUID(), 'Names')).id
  const invitation = await run(tab, { type: 'invite.create', email: huy.email, role: 'collaborator', conversationId: 'lead' })
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, huy)
  return tab
}

describe('a machine joins under the name its owner gave it', () => {
  it('takes the account name over the name its client sent', async () => {
    await rename('studio-2', 'Mac 3')
    const tab = await swarm()
    await contribute(tab, 'studio-2', 'Macs-Mac-Studio-2')
    expect(await nameIn(tab, 'studio-2')).toBe('Mac 3')
  })

  it('keeps its computer name while never renamed', async () => {
    const tab = await swarm()
    await contribute(tab, 'studio-2', 'Macs-Mac-Studio-2')
    // Clients drop '.local' (Desktop superTabMachineName); the Swarm keeps the account's name as it is.
    expect(await nameIn(tab, 'studio-2')).toBe('Macs-Mac-Studio-2.local')
  })

  it('keeps the name its client sent when its account row has none', async () => {
    await rename('studio-2', null)
    const tab = await swarm()
    await contribute(tab, 'studio-2', 'Macs-Mac-Studio-2')
    expect(await nameIn(tab, 'studio-2')).toBe('Macs-Mac-Studio-2')
  })

  it('shows a teammate\'s machine by the name its owner gave it', async () => {
    const tab = await swarm()
    await contribute(tab, 'huy-mini', 'huys-mac-mini.local', huy)
    expect(await nameIn(tab, 'huy-mini', dee)).toBe('Huy Mini')
  })
})

describe('a rename after joining', () => {
  it('shows in the Swarm on its machine\'s next reading, and the one after is fast again', async () => {
    const tab = await swarm()
    await contribute(tab, 'studio-2', 'Macs-Mac-Studio-2')
    await report(tab, 'studio-2')
    expect(await report(tab, 'studio-2')).toBe('fast')
    await rename('studio-2', 'Mac 3')
    pushes = []
    expect(await report(tab, 'studio-2')).toBe('full')
    expect(await nameIn(tab, 'studio-2')).toBe('Mac 3')
    expect(await nameIn(tab, 'studio-2', huy)).toBe('Mac 3')
    // Its members' clients are told, so the next refresh reads it.
    expect(pushes.find(p => p.tabId === tab)).toMatchObject({ userIds: expect.arrayContaining([dee.sub, huy.sub]), parts: expect.arrayContaining(['main']) })
    // The rename moved the Swarm's main stamp, so the report after runs in full once more, then they are fast again.
    expect([await report(tab, 'studio-2'), await report(tab, 'studio-2')]).toEqual(['full', 'fast'])
  })

  it('renames it in every Swarm it is in', async () => {
    const [one, two] = [await swarm(), await swarm()]
    for (const tab of [one, two]) await contribute(tab, 'studio-2', 'Macs-Mac-Studio-2')
    await rename('studio-2', 'Mac 3')
    for (const tab of [one, two]) await report(tab, 'studio-2')
    expect([await nameIn(one, 'studio-2'), await nameIn(two, 'studio-2')]).toEqual(['Mac 3', 'Mac 3'])
  })

  it('renames its Mac\'s Team account with it, which its own reading never renames to its account\'s name', async () => {
    const tab = await swarm()
    await contribute(tab, 'studio-2', 'Macs-Mac-Studio-2')
    await contribute(tab, 'studio-2-team', 'Macs-Mac-Studio-2 · Team', dee, { ifMissing: true, maxAgents: 1 })
    expect(await nameIn(tab, 'studio-2-team')).toBe('Macs-Mac-Studio-2.local · Team account')
    await rename('studio-2', 'Mac 3')
    await report(tab, 'studio-2')
    expect(await nameIn(tab, 'studio-2-team')).toBe('Mac 3 · Team account')
    await report(tab, 'studio-2-team', deeTeam)
    expect(await nameIn(tab, 'studio-2-team')).toBe('Mac 3 · Team account')
  })

  it('keeps the Swarm\'s name when its owner clears it back to none', async () => {
    const tab = await swarm()
    await rename('studio-2', 'Mac 3')
    await contribute(tab, 'studio-2', 'Macs-Mac-Studio-2')
    await rename('studio-2', null)
    await report(tab, 'studio-2')
    expect(await nameIn(tab, 'studio-2')).toBe('Mac 3')
  })
})

// Review of #2717: a machine renamed while offline sends no reading, so a rename in Machines reaches its Swarms by itself
// (MachineService.rename → store.machineRenamed); the heartbeat stays the backstop.
describe('a rename in Machines', () => {
  const renamed = (machineId: string, owner: AuthUser = dee) => store.machineRenamed({ machineId, ownerId: owner.sub, autonomousEnv: 'prod' })

  it('reaches every Swarm the machine is in at once, its Team account with it, with no reading', async () => {
    const [one, two] = [await swarm(), await swarm()]
    for (const tab of [one, two]) {
      await contribute(tab, 'studio-2', 'Macs-Mac-Studio-2')
      await contribute(tab, 'studio-2-team', 'Macs-Mac-Studio-2 · Team', dee, { ifMissing: true, maxAgents: 1 })
      await contribute(tab, 'huy-mini', 'Huy Mini', huy)
    }
    await rename('studio-2', 'Mac 3')
    pushes = []
    await renamed('studio-2')
    for (const tab of [one, two]) {
      expect([await nameIn(tab, 'studio-2', huy), await nameIn(tab, 'studio-2-team'), await nameIn(tab, 'huy-mini')]).toEqual(['Mac 3', 'Mac 3 · Team account', 'Huy Mini'])
      expect(pushes.find(p => p.tabId === tab)).toMatchObject({ userIds: expect.arrayContaining([dee.sub, huy.sub]), parts: expect.arrayContaining(['main']) })
    }
  })

  it('keeps the Swarm\'s name when the name was cleared', async () => {
    const tab = await swarm()
    await rename('studio-2', 'Mac 3')
    await contribute(tab, 'studio-2', 'Macs-Mac-Studio-2')
    await rename('studio-2', null)
    await renamed('studio-2')
    expect(await nameIn(tab, 'studio-2')).toBe('Mac 3')
  })

  it('changes nothing for anyone but the machine\'s owner', async () => {
    const tab = await swarm()
    await contribute(tab, 'studio-2', 'Macs-Mac-Studio-2')
    await rename('studio-2', 'Mac 3')
    await renamed('studio-2', huy)
    expect(await nameIn(tab, 'studio-2')).toBe('Macs-Mac-Studio-2.local')
  })
})
