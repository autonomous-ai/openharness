import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { listGroupIndexes } from '../src/superTabs/parts/indexed.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// Roadmap Phase 3 (database optimization, 2026-10-29): Prisma sends `in` and `has` as $expr, which the planner bounds by an
// index's first field alone; on 28 Oct such reads scanned 50 M documents for 220 k returned. Each read here names its index,
// and under Mongo's profiler examines no document it does not return. A fresh loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const NOW = Date.parse('2026-10-29T08:00:00Z')
const person = (name: string): AuthUser => ({ sub: `user-${name}-${randomUUID().slice(0, 6)}`, email: `${name}@example.com`, autonomousEnv: 'prod', role: 'user' })
const owner = person('owner')
/** Swarms of other people in the same environment: a read bounded by the environment alone examines these too. */
const OTHERS = 12

/** A SuperTab row of `ownerId`, in parts (format 2), with these members and machines. */
async function swarmRow(ownerId: string, fields: { memberIds?: string[]; machineIds?: string[]; cleanupMachineIds?: string[]; autonomousEnv?: string } = {}) {
  const id = `tab-${randomUUID()}`
  await db.superTab.create({ data: { id, ownerId, autonomousEnv: fields.autonomousEnv ?? 'prod', memberIds: fields.memberIds ?? [ownerId], invitedEmails: [],
    machineIds: fields.machineIds ?? [], cleanupMachineIds: fields.cleanupMachineIds ?? [], format: 2, state: { version: 2 } } })
  return id
}

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_named_reads_test'))
  store = new SuperTabStore(db, () => NOW)
  await listGroupIndexes(db)
  for (let i = 0; i < OTHERS; i++) {
    const other = person(`other${i}`)
    await swarmRow(other.sub, { memberIds: [other.sub, `user-guest-${i}`] })
  }
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe('the owner\'s grid poll', () => {
  it('finds the owner\'s Swarms by the owner index, examining none of anyone else\'s', async () => {
    const mine = [await swarmRow(owner.sub), await swarmRow(owner.sub)]
    // Another environment's Swarm of the same owner id is never theirs here.
    await swarmRow(owner.sub, { autonomousEnv: 'dev' })
    const entries = await profiled(db, () => store.hostGrids(owner))
    const rows = reads(entries, 'SuperTab', ['ownerId'])
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.nreturned).toBe(mine.length)
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(mine.length)
    expect(rows[0]!.command?.hint, 'the read names its index').toBeTruthy()
  })
})
