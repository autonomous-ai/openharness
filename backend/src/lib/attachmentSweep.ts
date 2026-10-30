import { setTimeout as delay } from 'node:timers/promises'
import type { PrismaClient } from '@prisma/client'
import { AVATAR_PURPOSE, EXPIRED_UPLOAD, UNSENT_LIFE_MS, type AttachmentStore, type Attachments } from '../superTabs/attachments.js'
import { logger } from '../utils/logger.js'

/**
 * Removes Swarm uploads nobody used within a day (Diego, 10-30): chat files never sent and pictures never set, row and stored
 * file, so the bucket stops growing. A file a message, a proposal or an avatar uses is never touched.
 *
 * An upload is first taken with one conditional write: still unused, never proposed and still a day old, its `usedBy` becomes
 * [EXPIRED_UPLOAD]. Every use takes an upload only while `usedBy` is empty (superTabs/store.ts), so a send racing the sweep
 * either took it first, and the claim leaves it, or finds it taken and is refused. Servers from before this sweep refuse a
 * taken upload too: to them it is a file already sent. Only what the claim marked is then removed: its stored file first,
 * then its row. When the file cannot be removed, the row stays marked and a later run tries again.
 *
 * Nothing indexes this scan (the only index starts with the Swarm), and it runs once an hour in the singleton worker over
 * about 2,000 rows (10-30).
 */
type Log = Pick<typeof logger, 'info' | 'warn'>
export interface AttachmentSweepOptions { chunk: number; chunks: number; pauseMs: number; log?: Log }
/** At most 500 uploads an hour, in chunks of 100 with a pause between them. */
export const ATTACHMENT_SWEEP = { chunk: 100, chunks: 5, pauseMs: 250, everyMs: 3_600_000 } as const

export interface AttachmentSweepPass {
  /** Uploads removed, stored file and row. */
  removed: number
  /** Taken uploads whose stored file could not be removed this run: their rows stay for the next one. */
  failed: number
}

// Raw commands, as the receipt sweep sends them: Prisma would send `in` and the unset-field checks as $expr (superTabs/hotFilters.test.ts).
const COLLECTION = 'SuperTabAttachment'
const date = (at: Date) => ({ $date: at.toISOString() })
type Found<T> = { cursor: { firstBatch: T[] } }
type Written = { n?: number; writeErrors?: unknown[] }
const written = (answer: Written, what: string) => {
  if (answer.writeErrors?.length) throw new Error(`The database refused some upload ${what}`)
  return answer.n ?? 0
}

/** Takes up to [chunk] uploads that are a day old and unused; answers how many it took. `null` also matches a missing field. */
async function claim(db: PrismaClient, cutoff: Date, chunk: number): Promise<number> {
  const due = { createdAt: { $lt: date(cutoff) }, usedBy: null, proposedBy: null }
  const found = await db.$runCommandRaw({ find: COLLECTION, filter: due, projection: { _id: 1 }, limit: chunk, singleBatch: true } as never) as Found<{ _id: string }>
  const ids = found.cursor.firstBatch.map(row => row._id)
  if (!ids.length) return 0
  // The same conditions again: one used since it was found stays.
  return written(await db.$runCommandRaw({ update: COLLECTION, updates: [{ q: { _id: { $in: ids }, ...due }, u: { $set: { usedBy: EXPIRED_UPLOAD } },
    multi: true }] } as never) as Written, 'claims')
}

/**
 * What a failed store call is, without its text: a network error's text holds the request's address, and that holds the
 * stored file's name and its link key, which opens the file. A system code (ECONNRESET) or an HTTP status (403) says enough.
 */
export function failureCode(error: unknown): string {
  const { code, status } = (error && typeof error === 'object' ? error : {}) as { code?: unknown; status?: unknown }
  for (const value of [code, status]) {
    if (typeof value === 'number' && Number.isInteger(value)) return String(value)
    if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(value)) return value
  }
  return 'unknown'
}

/** Removes up to [chunk] taken uploads, skipping those whose file failed earlier in this run. */
async function remove(db: PrismaClient, attachments: Attachments, chunk: number, failedIds: Set<string>, log: Log): Promise<AttachmentSweepPass & { found: number }> {
  const found = await db.$runCommandRaw({ find: COLLECTION, filter: { usedBy: EXPIRED_UPLOAD, _id: { $nin: [...failedIds] } },
    projection: { _id: 1, objectKey: 1, purpose: 1 }, limit: chunk, singleBatch: true } as never) as Found<{ _id: string; objectKey: string; purpose?: string | null }>
  const rows = found.cursor.firstBatch
  const gone: string[] = []
  for (const row of rows) {
    const store: AttachmentStore | null = row.purpose === AVATAR_PURPOSE ? attachments.avatars ?? null : attachments.store
    try {
      if (!store) throw new Error('No avatar store is configured')
      await store.delete(row.objectKey)
      gone.push(row._id)
    } catch (error) {
      // The key and the error's text hold the file's name and link key: only the row id and the error's code are logged.
      failedIds.add(row._id)
      log.warn('[attachment-sweep] could not remove a stored file; its row stays for the next run', { attachmentId: row._id, code: failureCode(error) })
    }
  }
  const removed = gone.length ? written(await db.$runCommandRaw({ delete: COLLECTION, deletes: [{ q: { _id: { $in: gone }, usedBy: EXPIRED_UPLOAD }, limit: 0 }] } as never) as Written, 'removals') : 0
  return { removed, failed: rows.length - gone.length, found: rows.length }
}

/** One pass: at most [chunks] × [chunk] uploads taken and removed. Safe to repeat, and from two processes at once. */
export async function sweepUnsentAttachments(db: PrismaClient, attachments: Attachments, now = new Date(),
  options: AttachmentSweepOptions = ATTACHMENT_SWEEP): Promise<AttachmentSweepPass> {
  const cutoff = new Date(now.getTime() - UNSENT_LIFE_MS)
  const failedIds = new Set<string>()
  let removed = 0
  for (let i = 0; i < options.chunks; i++) {
    if (i) await delay(options.pauseMs)
    const taken = await claim(db, cutoff, options.chunk)
    const pass = await remove(db, attachments, options.chunk, failedIds, options.log ?? logger)
    removed += pass.removed
    if (taken < options.chunk && pass.found < options.chunk) break
  }
  return { removed, failed: failedIds.size }
}

/** Runs a pass at start and then every hour in the singleton worker. A failed pass is logged and the next one tries again. */
export function startAttachmentSweep(db: PrismaClient, attachments: Attachments, settings: Partial<AttachmentSweepOptions & { everyMs: number;
  now: () => Date; log: Log }> = {}): () => void {
  const { everyMs, now, ...options } = { ...ATTACHMENT_SWEEP, now: () => new Date(), log: logger as Log, ...settings }
  const { log } = options
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      const pass = await sweepUnsentAttachments(db, attachments, now(), options)
      if (pass.removed || pass.failed) log.info('[attachment-sweep] pass', { ...pass })
    } catch (error) {
      log.warn('[attachment-sweep] pass failed; retrying next hour', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void run(), everyMs)
  timer.unref()
  void run()
  return () => clearInterval(timer)
}

/**
 * The worker's start: reads the attachment settings, says once whether the sweep is on, and starts it. The worker runs
 * in its own deployment, so its settings can differ from the API's: without a bucket the sweep says it is off, and settings
 * that cannot be read turn off only the sweep, never the worker's other jobs. Setting errors name a setting, never its value.
 */
export function startAttachmentSweepFrom(db: PrismaClient, settings: () => Attachments | null,
  options: Parameters<typeof startAttachmentSweep>[2] = {}): () => void {
  const log = options.log ?? logger
  let attachments: Attachments | null
  try {
    attachments = settings()
  } catch (error) {
    log.warn('[attachment-sweep] off: the attachment settings are invalid', { error: error instanceof Error ? error.message : String(error) })
    return () => {}
  }
  if (!attachments) {
    log.info('[attachment-sweep] off: no attachments bucket is set (SUPER_TAB_ATTACHMENTS_BUCKET)')
    return () => {}
  }
  log.info('[attachment-sweep] on', { everyMinutes: (options.everyMs ?? ATTACHMENT_SWEEP.everyMs) / 60_000 })
  return startAttachmentSweep(db, attachments, options)
}
