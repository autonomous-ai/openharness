import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import { pageDeliveries, pageReactions } from '../src/superTabs/pageReads.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
// Prod Mongo spent hours an hour on the message page's delivery read (2026-10-28): Prisma sends `messageId in [...]` as an
// $expr $or, which no index can bound, so each page read every delivery of the Swarm. These tests read the Mongo profiler
// for the page reads against a Swarm of thousands of deliveries: each must use its index and examine only the rows it returns.
let replica: MongoMemoryReplSet
let db: PrismaClient
const pad = (n: number) => String(n).padStart(3, '0')
const MESSAGES = 300, AGENTS = 10
const PAGE = Array.from({ length: 100 }, (_, i) => `A-m${pad(100 + i)}`)
const T0 = Date.parse('2026-10-28T05:00:00.000Z')

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_indexes_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  // Two Swarms of 300 messages, each sent to 10 agents, and two reactions on each message.
  const deliveries = [], reactions = []
  for (const tab of ['A', 'B']) {
    for (let m = 0; m < MESSAGES; m++) {
      for (let a = 0; a < AGENTS; a++) {
        deliveries.push({ id: `${tab}-${pad(m)}-${a}`, tabId: tab, conversationId: `g${m % 20}`, messageId: `${tab}-m${pad(m)}`,
          agentId: `agent-${a}`, machineId: 'host', membershipGeneration: 'gen', authorKind: 'person', authorId: 'owner', authorGeneration: 'gen',
          status: a % 3 ? 'answered' : 'delivered', createdAt: new Date(T0 + m * 1000), updatedAt: new Date(T0 + m * 1000 + 500) })
      }
      reactions.push({ id: `${tab}-${pad(m)}-r1`, tabId: tab, conversationId: `g${m % 20}`, messageId: `${tab}-m${pad(m)}`, actorKind: 'person', actorId: 'owner', emoji: 'tada' },
        { id: `${tab}-${pad(m)}-r2`, tabId: tab, conversationId: `g${m % 20}`, messageId: `${tab}-m${pad(m)}`, actorKind: 'agent', actorId: 'agent-1', emoji: 'eyes' })
    }
  }
  await db.superTabDelivery.createMany({ data: deliveries })
  await db.superTabReaction.createMany({ data: reactions })
  // One delivery with every optional field set, and one older record that never had the hold fields at all.
  await db.superTabDelivery.update({ where: { id: 'A-150-3' }, data: { status: 'delivered', receipt: 'typed', holdReason: 'busy',
    holdSince: new Date(T0 + 7000), deliveredAt: new Date(T0 + 8000), answeredAt: new Date(T0 + 9000) } })
  await db.$runCommandRaw({ insert: 'SuperTabDelivery', documents: [{ _id: 'A-150-old', tabId: 'A', conversationId: 'g10', messageId: 'A-m150',
    agentId: 'agent-old', machineId: 'host', membershipGeneration: 'gen', authorKind: 'person', authorId: 'owner', authorGeneration: 'gen',
    status: 'answered', createdAt: { $date: new Date(T0).toISOString() }, updatedAt: { $date: new Date(T0 + 1).toISOString() } }] })
}, 120000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

interface Profiled { plans: string[]; docsExamined: number; returned: number }
/** What Mongo did for one collection while `read` ran: its plans, the documents it examined and the rows it returned,
 *  over the first batch and every getMore. */
async function profiled<T>(collection: string, read: () => Promise<T>): Promise<[T, Profiled]> {
  await db.$runCommandRaw({ profile: 2 })
  const result = await read()
  await db.$runCommandRaw({ profile: 0 })
  const found = await db.$runCommandRaw({ find: 'system.profile', filter: { 'command.profile': { $exists: false } }, batchSize: 10000 }) as
    unknown as { cursor: { firstBatch: Array<{ ns: string; planSummary?: string; docsExamined?: number; nreturned?: number }> } }
  await db.$runCommandRaw({ drop: 'system.profile' })
  const rows = found.cursor.firstBatch.filter(row => row.ns.endsWith(`.${collection}`))
  return [result, { plans: [...new Set(rows.flatMap(row => row.planSummary ? [row.planSummary] : []))],
    docsExamined: rows.reduce((sum, row) => sum + (row.docsExamined ?? 0), 0), returned: rows.reduce((sum, row) => sum + (row.nreturned ?? 0), 0) }]
}

describe('message page reads', () => {
  it('reads a page of deliveries through the tabId+messageId index, examining only the deliveries it returns', async () => {
    const [rows, profile] = await profiled('SuperTabDelivery', () => pageDeliveries(db, 'A', PAGE))
    expect(rows).toHaveLength(1001)
    expect(profile).toEqual({ plans: ['IXSCAN { tabId: 1, messageId: 1 }'], docsExamined: 1001, returned: 1001 })
  })

  it('reads a page of reactions through the tabId+messageId index, examining only the reactions it returns', async () => {
    const [rows, profile] = await profiled('SuperTabReaction', () => pageReactions(db, 'A', PAGE))
    expect(rows).toHaveLength(200)
    expect(profile).toEqual({ plans: ['IXSCAN { tabId: 1, messageId: 1 }'], docsExamined: 200, returned: 200 })
  })

  it('returns each delivery as the Prisma read did: ids, dates as Dates, absent fields as null', async () => {
    const rows = await pageDeliveries(db, 'A', ['A-m150'])
    expect(rows.find(row => row.id === 'A-150-3')).toEqual({ id: 'A-150-3', messageId: 'A-m150', agentId: 'agent-3', status: 'delivered',
      receipt: 'typed', holdReason: 'busy', holdSince: new Date(T0 + 7000), deliveredAt: new Date(T0 + 8000), answeredAt: new Date(T0 + 9000),
      createdAt: new Date(T0 + 150_000), updatedAt: expect.any(Date) })
    expect(rows.find(row => row.id === 'A-150-old')).toEqual({ id: 'A-150-old', messageId: 'A-m150', agentId: 'agent-old', status: 'answered',
      receipt: null, holdReason: null, holdSince: null, deliveredAt: null, answeredAt: null, createdAt: new Date(T0), updatedAt: new Date(T0 + 1) })
    expect(rows.find(row => row.id === 'A-150-4')).toEqual({ id: 'A-150-4', messageId: 'A-m150', agentId: 'agent-4', status: 'answered',
      receipt: null, holdReason: null, holdSince: null, deliveredAt: null, answeredAt: null,
      createdAt: new Date(T0 + 150_000), updatedAt: new Date(T0 + 150_500) })
  })

  // The delivery read never had an order (no orderBy: it followed whichever index the planner took), so it is compared by id.
  // Reactions keep the tabId+messageId index order, which their counts' `by` lists show.
  it('returns the same rows as the Prisma reads it replaces', async () => {
    const select = { id: true, messageId: true, agentId: true, status: true, receipt: true,
      holdReason: true, holdSince: true, deliveredAt: true, answeredAt: true, createdAt: true, updatedAt: true }
    const byId = (rows: Array<{ id: string }>) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
    expect(byId(await pageDeliveries(db, 'A', PAGE))).toEqual(byId(await db.superTabDelivery.findMany({ where: { tabId: 'A', messageId: { in: PAGE } }, select })))
    expect(await pageReactions(db, 'A', PAGE)).toEqual(await db.superTabReaction.findMany({ where: { tabId: 'A', messageId: { in: PAGE } },
      select: { messageId: true, emoji: true, actorKind: true, actorId: true } }))
    expect(await pageDeliveries(db, 'B', PAGE)).toEqual([])
  })
})
