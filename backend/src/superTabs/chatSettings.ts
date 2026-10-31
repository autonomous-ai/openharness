/**
 * A person's notification setting for each chat (Slack's channel notification settings): `all` new messages, `mentions` only
 * (the default, what Desktop did before) or `muted`. Kept per person on the server so it follows them to every device, in
 * SuperTabChatSetting, never in the tab state: writing one wakes no other reader, and an older backend reads and writes a tab
 * that has them. A person's settings go only to their own reads (read/service.ts), for the chats they can read now.
 *
 * Growth: a row back at the default is kept CHAT_SETTING_DEFAULT_KEEP_MS so a device that polls learns of the change, then the
 * hourly sweep deletes it, as it deletes the rows of people no longer in the Swarm and of Swarms that are gone. A person keeps
 * at most CHAT_SETTING_CAP rows in one Swarm.
 */
import { Prisma, type PrismaClient } from '@prisma/client'
import { fail, stableId } from './model.js'
import { readBy } from './parts/indexed.js'

export const NOTIFY_LEVELS = ['all', 'mentions', 'muted'] as const
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number]
export const DEFAULT_NOTIFY: NotifyLevel = 'mentions'
/** A row back at the default stays this long, then the sweep deletes it. */
export const CHAT_SETTING_DEFAULT_KEEP_MS = 7 * 24 * 60 * 60_000
/** The most rows one person keeps in one Swarm: a new one past it is refused. */
export const CHAT_SETTING_CAP = 2_000
/** Swarms one sweep checks for rows of people no longer there. */
export const CHAT_SETTING_SWARMS = 500
const SWEEP_BATCH = 1_000

export interface ChatSettingWrite { tabId: string; personId: string; conversationId: string; notify: NotifyLevel; now: number }

/** Stores the person's setting for one chat and answers it. Two first writes racing: the loser's create fails on the id and
 *  its update runs again on the winner's row, so the last write wins. */
export async function writeChatSetting(db: PrismaClient, write: ChatSettingWrite): Promise<NotifyLevel> {
  const { tabId, personId, conversationId, notify } = write
  const id = stableId(tabId, conversationId, personId, 'notify'), updatedAt = new Date(write.now)
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await db.superTabChatSetting.updateMany({ where: { id }, data: { notify, updatedAt } })).count) return notify
    // Nothing to keep: a chat at the default needs no row.
    if (notify === DEFAULT_NOTIFY) return notify
    if (await db.superTabChatSetting.count({ where: { tabId, personId } }) >= CHAT_SETTING_CAP) {
      fail('TOO_MANY_CHAT_SETTINGS', 'You have set notifications for too many chats in this Swarm. Set some back to Mentions only first.', 400)
    }
    try {
      await db.superTabChatSetting.create({ data: { id, tabId, personId, conversationId, notify, updatedAt } })
      return notify
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    }
  }
  return fail('CHAT_SETTING_BUSY', 'This chat is being changed on another device. Try again.', 503)
}

/** The person's settings in this tab, by conversation; with `since`, only those moved at or after it. The caller keeps those
 *  of conversations the reader may read. */
export async function readChatSettings(db: Prisma.TransactionClient, tabId: string, personId: string, since?: number): Promise<Map<string, NotifyLevel>> {
  const rows = await db.superTabChatSetting.findMany({ where: { tabId, personId, ...(since === undefined ? {} : { updatedAt: { gte: new Date(since) } }) },
    select: { conversationId: true, notify: true } })
  return new Map(rows.flatMap(r => (NOTIFY_LEVELS as readonly string[]).includes(r.notify) ? [[r.conversationId, r.notify as NotifyLevel] as const] : []))
}

async function deleteWhere(db: PrismaClient, q: Record<string, unknown>): Promise<number> {
  const reply = await db.$runCommandRaw({ delete: 'SuperTabChatSetting', deletes: [{ q: q as Prisma.InputJsonObject, limit: 0 }] }) as { n?: number }
  return Number(reply.n ?? 0)
}

/** The hourly sweep (sweeps.ts): deletes default rows untouched for CHAT_SETTING_DEFAULT_KEEP_MS by the age index, then checks
 *  up to CHAT_SETTING_SWARMS Swarms with rows: a Swarm whose row is gone loses all of them, a person no longer in its
 *  `memberIds` theirs. A Swarm row without `memberIds` is skipped, never read as having no members. */
export async function sweepChatSettings(db: PrismaClient, now: number): Promise<{ expired: number; lost: number }> {
  let expired = 0
  const before = { $date: new Date(now - CHAT_SETTING_DEFAULT_KEEP_MS).toISOString() }
  for (;;) {
    const rows = await readBy(db, 'SuperTabChatSetting', 'age', [{ $match: { updatedAt: { $lt: before } } }, { $match: { notify: DEFAULT_NOTIFY } },
      { $limit: SWEEP_BATCH }, { $project: { _id: 1 } }])
    if (rows.length) expired += await deleteWhere(db, { _id: { $in: rows.map(r => r._id as string) } })
    if (rows.length < SWEEP_BATCH) break
  }
  // Settings are few (one per chat a person set by hand): their Swarms in one grouped read.
  const tabs = await db.superTabChatSetting.aggregateRaw({ pipeline: [{ $group: { _id: '$tabId' } }, { $sort: { _id: 1 } }, { $limit: CHAT_SETTING_SWARMS }] }) as unknown as
    Array<{ _id: string }>
  let lost = 0
  for (const { _id: tabId } of tabs) {
    const [row] = await readBy(db, 'SuperTab', 'id', [{ $match: { _id: tabId } }, { $project: { memberIds: 1 } }])
    if (!row) lost += await deleteWhere(db, { tabId })
    else if (Array.isArray(row.memberIds)) lost += await deleteWhere(db, { tabId, personId: { $nin: row.memberIds as string[] } })
  }
  return { expired, lost }
}
