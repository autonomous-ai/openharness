/** How far each person has read each conversation, and each thread in one: the newest message sequence they saw there, so
 *  unread state follows them across devices. Marks live in SuperTabReadMark and SuperTabThreadMark, never in the tab state:
 *  writing one wakes no other reader, and an older backend reads and writes a tab that has them (it never reads the thread
 *  marks' collection). A person's marks go only to their own reads (read/service.ts); agents, Buddies included, have none. */
import { Prisma, type PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'
import { fail, stableId } from './model.js'
import { readBy } from './parts/indexed.js'

/** A mark untouched this long is removed by a TTL index; the conversation then reads as the device last saw it. */
export const READ_MARK_EXPIRY_MS = 180 * 24 * 60 * 60_000

/** The most thread marks one person keeps in one Swarm: a new one past it removes the least recently moved. A thread whose
 *  mark went reads as far as its conversation's mark, as on a device that never kept one. */
export const THREAD_MARK_CAP = 500

/** Run by the singleton worker at startup, like the mention expiry. */
export async function ensureReadMarkExpiry(db: PrismaClient): Promise<void> {
  await ensureIndex(db, 'SuperTabReadMark', { key: { updatedAt: 1 }, name: 'read_mark_expiry', expireAfterSeconds: READ_MARK_EXPIRY_MS / 1000 })
  await ensureIndex(db, 'SuperTabThreadMark', { key: { updatedAt: 1 }, name: 'thread_mark_expiry', expireAfterSeconds: READ_MARK_EXPIRY_MS / 1000 })
}

export interface ReadMarkWrite { tabId: string; personId: string; conversationId: string; sequence: number; now: number }
export interface ThreadMarkWrite extends ReadMarkWrite { threadId: string }

/** The calls `raise` makes, which both mark collections answer alike. */
interface MarkRows {
  updateMany(args: { where: { id: string; sequence: { lt: number } }; data: { sequence: number; updatedAt: Date } }): Promise<{ count: number }>
  findUnique(args: { where: { id: string }; select: { sequence: true } }): Promise<{ sequence: number } | null>
  create(args: { data: Record<string, unknown> & { id: string } }): Promise<unknown>
}

/** Moves row `id` forward to `sequence` and answers the mark as stored, with whether this call created the row. An older
 *  mark never replaces a newer one: the update matches only a lower mark. When another device's write lands between the
 *  update and the look after it (two first writes racing to create the row, or one raising it), the update runs again;
 *  every retry follows a write that raised the mark, so a few settle it. */
async function raise(rows: MarkRows, id: string, sequence: number, updatedAt: Date, data: Record<string, unknown>): Promise<{ sequence: number; created: boolean }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const moved = await rows.updateMany({ where: { id, sequence: { lt: sequence } }, data: { sequence, updatedAt } })
    if (moved.count) return { sequence, created: false }
    const held = await rows.findUnique({ where: { id }, select: { sequence: true } })
    if (held && held.sequence >= sequence) return { sequence: held.sequence, created: false }
    if (held) continue
    try {
      await rows.create({ data: { id, ...data, sequence, updatedAt } })
      return { sequence, created: true }
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    }
  }
  return fail('READ_MARK_BUSY', 'This conversation is being marked read on another device. Try again.', 503)
}

/** Moves the person's mark of a conversation forward to `sequence` and answers the mark as stored (`raise`). */
export async function writeReadMark(db: PrismaClient, mark: ReadMarkWrite): Promise<number> {
  const { tabId, personId, conversationId, sequence } = mark
  return (await raise(db.superTabReadMark as unknown as MarkRows, stableId(tabId, conversationId, personId), sequence, new Date(mark.now),
    { tabId, personId, conversationId })).sequence
}

/** Moves the person's mark of one thread forward to `sequence` and answers the mark as stored (`raise`). A new mark past
 *  THREAD_MARK_CAP removes the person's least recently moved ones in this Swarm. Two first marks racing may each remove
 *  one; a removed mark only makes its thread read as far as its conversation's mark. */
export async function writeThreadMark(db: PrismaClient, mark: ThreadMarkWrite): Promise<number> {
  const { tabId, personId, conversationId, threadId, sequence } = mark
  const stored = await raise(db.superTabThreadMark as unknown as MarkRows, stableId(tabId, conversationId, threadId, personId), sequence,
    new Date(mark.now), { tabId, personId, conversationId, threadId })
  if (stored.created) await capThreadMarks(db, tabId, personId)
  return stored.sequence
}

/** Removes the person's least recently moved thread marks in the Swarm past THREAD_MARK_CAP, by the (tabId, personId,
 *  updatedAt) index: it counts the person's marks and reads only the ids of those past the cap. */
async function capThreadMarks(db: PrismaClient, tabId: string, personId: string): Promise<void> {
  const [counted] = await readBy(db, 'SuperTabThreadMark', 'moved', [{ $match: { tabId, personId } }, { $count: 'n' }])
  const over = Number(counted?.n ?? 0) - THREAD_MARK_CAP
  if (over <= 0) return
  const oldest = await readBy(db, 'SuperTabThreadMark', 'moved', [{ $match: { tabId, personId } }, { $sort: { updatedAt: 1 } }, { $limit: over },
    { $project: { _id: 1 } }])
  await db.superTabThreadMark.deleteMany({ where: { id: { in: oldest.map(row => row._id as string) } } })
}

/** The person's marks in this tab, by conversation; with `since`, only those moved at or after it. */
export async function readMarks(db: PrismaClient, tabId: string, personId: string, since?: number): Promise<Map<string, number>> {
  const rows = await db.superTabReadMark.findMany({ where: { tabId, personId, ...(since === undefined ? {} : { updatedAt: { gte: new Date(since) } }) },
    select: { conversationId: true, sequence: true } })
  return new Map(rows.map(row => [row.conversationId, row.sequence]))
}

/** The person's thread marks in this tab, by conversation then thread root. With `conversationIds`, those of the listed
 *  conversations, by the (tabId, personId, conversationId) index; with `since`, those moved at or after it, by the
 *  (tabId, personId, updatedAt) index. One raw match each: Prisma's filters plan slowly at this size (parts/indexed.ts). */
export async function readThreadMarks(db: Prisma.TransactionClient, tabId: string, personId: string, among: { conversationIds: string[] } | { since: number }):
  Promise<Map<string, Map<string, number>>> {
  const marks = new Map<string, Map<string, number>>()
  if ('conversationIds' in among && !among.conversationIds.length) return marks
  const rows = 'conversationIds' in among
    ? await readBy(db, 'SuperTabThreadMark', 'held', [{ $match: { tabId, personId, conversationId: { $in: among.conversationIds } } },
      { $project: { _id: 0, conversationId: 1, threadId: 1, sequence: 1 } }])
    : await readBy(db, 'SuperTabThreadMark', 'moved', [{ $match: { tabId, personId, updatedAt: { $gte: { $date: new Date(among.since).toISOString() } } } },
      { $project: { _id: 0, conversationId: 1, threadId: 1, sequence: 1 } }])
  for (const row of rows) {
    const conversationId = row.conversationId as string, threadId = row.threadId as string, sequence = Number(row.sequence)
    let held = marks.get(conversationId)
    if (!held) marks.set(conversationId, held = new Map())
    held.set(threadId, sequence)
  }
  return marks
}
