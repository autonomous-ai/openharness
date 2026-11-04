import { setTimeout as delay } from 'node:timers/promises'
import type { PrismaClient } from '@prisma/client'
import { PRODUCT_USAGE_RECEIPT_EXPIRY_DAYS } from '../types/productUsageReceipt.js'
import { logger } from '../utils/logger.js'
import { notAuthorized } from './db/indexes.js'
import { removeChunk, startChunkSweep } from './chunkSweep.js'

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
 *
 * Production's app user may not install the rule (no collMod), and the sweep then removes without it (Ken, 2026-11-04): a
 * server from before 2026-10-29 is no longer deployed, and only a rollback to one could count a retried report twice.
 */
const COLLECTION = 'product_usage_receipts'
const DAY = 86_400_000
const OLD_EXPIRY_DAYS = 36
/** One delete of 500 every 30 s, about 1,000 a minute. On production's M20 a delete of 500 old receipts took 12–17 s (cold
 *  index pages, read from disk; 2026-11-04), so the database spends about half its time on them at most, and a pass still
 *  running when the next is due skips it. The ~4M old receipts take about 3 days, against 2026-12-04 by expiry alone. */
export const RECEIPT_SWEEP = { chunk: 500, chunks: 1, pauseMs: 0, everyMs: 30_000 } as const

/** Every receipt write must carry its life; old receipts, never written again, are not checked. */
export const RECEIPT_RULE = { validator: { $jsonSchema: { required: ['life'] } }, validationLevel: 'strict', validationAction: 'error' } as const

export interface SweepOptions {
  chunk: number; chunks: number; pauseMs: number
  /** Removes without installing [RECEIPT_RULE] first: the database user may not (production's, no collMod). */
  withoutRule?: boolean
}
export interface SweepPass {
  removed: number
  /** No old receipt is left that this sweep would ever remove. */
  done: boolean
}

const date = (ms: number) => ({ $date: new Date(ms).toISOString() })
const startOfDay = (now: Date) => Math.floor(now.getTime() / DAY) * DAY

/** The database user may not install [RECEIPT_RULE] (production's app user may not run collMod, 10-29). */
export class ReceiptRuleRefused extends Error {
  constructor() { super('The database user is not authorized to install the receipt rule (collMod)') }
}

/** Installs [RECEIPT_RULE] unless it is there already. collMod locks the collection only for the change itself; a receipt
 * write in flight finishes first, under the old rule, and every later write is checked. */
export async function ensureReceiptRule(db: PrismaClient): Promise<void> {
  const answer = await db.$runCommandRaw({ listCollections: 1, filter: { name: COLLECTION } } as never) as
    { cursor: { firstBatch: Array<{ options?: Record<string, unknown> }> } }
  const options = answer.cursor.firstBatch[0]?.options ?? {}
  if ((Object.keys(RECEIPT_RULE) as Array<keyof typeof RECEIPT_RULE>)
    .every(key => JSON.stringify(options[key]) === JSON.stringify(RECEIPT_RULE[key]))) return
  try {
    await db.$runCommandRaw({ collMod: COLLECTION, ...RECEIPT_RULE } as never)
  } catch (error) {
    if (notAuthorized(error)) throw new ReceiptRuleRefused()
    throw error
  }
}

/** Old receipts are those past [PRODUCT_USAGE_RECEIPT_EXPIRY_DAYS] + 1 days from today: no new receipt expires that late. */
const oldFloor = (now: Date) => date(startOfDay(now) + (PRODUCT_USAGE_RECEIPT_EXPIRY_DAYS + 1) * DAY)
/** A date as `$runCommandRaw` answers it (extended JSON), or as a Date. */
const dateOf = (value: unknown): Date => {
  const raw = value && typeof value === 'object' && '$date' in value ? (value as { $date: unknown }).$date : value
  const inner = raw && typeof raw === 'object' && '$numberLong' in raw ? Number((raw as { $numberLong: string }).$numberLong) : raw
  return new Date(inner as string | number | Date)
}

/** When the newest old receipt expires by itself: one key of the expiry index, never a count of the millions. Null once no old
 *  receipt is left, which is when this sweep has nothing more to do, with or without its rule. */
export async function lastOldReceipt(db: PrismaClient, now: Date): Promise<Date | null> {
  const answer = await db.$runCommandRaw({ find: COLLECTION, filter: { expiresAt: { $gt: oldFloor(now) } }, projection: { _id: 0, expiresAt: 1 },
    sort: { expiresAt: -1 }, hint: 'product_usage_expiry', limit: 1, singleBatch: true } as never) as { cursor: { firstBatch: Array<{ expiresAt: unknown }> } }
  const newest = answer.cursor.firstBatch[0]
  return newest ? dateOf(newest.expiresAt) : null
}

/** One chunk of old receipts in expiresAt order (lib/chunkSweep.ts). */
const removeOldChunk = (db: PrismaClient, now: Date, chunk: number) => removeChunk(db, { collection: COLLECTION, sort: { expiresAt: 1 },
  hint: 'product_usage_expiry', chunk, filter: { expiresAt: { $gt: oldFloor(now),
    $lte: date(now.getTime() + (OLD_EXPIRY_DAYS - PRODUCT_USAGE_RECEIPT_EXPIRY_DAYS) * DAY) } } })

/** One pass: the rule unless [SweepOptions.withoutRule], then at most [chunks] × [chunk] receipts. Safe to repeat, and from
 *  two processes at once. */
export async function sweepOldReceipts(db: PrismaClient, now = new Date(), options: SweepOptions = RECEIPT_SWEEP): Promise<SweepPass> {
  if (!options.withoutRule) await ensureReceiptRule(db)
  let removed = 0
  for (let i = 0; i < options.chunks; i++) {
    if (i) await delay(options.pauseMs)
    const n = await removeOldChunk(db, now, options.chunk)
    removed += n
    if (n < options.chunk) break
  }
  return { removed, done: !await lastOldReceipt(db, now) }
}

/** Runs a pass every [RECEIPT_SWEEP.everyMs] in the singleton worker until nothing is left to remove, then stops; a restart
 *  checks once more. A database user that may not install the rule is asked once: the sweep says so once and goes on without. */
export function startReceiptSweep(db: PrismaClient, settings: Partial<SweepOptions & { everyMs: number;
  now: () => Date; log: Pick<typeof logger, 'info' | 'warn'> }> = {}): () => void {
  const { everyMs, now, log, ...options } = { ...RECEIPT_SWEEP, now: () => new Date(), log: logger, ...settings }
  let withoutRule = options.withoutRule ?? false
  return startChunkSweep({ label: '[usage-receipts]', everyMs, log, doneMessage: 'done: no old receipts left',
    pass: () => sweepOldReceipts(db, now(), { ...options, withoutRule }),
    handle: error => {
      if (!(error instanceof ReceiptRuleRefused)) return false
      withoutRule = true
      log.warn('[usage-receipts] the database user may not install the receipt rule (collMod): removing the old receipts without it '
        + '(Ken, 2026-11-04). A server from before 2026-10-29, were one rolled back, could count a retried report twice.')
      return true
    } })
}
