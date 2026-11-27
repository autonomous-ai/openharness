import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import { ensureIndex } from '../src/lib/db/indexes.js'
import { releaseSchema } from '../src/lib/db/schemaRelease.js'
import { ensureReceiptRule } from '../src/lib/productUsageReceiptSweep.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database; each test has a
// database of its own. On 10-28 a release's schema step dropped every expiry index Prisma does not describe and the worker
// built each one again over its whole collection, and reads whose transactions wait at most 5 ms for a lock failed. Mongo's
// profiler shows every command a release sends and the locks each one took.
let replica: MongoMemoryReplSet
let folder: string
const DAY = 86_400
const SCHEMA = join(process.cwd(), 'prisma/schema.prisma')

/** Every index Prisma cannot describe, as the worker has always made it: collection, name, key, seconds to expiry. */
const EXPIRY: Array<[string, string, Record<string, number>, number]> = [
  ['product_usage_receipts', 'product_usage_expiry', { expiresAt: 1 }, 0],
  ['product_usage_totals', 'product_usage_expiry', { dayUtc: 1 }, 396 * DAY],
  ...['user_daily_presence', 'user_daily_client_presence', 'user_daily_remote_usage', 'user_daily_device_presence', 'machine_daily_presence',
    'agent_daily_presence', 'analytics_daily_buckets', 'analytics_daily_machines'].map(c => [c, 'product_usage_expiry', { dayUtc: 1 }, 35 * DAY] as [string, string, Record<string, number>, number]),
  ['product_usage_activity', 'product_usage_expiry', { expiresAt: 1 }, 0],
  ['harness_sessions', 'harness_session_expiry', { expiresAt: 1 }, 30 * DAY],
  ['push_devices', 'push_device_expiry', { seenAt: 1 }, 90 * DAY],
]

type Profiled = { ts: Date; ns: string; errCode?: number; command?: Record<string, unknown>; locks?: Record<string, { acquireCount?: Record<string, number> }> }

async function database() {
  const uri = replica.getUri(`schema_release_test_${randomUUID().replaceAll('-', '_')}`)
  const db = new PrismaClient({ datasources: { db: { url: uri } } })
  await db.$runCommandRaw({ profile: 2 })
  return { db, target: { databaseUrl: uri } }
}

async function profiled(db: PrismaClient, since: Date): Promise<Profiled[]> {
  const answer = await db.$runCommandRaw({ find: 'system.profile', filter: { ts: { $gt: { $date: since.toISOString() } } }, batchSize: 100_000, singleBatch: true }) as
    { cursor: { firstBatch: Profiled[] } }
  return answer.cursor.firstBatch
}

/** The index changes a release made: index builds, drops and option changes, in order, as `command collection name`. */
async function indexChanges(db: PrismaClient, since: Date): Promise<string[]> {
  return (await profiled(db, since)).flatMap(entry => {
    const command = entry.command ?? {}
    if (entry.errCode !== undefined) return []
    if ('createIndexes' in command) return (command.indexes as Array<{ name: string }>).map(i => `createIndexes ${command.createIndexes} ${i.name}`)
    if ('dropIndexes' in command) return [`dropIndexes ${command.dropIndexes} ${command.index}`]
    if ('collMod' in command) return [`collMod ${command.collMod} ${(command.index as { name?: string } | undefined)?.name ?? ''}`]
    return []
  })
}

/** Operations that took a database or collection lock in exclusive mode (W), which every other read and write waits behind. */
async function exclusiveLocks(db: PrismaClient, since: Date): Promise<string[]> {
  return (await profiled(db, since)).filter(entry => ['Database', 'Collection'].some(resource => entry.locks?.[resource]?.acquireCount?.W))
    .map(entry => `${Object.keys(entry.command ?? {})[0]} ${entry.ns}`)
}

async function expiryIndexes(db: PrismaClient): Promise<Array<[string, string, Record<string, number>, number | undefined]>> {
  const found: Array<[string, string, Record<string, number>, number | undefined]> = []
  for (const [collection, name] of EXPIRY) {
    const answer = await db.$runCommandRaw({ listIndexes: collection }) as { cursor: { firstBatch: Array<{ name: string; key: Record<string, number>; expireAfterSeconds?: number }> } }
    const index = answer.cursor.firstBatch.find(i => i.name === name)
    if (index) found.push([collection, index.name, index.key, index.expireAfterSeconds])
  }
  return found
}

/** The release's schema with `edit` applied, in a file of its own. */
async function schemaWith(edit: (schema: string) => string): Promise<string> {
  const path = join(folder, `${randomUUID()}.prisma`)
  const schema = await readFile(SCHEMA, 'utf8')
  const edited = edit(schema)
  expect(edited).not.toBe(schema)
  await writeFile(path, edited)
  return path
}
/** The schema with one more index on the shares. */
const shareIndex = (schema: string) => schema.replace('  @@index([ownerId, machineId])\n', '  @@index([ownerId, machineId])\n  @@index([ownerId, createdAt])\n')

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  folder = await mkdtemp(join(tmpdir(), 'schema-release-'))
})
afterAll(async () => {
  await replica?.stop()
  if (folder) await rm(folder, { recursive: true, force: true })
})

describe('a release\'s schema step', () => {
  it('gives a new database every expiry index, each with its time', async () => {
    const { db, target } = await database()
    await releaseSchema(db, target)
    expect(await expiryIndexes(db)).toEqual(EXPIRY)
    await db.$disconnect()
  }, 240_000)

  it('changes no index and takes no exclusive lock when the schema has not changed', async () => {
    const { db, target } = await database()
    await releaseSchema(db, target)
    const since = new Date()
    await releaseSchema(db, target)
    expect(await indexChanges(db, since)).toEqual([])
    expect(await exclusiveLocks(db, since)).toEqual([])
    expect(await expiryIndexes(db)).toEqual(EXPIRY)
    await db.$disconnect()
  }, 240_000)

  it('builds only the new index when the schema changed, and drops no expiry index', async () => {
    const { db, target } = await database()
    await releaseSchema(db, target)
    const since = new Date()
    await releaseSchema(db, { ...target, schema: await schemaWith(shareIndex) })
    expect(await indexChanges(db, since)).toEqual(['createIndexes harness_shares harness_shares_ownerId_createdAt_idx'])
    // The build's own moment: Mongo builds in the background and locks the collection exclusively only to begin and to finish.
    expect(await exclusiveLocks(db, since)).toEqual([expect.stringMatching(/^createIndexes \w+\.harness_shares$/)])
    expect(await expiryIndexes(db)).toEqual(EXPIRY)
    await db.$disconnect()
  }, 240_000)

  it('gives an expiry index whose time changed its new time, without a rebuild', async () => {
    const { db, target } = await database()
    await releaseSchema(db, target)
    await db.$runCommandRaw({ collMod: 'harness_sessions', index: { name: 'harness_session_expiry', expireAfterSeconds: 7 * DAY } })
    const since = new Date()
    await releaseSchema(db, target)
    expect(await indexChanges(db, since)).toEqual(['collMod harness_sessions harness_session_expiry'])
    expect(await expiryIndexes(db)).toEqual(EXPIRY)
    await db.$disconnect()
  }, 240_000)

  it('gives an existing collection its new expiry index when the database user may not run collMod (prod 10-29)', async () => {
    const { db, target } = await database()
    // Production before the push devices' expiry: their collection, with a row, and no expiry index.
    const before = await schemaWith(schema => schema.replace(/\n *\/\/\/[^\n]*\n *@@index\(\[seenAt\], map: "push_device_expiry"\)/, ''))
    await releaseSchema(db, { ...target, schema: before })
    await db.$runCommandRaw({ dropIndexes: 'push_devices', index: 'push_device_expiry' }).catch(() => {})
    await db.pushDevice.create({ data: { id: 'phone', userId: 'u', platform: 'ios', token: 't', seenAt: new Date() } })
    // As Prisma reports Mongo's refusal (code 13) of collMod to production's app user; db push runs as its own process.
    const refusing = new Proxy(db, { get: (held, key) => key === '$runCommandRaw'
      ? (command: Record<string, unknown>) => 'collMod' in command
        ? Promise.reject(new Error('Raw query failed. Code: `13`. Message: `not authorized on harness to execute command { collMod: "push_devices" }`'))
        : held.$runCommandRaw(command as never)
      : Reflect.get(held, key) })
    const since = new Date()
    await releaseSchema(refusing, target)
    expect((await indexChanges(db, since)).filter(change => change.includes('push_devices'))).toEqual(['createIndexes push_devices push_device_expiry'])
    expect(await expiryIndexes(db)).toEqual(EXPIRY)
    await db.$disconnect()
  }, 240_000)
})

describe('the usage receipt rule (lib/productUsageReceiptSweep.ts)', () => {
  const rule = async (db: PrismaClient) => ((await db.$runCommandRaw({ listCollections: 1, filter: { name: 'product_usage_receipts' } }) as
    { cursor: { firstBatch: Array<{ options: Record<string, unknown> }> } }).cursor.firstBatch[0]?.options)

  it('survives a release, with or without a schema change, and the release does not touch it', async () => {
    const { db, target } = await database()
    await releaseSchema(db, target)
    await ensureReceiptRule(db)
    const installed = await rule(db)
    expect(installed).toMatchObject({ validator: { $jsonSchema: { required: ['life'] } }, validationLevel: 'strict', validationAction: 'error' })
    const since = new Date()
    await releaseSchema(db, target)
    await releaseSchema(db, { ...target, schema: await schemaWith(shareIndex) })
    expect(await rule(db)).toEqual(installed)
    expect((await indexChanges(db, since)).filter(change => change.includes('product_usage_receipts'))).toEqual([])
    await db.$disconnect()
  }, 240_000)

  it('is installed once: a second install sends no change', async () => {
    const { db, target } = await database()
    await releaseSchema(db, target)
    await ensureReceiptRule(db)
    const since = new Date()
    await ensureReceiptRule(db)
    expect(await indexChanges(db, since)).toEqual([])
    await db.$disconnect()
  }, 240_000)
})

describe('ensureIndex', () => {
  it('creates the collection and its index when neither exists', async () => {
    const { db } = await database()
    await ensureIndex(db, 'not_yet_made', { key: { at: 1 }, name: 'not_yet_made_expiry', expireAfterSeconds: 60 })
    const answer = await db.$runCommandRaw({ listIndexes: 'not_yet_made' }) as { cursor: { firstBatch: Array<{ name: string; expireAfterSeconds?: number }> } }
    expect(answer.cursor.firstBatch.map(i => [i.name, i.expireAfterSeconds])).toEqual([['_id_', undefined], ['not_yet_made_expiry', 60]])
    await db.$disconnect()
  })
})
