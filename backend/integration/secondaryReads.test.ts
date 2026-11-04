import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient, type Prisma } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { secondaryReadsUrl } from '../src/lib/databaseUrl.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import type { Command } from '../src/superTabs/commands.js'
import { planDatabase } from './plans.test-support.js'

// Task #2970: the reads that tolerate a few seconds of lag go to the secondary client, everything that must see the latest
// write stays on the primary. A single-node replica set: the secondary client's `secondaryPreferred` reads its one member,
// so a moved read must return exactly the rows the primary gives.
let replica: MongoMemoryReplSet
let uri: string
let db: PrismaClient
const clients: PrismaClient[] = []
const owner: AuthUser = { sub: '510000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '510000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

type Op = { model: string; operation: string; args: unknown }
/** A client that keeps the operations it sends, by model and action. */
function recorded(base: PrismaClient): { client: PrismaClient; ops: Op[] } {
  const ops: Op[] = []
  const client = base.$extends({ query: { async $allOperations({ model, operation, args, query }) {
    ops.push({ model: model ?? '-', operation, args })
    return query(args)
  } } }) as unknown as PrismaClient
  return { client, ops }
}
const client = (url: string) => { const made = new PrismaClient({ datasources: { db: { url } } }); clients.push(made); return made }
const models = (ops: Op[]) => [...new Set(ops.map(o => o.model))].sort()
/** The message reads among `ops` that page by sequence: an older or newer page's batches. */
const pageBatches = (ops: Op[]) => ops.filter(o => o.model === 'SuperTabMessage' && JSON.stringify(o.args).includes('"sequence":{'))

beforeAll(async () => {
  ({ replica, db, uri } = await planDatabase('secondary_reads_test'))
  for (const user of [owner, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: 'prod', name: user.email.split('@')[0] } })
  await db.machine.create({ data: { machineId: 'test-host', userId: host.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machineShare.create({ data: { machineId: 'test-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
})
afterAll(async () => {
  await Promise.allSettled([db?.$disconnect(), ...clients.map(c => c.$disconnect())])
  await replica?.stop()
})

/** A store whose primary and secondary clients each record what they read; [secondaryUrl] is where the secondary reads. */
function stores(secondaryUrl = secondaryReadsUrl(uri)) {
  const primary = recorded(client(uri)), secondary = recorded(client(secondaryUrl))
  const store = new SuperTabStore(primary.client, Date.now, null, { replica: secondary.client })
  const clear = () => { primary.ops.length = 0; secondary.ops.length = 0 }
  return { store, reads: new SwarmReads(store), primary: primary.ops, secondary: secondary.ops, clear }
}

async function fixture(store: SuperTabStore) {
  const run = (command: Command) => store.execute(owner, tab, { operationId: randomUUID(), command })
  const tab = (await store.create(owner, randomUUID(), 'Secondary reads')).id
  await run({ type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(), name: 'Lead', configuration: config, lead: true })
  const rows: Prisma.SuperTabMessageCreateManyInput[] = Array.from({ length: 250 }, (_, i) => {
    const id = `${tab}-m${String(i).padStart(4, '0')}`
    return { id, tabId: tab, conversationId: 'lead', sequence: 1000 + i, author: { kind: 'person', id: owner.sub, name: owner.email, membershipGeneration: 'g' },
      text: `row ${i}`, replyTo: null, recipientIds: [], mentions: [], thread: id }
  })
  await db.superTabMessage.createMany({ data: rows })
  return { tab, run }
}

const ids = (page: { messages: Array<{ id: string }> }) => page.messages.map(m => m.id)

describe('older history pages', () => {
  it('read their rows on the secondary, the same rows the primary gives, and their access on the primary', async () => {
    const s = stores()
    const { tab } = await fixture(s.store)
    const only = new SuperTabStore(db)
    const newest = await s.store.messages(owner, tab, 'lead', {})
    s.clear()
    const older = await s.store.messages(owner, tab, 'lead', { before: newest.next!.sequence, beforeId: newest.next!.id })
    expect(ids(older)).toEqual(ids(await only.messages(owner, tab, 'lead', { before: newest.next!.sequence, beforeId: newest.next!.id })))
    expect(ids(older)).toHaveLength(100)
    expect(pageBatches(s.secondary).length).toBeGreaterThan(0)
    expect(pageBatches(s.primary)).toEqual([])
    // What decides what this reader may see: the Swarm and its parts, read on the primary only.
    expect(models(s.secondary).every(m => ['SuperTabDelivery', 'SuperTabMessage', 'SuperTabReaction', 'SuperTabThread'].includes(m))).toBe(true)
    expect(models(s.primary).length).toBeGreaterThan(0)

    // The oldest page, which reaches the end, and a thread's older page read the same way.
    s.clear()
    const oldest = await s.store.messages(owner, tab, 'lead', { before: older.next!.sequence, beforeId: older.next!.id })
    expect(ids(oldest)).toEqual(ids(await only.messages(owner, tab, 'lead', { before: older.next!.sequence, beforeId: older.next!.id })))
    expect(oldest.next).toBeNull()
    expect(pageBatches(s.primary)).toEqual([])
  })

  it('read a page without the edge id on the secondary too', async () => {
    const s = stores()
    const { tab } = await fixture(s.store)
    const only = new SuperTabStore(db)
    s.clear()
    const older = await s.store.messages(owner, tab, 'lead', { before: 1100 })
    expect(ids(older)).toEqual(ids(await only.messages(owner, tab, 'lead', { before: 1100 })))
    expect(ids(older).at(-1)).toBe(`${tab}-m0099`)
    expect(pageBatches(s.primary)).toEqual([])
  })

  it('read on the primary when the secondary does not hold the row the reader pages from yet, so lag never skips a row', async () => {
    // A secondary that holds nothing yet: another database on the same server.
    const behind = secondaryReadsUrl(uri.replace(/\/([^/?]+)(\?|$)/, `/behind_${randomUUID().replaceAll('-', '_')}$2`))
    const s = stores(behind)
    const { tab } = await fixture(s.store)
    const only = new SuperTabStore(db)
    const newest = await s.store.messages(owner, tab, 'lead', {})
    s.clear()
    const older = await s.store.messages(owner, tab, 'lead', { before: newest.next!.sequence, beforeId: newest.next!.id })
    expect(ids(older)).toEqual(ids(await only.messages(owner, tab, 'lead', { before: newest.next!.sequence, beforeId: newest.next!.id })))
    expect(ids(older)).toHaveLength(100)
    expect(pageBatches(s.primary).length).toBeGreaterThan(0)
  })
})

describe('reads that must see the latest write', () => {
  it('stay on the primary: the newest page, a newer page, one message, the change feed and a write with its reads', async () => {
    const s = stores()
    const { tab, run } = await fixture(s.store)
    s.clear()
    const first = await s.reads.firstLoad(owner, tab)
    const newest = await s.store.messages(owner, tab, 'lead', {})
    await s.store.messages(owner, tab, 'lead', { after: 1200, afterId: `${tab}-m0200` })
    await s.store.messages(owner, tab, 'lead', { messageId: `${tab}-m0010` })
    await run({ type: 'message.send', conversationId: 'lead', text: 'a new one', replyTo: null, recipientIds: [] })
    const changed = await s.reads.changes(owner, tab, first.cursor)
    expect(newest.messages).toHaveLength(100)
    expect(changed).toBeTruthy()
    expect(s.secondary).toEqual([])
    expect(pageBatches(s.primary).length).toBeGreaterThan(0)
  })
})

describe('reports', () => {
  it('costs read their decisions on the secondary and who may read them on the primary', async () => {
    const s = stores()
    const { tab } = await fixture(s.store)
    s.clear()
    const summary = await s.store.costSummary(owner, tab, 7)
    expect(summary).toMatchObject({ days: 7, truncated: false })
    expect(models(s.secondary)).toEqual(['SuperTabRouteDecision'])
    expect(s.primary.some(o => o.model === 'SuperTabRouteDecision')).toBe(false)
  })

  it('the leaderboard reads its people\'s names on the secondary', async () => {
    const s = stores()
    const { tab } = await fixture(s.store)
    s.clear()
    const board = await s.reads.leaderboard(owner, tab, 'lead')
    expect(board).toBeTruthy()
    expect(models(s.secondary)).toEqual(['User'])
    expect(s.primary.some(o => o.model === 'User' && o.operation === 'findMany')).toBe(false)
  })
})
