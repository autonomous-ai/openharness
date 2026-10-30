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

/** Run by the singleton worker at startup, like the mention expiry. Thread marks need no index option: the hourly sweep
 *  deletes them (sweepThreadMarks), as the app user may not set one on an index `db push` built (#2238). */
export async function ensureReadMarkExpiry(db: PrismaClient): Promise<void> {
  await ensureIndex(db, 'SuperTabReadMark', { key: { updatedAt: 1 }, name: 'read_mark_expiry', expireAfterSeconds: READ_MARK_EXPIRY_MS / 1000 })
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
  const [counted] = await readBy(db, 'SuperTabThreadMark', 'person', [{ $match: { tabId, personId } }, { $count: 'n' }])
  const over = Number(counted?.n ?? 0) - THREAD_MARK_CAP
  if (over <= 0) return
  const oldest = await readBy(db, 'SuperTabThreadMark', 'person', [{ $match: { tabId, personId } }, { $sort: { updatedAt: 1 } }, { $limit: over },
    { $project: { _id: 1 } }])
  // A plain $in on _id: Prisma's `in` plans slowly (parts/indexed.ts).
  await db.$runCommandRaw({ delete: 'SuperTabThreadMark', deletes: [{ q: { _id: { $in: oldest.map(row => row._id as string) } }, limit: 0 }] })
}

/** The person's marks in this tab, by conversation; with `since`, only those moved at or after it. */
export async function readMarks(db: PrismaClient, tabId: string, personId: string, since?: number): Promise<Map<string, number>> {
  const rows = await db.superTabReadMark.findMany({ where: { tabId, personId, ...(since === undefined ? {} : { updatedAt: { gte: new Date(since) } }) },
    select: { conversationId: true, sequence: true } })
  return new Map(rows.map(row => [row.conversationId, row.sequence]))
}

/** The person's thread marks in this tab, by conversation then thread root: every one (at most THREAD_MARK_CAP), or with
 *  `since` those moved at or after it. One raw match by the (tabId, personId, updatedAt) index: Prisma's filters plan slowly
 *  at this size (parts/indexed.ts). The caller keeps those of conversations the reader may read. */
export async function readThreadMarks(db: Prisma.TransactionClient, tabId: string, personId: string, since?: number):
  Promise<Map<string, Map<string, number>>> {
  const marks = new Map<string, Map<string, number>>()
  const rows = await readBy(db, 'SuperTabThreadMark', 'person', [{ $match: { tabId, personId,
    ...(since === undefined ? {} : { updatedAt: { $gte: { $date: new Date(since).toISOString() } } }) } },
  { $project: { _id: 0, conversationId: 1, threadId: 1, sequence: 1 } }])
  for (const row of rows) {
    const conversationId = row.conversationId as string, threadId = row.threadId as string, sequence = Number(row.sequence)
    let held = marks.get(conversationId)
    if (!held) marks.set(conversationId, held = new Map())
    held.set(threadId, sequence)
  }
  return marks
}

/** How many marks one sweep deletes at most, in batches, each kind: the rest wait for the next hour. */
export const THREAD_MARK_SWEEP = 20_000
const SWEEP_BATCH = 1_000

/** Deletes rows by id with a plain $in on _id (Prisma's `in` plans slowly). */
async function deleteIds(db: PrismaClient, ids: string[]): Promise<number> {
  if (!ids.length) return 0
  const reply = await db.$runCommandRaw({ delete: 'SuperTabThreadMark', deletes: [{ q: { _id: { $in: ids } }, limit: 0 }] }) as { n?: number }
  return Number(reply.n ?? 0)
}

/**
 * The hourly sweep of thread marks (run by the singleton worker with the Swarm sweeps, sweeps.ts): deletes marks untouched for
 * READ_MARK_EXPIRY_MS, then the marks of Swarms that no longer exist and of people no longer in their Swarm. Each kind reads
 * by its index in batches of SWEEP_BATCH, at most THREAD_MARK_SWEEP a pass. A delete only makes a thread read as far as its
 * conversation's mark, so a mark swept a moment before its person moves it again costs nothing.
 */
export async function sweepThreadMarks(db: PrismaClient, now: number): Promise<{ expired: number; lost: number }> {
  let expired = 0
  const before = { $date: new Date(now - READ_MARK_EXPIRY_MS).toISOString() }
  while (expired < THREAD_MARK_SWEEP) {
    const rows = await readBy(db, 'SuperTabThreadMark', 'age', [{ $match: { updatedAt: { $lt: before } } }, { $limit: SWEEP_BATCH }, { $project: { _id: 1 } }])
    expired += await deleteIds(db, rows.map(row => row._id as string))
    if (rows.length < SWEEP_BATCH) break
  }
  // Each Swarm's people with marks, read off the person index in order, then whether each Swarm and person is still there.
  const pairs = (await readBy(db, 'SuperTabThreadMark', 'person', [{ $sort: { tabId: 1, personId: 1 } },
    { $group: { _id: { tabId: '$tabId', personId: '$personId' } } }, { $limit: THREAD_MARK_SWEEP }]))
    .map(row => row._id as { tabId: string; personId: string })
  const tabIds = [...new Set(pairs.map(pair => pair.tabId))]
  const members = new Map((tabIds.length ? await readBy(db, 'SuperTab', 'id', [{ $match: { _id: { $in: tabIds } } }, { $project: { memberIds: 1 } }]) : [])
    .map(row => [row._id as string, new Set((row.memberIds as string[] | undefined) ?? [])]))
  const gone = pairs.filter(pair => !members.get(pair.tabId)?.has(pair.personId))
  let lost = 0
  for (let at = 0; at < gone.length && lost < THREAD_MARK_SWEEP; at += SWEEP_BATCH) {
    const reply = await db.$runCommandRaw({ delete: 'SuperTabThreadMark', deletes: gone.slice(at, at + SWEEP_BATCH)
      .map(pair => ({ q: { tabId: pair.tabId, personId: pair.personId }, limit: 0 })) }) as { n?: number }
    lost += Number(reply.n ?? 0)
  }
  return { expired, lost }
}
