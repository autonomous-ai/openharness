import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { REMOVED_COLLECTIONS } from '../src/superTabs/migration/dropCollections.js'
import { dropLegacyUntilDone } from '../src/superTabs/migration/dropLegacyJob.js'

// The job that removes what Swarm v4 removed from the database (superTabs/migration/dropCollections.ts), against a real database: the
// removed collections go, whole, with their in-flight removals; every other collection keeps every row, and a v4 Swarm reads as it did.
// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const owner: AuthUser = { sub: '300000000000000000000001', email: 'drop-owner@example.com', autonomousEnv: 'prod', role: 'user' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_collection_drop_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db)
  await db.user.create({ data: { id: owner.sub, externalId: 'fixture-drop-owner', email: owner.email, autonomousEnv: 'prod' } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

const raw = (command: object) => db.$runCommandRaw(command as never)
const removed = new Set<string>(REMOVED_COLLECTIONS)
const listed = async () => ((await raw({ listCollections: 1, nameOnly: true })) as { cursor: { firstBatch: Array<{ name: string }> } }).cursor.firstBatch.map(c => c.name).sort()
const count = async (collection: string) => Number(((await raw({ count: collection })) as { n: unknown }).n)
/** Rows as an older release left them: an id and the fields its indexes named. */
const fill = (collection: string, rows: number, extra: Record<string, unknown> = {}) => raw({ insert: collection,
  documents: Array.from({ length: rows }, (_, i) => ({ _id: `${collection}-${i}`, tabId: 'old-swarm', workspaceId: 'old-workspace', userId: 'old-person', ...extra })) })
/** Every collection a v4 Swarm uses, by its row count. */
async function kept(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const name of await listed()) if (!removed.has(name) && !name.startsWith('system.')) counts[name] = await count(name)
  return counts
}
/** A job that must finish in its first try: a failed or unfinished try would wait an hour. */
const once = { wait: () => Promise.reject(new Error('the job did not finish in its first try')) }

describe('the job that drops the collections Swarm v4 removed', () => {
  it('drops them whole, in-flight removals included, and leaves every row of every other collection and a v4 Swarm as they were', async () => {
    const tab = (await store.create(owner, randomUUID(), 'Pilot')).id
    await store.execute(owner, tab, { operationId: randomUUID(), command: { type: 'message.send', conversationId: 'lead', text: 'Kept by the drop', replyTo: null, recipientIds: [] } })
    for (const name of REMOVED_COLLECTIONS) await fill(name, 3, name === 'SwarmWorkspaceRemoval' ? { finishedAt: null } : {})
    const shown = async () => { const { state } = await store.read(owner, tab); return { name: state.name, chats: state.conversations.map(c => c.id).sort(), projects: state.projects!.map(p => p.id) } }
    const swarm = await shown()
    const rows = await kept()
    expect(Object.keys(rows)).toEqual(expect.arrayContaining(['SuperTab', 'SwarmHead', 'SwarmGroup', 'SuperTabMessage']))
    const lines: Array<Record<string, unknown>> = []

    const report = await dropLegacyUntilDone(db, { ...once, log: line => lines.push(line) })

    expect(report?.done).toBe(true)
    expect((await listed()).filter(name => removed.has(name))).toEqual([])
    expect(await kept()).toEqual(rows)
    expect(await shown()).toEqual(swarm)
    // The log says how many rows each held, and no row or id.
    const dropped = lines.flatMap(line => (line.removedCollections ?? []) as Array<{ collection: string; rows: number; dropped: boolean }>)
    expect(dropped.map(d => [d.collection, d.rows, d.dropped]).sort()).toEqual([...REMOVED_COLLECTIONS].map(name => [name, 3, true]).sort())
    expect(JSON.stringify(lines)).not.toContain('old-swarm')
    expect(lines.filter(line => 'failed' in line || (line.collectionsFailed as unknown[] | undefined)?.length)).toEqual([])
  })

  it('finds nothing to do the next time, so a restarted worker costs one listing', async () => {
    const lines: Array<Record<string, unknown>> = []
    const report = await dropLegacyUntilDone(db, { ...once, log: line => lines.push(line) })
    expect(report?.done).toBe(true)
    expect(lines.flatMap(line => (line.removedCollections ?? []) as unknown[])).toEqual([])
  })

  it('finishes in two pods at once, with many rows, whichever drops a collection first', async () => {
    for (const name of ['SwarmWorkspace', 'SwarmWorkspaceMember', 'SuperTabScorecard']) await fill(name, 1300)
    const before = await kept()
    const lines: Array<Record<string, unknown>> = []

    const [a, b] = await Promise.all([dropLegacyUntilDone(db, { ...once, log: line => lines.push(line) }), dropLegacyUntilDone(db, { ...once, log: line => lines.push(line) })])

    expect([a?.done, b?.done]).toEqual([true, true])
    expect((await listed()).filter(name => removed.has(name))).toEqual([])
    expect(await kept()).toEqual(before)
    expect(lines.filter(line => 'failed' in line || (line.collectionsFailed as unknown[] | undefined)?.length)).toEqual([])
  })
})
