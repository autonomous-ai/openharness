/**
 * Rows of Swarm v1-v3 features that Swarm v4 removed (anh Dee, 2026-11-10) and that nothing writes or reads any more: a person's
 * Activity (replies to their messages) and their reminders. They hold ids and times, never words, and go as they age, as they
 * always did, by the hourly sweep (sweeps.ts): Activity 30 days after it was written, a reminder 30 days after it was due (at
 * most 30 days ahead). So the last of them is gone by 2027-01-09; delete this file, its two jobs and the two models then.
 */
import type { PrismaClient } from '@prisma/client'
import { readBy, type NamedIndex } from './parts/indexed.js'

const DAY_MS = 24 * 60 * 60_000
/** Activity is deleted this long after it was written. */
const ACTIVITY_EXPIRY_MS = 30 * DAY_MS
/** A reminder is deleted this long after it was due. */
const REMINDER_EXPIRY_MS = 30 * DAY_MS
/** Rows one sweep deletes at most, in batches; the rest wait for the next hour. */
const ROWS_PER_SWEEP = 20_000
const SWEEP_BATCH = 1_000

/** Deletes `collection`'s rows whose `field` is before `before` by `index`, in batches, at most ROWS_PER_SWEEP. No TTL index:
 *  the app user may not set one on an index `db push` built (#2238). */
async function sweep<C extends 'SuperTabActivity' | 'SuperTabReminder'>(db: PrismaClient, collection: C, index: NamedIndex<C>, field: string,
  before: number): Promise<number> {
  let deleted = 0
  const due = { $date: new Date(before).toISOString() }
  const page = [{ $match: { [field]: { $lt: due } } }, { $limit: SWEEP_BATCH }, { $project: { _id: 1 } }]
  while (deleted < ROWS_PER_SWEEP) {
    const rows = await readBy(db, collection, index, page)
    if (rows.length) {
      const reply = await db.$runCommandRaw({ delete: collection, deletes: [{ q: { _id: { $in: rows.map(r => r._id as string) } }, limit: 0 }] }) as { n?: number }
      deleted += Number(reply.n ?? 0)
    }
    if (rows.length < SWEEP_BATCH) break
  }
  return deleted
}

export const sweepActivity = (db: PrismaClient, now: number): Promise<number> => sweep(db, 'SuperTabActivity', 'age', 'createdAt', now - ACTIVITY_EXPIRY_MS)
export const sweepReminders = (db: PrismaClient, now: number): Promise<number> => sweep(db, 'SuperTabReminder', 'due', 'dueAt', now - REMINDER_EXPIRY_MS)
