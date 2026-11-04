/**
 * A person's reminders in one Swarm (Desktop's Remind me on a message): the message comes back to them at a time, under
 * Activity's Reminders, until they open it. One row per person and message (SuperTabReminder): setting it again replaces its
 * time, opening it deletes it. Rows live outside the tab state, so writing one wakes no other reader; the person's own read
 * carries a digest of theirs (remindersDigest), and their client reads the list again when it moves or when the next one is due.
 *
 * Privacy: read, set and cleared only by their person, as themselves (read/service.ts). A list keeps only what they can read
 * now, as Activity's does (activity.ts readableMessages): the chat by canReadGroup, a quiet one read by id, and the message as a
 * page shows it to a person, still in the chat the row names.
 *
 * Growth: opening one deletes it; at most REMINDER_CAP per person and Swarm, due or not; the hourly sweep deletes those due
 * more than REMINDER_EXPIRY_MS ago (sweepReminders), and a Swarm's purge the rest (purge.ts). A row is at most
 * REMINDER_AHEAD_MS + REMINDER_EXPIRY_MS old.
 *
 * Reads: each of a person's reads is one range of the (tabId, personId, dueAt) index (`person`): the due ones newest first,
 * the next one after now, the digest's at most REMINDER_CAP and the cap's count. The sweep reads by `due`.
 */
import { createHash } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { AuthUser } from '../lib/ssoAuth.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import { fail, stableId, type Actor, type SuperTabState } from './model.js'
import { projectOf } from './projects.js'
import { readBy } from './parts/indexed.js'
import { ms } from './parts/light.js'
import { actorName, readableMessages, threadOf } from './activity.js'

/** Reminders one person keeps in one Swarm, due or not: one more is refused (REMINDER_LIMIT). The list reads at most these. */
export const REMINDER_CAP = 200
/** How far ahead a reminder may be set. */
export const REMINDER_AHEAD_MS = 30 * 24 * 60 * 60_000
/** A reminder due this long ago, never opened, is deleted by the sweep. */
export const REMINDER_EXPIRY_MS = 30 * 24 * 60 * 60_000
/** Rows one sweep deletes at most, in batches; the rest wait for the next hour. */
export const REMINDER_SWEEP = 20_000
const SWEEP_BATCH = 1_000

const at = (time: number) => ({ $date: new Date(time).toISOString() })
export const reminderId = (tabId: string, personId: string, messageId: string) => stableId(tabId, personId, messageId)

export interface ReminderWrite { tabId: string; personId: string; conversationId: string; messageId: string; dueAt: number; now: number }

/** Sets the person's reminder of a message to `dueAt`, replacing the time of one they set before, and answers it. The caller has
 *  checked the time and that they read the message. A new one past REMINDER_CAP is refused; two first ones racing at the cap
 *  may both land, one over it. */
export async function setReminder(db: PrismaClient, write: ReminderWrite): Promise<{ id: string; dueAt: string }> {
  const { tabId, personId, conversationId, messageId } = write
  const id = reminderId(tabId, personId, messageId), dueAt = new Date(write.dueAt)
  const [counted] = await readBy(db, 'SuperTabReminder', 'person', [{ $match: { tabId, personId } }, { $count: 'n' }])
  if (Number(counted?.n ?? 0) >= REMINDER_CAP && !(await db.superTabReminder.findUnique({ where: { id }, select: { id: true } }))) {
    fail('REMINDER_LIMIT', `You have ${REMINDER_CAP} reminders in this Swarm. Open or clear one first.`, 409)
  }
  const upsert = () => db.superTabReminder.upsert({ where: { id }, update: { dueAt },
    create: { id, tabId, personId, conversationId, messageId, dueAt, createdAt: new Date(write.now) } })
  try {
    await upsert()
  } catch (error) {
    // Two devices setting it at once: the loser's create meets the winner's row, and its time replaces it.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    await upsert()
  }
  return { id, dueAt: dueAt.toISOString() }
}

/** Deletes the person's reminder of a message of this chat, and answers whether there was one. Only their own: the id names them. */
export async function clearReminder(db: PrismaClient, ref: { tabId: string; personId: string; conversationId: string; messageId: string }): Promise<boolean> {
  const reply = await db.$runCommandRaw({ delete: 'SuperTabReminder', deletes: [{ q: { _id: reminderId(ref.tabId, ref.personId, ref.messageId),
    conversationId: ref.conversationId }, limit: 1 }] }) as { n?: number }
  return Number(reply.n ?? 0) > 0
}

/** A digest of the person's reminders and their times, moving when one is set, replaced or cleared: the client reads its list
 *  again when it moves, and at the `next` time a list gave it, never on a timer. No count and no chat. */
export async function remindersDigest(db: PrismaClient, tabId: string, personId: string): Promise<string> {
  const rows = await readBy(db, 'SuperTabReminder', 'person', [{ $match: { tabId, personId } }, { $sort: { dueAt: 1 } }, { $limit: REMINDER_CAP },
    { $project: { _id: 1, dueAt: 1 } }])
  return createHash('sha256').update(rows.map(r => `${r._id as string} ${ms(r.dueAt)}`).sort().join('\n')).digest('base64url').slice(0, 16)
}

export interface ReminderItem {
  id: string
  conversationId: string
  conversationTitle: string
  projectName: string
  messageId: string
  /** Where the message is in its chat. */
  messageSequence: number
  /** The thread the message is in, when it is a reply that lives only there; null for one in the chat's main stream. */
  threadId: string | null
  /** Who wrote the message. */
  author: { kind: 'person' | 'agent'; id: string; name: string }
  /** The message's text, cut by the database. */
  text: string
  dueAt: string
}

/** The person's due reminders, newest due first, those they can read now (see the file's comment), and when the next one is
 *  due after now (null when none is). */
export async function listReminders(db: PrismaClient, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number):
  Promise<{ due: ReminderItem[]; next: string | null }> {
  const personId = actor.userId
  const [rows, upcoming] = await Promise.all([
    readBy(db, 'SuperTabReminder', 'person', [{ $match: { tabId, personId, dueAt: { $lte: at(now) } } }, { $sort: { dueAt: -1 } }, { $limit: REMINDER_CAP },
      { $project: { _id: 1, conversationId: 1, messageId: 1, dueAt: 1 } }]),
    readBy(db, 'SuperTabReminder', 'person', [{ $match: { tabId, personId, dueAt: { $gt: at(now) } } }, { $sort: { dueAt: 1 } }, { $limit: 1 },
      { $project: { _id: 0, dueAt: 1 } }]),
  ])
  const next = upcoming[0] ? new Date(ms(upcoming[0].dueAt)).toISOString() : null
  const listed = rows.map(r => ({ id: r._id as string, conversationId: r.conversationId as string, messageId: r.messageId as string, dueAt: ms(r.dueAt) }))
  if (!listed.length) return { due: [], next }
  const shown = await readableMessages(db, tabId, state, actor, listed)
  const due = listed.flatMap(r => {
    const seen = shown(r)
    if (!seen) return []
    const { group, message } = seen
    return [{ id: r.id, conversationId: r.conversationId, conversationTitle: group.title, projectName: projectOf(state, group.projectId ?? 'lead').name,
      messageId: r.messageId, messageSequence: message.sequence, threadId: threadOf(message),
      author: { kind: message.author.kind, id: message.author.id, name: actorName(state, message.author.kind, message.author.id, message.author) },
      text: message.text, dueAt: new Date(r.dueAt).toISOString() }]
  })
  return { due, next }
}

/** The hourly sweep (sweeps.ts): deletes reminders due more than REMINDER_EXPIRY_MS ago by the due index, in batches. No TTL
 *  index: the app user may not set one on an index `db push` built (#2238), as Activity. */
export async function sweepReminders(db: PrismaClient, now: number): Promise<number> {
  let deleted = 0
  const before = at(now - REMINDER_EXPIRY_MS)
  while (deleted < REMINDER_SWEEP) {
    const rows = await readBy(db, 'SuperTabReminder', 'due', [{ $match: { dueAt: { $lt: before } } }, { $limit: SWEEP_BATCH }, { $project: { _id: 1 } }])
    if (rows.length) {
      const reply = await db.$runCommandRaw({ delete: 'SuperTabReminder', deletes: [{ q: { _id: { $in: rows.map(r => r._id as string) } }, limit: 0 }] }) as { n?: number }
      deleted += Number(reply.n ?? 0)
    }
    if (rows.length < SWEEP_BATCH) break
  }
  return deleted
}

/** Reminder list reads a person may make in one Swarm per window, as Activity's (activity.ts ACTIVITY_READS). */
export const REMINDER_READS = 10
export const REMINDER_WINDOW_MS = 10_000
const reminderReads = createRateLimiter('swarm-reminders', REMINDER_WINDOW_MS, REMINDER_READS)

/** Seconds a person must wait before reading this Swarm's reminders again, or 0 when they may now (as activityWait). */
export async function reminderWait(user: AuthUser, tabId: string, now = Date.now()): Promise<number> {
  if (await reminderReads.allows(`${user.sub}:${tabId}`, now)) return 0
  return Math.max(1, Math.ceil((REMINDER_WINDOW_MS - now % REMINDER_WINDOW_MS) / 1000))
}
/** Test seam: forget this process's counts. */
export const resetReminderReads = () => reminderReads.reset()
