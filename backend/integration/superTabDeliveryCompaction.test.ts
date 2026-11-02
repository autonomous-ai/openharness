import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { Prisma, PrismaClient, SuperTabDelivery } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { COMPACT_AFTER_MS, compactDeliveries, startDeliveryCompaction } from '../src/superTabs/deliveryCompaction.js'
import { listNamedIndexes, withoutHints } from '../src/superTabs/parts/indexed.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// Spec 5 phase C (docs/superpowers/specs/2026-10-30-swarm-messages-delta-and-retention-design.md): finished deliveries move
// into their messages' receipts after 14 days; pages, hosts and notices read them as the rows they were.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const owner: AuthUser = { sub: '600000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '600000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const DAY = 86_400_000

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_compaction_test'))
  store = new SuperTabStore(db)
  await listNamedIndexes(db)
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
  const tab = (await store.create(owner, randomUUID(), 'Receipts')).id
  const lead = String((await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(), name: 'Lead',
    configuration: config, lead: true })).result.agentId)
  return { tab, lead }
}
/** A message to the Lead and its delivery, claimed by the Lead's host. */
async function sent(tab: string, lead: string, text: string) {
  const messageId = String((await run(tab, { type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [] })).result.messageId)
  const delivery = (await store.deliveries(host, tab, lead)).find(d => d.messageId === messageId)!
  await store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: `claim-${text}` })
  return { messageId, deliveryId: delivery.id, claimId: `claim-${text}` }
}
/** A message to the Lead typed and answered. */
async function answered(tab: string, lead: string, text: string) {
  const one = await sent(tab, lead, text)
  await store.delivery(host, tab, lead, one.deliveryId, { type: 'ack', claimId: one.claimId, receipt: `typed-${text}`, uncertain: false })
  await run(tab, { type: 'message.send', conversationId: 'lead', text: `Re: ${text}`, replyTo: one.messageId, recipientIds: [] }, host, lead)
  return one
}
/** Moves these deliveries' last change `days` back, as if nothing touched them since. */
async function age(ids: string[], days: number) {
  await db.$runCommandRaw({ update: 'SuperTabDelivery', updates: ids.map(id => ({ q: { _id: id },
    u: { $set: { updatedAt: { $date: new Date(Date.now() - days * DAY).toISOString() } } } })) } as Prisma.InputJsonObject)
}
/** A delivery written straight into the database, for statuses no short flow reaches. */
async function row(tab: string, lead: string, status: string, fields: Partial<SuperTabDelivery> = {}) {
  const messageId = `${tab}-${randomUUID()}`
  await db.superTabMessage.create({ data: { id: messageId, tabId: tab, conversationId: 'lead', sequence: 500, text: status, replyTo: null,
    recipientIds: [fields.agentId ?? lead], mentions: [], thread: messageId, author: { kind: 'person', id: owner.sub, name: owner.email, membershipGeneration: 'g' } } })
  return db.superTabDelivery.create({ data: { id: `${messageId}-d`, tabId: tab, conversationId: 'lead', messageId, agentId: lead, machineId: 'test-host',
    machineOwnerId: host.sub, membershipGeneration: 'g', authorKind: 'person', authorId: owner.sub, authorGeneration: 'g', status, ...fields } })
}
const receiptOf = async (messageId: string) => (await db.$runCommandRaw({ find: 'SuperTabReceipt', filter: { _id: messageId } }) as unknown as
  { cursor: { firstBatch: Array<{ receipts: Record<string, { deliveryId: string; status: string }>; deliveryIds: string[] }> } }).cursor.firstBatch[0]

describe('compacting finished deliveries (spec 5 C)', () => {
  it('moves only answered, cancelled and superseded deliveries whose last change is over 14 days old', async () => {
    const { tab, lead } = await fixture()
    const final = await Promise.all(['answered', 'cancelled', 'superseded'].map(status => row(tab, lead, status)))
    const kept = await Promise.all(['delivered', 'confirmed', 'queued', 'claimed', 'uncertain'].map(status => row(tab, lead, status)))
    const recent = await row(tab, lead, 'answered')
    await age([...final, ...kept].map(d => d.id), 15)
    await age([recent.id], 13)
    // Delivered and confirmed ones stay rows, counted as unfinished.
    expect(await compactDeliveries(db, Date.now())).toEqual({ compacted: 3, remaining: 0, unfinished: 2 })
    const left = await db.superTabDelivery.findMany({ where: { tabId: tab }, select: { id: true } })
    expect(left.map(d => d.id).sort()).toEqual([...kept, recent].map(d => d.id).sort())
    for (const delivery of final) {
      expect(await receiptOf(delivery.messageId)).toMatchObject({ deliveryIds: [delivery.id],
        receipts: { [lead]: { deliveryId: delivery.id, status: delivery.status, machineOwnerId: host.sub } } })
    }
    expect(await compactDeliveries(db, Date.now())).toMatchObject({ compacted: 0, remaining: 0 })
  })

  it('keeps every agent of one message, compacted one after another or at once', async () => {
    const { tab, lead } = await fixture()
    const first = await row(tab, lead, 'answered')
    const other = (agentId: string) => db.superTabDelivery.create({ data: { ...first, id: `${first.messageId}-${agentId}`, agentId, updatedAt: undefined } })
    const second = await other('agent-b')
    await age([first.id], 15)
    await compactDeliveries(db, Date.now())
    await age([second.id], 15)
    await compactDeliveries(db, Date.now())
    const third = await other('agent-c'), fourth = await other('agent-d')
    await age([third.id, fourth.id], 15)
    await Promise.allSettled([compactDeliveries(db, Date.now(), 1), compactDeliveries(db, Date.now(), 1)])
    await compactDeliveries(db, Date.now())
    const receipt = await receiptOf(first.messageId)
    expect(Object.keys(receipt!.receipts).sort()).toEqual([lead, 'agent-b', 'agent-c', 'agent-d'].sort())
    expect(receipt!.deliveryIds.sort()).toEqual([first, second, third, fourth].map(d => d.id).sort())
    expect(await db.superTabDelivery.count({ where: { messageId: first.messageId } })).toBe(0)
  })

  it('leaves a delivery that changed after it was read, and moves it once it is old again', async () => {
    const { tab, lead } = await fixture()
    const delivery = await row(tab, lead, 'cancelled')
    await age([delivery.id], 15)
    let changed = false
    // Another writer settles the delivery after the batch read it and before it writes (a host typing a held one).
    const racing = new Proxy(db, { get(target, key, receiver) {
      if (key !== '$transaction') return Reflect.get(target, key, receiver)
      return (body: (tx: PrismaClient) => Promise<unknown>, options: unknown) => (target.$transaction as (b: unknown, o: unknown) => Promise<unknown>)(
        (tx: PrismaClient) => body(new Proxy(tx, { get(inner, name, innerReceiver) {
          const value = Reflect.get(inner, name, innerReceiver)
          if (name !== '$runCommandRaw' || changed) return value
          return async (...args: unknown[]) => {
            changed = true
            await db.superTabDelivery.update({ where: { id: delivery.id }, data: { receipt: 'typed late' } })
            return (value as (...a: unknown[]) => unknown).apply(inner, args)
          }
        } })), options)
    } }) as PrismaClient
    expect(await compactDeliveries(racing, Date.now())).toMatchObject({ compacted: 0, remaining: 0 })
    expect(changed).toBe(true)
    expect(await db.superTabDelivery.findUnique({ where: { id: delivery.id } })).toMatchObject({ receipt: 'typed late' })
    expect(await receiptOf(delivery.messageId)).toBeUndefined()
    await age([delivery.id], 15)
    expect(await compactDeliveries(db, Date.now())).toMatchObject({ compacted: 1, remaining: 0 })
  })

  it('reads a page the same before and after compaction, for a person and for the Lead', async () => {
    const { tab, lead } = await fixture()
    const done = [await answered(tab, lead, 'One'), await answered(tab, lead, 'Two')]
    await sent(tab, lead, 'Waiting')
    await age(done.map(d => d.deliveryId), 15)
    const before = [await store.messages(owner, tab, 'lead', {}), await store.messages(host, tab, 'lead', {}, lead)]
    expect((await compactDeliveries(db, Date.now())).compacted).toBe(2)
    expect([await store.messages(owner, tab, 'lead', {}), await store.messages(host, tab, 'lead', {}, lead)]).toEqual(before)
  })

  it('stops after 20 batches and counts what is left as remaining', async () => {
    const { tab, lead } = await fixture()
    const rows = await Promise.all(Array.from({ length: 23 }, () => row(tab, lead, 'answered')))
    await age(rows.map(d => d.id), 15)
    expect(await compactDeliveries(db, Date.now(), 1)).toMatchObject({ compacted: 20, remaining: 3 })
    expect(await compactDeliveries(db, Date.now(), 1)).toMatchObject({ compacted: 3, remaining: 0 })
  })

  it('leaves a delivery whose agent id cannot name a receipt as a row, without holding the others back', async () => {
    const { tab, lead } = await fixture()
    const odd = await row(tab, lead, 'answered', { agentId: 'agent.with.dots' })
    const rows = [await row(tab, lead, 'answered'), await row(tab, lead, 'cancelled')]
    await age([odd.id], 16)
    await age(rows.map(d => d.id), 15)
    try {
      expect(await compactDeliveries(db, Date.now(), 1)).toMatchObject({ compacted: 2, remaining: 1 })
      expect(await db.superTabDelivery.findUnique({ where: { id: odd.id } })).not.toBeNull()
      expect(await receiptOf(odd.messageId)).toBeUndefined()
    } finally {
      await db.superTabDelivery.delete({ where: { id: odd.id } })
    }
  })

  it('reads only what it moves, by its index', async () => {
    const { tab, lead } = await fixture()
    await Promise.all(Array.from({ length: 30 }, () => row(tab, lead, 'answered')))
    const old = await Promise.all(Array.from({ length: 4 }, () => row(tab, lead, 'cancelled')))
    await age(old.map(d => d.id), 15)
    // As the worker reads, which lists no named index: the planner picks it.
    const entries = await profiled(db, () => withoutHints(() => compactDeliveries(db, Date.now())))
    const found = reads(entries, 'SuperTabDelivery', ['status', 'updatedAt'], ['_id'])
    expect(found.length, JSON.stringify(plan(found))).toBeGreaterThan(0)
    for (const entry of found) {
      expect(entry.docsExamined, JSON.stringify(plan(found))).toBeLessThanOrEqual(4)
      expect(entry.planSummary, JSON.stringify(plan(found))).toContain('status: 1, updatedAt: 1')
    }
  })

  it('starts nothing when the kill switch is off', () => {
    const untouchable = new Proxy({}, { get() { throw new Error('read the database') } }) as PrismaClient
    const stop = startDeliveryCompaction(untouchable, 'off')
    stop()
    expect(COMPACT_AFTER_MS).toBe(14 * DAY)
  })
})

describe('hosts read compacted deliveries (spec 5 C)', () => {
  it('a host back after weeks offline gets a compacted delivery\'s final status; another person is refused', async () => {
    const { tab, lead } = await fixture()
    const done = await answered(tab, lead, 'Old')
    await age([done.deliveryId], 15)
    await compactDeliveries(db, Date.now())
    expect(await db.superTabDelivery.findUnique({ where: { id: done.deliveryId } })).toBeNull()
    expect(await store.deliveryReceipt(host, tab, lead, done.deliveryId)).toEqual({ id: done.deliveryId, status: 'answered' })
    await expect(store.deliveryReceipt(owner, tab, lead, done.deliveryId)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    await expect(store.deliveryReceipt(host, tab, 'another-agent', done.deliveryId)).rejects.toMatchObject({ status: 404 })
    await expect(store.deliveryReceipt(host, tab, lead, 'not-a-delivery')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    // A compacted delivery is finished: it is resolved, as its row was.
    await expect(store.delivery(host, tab, lead, done.deliveryId, { type: 'ack', claimId: done.claimId, receipt: 'again', uncertain: false }))
      .rejects.toMatchObject({ code: 'DELIVERY_RESOLVED' })
  })

  it('finds a compacted delivery by its index, examining only its receipt, and a page\'s receipts by message id', async () => {
    const { tab, lead } = await fixture()
    const done = await Promise.all(['A', 'B', 'C'].map(text => answered(tab, lead, text)))
    await age(done.map(d => d.deliveryId), 15)
    await compactDeliveries(db, Date.now())
    const hostReads = await profiled(db, () => store.deliveryReceipt(host, tab, lead, done[1]!.deliveryId))
    const byDelivery = reads(hostReads, 'SuperTabReceipt', ['deliveryIds'])
    expect(byDelivery, JSON.stringify(plan(byDelivery))).toHaveLength(1)
    expect(byDelivery[0]!.docsExamined, JSON.stringify(plan(byDelivery))).toBeLessThanOrEqual(1)
    expect(byDelivery[0]!.command?.hint, `names its index: ${JSON.stringify(plan(byDelivery))}`).toBeTruthy()
    const page = await profiled(db, () => store.messages(owner, tab, 'lead', {}))
    const byMessage = reads(page, 'SuperTabReceipt', ['_id'])
    expect(byMessage, JSON.stringify(plan(byMessage))).toHaveLength(1)
    expect(byMessage[0]!.docsExamined, JSON.stringify(plan(byMessage))).toBeLessThanOrEqual(3)
    expect(byMessage[0]!.command?.hint, `names its index: ${JSON.stringify(plan(byMessage))}`).toBeTruthy()
  })

  it('a host confirming it typed a held delivery the pass ended gets the same answer compacted or not', async () => {
    const { tab, lead } = await fixture()
    const ended = async (text: string) => {
      const one = await sent(tab, lead, text)
      await store.delivery(host, tab, lead, one.deliveryId, { type: 'hold', claimId: one.claimId, reason: 'team_waiting_user' })
      // The delivery pass ends a hold it waited on too long, keeping its reason (deliverySettle.ts).
      await db.superTabDelivery.update({ where: { id: one.deliveryId }, data: { status: 'cancelled' } })
      return one
    }
    const live = await ended('Live'), compacted = await ended('Compacted')
    await age([compacted.deliveryId], 15)
    expect((await compactDeliveries(db, Date.now())).compacted).toBe(1)
    const typed = async (one: typeof live) =>
      await store.delivery(host, tab, lead, one.deliveryId, { type: 'ack', claimId: one.claimId, receipt: 'typed', uncertain: false }) as {
        delivery: SuperTabDelivery; message: { id: string } }
    const [a, b] = [await typed(live), await typed(compacted)]
    const shape = (answer: typeof a, one: typeof live) => ({ ...answer, delivery: { ...answer.delivery, updatedAt: null, deliveredAt: null, createdAt: null,
      id: answer.delivery.id === one.deliveryId, messageId: answer.delivery.messageId === one.messageId, claimId: answer.delivery.claimId === one.claimId },
    message: { ...answer.message, id: answer.message.id === one.messageId, text: null, sequence: null, createdAt: null, thread: null } })
    expect(shape(b, compacted)).toEqual(shape(a, live))
    expect(b.delivery).toMatchObject({ status: 'delivered', receipt: 'typed', holdReason: null })
    expect(await receiptOf(compacted.messageId)).toMatchObject({ receipts: {}, deliveryIds: [] })
    const page = await store.messages(owner, tab, 'lead', {})
    expect(page.messages.find(m => m.id === compacted.messageId)!.deliveries).toEqual([expect.objectContaining({ id: compacted.deliveryId, status: 'delivered' })])
  })
})
