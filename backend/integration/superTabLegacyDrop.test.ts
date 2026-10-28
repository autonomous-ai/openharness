import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import * as parts from '../src/superTabs/parts/index.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { dropLegacyStates } from '../src/superTabs/migration/dropLegacy.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, richSwarm } from '../src/superTabs/read/fixture.test-support.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database. Each test
// starts from an empty database: the script's first check spans every Swarm.
let replica: MongoMemoryReplSet
let db: PrismaClient

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_legacy_drop_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** One kept old state of a known size: a document holding one 100,000-character string. */
const OLD_STATE = { padding: 'x'.repeat(100_000) }
/** Its BSON size by hand: length 4, then the field (type 1, "padding" and its 0: 8, string length 4, the string and its 0:
 *  100,001), then the closing 0. */
const OLD_STATE_BYTES = 4 + 1 + 8 + 4 + 100_001 + 1

async function legacySwarm() {
  const state = structuredClone(richSwarm().state)
  state.id = `tab-${randomUUID()}`
  await writeLegacySwarm(db, { state, revision: 500 })
  return state.id
}
/** A Swarm split into parts that still keeps its old state, as production Swarms do since the migration. */
async function migratedSwarm() {
  const tabId = await legacySwarm()
  expect((await migrateSwarm(db, tabId, { now: () => NOW })).ok).toBe(true)
  await db.superTab.update({ where: { id: tabId }, data: { legacyState: OLD_STATE } })
  return tabId
}
async function empty() {
  for (const model of [db.superTab, db.superTabMessage, db.swarmHead, db.swarmMember, db.swarmAgent, db.swarmGroup, db.swarmMachine,
    db.swarmStart, db.swarmProgress] as unknown as Array<{ deleteMany(args: unknown): Promise<unknown> }>) await model.deleteMany({})
}
const kept = async (tabId: string) => (await db.superTab.findUnique({ where: { id: tabId }, select: { legacyState: true } }))!.legacyState

describe('removing the old state migrated Swarms keep (Stability 2.1)', () => {
  it('refuses while any Swarm is still in one row, even to remove, and writes nothing', async () => {
    await empty()
    const migrated = await migratedSwarm()
    await legacySwarm()

    for (const apply of [false, true]) {
      expect(await dropLegacyStates(db, { apply })).toEqual({ ok: false, swarms: 2, unmigrated: 1, kept: 1, keptBytes: OLD_STATE_BYTES, removed: 0, batches: 0, writeErrors: 0 })
    }
    expect(await kept(migrated)).toEqual(OLD_STATE)
  })

  it('counts a Swarm whose row predates the format field as not migrated', async () => {
    await empty()
    await migratedSwarm()
    const old = await legacySwarm()
    await db.$runCommandRaw({ update: 'SuperTab', updates: [{ q: { _id: old }, u: { $unset: { format: '' } } }] })

    expect(await dropLegacyStates(db, { apply: true })).toMatchObject({ ok: false, unmigrated: 1, removed: 0 })
  })

  it('by default only reports how many Swarms keep an old state and its size, and writes nothing', async () => {
    await empty()
    const [first, second] = [await migratedSwarm(), await migratedSwarm()]
    await db.superTab.create({ data: { id: `tab-${randomUUID()}`, ownerId: 'owner', autonomousEnv: 'prod', format: 2, state: { version: 2 } } })

    expect(await dropLegacyStates(db)).toEqual({ ok: true, swarms: 3, unmigrated: 0, kept: 2, keptBytes: 2 * OLD_STATE_BYTES, removed: 0, batches: 0, writeErrors: 0 })
    expect([await kept(first), await kept(second)]).toEqual([OLD_STATE, OLD_STATE])
  })

  it('stops at the first batch the database refuses, and counts its refused writes', async () => {
    await empty()
    const ids = [await migratedSwarm(), await migratedSwarm()]
    // A validator that refuses any row without an old state, so every removal comes back as a write error.
    await db.$runCommandRaw({ collMod: 'SuperTab', validator: { legacyState: { $exists: true } }, validationAction: 'error' })
    try {
      expect(await dropLegacyStates(db, { apply: true, batch: 1 })).toEqual({ ok: true, swarms: 2, unmigrated: 0, kept: 2, keptBytes: 2 * OLD_STATE_BYTES,
        removed: 0, batches: 1, writeErrors: 1 })
    } finally {
      await db.$runCommandRaw({ collMod: 'SuperTab', validator: {}, validationLevel: 'off' })
    }
    expect(await Promise.all(ids.map(kept))).toEqual([OLD_STATE, OLD_STATE])
  }, 10_000)

  it('removes every kept old state in batches, leaving each Swarm\'s row and parts as they were', async () => {
    await empty()
    const ids = [await migratedSwarm(), await migratedSwarm(), await migratedSwarm()]
    const snapshot = () => Promise.all(ids.map(async id => ({
      row: await db.superTab.findUnique({ where: { id }, select: { format: true, revision: true, state: true, memberIds: true, migratedAt: true } }),
      parts: await db.$transaction(tx => parts.loadAll(tx, id)) })))
    const before = await snapshot()

    expect(await dropLegacyStates(db, { apply: true, batch: 2 })).toEqual({ ok: true, swarms: 3, unmigrated: 0, kept: 3, keptBytes: 3 * OLD_STATE_BYTES, removed: 3, batches: 2, writeErrors: 0 })
    expect(await db.$runCommandRaw({ count: 'SuperTab', query: { legacyState: { $exists: true } } })).toMatchObject({ n: 0 })
    expect(await Promise.all(ids.map(kept))).toEqual([null, null, null])
    expect(await snapshot()).toEqual(before)
    // Run again, it finds nothing left.
    expect(await dropLegacyStates(db, { apply: true })).toEqual({ ok: true, swarms: 3, unmigrated: 0, kept: 0, keptBytes: 0, removed: 0, batches: 0, writeErrors: 0 })
  })
})
