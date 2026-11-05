import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { otherAccountsOnComputer } from '../src/superTabs/computerMoves.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { localReportMemory } from '../src/superTabs/machineReports.js'
import type { Command } from '../src/superTabs/commands.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// One computer, signed in as kelvin, then as ttkhoahcmus (Scholes, #3122): each account has its own machine row for it, joined
// only by the computer's id. A fresh loopback replica set, created here.
const COMPUTER = 'c'.repeat(32), OTHER = 'd'.repeat(32)
const kelvin = '500000000000000000000001', tt = '500000000000000000000002', other = '500000000000000000000003'
const user = (sub: string, email: string): AuthUser => ({ sub, email, autonomousEnv: 'prod', role: 'user' })
const owner = user('500000000000000000000009', 'owner@example.com'), kelvinUser = user(kelvin, 'kelvin@example.com'), ttUser = user(tt, 'ttkhoahcmus@example.com')
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore

beforeAll(async () => {
  ({ replica, db } = await planDatabase('computer_moves'))
  const machine = (machineId: string, userId: string, computerId: string, extra: Record<string, unknown> = {}) => db.machine.create({ data: {
    machineId, userId, computerId, sessionKind: 'computer', apiKey: `fixture-${machineId}`, managerId: '', autonomousEnv: 'prod', authMode: 'remote', ...extra } })
  await machine('kelvin-mac', kelvin, COMPUTER)
  await machine('tt-mac', tt, COMPUTER)
  // Not another account's sign-in on this computer: a Team row, a deleted row, another environment's, another computer's.
  await machine('kelvin-team', kelvin, COMPUTER, { sessionKind: 'team', hostMachineId: 'kelvin-mac' })
  await machine('other-deleted', other, COMPUTER, { deletedAt: new Date() })
  await machine('other-stag', other, COMPUTER, { autonomousEnv: 'stag' })
  await machine('other-elsewhere', other, OTHER)
  // Many other computers' rows, which a read not bounded by the computer would examine too.
  for (let i = 0; i < 40; i++) await machine(`filler-${i}`, other, i.toString(16).padStart(32, '0'))
  for (const person of [owner, kelvinUser, ttUser]) {
    await db.user.create({ data: { id: person.sub, externalId: `fixture-${person.sub}`, email: person.email, autonomousEnv: 'prod' } })
  }
  const memory = localReportMemory(Date.now)
  store = new SuperTabStore(db, Date.now, null, { reports: { get: (t, m) => memory.get(t, m), set: (t, m, r) => memory.set(t, m, r), sweepDue: async () => false } })
}, 300_000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe("a computer's other accounts", () => {
  it('are the live rows of other accounts signed in on it before, never the owner\'s own, a Team row, or another computer\'s', async () => {
    expect(await otherAccountsOnComputer(db, { computerId: COMPUTER, ownerId: tt, autonomousEnv: 'prod' }))
      .toEqual([{ machineId: 'kelvin-mac', userId: kelvin }])
    expect(await otherAccountsOnComputer(db, { computerId: COMPUTER, ownerId: kelvin, autonomousEnv: 'prod' }))
      .toEqual([{ machineId: 'tt-mac', userId: tt }])
  })

  it('are read from the index on the computer id', async () => {
    const entries = await profiled(db, () => otherAccountsOnComputer(db, { computerId: COMPUTER, ownerId: tt, autonomousEnv: 'prod' }))
    const rows = reads(entries, 'machines', ['computerId'])
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.planSummary, JSON.stringify(plan(rows))).toMatch(/IXSCAN \{ computerId: 1, userId: 1 \}/)
    // Only this computer's six rows, not the 41 others.
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(6)
  })
})

describe('a computer signed in as another account', () => {
  const run = (tab: string, command: Command, as: AuthUser = owner) => store.execute(as, tab, { operationId: randomUUID(), command })
  /** A Swarm with kelvin and ttkhoahcmus in it, and kelvin's Mac added, which reports nothing since he signed out of it. */
  async function swarm() {
    const tab = (await store.create(owner, randomUUID(), 'Machines')).id
    for (const person of [kelvinUser, ttUser]) {
      const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
      await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
    }
    await run(tab, { type: 'machine.contribute', machineId: 'kelvin-mac', name: 'MacBooks-MacBook-Pro-7', cwd: '/work', scope: 'swarm', engines: ['claude'],
      maxAgents: 2, teamAccountOnly: true }, kelvinUser)
    return tab
  }
  const machinesIn = async (tab: string) => (await store.read(owner, tab)).state.machines!.map(m => ({ machineId: m.machineId, contributorId: m.contributorId,
    previousOwner: m.previousOwner?.personId }))

  it("moves its entry in every Swarm to the new account, once", async () => {
    const tabs = [await swarm(), await swarm()]
    expect(await store.computerSignedIn({ machineId: 'tt-mac', ownerId: tt, computerId: COMPUTER, autonomousEnv: 'prod' })).toBe(2)
    for (const tab of tabs) expect(await machinesIn(tab)).toEqual([{ machineId: 'tt-mac', contributorId: tt, previousOwner: kelvin }])
    expect(await store.computerSignedIn({ machineId: 'tt-mac', ownerId: tt, computerId: COMPUTER, autonomousEnv: 'prod' })).toBe(0)
    for (const tab of tabs) expect(await machinesIn(tab)).toEqual([{ machineId: 'tt-mac', contributorId: tt, previousOwner: kelvin }])
  })

  it('moves nothing for a computer id the signed-in machine does not have', async () => {
    const tab = await swarm()
    expect(await store.computerSignedIn({ machineId: 'tt-mac', ownerId: tt, computerId: OTHER, autonomousEnv: 'prod' })).toBe(0)
    expect(await store.computerSignedIn({ machineId: 'other-elsewhere', ownerId: other, computerId: COMPUTER, autonomousEnv: 'prod' })).toBe(0)
    expect(await machinesIn(tab)).toEqual([{ machineId: 'kelvin-mac', contributorId: kelvin, previousOwner: undefined }])
  })

  it('cannot be asked for by a person', async () => {
    const tab = await swarm()
    await expect(run(tab, { type: 'machine.moved', machineId: 'kelvin-mac' }, kelvinUser)).rejects.toThrow()
    await expect(run(tab, { type: 'machine.moved', machineId: 'kelvin-mac' }, ttUser)).rejects.toThrow()
    expect(await machinesIn(tab)).toEqual([{ machineId: 'kelvin-mac', contributorId: kelvin, previousOwner: undefined }])
  })
})
