/** Operation receipts (SuperTabOperation): one per command, terminal event and recovery, read back only to answer a repeat of
 *  the same request, to pair a terminal prompt with its answer, and to date a start. None of those needs a receipt older than
 *  a prompt left waiting, so a TTL index removes each 30 days after it was written (task #2488, Ken 2026-11-03: ~14k a day). */
import type { PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'

/** A receipt is kept this long: long enough for a prompt waiting on its answer, and for any repeat of an interrupted request. */
export const OPERATION_EXPIRY_MS = 30 * 24 * 60 * 60_000

/** Run by the release's schema step before db push (lib/db/schemaRelease.ts), so the index is built with its expiry by
 *  createIndexes, which production's app user may run, rather than built plain by the push and given its expiry by collMod,
 *  which it may not (10-29). */
export async function ensureOperationExpiry(db: PrismaClient): Promise<void> {
  await ensureIndex(db, 'SuperTabOperation', { key: { createdAt: 1 }, name: 'operation_expiry', expireAfterSeconds: OPERATION_EXPIRY_MS / 1000 })
}
