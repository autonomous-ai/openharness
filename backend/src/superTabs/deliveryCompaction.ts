import type { Prisma, PrismaClient, SuperTabDelivery } from '@prisma/client'
import { logger } from '../utils/logger.js'
import { readBy, retryStaleIndex } from './parts/indexed.js'
import { receiptFields } from './pageReads.js'
import { prismaRow } from './rawRows.js'
import { retryTransient } from './retry.js'

/**
 * Message history is kept forever with its receipts, while delivery rows stop growing (spec 5 phase C): a finished delivery
 * whose last change is 14 days old moves into its message's SuperTabReceipt, which page reads, hosts and notices read as the
 * row (pageReads.ts). `delivered` and `confirmed` are not finished (a reply or a project report moves them to `answered`),
 * nor are the open ones.
 */
export const FINAL_DELIVERY = ['answered', 'cancelled', 'superseded'] as const
export const COMPACT_AFTER_MS = 14 * 86_400_000
/** Batches per hourly run: up to 10 k deliveries, so the first runs also clear the backlog. Prod finishes ≤ 3.4 k a day. */
const BATCHES_PER_RUN = 20
/** Deliveries a reply or a project report may still answer: never compacted, counted so their growth shows in the log. */
const UNFINISHED_DELIVERY = ['delivered', 'confirmed'] as const

const old = (statuses: readonly string[], cutoff: Date) => ({ status: { $in: [...statuses] }, updatedAt: { $lt: { $date: cutoff.toISOString() } } })
/** A receipt is stored under its agent's id as a field name: never one Mongo would read as a path or an operator. Ids are
 *  hex (model.ts stableId); another is left as a row, and never read again ahead of the rest. */
const compactable = (cutoff: Date) => ({ ...old(FINAL_DELIVERY, cutoff), agentId: { $regex: '^[A-Za-z0-9_-]+$' } })

/** One batch, in one transaction: the oldest finished deliveries past the cutoff, written into their messages' receipts by
 *  field path (two compactions of one message keep each other's agents) and deleted. A delivery changed since it was read
 *  is not deleted: the transaction fails and nothing of it is written. */
async function compactBatch(db: PrismaClient, cutoff: Date, batch: number): Promise<number> {
  return retryTransient(() => retryStaleIndex(() => db.$transaction(async tx => {
    const moving = (await readBy(tx, 'SuperTabDelivery', 'compaction', [{ $match: compactable(cutoff) }, { $sort: { updatedAt: 1 } }, { $limit: batch }]))
      .map(row => prismaRow<SuperTabDelivery>('SuperTabDelivery', row))
    if (!moving.length) return 0
    const byMessage = new Map<string, SuperTabDelivery[]>()
    for (const row of moving) byMessage.set(row.messageId, [...byMessage.get(row.messageId) ?? [], row])
    await tx.$runCommandRaw({ update: 'SuperTabReceipt', updates: [...byMessage.values()].map(deliveries => ({ q: { _id: deliveries[0]!.messageId }, upsert: true,
      u: { $set: { tabId: deliveries[0]!.tabId, conversationId: deliveries[0]!.conversationId,
        ...Object.fromEntries(deliveries.map(row => [`receipts.${row.agentId}`, receiptFields(row)])) },
      $addToSet: { deliveryIds: { $each: deliveries.map(row => row.id) } } } })) } as Prisma.InputJsonObject)
    const deleted = await tx.$runCommandRaw({ delete: 'SuperTabDelivery', deletes: moving.map(row => ({ limit: 1,
      q: { _id: row.id, status: row.status, updatedAt: { $date: row.updatedAt.toISOString() } } })) } as Prisma.InputJsonObject) as unknown as { n: number }
    if (deleted.n !== moving.length) throw new Error(`deliveries changed while compacting: ${moving.length - deleted.n}`)
    return moving.length
  }, TRANSACTION_OPTIONS)))
}

/** As the store's transactions (store.ts): a batch of 500 writes outlasts Prisma's 5 s default under load. */
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 }

/** A compacted delivery made a row again, and taken out of its message's receipts, in `tx`: a host that held it typed it
 *  after all (store.ts deliver). */
export async function restoreDelivery(tx: Prisma.TransactionClient, row: SuperTabDelivery): Promise<void> {
  await tx.superTabDelivery.create({ data: row })
  await tx.$runCommandRaw({ update: 'SuperTabReceipt', updates: [{ q: { _id: row.messageId, tabId: row.tabId },
    u: { $unset: { [`receipts.${row.agentId}`]: '' }, $pull: { deliveryIds: row.id } } }] })
}

/** Compacts finished deliveries older than 14 days at `now`, `batch` at a time, until none is left or 20 batches ran.
 *  `remaining`: those still old enough afterwards, the backlog the log warns on. `unfinished`: delivered or confirmed ones as
 *  old, which stay rows until a reply or a report answers them. */
export async function compactDeliveries(db: PrismaClient, now: number, batch = 500): Promise<{ compacted: number; remaining: number; unfinished: number }> {
  const cutoff = new Date(now - COMPACT_AFTER_MS)
  let compacted = 0
  for (let runs = 0; runs < BATCHES_PER_RUN; runs++) {
    const moved = await compactBatch(db, cutoff, batch)
    compacted += moved
    if (moved < batch) break
  }
  const count = async (statuses: readonly string[]) => Number((await readBy(db as unknown as Prisma.TransactionClient, 'SuperTabDelivery', 'compaction',
    [{ $match: old(statuses, cutoff) }, { $count: 'n' }]))[0]?.n ?? 0)
  return { compacted, remaining: await count(FINAL_DELIVERY), unfinished: await count(UNFINISHED_DELIVERY) }
}

/** Runs the compaction now and then every `everyMs`, one run at a time, unless `setting` (env SWARM_DELIVERY_COMPACTION) is
 *  the kill switch. A failed run is logged and tried again next time. */
export function startDeliveryCompaction(db: PrismaClient, setting: 'on' | 'off', everyMs = 3_600_000): () => void {
  if (setting === 'off') {
    logger.info('[swarm-deliveries] compaction is off (SWARM_DELIVERY_COMPACTION=off)')
    return () => {}
  }
  let running = false
  const run = () => {
    if (running) return
    running = true
    void compactDeliveries(db, Date.now()).then(counts => logger.info('[swarm-deliveries] compacted', counts))
      .catch(error => logger.warn('[swarm-deliveries] compaction failed', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = false })
  }
  run()
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
