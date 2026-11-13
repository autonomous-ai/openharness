import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import { SWARM_COLLECTIONS } from '../src/lib/db/dropCollections.js'
import { removeSwarmData } from '../src/lib/db/swarmDataRemoval.js'
import type { FileStore } from '../src/lib/db/swarmFiles.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// The one-time removal of everything the Swarm stored (anh Dee, 2026-11-14), against a fresh loopback replica set with this
// release's schema pushed and the Swarm's collections as an older release left them: never DATABASE_URL or a real database.
let replica: MongoMemoryReplSet
let db: PrismaClient
const DAY = 86_400_000
const settings = { SUPER_TAB_ATTACHMENTS_BUCKET: 'files', SUPER_TAB_ATTACHMENTS_CREDENTIALS: '', SUPER_TAB_ATTACHMENTS_PREFIX: 'super-tabs', SUPER_TAB_AVATARS_BUCKET: '' }

/** The attachments bucket as production has it: the Swarm's chat files and avatars beside what other releases keep there. */
class Bucket implements FileStore {
  readonly names = new Set<string>()
  constructor(...names: string[]) { for (const name of names) this.names.add(name) }
  async list(prefix: string, max: number) { return [...this.names].filter(name => name.startsWith(prefix)).sort().slice(0, max) }
  async delete(name: string) { this.names.delete(name) }
}

const collections = async (): Promise<string[]> => ((await db.$runCommandRaw({ listCollections: 1, nameOnly: true }) as
  { cursor: { firstBatch: Array<{ name: string }> } }).cursor.firstBatch.map(c => c.name).filter(name => !name.startsWith('system.')).sort())
const count = async (collection: string) => Number((await db.$runCommandRaw({ count: collection }) as { n: number }).n)

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_data_removal'))
  // What an older release left: a few rows in every collection only the Swarm used, as raw documents.
  for (const collection of SWARM_COLLECTIONS) {
    await db.$runCommandRaw({ insert: collection, documents: Array.from({ length: 3 }, (_, i) => ({ _id: `${collection}-${i}`, tabId: 't', text: 'a person\'s words' })) })
  }
  await db.$runCommandRaw({ createIndexes: 'SwarmGroup', indexes: [{ key: { tabId: 1 }, name: 'SwarmGroup_tabId_idx' }] })
  // What everything else keeps.
  await db.user.create({ data: { id: 'a'.repeat(24), externalId: 'fixture-a', email: 'owner@example.com', autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'm1', userId: 'a'.repeat(24), apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await db.pushDevice.create({ data: { id: 'phone', userId: 'a'.repeat(24), platform: 'ios', token: 't', seenAt: new Date() } })
  const share = (agentId: string, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), ownerId: 'a'.repeat(24), machineId: 'm1', agentId,
    recipientEmail: 'ken@example.com', autonomousEnv: 'prod', name: agentId, ownerPublicKey: 'fixture-key', expiresAt: new Date(Date.now() + DAY), ...extra })
  await db.harnessShare.createMany({ data: [share('ordinary', { superTabId: null }), share('older'), ...Array.from({ length: 3 }, (_, i) => share(`swarm-${i}`, { superTabId: 'b'.repeat(24) }))] })
}, 300_000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe('the Swarm data removal on Mongo', () => {
  it('drops every Swarm collection and the Swarm\'s shares and files, and keeps everything else', async () => {
    const before = await collections()
    expect(SWARM_COLLECTIONS.every(name => before.includes(name))).toBe(true)
    const bucket = new Bucket('super-tabs/t/x/notes.txt', 'super-tabs/t/x/a.png.thumb.webp', 'avatars/t/a.png', 'harness/cli/metadata.json', 'release/icon.png')

    let pass!: Awaited<ReturnType<typeof removeSwarmData>>
    const entries = await profiled(db, async () => { pass = await removeSwarmData(db, settings, () => bucket) })

    expect(pass).toMatchObject({ files: { objects: 3, failed: 0, done: true }, shares: 3, collectionsFailed: [], failed: {}, clean: false })
    expect(pass.collections.map(c => [c.collection, c.rows, c.dropped]).sort()).toEqual(SWARM_COLLECTIONS.map(name => [name, 3, true]).sort())
    expect((await collections()).filter(name => (SWARM_COLLECTIONS as readonly string[]).includes(name))).toEqual([])
    expect(before.filter(name => !(SWARM_COLLECTIONS as readonly string[]).includes(name))).toEqual(await collections())
    expect((await db.harnessShare.findMany({ select: { agentId: true }, orderBy: { agentId: 'asc' } })).map(s => s.agentId)).toEqual(['older', 'ordinary'])
    expect([await count('users'), await count('machines'), await count('push_devices')]).toEqual([1, 1, 1])
    expect([...bucket.names].sort()).toEqual(['harness/cli/metadata.json', 'release/icon.png'])
    // The shares are read by their _id index, a chunk at a time, never a collection scan.
    const shareReads = reads(entries, 'harness_shares', ['superTabId'])
    expect(shareReads.length, JSON.stringify(plan(shareReads))).toBeGreaterThan(0)
    for (const row of shareReads) expect(row.planSummary, JSON.stringify(plan(shareReads))).toMatch(/IXSCAN \{ _id: 1 \}/)
  }, 120_000)

  it('finds nothing left on the next pass, and writes nothing', async () => {
    const bucket = new Bucket('harness/cli/metadata.json')
    let pass!: Awaited<ReturnType<typeof removeSwarmData>>
    const kept = await collections()
    const entries = await profiled(db, async () => { pass = await removeSwarmData(db, settings, () => bucket) })
    expect(pass).toMatchObject({ clean: true, shares: 0, collections: [], failed: {}, files: { objects: 0, done: true } })
    expect(entries.filter(e => ['remove', 'update', 'insert'].includes(e.op)).map(e => `${e.op} ${e.ns}`)).toEqual([])
    expect(await collections()).toEqual(kept)
    expect(bucket.names.size).toBe(1)
  }, 60_000)

  it('removes what an older release still wrote after the first pass, during its rollout', async () => {
    await db.$runCommandRaw({ insert: 'SuperTabOperation', documents: [{ _id: 'late', tabId: 't' }] })
    const pass = await removeSwarmData(db, settings, () => new Bucket())
    expect(pass.collections).toEqual([{ collection: 'SuperTabOperation', rows: 1, dropped: true }])
    expect(pass.clean).toBe(false)
    expect((await removeSwarmData(db, settings, () => new Bucket())).clean).toBe(true)
  }, 60_000)
})
