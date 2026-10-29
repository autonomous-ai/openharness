/** How far each person has read each conversation: the newest message sequence they saw there, so unread state follows them
 *  across devices. Marks live in SuperTabReadMark, never in the tab state: writing one wakes no other reader, and an older
 *  backend reads and writes a tab that has them. A person's marks go only to their own reads (read/service.ts); agents have
 *  none. */
import { Prisma, type PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'
import { fail, stableId } from './model.js'

/** A mark untouched this long is removed by a TTL index; the conversation then reads as the device last saw it. */
export const READ_MARK_EXPIRY_MS = 180 * 24 * 60 * 60_000

/** Run by the singleton worker at startup, like the mention expiry. */
export async function ensureReadMarkExpiry(db: PrismaClient): Promise<void> {
  await ensureIndex(db, 'SuperTabReadMark', { key: { updatedAt: 1 }, name: 'read_mark_expiry', expireAfterSeconds: READ_MARK_EXPIRY_MS / 1000 })
}

export interface ReadMarkWrite { tabId: string; personId: string; conversationId: string; sequence: number; now: number }

/** Moves the person's mark forward to `sequence` and answers the mark as stored. An older mark never replaces a newer one:
 *  the update matches only a lower mark. When another device's write lands between the update and the look after it (two
 *  first writes racing to create the row, or one raising it), the update runs again; every retry follows a write that
 *  raised the mark, so a few settle it. */
export async function writeReadMark(db: PrismaClient, mark: ReadMarkWrite): Promise<number> {
  const { tabId, personId, conversationId, sequence } = mark
  const id = stableId(tabId, conversationId, personId), updatedAt = new Date(mark.now)
  for (let attempt = 0; attempt < 4; attempt++) {
    const moved = await db.superTabReadMark.updateMany({ where: { id, sequence: { lt: sequence } }, data: { sequence, updatedAt } })
    if (moved.count) return sequence
    const held = await db.superTabReadMark.findUnique({ where: { id }, select: { sequence: true } })
    if (held && held.sequence >= sequence) return held.sequence
    if (held) continue
    try {
      await db.superTabReadMark.create({ data: { id, tabId, personId, conversationId, sequence, updatedAt } })
      return sequence
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    }
  }
  return fail('READ_MARK_BUSY', 'This conversation is being marked read on another device. Try again.', 503)
}

/** The person's marks in this tab, by conversation; with `since`, only those moved at or after it. */
export async function readMarks(db: PrismaClient, tabId: string, personId: string, since?: number): Promise<Map<string, number>> {
  const rows = await db.superTabReadMark.findMany({ where: { tabId, personId, ...(since === undefined ? {} : { updatedAt: { gte: new Date(since) } }) },
    select: { conversationId: true, sequence: true } })
  return new Map(rows.map(row => [row.conversationId, row.sequence]))
}
