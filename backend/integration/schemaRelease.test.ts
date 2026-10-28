import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import { ensureIndex } from '../src/lib/db/indexes.js'
import { releaseSchema } from '../src/lib/db/schemaRelease.js'
import { DIRECT, readLight, readParts } from '../src/superTabs/cachedReads.js'
import * as parts from '../src/superTabs/parts/index.js'
import { swarm } from '../src/superTabs/read/fixture.test-support.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database; each test has a
// database of its own. On 10-28 a release's schema step dropped every expiry index Prisma does not describe and the worker
// built each one again over its whole collection: Swarm reads, whose transactions wait at most 5 ms for a lock, failed on
// the groups and starts collections. Mongo's profiler shows every command a release sends and the locks each one took.
let replica: MongoMemoryReplSet
let folder: string
const DAY = 86_400
const SCHEMA = join(process.cwd(), 'prisma/schema.prisma')

/** Every index Prisma cannot describe, as the worker has always made it: collection, name, key, seconds to expiry. */
const EXPIRY: Array<[string, string, Record<string, number>, number]> = [
  ...['SwarmHead', 'SwarmGroup', 'SwarmStart', 'SwarmProgress'].map(c => [c, 'part_purge', { purgeAt: 1 }, 0] as [string, string, Record<string, number>, number]),
  ...['SwarmWorkspace', 'SwarmWorkspaceMember', 'SwarmWorkspaceRemoval'].map(c => [c, 'workspace_purge', { purgeAt: 1 }, 0] as [string, string, Record<string, number>, number]),
  ['SwarmWorkspaceInvitation', 'workspace_invitation_expiry', { expiresAt: 1 }, 0],
  ['SuperTabMention', 'mention_expiry', { createdAt: 1 }, 30 * DAY],
  ['SuperTabTerminalRequest', 'terminal_request_expiry', { createdAt: 1 }, 120],
  ['product_usage_receipts', 'product_usage_expiry', { expiresAt: 1 }, 0],
  ['product_usage_totals', 'product_usage_expiry', { dayUtc: 1 }, 396 * DAY],
  ...['user_daily_presence', 'user_daily_client_presence', 'user_daily_remote_usage', 'user_daily_device_presence', 'machine_daily_presence',
    'agent_daily_presence', 'analytics_daily_buckets', 'analytics_daily_machines'].map(c => [c, 'product_usage_expiry', { dayUtc: 1 }, 35 * DAY] as [string, string, Record<string, number>, number]),
  ['product_usage_activity', 'product_usage_expiry', { expiresAt: 1 }, 0],
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
const groupIndex = (line: string) => (schema: string) => schema.replace('  @@index([workFinished, archived, lastActivityAt])\n', `  @@index([workFinished, archived, lastActivityAt])\n  ${line}\n`)

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
    await releaseSchema(db, { ...target, schema: await schemaWith(groupIndex('@@index([tabId, purgeAt])')) })
    expect(await indexChanges(db, since)).toEqual(['createIndexes SwarmGroup SwarmGroup_tabId_purgeAt_idx'])
    // The build's own moment: Mongo builds in the background and locks the collection exclusively only to begin and to finish.
    expect(await exclusiveLocks(db, since)).toEqual([expect.stringMatching(/^createIndexes \w+\.SwarmGroup$/)])
    expect(await expiryIndexes(db)).toEqual(EXPIRY)
    await db.$disconnect()
  }, 240_000)

  it('gives an expiry index whose time changed its new time, without a rebuild', async () => {
    const { db, target } = await database()
    await releaseSchema(db, target)
    await db.$runCommandRaw({ collMod: 'SuperTabMention', index: { name: 'mention_expiry', expireAfterSeconds: 7 * DAY } })
    const since = new Date()
    await releaseSchema(db, target)
    expect(await indexChanges(db, since)).toEqual(['collMod SuperTabMention mention_expiry'])
    expect(await expiryIndexes(db)).toEqual(EXPIRY)
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

/** Resolves once `ready` holds, checking every 10 ms. */
async function until(ready: () => boolean | Promise<boolean>): Promise<void> {
  while (!await ready()) await new Promise(resolve => setTimeout(resolve, 10))
}

describe('a Swarm read on a cache miss while a release changes an index on its collection', () => {
  // The 10-28 failure, made certain: a transaction that has read the groups holds its lock until it ends, an index build
  // queues for its exclusive lock behind it, and every transaction after that waits behind the build. Mongo lets a
  // transaction wait 5 ms for a lock, so the read's first attempt always fails; the open transaction ends only once the read
  // has had to try again.
  for (const [name, read] of [
    ['reading the active parts', (db: PrismaClient) => readParts(db, DIRECT, 't')],
    ['a light read', (db: PrismaClient) => readLight(db, DIRECT, 't', {})],
  ] as const) {
    it(`${name} waits the lock out instead of failing`, async () => {
      const { db } = await database()
      const fixture = swarm(Date.now())
      fixture.group('Web')
      await db.$transaction(tx => parts.insertParts(tx, parts.split(fixture.state, { tabId: 't', version: 1, now: Date.now() })))
      const groups = fixture.state.conversations.map(c => c.id).sort()
      let release!: () => void, opened!: () => void
      const held = new Promise<void>(resolve => { release = resolve }), isOpen = new Promise<void>(resolve => { opened = resolve })
      const open = db.$transaction(async tx => { await tx.swarmGroup.findMany({ where: { tabId: 't' } }); opened(); await held }, { timeout: 60_000 })
      await isOpen
      // Prisma sends a query only once it is awaited or given a then.
      const build = db.$runCommandRaw({ createIndexes: 'SwarmGroup', indexes: [{ key: { tabId: 1, ordinal: 1 }, name: 'built_during_a_read' }] }).then(answer => answer)
      const admin = new PrismaClient({ datasources: { db: { url: replica.getUri('admin') } } })
      await until(async () => {
        const ops = await admin.$runCommandRaw({ aggregate: 1, pipeline: [{ $currentOp: {} }, { $match: { 'command.createIndexes': 'SwarmGroup', waitingForLock: true } }], cursor: {} }) as
          { cursor: { firstBatch: unknown[] } }
        return ops.cursor.firstBatch.length > 0
      })
      await admin.$disconnect()
      let attempts = 0
      const counting = new Proxy(db, { get: (target, key, receiver) => key === '$transaction'
        ? (...args: Parameters<PrismaClient['$transaction']>) => { attempts++; return (target.$transaction as (...a: unknown[]) => unknown)(...args) }
        : Reflect.get(target, key, receiver) })
      let settled = false
      const reading = read(counting).finally(() => { settled = true })
      await until(() => attempts >= 2 || settled)
      release()
      await Promise.all([open, build])
      expect((await reading).groups.map(g => g.key).sort()).toEqual(groups)
      expect(attempts).toBeGreaterThanOrEqual(2)
      await db.$disconnect()
    }, 60_000)
  }
})
