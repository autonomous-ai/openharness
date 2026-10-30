import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import { inConversationOrder, pageDeliveries, pageReactions, pageThreads } from '../src/superTabs/pageReads.js'
import { costRows } from '../src/superTabs/costs/read.js'
import { readEvidence } from '../src/superTabs/evidence/store.js'
import { recentDecisions } from '../src/superTabs/routeDecisions.js'
import { settleStuckDeliveries } from '../src/superTabs/deliverySettle.js'
import { revokeNativeContexts } from '../src/superTabs/native.js'
import { outsider, owner, peer, richSwarm, swarm } from '../src/superTabs/read/fixture.test-support.js'
import { threadSummaries } from '../src/superTabs/threads.js'
import type { SuperTabState } from '../src/superTabs/model.js'

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
const GROUPS = Array.from({ length: 360 }, (_, i) => `g${pad(i)}`)

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
  // Two Swarms of 360 conversations and 2,000 route decisions each, as a busy Swarm keeps them for 90 days. Every fifth
  // decision has its pick, override and outcome; every seventh is an older record that never had those fields.
  const decisions = []
  for (const tab of ['A', 'B']) {
    for (let i = 0; i < 2000; i++) {
      const full = i % 5 === 0
      decisions.push({ id: `${tab}-d${String(i).padStart(4, '0')}`, tabId: tab, conversationId: GROUPS[i % 360],
        record: { difficulty: 'medium', candidates: [{ id: 'c0', p: 0.42, slots: 3, title: 'Claude opus high' }, { id: 'c1', p: null, slots: 0 }], why: `route ${i}` },
        ...full ? { final: { kind: 'new', startId: `s${i}` }, override: { by: 'lead', candidateId: 'c1' }, assignmentId: `as${i}`, outcome: 'done',
          outcomeAt: new Date(T0 + i * 1000 + 500) } : {},
        createdAt: new Date(T0 + i * 1000) })
    }
  }
  await db.superTabRouteDecision.createMany({ data: decisions.filter((_, i) => i % 7) })
  await db.$runCommandRaw({ insert: 'SuperTabRouteDecision', documents: decisions.filter((_, i) => !(i % 7)).map(({ id, createdAt, ...rest }) =>
    ({ _id: id, ...rest, ...rest.outcomeAt ? { outcomeAt: { $date: rest.outcomeAt.toISOString() } } : {}, createdAt: { $date: createdAt.toISOString() } })) })
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

  it('reads a page\'s threads through the tabId+conversationId+thread index, examining only their messages and returning a few', async () => {
    // 300 top-level messages in one conversation, every tenth with three replies, beside another conversation's.
    const rows = []
    for (const conversationId of ['t0', 't1']) {
      for (let m = 0; m < 300; m++) {
        const root = `${conversationId}-m${pad(m)}`
        rows.push({ id: root, thread: root, sequence: m * 4 })
        if (m % 10 === 0) for (let r = 1; r <= 3; r++) rows.push({ id: `${root}-r${r}`, thread: root, sequence: m * 4 + r })
      }
    }
    await db.superTabMessage.createMany({ data: rows.map(row => ({ ...row, tabId: 'T', conversationId: row.id.slice(0, 2), text: 'x',
      author: { kind: 'person', id: 'owner', name: 'owner', membershipGeneration: 'gen' }, recipientIds: [], mentions: [],
      createdAt: new Date(T0 + row.sequence * 1000) })) })
    const roots = Array.from({ length: 100 }, (_, i) => `t0-m${pad(100 + i)}`)
    const [threads, profile] = await profiled('SuperTabMessage', () => pageThreads(db, 'T', 't0', roots))
    // Each root, and of each thread's three replies by one author the first and the last, which stands for all three.
    expect(threads).toHaveLength(120)
    expect(threads.filter(row => row.id !== row.thread).slice(0, 2).map(row => [row.id, row.count])).toEqual([['t0-m100-r1', 0], ['t0-m100-r3', 3]])
    expect(threads[0]).toEqual({ thread: 't0-m100', id: 't0-m100', author: expect.objectContaining({ id: 'owner' }), mentions: [],
      sequence: 400, createdAt: new Date(T0 + 400_000), agentOnly: false, routing: false, count: 1 })
    expect(profile).toEqual({ plans: ['IXSCAN { tabId: 1, conversationId: 1, thread: 1, sequence: 1 }'], docsExamined: 130, returned: 1 })
  })

  it('sums up a 500-reply thread from a few rows: what each reader may see, counted in the database', async () => {
    // One long thread: 500 replies. Every tenth an agent-only note to another agent (no reader counts it), five route rows
    // (a Buddy never reads them), a person who is not in the Swarm writing every third, the owner renamed after reply 100,
    // and the last two replies written by one command (one sequence). Beside it, a thread whose only reply is hidden, and a
    // short one. Each reader's summaries are the ones every reply read gave before (written out here by hand).
    const s = richSwarm()
    const group = s.state.conversations.find(c => c.id === s.web)!
    const person = (id: string, displayName?: string) => ({ kind: 'person' as const, id, name: id, ...displayName ? { displayName } : {}, membershipGeneration: 'gen' })
    const agent = (id: string) => ({ kind: 'agent' as const, id, name: id, membershipGeneration: 'gen' })
    const rows: Array<{ id: string; thread: string; sequence: number; author: unknown; mentions?: string[]; source?: object; recipientIds?: string[] }> = [
      { id: 'qa-root', thread: 'qa-root', sequence: 10_000, author: person(owner.userId, 'Owner now') },
      { id: 'qb-root', thread: 'qb-root', sequence: 5_000, author: agent('lead') },
      { id: 'qb-r1', thread: 'qb-root', sequence: 5_001, author: agent('ghost'), source: { kind: 'agent-only' }, recipientIds: ['a1'] },
      { id: 'qc-root', thread: 'qc-root', sequence: 20_000, author: agent('lead') },
      { id: 'qc-r1', thread: 'qc-root', sequence: 20_001, author: person(peer.userId) },
    ]
    for (let i = 0; i < 500; i++) {
      const hidden = i % 10 === 9, route = i % 100 === 50
      const author = hidden ? agent('ghost') : route ? agent('lead') : [person(owner.userId, i < 100 ? 'Owner before' : 'Owner now'), person('stranger'), agent('a1')][i % 3]
      rows.push({ id: `qa-r${pad(i)}`, thread: 'qa-root', sequence: i === 498 ? 10_498 : 10_001 + i, author,
        mentions: { 8: ['stranger'], 19: [peer.userId], 50: [outsider.userId], 307: [peer.userId, outsider.userId] }[i] ?? [],
        ...hidden ? { source: { kind: 'agent-only' }, recipientIds: ['a1'] } : route ? { source: { kind: 'route' } } : {} })
    }
    await db.superTabMessage.createMany({ data: rows.map(row => ({ recipientIds: [], mentions: [], ...row, tabId: 'T', conversationId: 'qa', text: 'x',
      author: row.author as object, createdAt: new Date(T0 + row.sequence * 1000) })) })
    // Replies in the same thread id elsewhere, another conversation's and another Swarm's: never counted, named or read.
    await db.superTabMessage.createMany({ data: [['T', 'qz'], ['U', 'qa']].map(([tabId, conversationId]) => ({ id: `${tabId}-${conversationId}-r`, tabId: tabId!,
      conversationId: conversationId!, thread: 'qa-root', sequence: 30_000, text: 'x', author: person('elsewhere'), recipientIds: [], mentions: [outsider.userId],
      createdAt: new Date(T0 + 30_000_000) })) })
    const [threads, profile] = await profiled('SuperTabMessage', () => pageThreads(db, 'T', 'qa', ['qa-root', 'qb-root', 'qc-root']))
    const last = { lastSequence: 10_498, lastAt: new Date(T0 + 10_498_000) }
    expect(threadSummaries(s.state, group, threads)).toEqual([
      { id: 'qa-root', replies: 450, ...last, authors: [person(owner.userId, 'Owner before'), agent('a1'), agent('lead')],
        people: [owner.userId, outsider.userId, peer.userId] },
      { id: 'qc-root', replies: 1, lastSequence: 20_001, lastAt: new Date(T0 + 20_001_000), authors: [person(peer.userId)], people: [peer.userId] },
    ])
    // A Buddy's page leaves the route rows out first (store.ts messages).
    expect(threadSummaries(s.state, group, threads.filter(row => !row.routing))[0]).toEqual({ id: 'qa-root', replies: 445, ...last,
      authors: [person(owner.userId, 'Owner before'), agent('a1')], people: [owner.userId, peer.userId, outsider.userId] })
    // A few rows per author and kind of row, however long the thread: the database counts, not the server.
    expect(threads.length).toBeLessThan(30)
    expect(profile).toEqual({ plans: ['IXSCAN { tabId: 1, conversationId: 1, thread: 1, sequence: 1 }'], docsExamined: 505, returned: 1 })
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
      createdAt: new Date(T0 + 150_000), updatedAt: expect.any(Date), claimFailingSince: null, claimFailures: null })
    expect(rows.find(row => row.id === 'A-150-old')).toEqual({ id: 'A-150-old', messageId: 'A-m150', agentId: 'agent-old', status: 'answered',
      receipt: null, holdReason: null, holdSince: null, deliveredAt: null, answeredAt: null, createdAt: new Date(T0), updatedAt: new Date(T0 + 1), claimFailingSince: null, claimFailures: null })
    expect(rows.find(row => row.id === 'A-150-4')).toEqual({ id: 'A-150-4', messageId: 'A-m150', agentId: 'agent-4', status: 'answered',
      receipt: null, holdReason: null, holdSince: null, deliveredAt: null, answeredAt: null,
      createdAt: new Date(T0 + 150_000), updatedAt: new Date(T0 + 150_500), claimFailingSince: null, claimFailures: null })
  })

  // The delivery read never had an order (no orderBy: it followed whichever index the planner took), so it is compared by id.
  // Reactions keep the tabId+messageId index order, which their counts' `by` lists show.
  it('returns the same rows as the Prisma reads it replaces', async () => {
    const select = { id: true, messageId: true, agentId: true, status: true, receipt: true,
      holdReason: true, holdSince: true, deliveredAt: true, answeredAt: true, createdAt: true, updatedAt: true,
      claimFailingSince: true, claimFailures: true }
    const byId = (rows: Array<{ id: string }>) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
    expect(byId(await pageDeliveries(db, 'A', PAGE))).toEqual(byId(await db.superTabDelivery.findMany({ where: { tabId: 'A', messageId: { in: PAGE } }, select })))
    expect(await pageReactions(db, 'A', PAGE)).toEqual(await db.superTabReaction.findMany({ where: { tabId: 'A', messageId: { in: PAGE } },
      select: { messageId: true, emoji: true, actorKind: true, actorId: true } }))
    expect(await pageDeliveries(db, 'B', PAGE)).toEqual([])
  })
})

describe('the delivery poll order', () => {
  const at = new Date(T0), later = new Date(T0 + 1000)
  const row = (messageId: string, conversationId: string, createdAt = at) => ({ messageId, conversationId, createdAt })
  beforeAll(async () => {
    await db.superTabMessage.createMany({ data: [['O-c1-1', 'c1', 1], ['O-c1-2', 'c1', 2], ['O-c1-3', 'c1', 3], ['O-c1-4', 'c1', 4],
      ['O-c2-7', 'c2', 7], ['O-c2-8', 'c2', 8]].map(([id, conversationId, sequence]) => ({ id: id as string, tabId: 'O',
      conversationId: conversationId as string, sequence: sequence as number, author: { kind: 'person', id: 'owner' }, text: 'm', recipientIds: ['agent-0'] })) })
  })

  it('puts each conversation\'s tied rows in sequence order in that conversation\'s places, reading only the tied messages by id', async () => {
    const read = [row('O-c1-3', 'c1'), row('O-c2-8', 'c2'), row('O-c1-1', 'c1'), row('O-c1-4', 'c1', later), row('O-c2-7', 'c2'), row('O-c1-2', 'c1')]
    const [rows, profile] = await profiled('SuperTabMessage', () => inConversationOrder(db, 'O', read))
    expect(rows.map(r => r.messageId)).toEqual(['O-c1-1', 'O-c2-7', 'O-c1-2', 'O-c1-4', 'O-c2-8', 'O-c1-3'])
    expect(profile).toEqual({ plans: ['IXSCAN { _id: 1 }'], docsExamined: 5, returned: 5 })
  })

  it('reads nothing when no conversation has two rows at one time', async () => {
    const read = [row('O-c1-2', 'c1'), row('O-c2-7', 'c2'), row('O-c1-1', 'c1', later)]
    const [rows, profile] = await profiled('SuperTabMessage', () => inConversationOrder(db, 'O', read))
    expect(rows).toEqual(read)
    expect(profile).toEqual({ plans: [], docsExamined: 0, returned: 0 })
  })

  it('never orders by another Swarm\'s messages: rows whose messages it does not find keep their places', async () => {
    const read = [row('O-c1-2', 'c1'), row('O-c1-1', 'c1')]
    expect((await inConversationOrder(db, 'B', read)).map(r => r.messageId)).toEqual(['O-c1-2', 'O-c1-1'])
  })
})

describe('the delivery pass', () => {
  it('reads the open deliveries through the status index, examining only those it judges, with their dates as Dates', async () => {
    const open = ['queued', 'claimed', 'uncertain'].map((status, i) => ({ _id: `A-open-${i}`, tabId: 'A', conversationId: 'g1', messageId: 'A-m900',
      agentId: `agent-${i}`, machineId: 'host', membershipGeneration: 'gen', authorKind: 'person', authorId: 'owner', authorGeneration: 'gen', status,
      ...status === 'claimed' ? { claimId: 'claim', holdReason: 'team_waiting_user', holdSince: { $date: new Date(T0 + 1000).toISOString() } } : {},
      createdAt: { $date: new Date(T0).toISOString() }, updatedAt: { $date: new Date(T0 + 2000).toISOString() } }))
    await db.$runCommandRaw({ insert: 'SuperTabDelivery', documents: open })
    const judged: Array<{ tabId: string; rows: unknown[] }> = []
    const store = { settleDeliveries: async (tabId: string, rows: unknown[]) => { judged.push({ tabId, rows }); return 0 } }
    const [, profile] = await profiled('SuperTabDelivery', () => settleStuckDeliveries(db, store, T0))
    await db.superTabDelivery.deleteMany({ where: { messageId: 'A-m900' } })
    // One scan of the index per open status, merged in id order.
    expect(profile).toEqual({ plans: [Array(3).fill('IXSCAN { status: 1, _id: 1 }').join(', ')], docsExamined: 3, returned: 3 })
    expect(judged).toEqual([{ tabId: 'A', rows: [
      expect.objectContaining({ id: 'A-open-0', status: 'queued', holdSince: null, createdAt: new Date(T0), updatedAt: new Date(T0 + 2000) }),
      expect.objectContaining({ id: 'A-open-1', status: 'claimed', holdReason: 'team_waiting_user', holdSince: new Date(T0 + 1000) }),
      expect.objectContaining({ id: 'A-open-2', status: 'uncertain', conversationId: 'g1', agentId: 'agent-2' }),
    ] }])
  })
})

describe('cost summary', () => {
  // The Swarm's cost read (superTabs/costs/read.ts) takes the decisions routed in a period. Never a collection scan, and never
  // more documents than the period holds, however many the Swarm keeps.
  it('reads the decisions of a period with one index scan, examining only those', async () => {
    const [found, profile] = await profiled('SuperTabRouteDecision', () => costRows(db, 'A', T0 + 1500 * 1000))
    // The fixture's decisions carry no runs, so none is an attempt to summarize; what matters is what Mongo read.
    expect(found).toEqual({ rows: [], truncated: false })
    expect(profile).toEqual({ plans: ['IXSCAN { tabId: 1, createdAt: 1 }'], docsExamined: 500, returned: 500 })
  })
})

describe('model evidence', () => {
  // Routing and the weekly report read a Swarm's evidence (superTabs/evidence/store.ts): only the weeks asked for, by index.
  it('reads the weeks of a period and the last-ten rows with one index scan each, examining only that Swarm\'s rows', async () => {
    const WEEK = 7 * 86_400_000, MONDAY = Date.UTC(2026, 9, 26)
    const rows = ['A', 'B'].flatMap(tabId => ['opus', 'sonnet', 'kimi'].flatMap(model => Array.from({ length: 26 }, (_, w) => ({
      _id: `${tabId}-${model}-${w}`, tabId, projectId: 'p1', engine: 'claude', model, kind: 'backend', week: { $date: new Date(MONDAY - w * WEEK).toISOString() },
      attempts: 1, updatedAt: { $date: new Date(MONDAY).toISOString() } }))))
    await db.$runCommandRaw({ insert: 'SuperTabModelEvidence', documents: rows as never })
    await db.$runCommandRaw({ insert: 'SuperTabModelRecent', documents: ['A', 'B'].flatMap(tabId => ['opus', 'sonnet', 'kimi'].map(model => ({
      _id: `${tabId}-${model}`, tabId, projectId: 'p1', engine: 'claude', model, kind: 'backend', results: [{ a: 'x', at: MONDAY, passed: true }],
      updatedAt: { $date: new Date(MONDAY).toISOString() } }))) as never })
    // The last four weeks: 3 models x 4 weeks.
    const [read, profile] = await profiled('SuperTabModelEvidence', () => readEvidence(db, 'A', MONDAY - 3 * WEEK))
    expect(read.models.map(m => [m.model, m.attempts, m.recent])).toEqual([['kimi', 4, [true]], ['opus', 4, [true]], ['sonnet', 4, [true]]])
    expect(profile).toEqual({ plans: ['IXSCAN { tabId: 1, week: 1 }'], docsExamined: 12, returned: 12 })
    const [, recent] = await profiled('SuperTabModelRecent', () => readEvidence(db, 'A', MONDAY))
    expect(recent).toEqual({ plans: ['IXSCAN { tabId: 1, updatedAt: 1 }'], docsExamined: 3, returned: 3 })
  })
})

describe('route decision list', () => {
  const prismaRead = (tabId: string, conversationIds: string[]) => db.superTabRouteDecision.findMany({ where: { tabId, conversationId: { in: conversationIds } },
    orderBy: { createdAt: 'desc' }, take: 100 })

  it('reads a Lead\'s newest 100 decisions over every conversation with one index scan of 100 documents', async () => {
    const [rows, profile] = await profiled('SuperTabRouteDecision', () => recentDecisions(db, 'A', GROUPS))
    expect(rows.map(row => row.id)).toEqual(Array.from({ length: 100 }, (_, i) => `A-d${1999 - i}`))
    expect(profile).toEqual({ plans: ['IXSCAN { tabId: 1, createdAt: 1 }'], docsExamined: 100, returned: 100 })
  })

  // Prisma sends `conversationId in [...]` as an $expr $or of one branch per conversation, which Mongo plans branch by branch:
  // over a Lead's ~360 conversations that took 25 ms of planning per read, against under 1 ms for the plain $in match. Both
  // examine the same documents, so the plan shape is what tells them apart: one IXSCAN, never an OR of them.
  it('reads the decisions of a reader\'s few conversations with one index scan, examining only those', async () => {
    const [rows, profile] = await profiled('SuperTabRouteDecision', () => recentDecisions(db, 'A', ['g007', 'g300']))
    expect(rows).toHaveLength(11)
    expect(profile).toEqual({ plans: ['IXSCAN { tabId: 1, conversationId: 1, outcome: 1 }'], docsExamined: 11, returned: 11 })
  })

  it('returns each decision as the Prisma read did', async () => {
    const rows = await recentDecisions(db, 'A', ['g000', 'g001'])
    expect(rows.find(row => row.id === 'A-d1800')).toEqual({ id: 'A-d1800', tabId: 'A', conversationId: 'g000',
      record: { difficulty: 'medium', candidates: [{ id: 'c0', p: 0.42, slots: 3, title: 'Claude opus high' }, { id: 'c1', p: null, slots: 0 }], why: 'route 1800' },
      final: { kind: 'new', startId: 's1800' }, override: { by: 'lead', candidateId: 'c1' }, assignmentId: 'as1800', outcome: 'done',
      outcomeAt: new Date(T0 + 1_800_500), run: null, evidence: null, createdAt: new Date(T0 + 1_800_000) })
    // Written as an older record: none of the optional fields exist.
    expect(rows.find(row => row.id === 'A-d0721')).toEqual({ id: 'A-d0721', tabId: 'A', conversationId: 'g001',
      record: { difficulty: 'medium', candidates: [{ id: 'c0', p: 0.42, slots: 3, title: 'Claude opus high' }, { id: 'c1', p: null, slots: 0 }], why: 'route 721' },
      final: null, override: null, assignmentId: null, outcome: null, outcomeAt: null, run: null, evidence: null, createdAt: new Date(T0 + 721_000) })
    expect(await recentDecisions(db, 'A', GROUPS)).toEqual(await prismaRead('A', GROUPS))
    expect(await recentDecisions(db, 'A', ['g007', 'g300'])).toEqual(await prismaRead('A', ['g007', 'g300']))
    expect(await recentDecisions(db, 'B', [])).toEqual([])
  })
})

// Every command revokes the terminal contexts its change of access ends (native.ts). On 2026-10-28 that read ran on every
// command, rebuilt from who could not read what rather than from what changed: each viewer, and each member outside each
// private conversation, became an $or branch tested against every open context of the Swarm (prod mean 965 ms).
describe('terminal context revoke', () => {
  const context = (id: string, conversationId: string, userId: string) => ({ id, tabId: 'tab', conversationId, agentId: 'agent', userId, binding: {} })
  const revoked = async () => (await db.superTabNativeContext.findMany({ where: { tabId: 'tab', revoked: true }, select: { id: true } })).map(row => row.id).sort()

  /** A Swarm with a viewer and a private project its other members cannot read: what made every command revoke before. */
  function scene() {
    const s = swarm()
    s.join(peer)
    s.join(outsider)
    const open = s.group('Open work'), done = s.group('Done work')
    const secret = s.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).projectId as string
    const hidden = s.group('Secret work', secret)
    return { s, open, done, hidden, projectId: s.state.conversations.find(c => c.id === open)!.projectId as string }
  }

  it('sends no query for a command that changes no one\'s access', async () => {
    await db.superTabNativeContext.deleteMany({})
    const { s, open, hidden } = scene()
    s.edit(state => { state.people.find(p => p.id === outsider.userId)!.role = 'viewer' })
    await db.superTabNativeContext.createMany({ data: [context('owner-open', open, s.state.ownerId), context('owner-secret', hidden, s.state.ownerId)] })
    const before = structuredClone(s.state) as SuperTabState
    s.run({ type: 'message.send', conversationId: open, text: 'Status?', replyTo: null, recipientIds: [] })
    const [, profile] = await profiled('SuperTabNativeContext', () => revokeNativeContexts(db, before, s.state))
    expect(profile).toEqual({ plans: [], docsExamined: 0, returned: 0 })
    expect(await revoked()).toEqual([])
  })

  it('revokes at once a removal, a lost conversation and an archive made by one change, and cancels their waiting turns', async () => {
    await db.superTabNativeContext.deleteMany({})
    await db.superTabDelivery.deleteMany({ where: { tabId: 'tab' } })
    const { s, open, done, projectId } = scene()
    await db.superTabNativeContext.createMany({ data: [context('peer-open', open, peer.userId), context('outsider-open', open, outsider.userId),
      context('owner-done', done, s.state.ownerId), context('owner-open', open, s.state.ownerId)] })
    await db.superTabDelivery.create({ data: { id: 'turn', tabId: 'tab', conversationId: open, messageId: 'm', nativeContextId: 'peer-open', agentId: 'agent',
      machineId: 'host', membershipGeneration: 'gen', authorKind: 'person', authorId: peer.userId, authorGeneration: 'gen', status: 'queued' } })
    const before = structuredClone(s.state) as SuperTabState
    s.run({ type: 'member.remove', userId: peer.userId })
    s.run({ type: 'project.sharing', projectId, visibility: 'private', memberIds: [] })
    s.run({ type: 'conversation.archive', conversationId: done, archived: true })
    await revokeNativeContexts(db, before, s.state)
    expect(await revoked()).toEqual(['outsider-open', 'owner-done', 'peer-open'])
    expect((await db.superTabDelivery.findUniqueOrThrow({ where: { id: 'turn' } })).status).toBe('cancelled')
  })

  // A session in a private conversation reads it (projects.ts confidentialSession): only its machine's owner may watch or drive it
  // from then on. A command can no longer put a Builder there; a session marked before that rule, or made so by the shared
  // rule's next change, is revoked through the same watchersLost comparison.
  it('revokes at once everyone\'s terminals on an agent that joins a private conversation, but its machine\'s owner\'s', async () => {
    await db.superTabNativeContext.deleteMany({})
    const { s, open } = scene()
    const worker = s.add('builder-harness', open, false, peer, 'host', peer.userId)
    await db.superTabNativeContext.createMany({ data: [{ ...context('peer-worker', open, peer.userId), agentId: worker },
      { ...context('outsider-worker', open, outsider.userId), agentId: worker }, { ...context('owner-worker', open, s.state.ownerId), agentId: worker }] })
    const before = structuredClone(s.state) as SuperTabState
    // A private conversation now is a Buddy chat (buddies.ts), which only its owner's Buddy joins: written here as that join leaves it.
    s.edit(state => {
      const generation = state.people.find(p => p.id === peer.userId)!.generation
      state.conversations.push({ id: 'peer-buddy', kind: 'buddy', projectId: state.conversations.find(c => c.id === open)!.projectId, title: 'Peer\'s Buddy',
        leadId: null, agentIds: [worker], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0,
        audience: { people: [{ id: peer.userId, generation }] } })
    })
    await revokeNativeContexts(db, before, s.state)
    expect(await revoked()).toEqual(['outsider-worker', 'owner-worker'])
  })

  it('revokes the contexts of a person made a viewer', async () => {
    await db.superTabNativeContext.deleteMany({})
    const { s, open } = scene()
    await db.superTabNativeContext.createMany({ data: [context('peer-open', open, peer.userId), context('owner-open', open, s.state.ownerId)] })
    const before = structuredClone(s.state) as SuperTabState
    s.edit(state => { state.people.find(p => p.id === peer.userId)!.role = 'viewer' })
    await revokeNativeContexts(db, before, s.state)
    expect(await revoked()).toEqual(['peer-open'])
  })
})
