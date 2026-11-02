import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { Prisma, PrismaClient, SuperTabMessage } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { agentOnly } from '../src/superTabs/model.js'
import { receiptFields } from '../src/superTabs/pageReads.js'
import { startMessageReadStats, type MessageReadKey } from '../src/superTabs/messageReadStats.js'
import { planDatabase } from './plans.test-support.js'

// Spec 5 phase A (docs/superpowers/specs/2026-10-30-swarm-messages-delta-and-retention-design.md): who reads messages how, a
// page that decodes about the rows it shows, and receipts read the same whether their deliveries are live or compacted.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const owner: AuthUser = { sub: '500000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '500000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_pages_test'))
  store = new SuperTabStore(db)
  for (const user of [owner, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'test-host', userId: host.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machineShare.create({ data: { machineId: 'test-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

const run = (tab: string, command: Command, user = owner, asAgentId?: string) => store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
async function fixture() {
  const tab = (await store.create(owner, randomUUID(), 'Pages')).id
  const lead = String((await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(), name: 'Lead',
    configuration: config, lead: true })).result.agentId)
  return { tab, lead }
}

/** `count` messages in the Lead chat from sequence 1000 on; `hidden(i)` ones are agent-only notes to another agent. */
async function seed(tab: string, count: number, hidden: (i: number) => boolean) {
  const rows: Prisma.SuperTabMessageCreateManyInput[] = Array.from({ length: count }, (_, i) => {
    const id = `${tab}-m${String(i).padStart(4, '0')}`
    return { id, tabId: tab, conversationId: 'lead', sequence: 1000 + i, author: { kind: 'person', id: owner.sub, name: owner.email, membershipGeneration: 'g' },
      text: `row ${i}`, replyTo: null, recipientIds: hidden(i) ? ['someone-else'] : [], mentions: [], thread: id,
      ...(hidden(i) ? { source: { kind: 'agent-only' } } : {}) }
  })
  await db.superTabMessage.createMany({ data: rows })
}

/** The newest page and its cursor as every row of the conversation gives them, for a reader who sees what `sees` keeps. */
async function expectedPage(tab: string, sees: (m: SuperTabMessage) => boolean) {
  const all = await db.superTabMessage.findMany({ where: { tabId: tab, conversationId: 'lead' }, orderBy: [{ sequence: 'desc' }, { id: 'desc' }] })
  const shown = all.filter(sees)
  const page = shown.slice(0, 100)
  return { ids: page.map(m => m.id).reverse(), next: shown.length > 100 ? { sequence: page.at(-1)!.sequence, id: page.at(-1)!.id } : null }
}
const personSees = (m: SuperTabMessage) => !agentOnly(m.source, m.recipientIds)
const agentSees = (agentId: string) => (m: SuperTabMessage) => personSees(m) || m.recipientIds.includes(agentId)

type Counted = MessageReadKey & { n: number; batches: number; decoded: number; shown: number }
/** What `read` adds to the messages read log. */
async function counted<T>(read: () => Promise<T>): Promise<{ value: T; rows: Counted[] }> {
  const rows: Counted[] = []
  const stop = startMessageReadStats({ everyMs: 3_600_000, log: (_message, context) => rows.push(...context.rows as Counted[]) })
  try {
    return { value: await read(), rows }
  } finally {
    stop()
  }
}

describe('messages by reader (spec 5 A1)', () => {
  it('counts an agent\'s older page and a person\'s newest page under their kinds, with batches and rows, naming nothing', async () => {
    const { tab, lead } = await fixture()
    await seed(tab, 150, () => false)
    const edge = (await db.superTabMessage.findFirstOrThrow({ where: { tabId: tab, sequence: 1100 } }))
    const { rows } = await counted(async () => {
      await store.messages(host, tab, 'lead', { before: edge.sequence, beforeId: edge.id }, lead)
      await store.messages(owner, tab, 'lead', {})
      await store.messages(owner, tab, 'lead', { before: 1150 })
      await store.catchUp(owner, tab, 'lead', 1140)
    })
    const row = (reader: string, cursor: string) => rows.find(r => r.reader === reader && r.cursor === cursor)
    expect(row('agent', 'beforeId')).toMatchObject({ session: 'sso', n: 1, batches: 1, shown: 100 })
    expect(row('person', 'latest')).toMatchObject({ session: 'sso', n: 1, batches: 1, decoded: 101, shown: 100 })
    expect(row('person', 'before')).toMatchObject({ n: 1, shown: 100 })
    expect(row('person', 'catchUp')).toMatchObject({ n: 1, batches: 1, decoded: 9, shown: 9 })
    expect(JSON.stringify(rows)).not.toMatch(/[0-9a-f]{12,}|@|tab-/i)
  })
})

describe('a page reads about the rows it shows (spec 5 A2)', () => {
  it('a page with one hidden row in its first 101 decodes at most 101 + 10 rows and returns the same page and next as before', async () => {
    const { tab } = await fixture()
    await seed(tab, 300, i => i === 250)
    const { value, rows } = await counted(() => store.messages(owner, tab, 'lead', {}))
    const expected = await expectedPage(tab, personSees)
    expect(value.messages.map(m => m.id)).toEqual(expected.ids)
    expect(value.next).toEqual(expected.next)
    expect(rows).toEqual([expect.objectContaining({ reader: 'person', cursor: 'latest', n: 1, shown: 100 })])
    expect(rows[0]!.decoded).toBeLessThanOrEqual(111)
  })

  it('an agent reading a chat where most rows are notes to others still gets a full page, and the next page goes on from it', async () => {
    const { tab, lead } = await fixture()
    await seed(tab, 440, i => i % 4 !== 0)
    const { value: first, rows } = await counted(() => store.messages(host, tab, 'lead', {}, lead))
    // The old 101-row batches read 404 rows in 4 batches for this page; sized by the rate seen, two batches read about as many.
    expect(rows[0]).toMatchObject({ reader: 'agent', cursor: 'latest', shown: 100 })
    expect(rows[0]!.batches).toBeLessThanOrEqual(2)
    expect(rows[0]!.decoded).toBeLessThanOrEqual(485)
    const expected = await expectedPage(tab, agentSees(lead))
    expect(first.messages).toHaveLength(100)
    expect(first.messages.map(m => m.id)).toEqual(expected.ids)
    expect(first.next).toEqual(expected.next)
    const second = await store.messages(host, tab, 'lead', { before: first.next!.sequence, beforeId: first.next!.id }, lead)
    expect(second.messages.length).toBeGreaterThan(0)
    expect(second.messages.at(-1)!.sequence).toBeLessThan(first.messages[0]!.sequence)
  })

  it('a conversation that ends inside a short batch reads it once and stops', async () => {
    const { tab } = await fixture()
    await seed(tab, 105, i => i >= 100)
    const { value, rows } = await counted(() => store.messages(owner, tab, 'lead', {}))
    expect(value.messages.map(m => m.id)).toEqual((await expectedPage(tab, personSees)).ids)
    expect(rows[0]!.batches).toBeLessThanOrEqual(2)
  })
})

/** Moves deliveries into their messages' receipts and deletes them, as the compaction job does (deliveryCompaction.ts). */
async function compactByHand(ids: string[]) {
  for (const row of await db.superTabDelivery.findMany({ where: { id: { in: ids } } })) {
    await db.$runCommandRaw({ update: 'SuperTabReceipt', updates: [{ q: { _id: row.messageId }, upsert: true,
      u: { $set: { tabId: row.tabId, conversationId: row.conversationId, [`receipts.${row.agentId}`]: receiptFields(row) }, $addToSet: { deliveryIds: row.id } } }] })
    await db.superTabDelivery.delete({ where: { id: row.id } })
  }
}

describe('receipts read the same live or compacted (spec 5 A3)', () => {
  /** Three messages to the Lead, each claimed, typed and answered, and a fourth still waiting. */
  async function answered() {
    const f = await fixture()
    for (const text of ['One', 'Two', 'Three']) {
      const sent = String((await run(f.tab, { type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [] })).result.messageId)
      const delivery = (await store.deliveries(host, f.tab, f.lead)).find(d => d.messageId === sent)!
      await store.delivery(host, f.tab, f.lead, delivery.id, { type: 'claim', claimId: `claim-${text}` })
      await store.delivery(host, f.tab, f.lead, delivery.id, { type: 'ack', claimId: `claim-${text}`, receipt: `typed-${text}`, uncertain: false })
      await run(f.tab, { type: 'message.send', conversationId: 'lead', text: `Re: ${text}`, replyTo: sent, recipientIds: [] }, host, f.lead)
    }
    await run(f.tab, { type: 'message.send', conversationId: 'lead', text: 'Four', replyTo: null, recipientIds: [] })
    const deliveries = await db.superTabDelivery.findMany({ where: { tabId: f.tab }, orderBy: { createdAt: 'asc' } })
    return { ...f, deliveries }
  }

  it('a page reads the same whether its deliveries are live, compacted or half each', async () => {
    const f = await answered()
    expect(f.deliveries.map(d => d.status)).toEqual(['answered', 'answered', 'answered', 'queued'])
    const live = await store.messages(owner, f.tab, 'lead', {}), liveToLead = await store.messages(host, f.tab, 'lead', {}, f.lead)
    expect(live.messages.flatMap(m => m.deliveries)).toHaveLength(4)
    await compactByHand(f.deliveries.slice(0, 2).map(d => d.id))
    expect(await store.messages(owner, f.tab, 'lead', {})).toEqual(live)
    await compactByHand([f.deliveries[2]!.id])
    expect(await store.messages(owner, f.tab, 'lead', {})).toEqual(live)
    expect(await store.messages(host, f.tab, 'lead', {}, f.lead)).toEqual(liveToLead)
  })

  it('keeps one order for a message\'s receipts whichever of them are compacted', async () => {
    const { tab, lead } = await fixture()
    const id = `${tab}-shared`, at = new Date()
    await db.superTabMessage.create({ data: { id, tabId: tab, conversationId: 'lead', sequence: 900, text: 'To both', replyTo: null, recipientIds: [lead, 'agent-b'],
      mentions: [], thread: id, author: { kind: 'person', id: owner.sub, name: owner.email, membershipGeneration: 'g' } } })
    const delivery = (agentId: string) => ({ id: `${id}-${agentId}`, tabId: tab, conversationId: 'lead', messageId: id, agentId, machineId: 'test-host',
      membershipGeneration: 'g', authorKind: 'person', authorId: owner.sub, authorGeneration: 'g', status: 'answered', createdAt: at })
    await db.superTabDelivery.createMany({ data: [delivery(lead), delivery('agent-b')] })
    const shown = async () => (await store.messages(owner, tab, 'lead', {})).messages.find(m => m.id === id)!.deliveries.map(d => d.agentId)
    const before = await shown()
    expect(before).toEqual([lead, 'agent-b'])
    await compactByHand([`${id}-${lead}`])
    expect(await shown()).toEqual(before)
  })

  it('a live row wins over a compacted one for the same agent', async () => {
    const f = await answered()
    const first = f.deliveries[0]!
    const live = await store.messages(owner, f.tab, 'lead', {})
    await compactByHand([first.id])
    // A row for the same message and agent again (a host that settled it while it was being moved): it is what the page shows.
    await db.superTabDelivery.create({ data: { ...first, status: 'confirmed', receipt: 'again' } })
    const page = await store.messages(owner, f.tab, 'lead', {})
    const row = page.messages.find(m => m.id === first.messageId)!
    expect(row.deliveries).toHaveLength(1)
    expect(row.deliveries[0]).toMatchObject({ id: first.id, status: 'confirmed', receipt: 'again' })
    expect(page.messages.filter(m => m.id !== first.messageId)).toEqual(live.messages.filter(m => m.id !== first.messageId))
  })

  it('a compacted receipt for news a row does not name (a Buddy\'s) is shown only to that agent, as a live one is', async () => {
    const { tab, lead } = await fixture()
    // The Lead's delivery of a row that does not list it among its recipients: the shape of Buddy news (buddyNews.ts).
    const id = `${tab}-news`
    await db.superTabMessage.create({ data: { id, tabId: tab, conversationId: 'lead', sequence: 900, text: 'News', replyTo: null, recipientIds: [],
      mentions: [], thread: id, author: { kind: 'person', id: owner.sub, name: owner.email, membershipGeneration: 'g' } } })
    await db.superTabDelivery.create({ data: { id: `${id}-d`, tabId: tab, conversationId: 'lead', messageId: id, agentId: lead, machineId: 'test-host',
      membershipGeneration: 'g', authorKind: 'person', authorId: owner.sub, authorGeneration: 'g', status: 'answered' } })
    const receipts = async (user: AuthUser, asAgentId?: string) =>
      (await store.messages(user, tab, 'lead', {}, asAgentId)).messages.find(m => m.id === id)!.deliveries.map(d => d.agentId)
    expect(await receipts(owner)).toEqual([])
    expect(await receipts(host, lead)).toEqual([lead])
    await compactByHand([`${id}-d`])
    expect(await receipts(owner)).toEqual([])
    expect(await receipts(host, lead)).toEqual([lead])
  })

  it('no message read returns a receipts map or a compacted receipt\'s host fields', async () => {
    const f = await answered()
    await compactByHand(f.deliveries.slice(0, 3).map(d => d.id))
    const replies = [await store.messages(owner, f.tab, 'lead', {}), await store.messages(host, f.tab, 'lead', {}, f.lead),
      await store.messages(owner, f.tab, 'lead', { messageId: f.deliveries[0]!.messageId }), await store.catchUp(owner, f.tab, 'lead', 0),
      await store.mentions(owner, f.tab, 'waiting')]
    for (const reply of replies) expect(JSON.stringify(reply)).not.toMatch(/"receipts"|"deliveryIds"|"deliveryId"|"machineOwnerId"|"claimId"/)
  })
})
