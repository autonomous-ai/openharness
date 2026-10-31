/**
 * A person's Activity in one Swarm (Desktop's Activity view, as Slack's): replies to their messages and reactions to them.
 * Tags and decisions have their own rows (mentions.ts, decisions.ts); Desktop merges the three.
 *
 * A row is written when it happens, in the command's own transaction (store.ts): a thread reply whose root a person wrote, by
 * anyone else, and a reaction to a person's message by anyone else. Removing the reaction removes its row. Rows live in
 * SuperTabActivity, never in the tab state, so writing one wakes no other reader and an older backend reads and writes a tab
 * that has them.
 *
 * Reads go only to the person the row is for, and only for what they can read now: the chat by the messages read's check
 * (canReadGroup, a quiet chat read by id as tags are), the message as a page shows it to a person (never an agent-only notice
 * or a delivered copy), and a reactor still in the Swarm.
 *
 * Growth: the hourly sweep deletes rows older than ACTIVITY_EXPIRY_MS (sweepActivity); a list reads the newest ACTIVITY_LIST.
 */
import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthUser } from '../lib/ssoAuth.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import { agentOnly, isLeads, stableId, type Actor, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { canReadGroup, projectOf } from './projects.js'
import { groupsBy, readBy } from './parts/indexed.js'
import { usernameOf } from './usernames.js'
import { FIELDS, readable, row as messageRow, type Row } from './read/inbox.js'

type Tx = Prisma.TransactionClient
/** A row goes this long after it was made, as a tag does (mentions.ts MENTION_EXPIRY_MS). */
export const ACTIVITY_EXPIRY_MS = 30 * 24 * 60 * 60_000
/** Rows one list reads, newest first; `more` says there were others. */
export const ACTIVITY_LIST = 200
/** Unread rows the digest covers, newest first. */
export const ACTIVITY_DIGEST_ROWS = 200
/** Rows one sweep deletes at most, in batches; the rest wait for the next hour. */
export const ACTIVITY_SWEEP = 20_000
const SWEEP_BATCH = 1_000

export type ActivityKind = 'reply' | 'reaction'
/** Mongo omits unset fields, so `readAt: null` alone would miss a row written without it. */
const unread: Prisma.SuperTabActivityWhereInput = { OR: [{ readAt: null }, { readAt: { isSet: false } }] }
const own = (author: { kind?: string; id?: string } | undefined, personId: string) => author?.kind === 'person' && author.id === personId

/** Activity rows for the thread replies among `messages`: one for the person who wrote the thread's root and one for the person
 *  who wrote the message replied to, unless they wrote the reply. A notice for agents alone is nobody's activity, and a root or
 *  quoted message counts only in the reply's own chat. Those messages by id in one read. */
export async function writeReplyActivity(tx: Tx, tabId: string, messages: MessageDraft[], now: number): Promise<void> {
  const replies = messages.filter(m => m.thread && m.thread !== m.id && !agentOnly(m.source ?? null, m.recipients))
  if (!replies.length) return
  const ids = [...new Set(replies.flatMap(m => [m.thread!, ...(m.replyTo ? [m.replyTo] : [])]))]
  // By id through its index, as a plain $in (parts/indexed.ts): Prisma's `in` plans slowly.
  const found = new Map((await readBy(tx, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: ids }, tabId } }, { $project: { conversationId: 1, author: 1 } }]))
    .map(r => [r._id as string, { conversationId: r.conversationId as string, author: r.author }]))
  const data = replies.flatMap(m => {
    const people = new Set([m.thread!, m.replyTo].flatMap(target => {
      const row = target ? found.get(target) : undefined
      const by = row?.author as { kind?: string; id?: string } | undefined
      return row && row.conversationId === m.conversationId && by?.kind === 'person' && by.id && !own(m.author, by.id) ? [by.id] : []
    }))
    return [...people].map(personId => ({ id: stableId(tabId, 'reply', m.id, personId), tabId, personId, kind: 'reply', conversationId: m.conversationId,
      messageId: m.id, threadId: m.thread!, actorKind: m.author.kind, actorId: m.author.id, emoji: null, createdAt: new Date(now), readAt: null }))
  })
  if (data.length) await tx.superTabActivity.createMany({ data })
}

/** The row of the reaction `reactionId`, for the person who wrote the message, unless they reacted themselves: written when the
 *  reaction is added, removed when it is. */
export async function writeReactionActivity(tx: Tx, write: { tabId: string; reactionId: string; conversationId: string; messageId: string
  actor: { kind: 'person' | 'agent'; id: string }; emoji: string; on: boolean; now: number }): Promise<void> {
  const id = stableId(write.tabId, 'reaction', write.reactionId)
  if (!write.on) return void await tx.superTabActivity.deleteMany({ where: { id } })
  const message = await tx.superTabMessage.findFirst({ where: { id: write.messageId, tabId: write.tabId }, select: { author: true, thread: true } })
  const by = message?.author as { kind?: string; id?: string } | undefined
  if (by?.kind !== 'person' || !by.id || (write.actor.kind === 'person' && write.actor.id === by.id)) return
  await tx.superTabActivity.upsert({ where: { id }, update: {}, create: { id, tabId: write.tabId, personId: by.id, kind: 'reaction',
    conversationId: write.conversationId, messageId: write.messageId, threadId: message?.thread ?? null, actorKind: write.actor.kind,
    actorId: write.actor.id, emoji: write.emoji, createdAt: new Date(write.now), readAt: null } })
}

/** A digest of which of the person's rows are unread, moving when one is written, read or removed: a client reads its list
 *  again when it moves, never on a timer. It carries no count and no chat: only that something changed. */
export async function activityDigest(tx: Tx, tabId: string, personId: string, now: number): Promise<string> {
  const rows = await tx.superTabActivity.findMany({ where: { tabId, personId, createdAt: { gt: new Date(now - ACTIVITY_EXPIRY_MS) }, ...unread },
    orderBy: { createdAt: 'desc' }, take: ACTIVITY_DIGEST_ROWS, select: { id: true } })
  return createHash('sha256').update(rows.map(r => r.id).sort().join('\n')).digest('base64url').slice(0, 16)
}

export interface ActivityItem {
  id: string
  kind: ActivityKind
  conversationId: string
  conversationTitle: string
  projectName: string
  /** The reply, or the message reacted to. */
  messageId: string
  /** Where the message is in its chat. */
  messageSequence: number
  /** The thread the message is in, when it is a reply that lives only there; null for one in the chat's main stream. */
  threadId: string | null
  actor: { kind: 'person' | 'agent'; id: string; name: string }
  emoji: string | null
  /** The reply's text, or the reacted message's, cut by the database. */
  text: string
  createdAt: string
  read: boolean
}

/** The person's own unexpired rows, newest first, those they can read now (see the file's comment). */
export async function listActivity(db: PrismaClient, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number):
  Promise<{ items: ActivityItem[]; more: boolean }> {
  const rows = await db.superTabActivity.findMany({ where: { tabId, personId: actor.userId, createdAt: { gt: new Date(now - ACTIVITY_EXPIRY_MS) } },
    orderBy: { createdAt: 'desc' }, take: ACTIVITY_LIST + 1 })
  const more = rows.length > ACTIVITY_LIST
  const listed = rows.slice(0, ACTIVITY_LIST)
  if (!listed.length) return { items: [], more }
  const groups = new Map(state.conversations.map(c => [c.id, c]))
  const missing = [...new Set(listed.map(r => r.conversationId))].filter(id => !groups.has(id))
  if (missing.length) {
    // A quiet chat by id through its index (parts/indexed.ts), as tags read theirs (mentions.ts readable).
    for (const row of await groupsBy(db, 'key', [{ $match: { tabId, deleted: false, key: { $in: missing } } }, { $project: { _id: 0, key: 1, data: 1 } }])) {
      groups.set(row.key as string, row.data as unknown as Conversation)
    }
  }
  const present = (kind: string, id: string) => kind === 'person' ? state.people.some(p => p.id === id) : state.agents.some(a => a.id === id)
  const kept = listed.filter(r => {
    const group = groups.get(r.conversationId)
    // A reaction by someone no longer here drops out, as its count does (reactions.ts reactionCounts).
    return group && !isLeads(group) && canReadGroup(state, actor, group) && (r.kind !== 'reaction' || present(r.actorKind, r.actorId))
  })
  if (!kept.length) return { items: [], more }
  const found = (await readBy(db, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: [...new Set(kept.map(r => r.messageId))] }, tabId } },
    { $project: { ...FIELDS, conversationId: 1 } }])).map(messageRow)
  const messages = new Map((await readable(db, tabId, found)).map(m => [m.id, m]))
  const items = kept.flatMap(r => {
    const message = messages.get(r.messageId)
    // The message must still be in the chat the row names, and be one the person reads; a reaction's must still be theirs.
    if (!message || message.conversationId !== r.conversationId || (r.kind === 'reaction' && !own(message.author, actor.userId))) return []
    const group = groups.get(r.conversationId)!
    return [{ id: r.id, kind: r.kind as ActivityKind, conversationId: r.conversationId, conversationTitle: group.title,
      projectName: projectOf(state, group.projectId ?? 'lead').name, messageId: r.messageId, messageSequence: message.sequence,
      threadId: threadOf(message), actor: { kind: r.actorKind as 'person' | 'agent', id: r.actorId, name: actorName(state, r.actorKind, r.actorId, message, r.kind) },
      emoji: r.emoji ?? null, text: message.text, createdAt: r.createdAt.toISOString(), read: !!r.readAt }]
  })
  return { items, more }
}

/** A reply that lives only in its thread names its root; a top-level message or one also sent to the chat names none. */
const threadOf = (m: Row) => m.thread && m.thread !== m.id && !m.alsoInChat ? m.thread : null

/** A person by their username, as everywhere in the Swarm; an agent by its name, or the reply's author name when it left. */
function actorName(state: SuperTabState, kind: string, id: string, message: Row, rowKind: string): string {
  if (kind === 'person') return usernameOf(state, id) ?? 'Someone'
  const agent = state.agents.find(a => a.id === id) as { displayName?: string | null; name?: string } | undefined
  const author = rowKind === 'reply' ? message.author as Author & { displayName?: string } : undefined
  return agent?.displayName ?? agent?.name ?? author?.displayName ?? author?.name ?? 'An agent'
}

/** Marks the person's rows made at or before `through` read, on every device. Only their own. */
export async function markActivityRead(db: PrismaClient, tabId: string, personId: string, through: number, now: number): Promise<number> {
  const moved = await db.superTabActivity.updateMany({ where: { tabId, personId, createdAt: { lte: new Date(through) }, ...unread },
    data: { readAt: new Date(now) } })
  return moved.count
}

/** The hourly sweep (sweeps.ts): deletes rows older than ACTIVITY_EXPIRY_MS by the age index, in batches. No TTL index: the app
 *  user may not set one on an index `db push` built (#2238), as thread marks. */
export async function sweepActivity(db: PrismaClient, now: number): Promise<number> {
  let deleted = 0
  const before = { $date: new Date(now - ACTIVITY_EXPIRY_MS).toISOString() }
  while (deleted < ACTIVITY_SWEEP) {
    const rows = await readBy(db, 'SuperTabActivity', 'age', [{ $match: { createdAt: { $lt: before } } }, { $limit: SWEEP_BATCH }, { $project: { _id: 1 } }])
    if (rows.length) {
      const reply = await db.$runCommandRaw({ delete: 'SuperTabActivity', deletes: [{ q: { _id: { $in: rows.map(r => r._id as string) } }, limit: 0 }] }) as { n?: number }
      deleted += Number(reply.n ?? 0)
    }
    if (rows.length < SWEEP_BATCH) break
  }
  return deleted
}

/** Activity reads a person may make in one Swarm per window, as the inbox's (read/inbox.ts INBOX_READS). */
export const ACTIVITY_READS = 10
export const ACTIVITY_WINDOW_MS = 10_000
const activityReads = createRateLimiter('swarm-activity', ACTIVITY_WINDOW_MS, ACTIVITY_READS)

/** Seconds a person must wait before reading this Swarm's Activity again, or 0 when they may now (as inboxWait). */
export async function activityWait(user: AuthUser, tabId: string, now = Date.now()): Promise<number> {
  if (await activityReads.allows(`${user.sub}:${tabId}`, now)) return 0
  return Math.max(1, Math.ceil((ACTIVITY_WINDOW_MS - now % ACTIVITY_WINDOW_MS) / 1000))
}
/** Test seam: forget this process's counts. */
export const resetActivityReads = () => activityReads.reset()
