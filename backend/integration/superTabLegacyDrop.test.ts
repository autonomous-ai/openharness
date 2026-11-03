import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import * as parts from '../src/superTabs/parts/index.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { dropLegacyStates } from '../src/superTabs/migration/dropLegacy.js'
import { dropLegacyUntilDone, startLegacyDrop } from '../src/superTabs/migration/dropLegacyJob.js'
import { SuperTabStore } from '../src/superTabs/store.js'
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
      expect(await dropLegacyStates(db, { apply })).toEqual({ ok: false, swarms: 2, unmigrated: 1, kept: 0, keptBytes: 0, removed: 0, batches: 0, writeErrors: 0, done: false })
    }
    expect(await kept(migrated)).toEqual(OLD_STATE)
  })

  it('sums the kept old states only when it may remove them: a refused run reads no old state', async () => {
    await empty()
    await migratedSwarm()
    await legacySwarm()
    const commands: string[] = []
    const watching = new Proxy(db, { get: (target, key) => key === '$runCommandRaw'
      ? (command: object) => { commands.push(Object.keys(command)[0]!); return target.$runCommandRaw(command as never) }
      : Reflect.get(target, key, target) }) as PrismaClient

    expect(await dropLegacyStates(watching, { apply: true })).toMatchObject({ ok: false, kept: 0, keptBytes: 0 })
    expect(commands).toEqual(['count', 'count'])
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

    expect(await dropLegacyStates(db)).toEqual({ ok: true, swarms: 3, unmigrated: 0, kept: 2, keptBytes: 2 * OLD_STATE_BYTES, removed: 0, batches: 0, writeErrors: 0, done: false })
    expect([await kept(first), await kept(second)]).toEqual([OLD_STATE, OLD_STATE])
  })

  it('stops at the first batch the database refuses, and counts its refused writes', async () => {
    await empty()
    const ids = [await migratedSwarm(), await migratedSwarm()]
    // A validator that refuses any row without an old state, so every removal comes back as a write error.
    await db.$runCommandRaw({ collMod: 'SuperTab', validator: { legacyState: { $exists: true } }, validationAction: 'error' })
    try {
      expect(await dropLegacyStates(db, { apply: true, batch: 1 })).toEqual({ ok: true, swarms: 2, unmigrated: 0, kept: 2, keptBytes: 2 * OLD_STATE_BYTES,
        removed: 0, batches: 1, writeErrors: 1, done: false })
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

    expect(await dropLegacyStates(db, { apply: true, batch: 2 })).toEqual({ ok: true, swarms: 3, unmigrated: 0, kept: 3, keptBytes: 3 * OLD_STATE_BYTES, removed: 3, batches: 2, writeErrors: 0, done: true })
    expect(await db.$runCommandRaw({ count: 'SuperTab', query: { legacyState: { $exists: true } } })).toMatchObject({ n: 0 })
    expect(await Promise.all(ids.map(kept))).toEqual([null, null, null])
    expect(await snapshot()).toEqual(before)
    // Run again, it finds nothing left.
    expect(await dropLegacyStates(db, { apply: true })).toEqual({ ok: true, swarms: 3, unmigrated: 0, kept: 0, keptBytes: 0, removed: 0, batches: 0, writeErrors: 0, done: true })
  })

  it('pauses after every batch, so a large backlog never holds the database for long', async () => {
    await empty()
    await Promise.all([migratedSwarm(), migratedSwarm(), migratedSwarm()])
    let pauses = 0

    const report = await dropLegacyStates(db, { apply: true, batch: 1, pause: async () => { pauses++ } })

    expect(report).toMatchObject({ removed: 3, batches: 3, done: true })
    expect(pauses).toBe(3)
  })

  it('does not call a refused run done, so a runner keeps trying', async () => {
    await empty()
    await migratedSwarm()
    await db.$runCommandRaw({ collMod: 'SuperTab', validator: { legacyState: { $exists: true } }, validationLevel: 'strict', validationAction: 'error' })
    try {
      expect(await dropLegacyStates(db, { apply: true })).toMatchObject({ writeErrors: 1, done: false })
    } finally {
      await db.$runCommandRaw({ collMod: 'SuperTab', validator: {}, validationLevel: 'off' })
    }
  }, 10_000)
})

describe('the automatic removal after a release', () => {
  const noWait = async () => {}

  it('removes every old state in small batches and stops, with nothing to remove left', async () => {
    await empty()
    const ids = [await migratedSwarm(), await migratedSwarm(), await migratedSwarm()]
    const logs: Array<Record<string, unknown>> = []

    const report = await dropLegacyUntilDone(db, { batch: 2, pause: noWait, wait: noWait, log: line => logs.push(line) })

    expect(report).toMatchObject({ removed: 3, batches: 2, done: true })
    expect(await Promise.all(ids.map(kept))).toEqual([null, null, null])
    // Counts and sizes only: nothing that names a Swarm.
    expect(logs).toEqual([expect.objectContaining({ removed: 3, kept: 3, done: true })])
    expect(JSON.stringify(logs)).not.toContain(ids[0])
  })

  it('does nothing and stops at once when no Swarm keeps an old state', async () => {
    await empty()
    await db.superTab.create({ data: { id: `tab-${randomUUID()}`, ownerId: 'owner', autonomousEnv: 'prod', format: 2, state: { version: 2 } } })
    let waits = 0

    expect(await dropLegacyUntilDone(db, { wait: async () => { waits++ } })).toMatchObject({ removed: 0, batches: 0, done: true })
    expect(waits).toBe(0)
  })

  it('waits while a Swarm is still in one row and removes once it is split, without ever removing before', async () => {
    await empty()
    const migrated = await migratedSwarm()
    const old = await legacySwarm()
    const seen: Array<unknown> = []

    const report = await dropLegacyUntilDone(db, { pause: noWait, wait: async () => {
      seen.push(await kept(migrated))
      expect((await migrateSwarm(db, old, { now: () => NOW })).ok).toBe(true)
    } })

    expect(seen).toEqual([OLD_STATE])
    expect(report).toMatchObject({ ok: true, done: true })
    // The Swarm migrated meanwhile keeps its own old state too, and loses it in the same run.
    expect([await kept(migrated), await kept(old)]).toEqual([null, null])
  })

  it('retries after the database throws, then finishes', async () => {
    await empty()
    const swarm = await migratedSwarm()
    let tries = 0
    const flaky = new Proxy(db, { get(target, key, receiver) {
      if (key === '$runCommandRaw' && tries++ === 0) return async () => { throw new Error('connection reset') }
      return Reflect.get(target, key, receiver)
    } })
    const logs: Array<Record<string, unknown>> = []

    expect(await dropLegacyUntilDone(flaky, { pause: noWait, wait: noWait, log: line => logs.push(line) })).toMatchObject({ removed: 1, done: true })
    expect(await kept(swarm)).toBeNull()
    expect(logs[0]).toEqual({ failed: 'connection reset' })
  })

  it('stops between runs when asked to', async () => {
    await empty()
    await migratedSwarm()
    await legacySwarm()
    const control = new AbortController()
    let waits = 0

    await dropLegacyUntilDone(db, { signal: control.signal, wait: async () => { if (++waits === 2) control.abort() } })

    expect(waits).toBe(2)
  })

  it('stops after the write in flight when asked, leaving the rest alone', async () => {
    await empty()
    const [first, second] = [await migratedSwarm(), await migratedSwarm()]
    const control = new AbortController()

    const report = await dropLegacyUntilDone(db, { batch: 1, signal: control.signal, pause: async () => control.abort(), wait: async () => {} })

    expect(report).toMatchObject({ removed: 1, batches: 1, done: false })
    expect([await kept(first), await kept(second)].filter(state => state === null)).toHaveLength(1)
  })

  it('runs by itself once started', async () => {
    await empty()
    const ids = [await migratedSwarm(), await migratedSwarm()]

    const stop = startLegacyDrop(db, 0)
    try {
      await vi.waitFor(async () => expect(await Promise.all(ids.map(kept))).toEqual([null, null]), { timeout: 10_000 })
    } finally {
      stop()
    }
  })

  it('stops in the middle of a backlog when asked, leaving the rest alone', async () => {
    await empty()
    const ids = [await migratedSwarm(), await migratedSwarm(), await migratedSwarm()]
    const removed = async () => (await Promise.all(ids.map(kept))).filter(state => state === null).length

    const stop = startLegacyDrop(db, 0, 1)
    await vi.waitFor(async () => expect(await removed()).toBeGreaterThan(0), { timeout: 10_000 })
    stop()
    // The pause between writes is cut short by the stop, and no further write follows it.
    const atStop = await removed()
    await new Promise(resolve => setTimeout(resolve, 1_000))

    expect(atStop).toBeLessThan(3)
    expect(await removed()).toBeLessThanOrEqual(atStop + 1)
    expect(await removed()).toBeLessThan(3)
  })

  it('never loads a kept old state into the rows the store and the host poll read', async () => {
    await empty()
    const tabId = await migratedSwarm()
    const user = { sub: (await db.superTab.findUniqueOrThrow({ where: { id: tabId } })).ownerId, email: 'o@example.com', autonomousEnv: 'prod', role: 'user' } as const

    const row = await new SuperTabStore(db).row(db, user, tabId)

    expect(Object.keys(row).sort()).toEqual(['deletedAt', 'format', 'id', 'ownerId', 'revision'])
  })
})
