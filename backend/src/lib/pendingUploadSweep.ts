import type { PrismaClient } from '@prisma/client'
import { attachmentsFromEnv, directUploads, errorCode, PENDING_UPLOAD_LIFE_MS, PENDING_UPLOAD_PURPOSE, REMOVING_UPLOAD_PURPOSE, type DirectUploads } from '../superTabs/attachments.js'
import { logger } from '../utils/logger.js'

/**
 * Removes uploads that went straight to the bucket on a link (superTabs/store.ts uploadLink) and were never finished: an hour
 * after the link expired, the stored object first, then the row. Finished but unsent uploads are not touched here; they are
 * unsent files like any other (#2268). Each sender's allowance row goes an hour after its last link request.
 *
 * Its reads go by the (purpose, createdAt) index (schema.prisma), so a pass reads only the uploads it removes, however many
 * attachments there are (workerIndexPlans.test.ts).
 */
export const PENDING_UPLOAD_SWEEP = { chunk: 100, everyMs: 10 * 60_000 } as const

export async function sweepPendingUploads(db: PrismaClient, bucket: DirectUploads, now: number, chunk: number = PENDING_UPLOAD_SWEEP.chunk,
  picked: () => Promise<void> = async () => {}) {
  // Both by the (purpose, createdAt) index: rows claimed by an earlier pass whose file delete failed, then the newly due.
  const claimed = await db.superTabAttachment.findMany({ where: { purpose: REMOVING_UPLOAD_PURPOSE }, select: { id: true, objectKey: true }, take: chunk })
  const due = await db.superTabAttachment.findMany({ where: { purpose: PENDING_UPLOAD_PURPOSE, createdAt: { lt: new Date(now - PENDING_UPLOAD_LIFE_MS) } },
    select: { id: true, objectKey: true }, take: chunk })
  await picked()
  let removed = 0, failed = 0
  const mine = [...claimed]
  for (const row of due) {
    // Claimed first, with one conditional write: a finish that wins it keeps its row and bytes, and this pass skips the row;
    // one that loses is refused (store.ts completeUpload). Only a row this write changed has its file removed.
    const claim = await db.superTabAttachment.updateMany({ where: { id: row.id, purpose: PENDING_UPLOAD_PURPOSE }, data: { purpose: REMOVING_UPLOAD_PURPOSE } })
    if (claim.count === 1) mine.push(row)
  }
  for (const row of mine) {
    try { await bucket.delete(row.objectKey) } catch (error) {
      // The row stays claimed for the next pass. Only its id and the error's code: the key, and the error's text, carry the file's link.
      logger.warn('[pending-upload-sweep] could not remove a stored file', { id: row.id, code: errorCode(error) })
      failed++
      continue
    }
    removed += (await db.superTabAttachment.deleteMany({ where: { id: row.id, purpose: REMOVING_UPLOAD_PURPOSE } })).count
  }
  await db.superTabUploadAllowance.deleteMany({ where: { at: { lt: new Date(now - 3_600_000) } } })
  return { removed, failed }
}

/** Runs the sweep in the worker every 10 minutes, once the attachment settings name a bucket; says once whether it is on. */
export function startPendingUploadSweep(db: PrismaClient, env: Parameters<typeof attachmentsFromEnv>[0], now: () => number = Date.now): () => void {
  let bucket: DirectUploads | null = null
  try {
    const attachments = attachmentsFromEnv(env)
    bucket = attachments ? directUploads(attachments.store) : null
  } catch (error) {
    logger.warn('[pending-upload-sweep] off: the attachment settings are invalid', { error: error instanceof Error ? error.message : String(error) })
    return () => {}
  }
  if (!bucket) { logger.info('[pending-upload-sweep] off: no attachments bucket is set'); return () => {} }
  logger.info('[pending-upload-sweep] on', { everyMinutes: PENDING_UPLOAD_SWEEP.everyMs / 60_000 })
  let running = false
  const pass = async () => {
    if (running) return
    running = true
    try {
      const result = await sweepPendingUploads(db, bucket!, now())
      if (result.removed || result.failed) logger.info('[pending-upload-sweep] pass', result)
    } catch (error) {
      logger.warn('[pending-upload-sweep] pass failed', { code: errorCode(error) })
    } finally { running = false }
  }
  void pass()
  const timer = setInterval(() => void pass(), PENDING_UPLOAD_SWEEP.everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
