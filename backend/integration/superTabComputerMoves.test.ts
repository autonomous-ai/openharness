import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import { otherAccountsOnComputer } from '../src/superTabs/computerMoves.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// One computer, signed in as kelvin, then as ttkhoahcmus (Scholes, #3122): each account has its own machine row for it, joined
// only by the computer's id. A fresh loopback replica set, created here.
const COMPUTER = 'c'.repeat(32), OTHER = 'd'.repeat(32)
const kelvin = '500000000000000000000001', tt = '500000000000000000000002', other = '500000000000000000000003'
let replica: MongoMemoryReplSet
let db: PrismaClient

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
