import { setTimeout as delay } from 'node:timers/promises'
import type { PrismaClient } from '@prisma/client'
import { PRODUCT_USAGE_RECEIPT_EXPIRY_DAYS } from '../types/productUsageReceipt.js'
import { logger } from '../utils/logger.js'

/**
 * Removes, a little at a time, the usage receipts written while a receipt lived 36 days (until 2026-10-29: about 4M of
 * them, most of the database's index size), once their new life is over. Mongo's expiry would take 36 days to.
 *
 * A receipt is `{ _id: report id, expiresAt: report day + N days }`, nothing else, so which life it was given shows only in
 * its expiresAt. A new receipt expires by today + 4 days; an old one at day + 36, and its new life ended at day + 4. So an
 * old receipt is removed when its expiresAt is past today + 5 (a day more than any new receipt, for a server clock ahead of
 * this one and a pass across midnight) and at most now + 32 days. Old receipts below that range expire within 5 days.
 *
 * Before any removal, the collection's rule ([RECEIPT_RULE]) refuses every receipt written without its `life`: a server
 * released before 2026-10-29 (a rollout in progress, a rollback) still accepts reports 35 days old, and would count one
 * again once its receipt is gone. Its receipt write and its totals share one transaction, so with the rule it counts nothing
 * and its client retries later. No server's presence is inferred: the rule holds whatever runs. Mongo applies a rule to
 * writes from then on only (receipts are never updated), so installing it reads no existing receipt.
 */
const COLLECTION = 'product_usage_receipts'
const DAY = 86_400_000
const OLD_EXPIRY_DAYS = 36
/** About 2,000 a minute, in four deletes with a pause between them: the backlog clears in about a day. */
export const RECEIPT_SWEEP = { chunk: 500, chunks: 4, pauseMs: 250, everyMs: 60_000 } as const

/** Every receipt write must carry its life; old receipts, never written again, are not checked. */
export const RECEIPT_RULE = { validator: { $jsonSchema: { required: ['life'] } }, validationLevel: 'strict', validationAction: 'error' } as const

export interface SweepOptions { chunk: number; chunks: number; pauseMs: number }
export interface SweepPass {
  removed: number
  /** No old receipt is left that this sweep would ever remove. */
  done: boolean
}

const date = (ms: number) => ({ $date: new Date(ms).toISOString() })
const startOfDay = (now: Date) => Math.floor(now.getTime() / DAY) * DAY

/** Installs [RECEIPT_RULE] unless it is there already. collMod locks the collection only for the change itself; a receipt
 * write in flight finishes first, under the old rule, and every later write is checked. */
export async function ensureReceiptRule(db: PrismaClient): Promise<void> {
  const answer = await db.$runCommandRaw({ listCollections: 1, filter: { name: COLLECTION } } as never) as
    { cursor: { firstBatch: Array<{ options?: Record<string, unknown> }> } }
  const options = answer.cursor.firstBatch[0]?.options ?? {}
  if ((Object.keys(RECEIPT_RULE) as Array<keyof typeof RECEIPT_RULE>)
    .every(key => JSON.stringify(options[key]) === JSON.stringify(RECEIPT_RULE[key]))) return
  await db.$runCommandRaw({ collMod: COLLECTION, ...RECEIPT_RULE } as never)
}

async function anyReceipt(db: PrismaClient, filter: Record<string, unknown>): Promise<boolean> {
  const answer = await db.$runCommandRaw({ find: COLLECTION, filter, projection: { _id: 1 }, limit: 1, singleBatch: true } as never) as
    { cursor: { firstBatch: unknown[] } }
  return answer.cursor.firstBatch.length > 0
}

/** One chunk: up to [chunk] old receipts in expiresAt order, then exactly those, their range checked again. */
async function removeChunk(db: PrismaClient, now: Date, chunk: number): Promise<number> {
  const range = { expiresAt: { $gt: date(startOfDay(now) + (PRODUCT_USAGE_RECEIPT_EXPIRY_DAYS + 1) * DAY),
    $lte: date(now.getTime() + (OLD_EXPIRY_DAYS - PRODUCT_USAGE_RECEIPT_EXPIRY_DAYS) * DAY) } }
  const found = await db.$runCommandRaw({ find: COLLECTION, filter: range, projection: { _id: 1 }, sort: { expiresAt: 1 },
    hint: 'product_usage_expiry', limit: chunk, singleBatch: true } as never) as { cursor: { firstBatch: Array<{ _id: string }> } }
  const ids = found.cursor.firstBatch.map(receipt => receipt._id)
  if (!ids.length) return 0
  const answer = await db.$runCommandRaw({ delete: COLLECTION, deletes: [{ q: { _id: { $in: ids }, ...range }, limit: 0 }] } as never) as
    { n?: number; writeErrors?: unknown[] }
  if (answer.writeErrors?.length) throw new Error('The database refused some receipt removals')
  return answer.n ?? 0
}

/** One pass: the rule, then at most [chunks] × [chunk] receipts. Safe to repeat, and from two processes at once. */
export async function sweepOldReceipts(db: PrismaClient, now = new Date(), options: SweepOptions = RECEIPT_SWEEP): Promise<SweepPass> {
  await ensureReceiptRule(db)
  let removed = 0
  for (let i = 0; i < options.chunks; i++) {
    if (i) await delay(options.pauseMs)
    const n = await removeChunk(db, now, options.chunk)
    removed += n
    if (n < options.chunk) break
  }
  const done = !await anyReceipt(db, { expiresAt: { $gt: date(startOfDay(now) + (PRODUCT_USAGE_RECEIPT_EXPIRY_DAYS + 1) * DAY) } })
  return { removed, done }
}

/** Runs a pass a minute in the singleton worker until nothing is left to remove, then stops; a restart checks once more. */
export function startReceiptSweep(db: PrismaClient, settings: Partial<SweepOptions & { everyMs: number; now: () => Date;
  log: Pick<typeof logger, 'info' | 'warn'> }> = {}): () => void {
  const { everyMs, now, log, ...options } = { ...RECEIPT_SWEEP, now: () => new Date(), log: logger, ...settings }
  let running = false, total = 0
  const run = async () => {
    if (running) return
    running = true
    try {
      const pass = await sweepOldReceipts(db, now(), options)
      total += pass.removed
      if (pass.removed) log.info('[usage-receipts] pass', { removed: pass.removed, removedSinceStart: total })
      if (pass.done) {
        stop()
        log.info('[usage-receipts] done: no old receipts left', { removedSinceStart: total })
      }
    } catch (error) {
      log.warn('[usage-receipts] pass failed; retrying next minute', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void run(), everyMs)
  timer.unref()
  const stop = () => clearInterval(timer)
  void run()
  return stop
}
