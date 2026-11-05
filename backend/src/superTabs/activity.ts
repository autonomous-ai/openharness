/**
 * A person's Activity in one Swarm (Desktop's Activity view, as Slack's): replies to their messages and reactions to them.
 * Tags and decisions have their own rows (mentions.ts, decisions.ts); Desktop merges the three.
 *
 * A row is written when it happens, in the command's own transaction (store.ts): a thread reply, for everyone in its thread but
 * its author (writeReplyActivity), and a reaction to a person's message by anyone else. Removing the reaction removes its row. Rows live in
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
import { SESSION_ENDED_KIND } from './buddySessions.js'
import { canReadGroup, projectOf } from './projects.js'
import { groupsBy, readBy } from './parts/indexed.js'
import type { ThreadFacet } from './pageReads.js'
import type { ReplyRow } from '../push/notices.js'
import { shownNameOf } from './personNames.js'
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

/** The most people one thread reply tells (replyAudience). */
export const REPLY_FANOUT = 100

/** Who one reply tells, before the checks of who may hear it (writeReplyActivity): the thread's starter and the author of the
 *  message it quotes first, then the people tagged in the thread, then those who replied in it, newest reply first; each once,
 *  at most REPLY_FANOUT. */
export function replyAudience(input: { starter: string | null; quoted: string | null; tagged: string[]; repliers: Array<{ id: string; sequence: number }> }): string[] {
  const told = new Set<string>()
  const add = (id: string | null) => { if (id && told.size < REPLY_FANOUT) told.add(id) }
  add(input.starter)
  add(input.quoted)
  for (const id of input.tagged) add(id)
  for (const r of [...input.repliers].sort((a, b) => b.sequence - a.sequence)) add(r.id)
  return [...told]
}

/** The people in a thread by its summary (pageReads.ts threadFacet), as the Threads view counts them (read/followedThreads.ts):
 *  each person who replied, by their newest reply, and each person tagged in it. */
function threadPeople(facet: ThreadFacet | undefined, root: string): { tagged: string[]; repliers: Array<{ id: string; sequence: number }> } {
  if (!facet) return { tagged: [], repliers: [] }
  const repliers = facet.parts.filter(p => p._id.thread === root && !p._id.root && p.newest.author?.kind === 'person' && p.newest.author.id)
    .map(p => ({ id: p.newest.author.id, sequence: p.newest.s }))
  const tagged = facet.mentions.filter(m => m._id.thread === root).sort((a, b) => a.first.s - b.first.s).map(m => m._id.person)
  return { tagged, repliers }
}

/** What writeReplyActivity needs to tell everyone in a thread: the Swarm as the command left it, and the summaries of the threads
 *  replied in, computed in the same transaction (pageReads.ts refreshReplies), so finding the people reads nothing more. */
export interface ReplyFanout { state: SuperTabState; threads: ReadonlyMap<string, ThreadFacet> }

/** Activity rows for the thread replies among `messages` (task #2745, as Slack's threads): a plain reply tells everyone in its
 *  thread, the person who started it, every person who replied in it and every person tagged in it (replyAudience, from
 *  `fanout`); a Swarm notice in a thread (a row with a source) tells only the starter and the author of the message it quotes,
 *  as before; without `fanout` every reply tells only those two. Never the reply's author, nor a person tagged in the reply
 *  itself (the tag tells them, mentions.ts), nor one who unfollowed the thread (readMarks.ts writeThreadFollow) or muted the
 *  chat (chatSettings.ts); with `fanout`, never a person no longer in the Swarm or who cannot read the chat now, and a chat
 *  its state does not hold tells only those two. A notice for
 *  agents alone, or a Buddy session's ended line, is nobody's activity. A root or quoted message counts only in the reply's own
 *  chat. Each row keeps its message's `sequence` (from `sequences`) and whether it is also in the chat, so a thread or chat mark
 *  reads it (markActivityThreadRead).
 *
 *  Reads: the roots and quoted messages by id, the people's thread marks by id and their chat settings by id: three reads
 *  whatever the thread's length, the last two only when someone is told. Writes: one row per person told, in one createMany. */
export async function writeReplyActivity(tx: Tx, tabId: string, messages: MessageDraft[], sequences: ReadonlyMap<string, number>, now: number,
  fanout?: ReplyFanout): Promise<ReplyRow[]> {
  const replies = messages.filter(m => m.thread && m.thread !== m.id && !agentOnly(m.source ?? null, m.recipients) && m.source?.kind !== SESSION_ENDED_KIND)
  if (!replies.length) return []
  const ids = [...new Set(replies.flatMap(m => [m.thread!, ...(m.replyTo ? [m.replyTo] : [])]))]
  // By id through its index, as a plain $in (parts/indexed.ts): Prisma's `in` plans slowly.
  const found = new Map((await readBy(tx, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: ids }, tabId } }, { $project: { conversationId: 1, author: 1 } }]))
    .map(r => [r._id as string, { conversationId: r.conversationId as string, author: r.author }]))
  const personOf = (m: MessageDraft, target: string | null | undefined) => {
    const row = target ? found.get(target) : undefined
    const by = row?.author as { kind?: string; id?: string } | undefined
    return row && row.conversationId === m.conversationId && by?.kind === 'person' && by.id ? by.id : null
  }
  const people = fanout ? new Map(fanout.state.people.map(p => [p.id, p])) : undefined
  const recipients = replies.map(m => {
    const starter = personOf(m, m.thread), quoted = personOf(m, m.replyTo)
    const group = fanout?.state.conversations.find(c => c.id === m.conversationId)
    const spread = fanout && group && !m.source ? threadPeople(fanout.threads.get(m.thread!), m.thread!) : { tagged: [], repliers: [] }
    const tagsHere = new Set(m.mentions ?? [])
    const told = replyAudience({ starter, quoted, ...spread }).filter(personId => {
      if (own(m.author, personId) || tagsHere.has(personId)) return false
      // A chat the command's state does not hold (a quiet one) tells the starter and the quoted author, as without `fanout`.
      if (!people || !group) return true
      const person = people.get(personId)
      return !!person && canReadGroup(fanout!.state, { kind: 'person', userId: person.id, email: person.email }, group)
    })
    return { message: m, people: told }
  })
  const markIds = [...new Set(recipients.flatMap(({ message, people }) => people.map(personId =>
    stableId(tabId, message.conversationId, message.thread!, personId))))]
  if (!markIds.length) return []
  const marks = await tx.superTabThreadMark.aggregateRaw({ pipeline: [
    { $match: { _id: { $in: markIds } } }, { $project: { _id: 1, follow: 1 } },
  ] }) as unknown as Array<{ _id: string; follow?: boolean | null }>
  const unfollowed = new Set(marks.filter(mark => mark.follow === false).map(mark => mark._id))
  // Muted chats: by the setting rows' ids, as the marks above (chatSettings.ts writeChatSetting names them).
  const settingIds = [...new Set(recipients.flatMap(({ message, people }) => people.map(personId => stableId(tabId, message.conversationId, personId, 'notify'))))]
  const settings = await tx.superTabChatSetting.aggregateRaw({ pipeline: [
    { $match: { _id: { $in: settingIds } } }, { $project: { _id: 1, notify: 1 } },
  ] }) as unknown as Array<{ _id: string; notify?: string }>
  const muted = new Set(settings.filter(row => row.notify === 'muted').map(row => row._id))
  const data = recipients.flatMap(({ message: m, people }) => {
    return people.filter(personId => !unfollowed.has(stableId(tabId, m.conversationId, m.thread!, personId))
      && !muted.has(stableId(tabId, m.conversationId, personId, 'notify'))).map(personId => ({ id: stableId(tabId, 'reply', m.id, personId), tabId, personId, kind: 'reply', conversationId: m.conversationId,
      messageId: m.id, threadId: m.thread!, actorKind: m.author.kind, actorId: m.author.id, emoji: null, createdAt: new Date(now), readAt: null,
      ...sequences.has(m.id) ? { sequence: sequences.get(m.id)! } : {}, ...m.alsoInChat ? { alsoInChat: true } : {} }))
  })
  if (data.length) await tx.superTabActivity.createMany({ data })
  return data
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
  // A plain `$match` through the unread index: `readAt: null` matches a row with no readAt too. Prisma's read sent an `$expr`
  // the index could bound only by person, and examined every row of theirs of 30 days (task #3146).
  const rows = await readBy(tx, 'SuperTabActivity', 'unread', [
    { $match: { tabId, personId, readAt: null, createdAt: { $gt: { $date: new Date(now - ACTIVITY_EXPIRY_MS).toISOString() } } } },
    { $sort: { createdAt: -1 } }, { $limit: ACTIVITY_DIGEST_ROWS }, { $project: { _id: 1 } }])
  return createHash('sha256').update(rows.map(r => r._id as string).sort().join('\n')).digest('base64url').slice(0, 16)
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
  const present = (kind: string, id: string) => kind === 'person' ? state.people.some(p => p.id === id) : state.agents.some(a => a.id === id)
  // A reaction by someone no longer here drops out, as its count does (reactions.ts reactionCounts).
  const kept = rows.slice(0, ACTIVITY_LIST).filter(r => r.kind !== 'reaction' || present(r.actorKind, r.actorId))
  if (!kept.length) return { items: [], more }
  const shown = await readableMessages(db, tabId, state, actor, kept)
  const items = kept.flatMap(r => {
    const seen = shown(r)
    // A reaction's message must still be theirs.
    if (!seen || (r.kind === 'reaction' && !own(seen.message.author, actor.userId))) return []
    const { group, message } = seen
    return [{ id: r.id, kind: r.kind as ActivityKind, conversationId: r.conversationId, conversationTitle: group.title,
      projectName: projectOf(state, group.projectId ?? 'lead').name, messageId: r.messageId, messageSequence: message.sequence,
      threadId: threadOf(message), actor: { kind: r.actorKind as 'person' | 'agent', id: r.actorId,
        name: actorName(state, r.actorKind, r.actorId, r.kind === 'reply' ? message.author : undefined) },
      emoji: r.emoji ?? null, text: message.text, createdAt: r.createdAt.toISOString(), read: !!r.readAt }]
  })
  return { items, more }
}

/** A row naming one message of one chat, as Activity's and reminders' (reminders.ts) do. */
export interface MessageRef { conversationId: string; messageId: string }

/** What the person reads now of the messages `rows` name (the file's comment): a lookup giving a row its chat and message, or
 *  null for a chat they cannot read (a quiet one is read by id, as tags read theirs, mentions.ts readable), a message a page
 *  would not show them, or one no longer in the chat the row names. The messages by id in one read. */
export async function readableMessages(db: PrismaClient, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>,
  rows: MessageRef[]): Promise<(row: MessageRef) => { group: Conversation; message: Row } | null> {
  const groups = new Map(state.conversations.map(c => [c.id, c]))
  const missing = [...new Set(rows.map(r => r.conversationId))].filter(id => !groups.has(id))
  if (missing.length) {
    // A quiet chat by id through its index (parts/indexed.ts).
    for (const row of await groupsBy(db, 'key', [{ $match: { tabId, deleted: false, key: { $in: missing } } }, { $project: { _id: 0, key: 1, data: 1 } }])) {
      groups.set(row.key as string, row.data as unknown as Conversation)
    }
  }
  const readableGroup = (id: string) => {
    const group = groups.get(id)
    return group && !isLeads(group) && canReadGroup(state, actor, group) ? group : null
  }
  const kept = rows.filter(r => readableGroup(r.conversationId))
  if (!kept.length) return () => null
  const found = (await readBy(db, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: [...new Set(kept.map(r => r.messageId))] }, tabId } },
    { $project: { ...FIELDS, conversationId: 1 } }])).map(messageRow)
  // As a page filters rows (read/inbox.ts readable), Buddy-session rows included: against the state with the quiet chats read
  // by id above, since a chat the state does not hold reads nothing.
  const held = new Set(state.conversations.map(c => c.id))
  const withQuiet: SuperTabState = { ...state, conversations: [...state.conversations, ...[...groups.values()].filter(g => !held.has(g.id))] }
  const messages = new Map((await readable(db, tabId, found, withQuiet)).map(m => [m.id, m]))
  return row => {
    const group = readableGroup(row.conversationId), message = messages.get(row.messageId)
    return group && message && message.conversationId === row.conversationId ? { group, message } : null
  }
}

/** A reply that lives only in its thread names its root; a top-level message or one also sent to the chat names none. */
export const threadOf = (m: Row) => m.thread && m.thread !== m.id && !m.alsoInChat ? m.thread : null

/** A person by the name the Swarm shows for them (personNames.ts); an agent by its name, or by `author`'s (the message it
 *  wrote) when it left. */
export function actorName(state: SuperTabState, kind: string, id: string, author?: Author): string {
  if (kind === 'person') return shownNameOf(state, id) ?? 'Someone'
  const agent = state.agents.find(a => a.id === id) as { displayName?: string | null; name?: string } | undefined
  const wrote = author as Author & { displayName?: string } | undefined
  return agent?.displayName ?? agent?.name ?? wrote?.displayName ?? wrote?.name ?? 'An agent'
}

/** Marks the person's rows made at or before `through` read, on every device. Only their own. */
export async function markActivityRead(db: PrismaClient, tabId: string, personId: string, through: number, now: number): Promise<number> {
  const moved = await db.superTabActivity.updateMany({ where: { tabId, personId, createdAt: { lte: new Date(through) }, ...unread },
    data: { readAt: new Date(now) } })
  return moved.count
}

/** Marks the person's unread reply rows of thread `threadId` read when their thread mark stands at `sequence`: those at or below it,
 *  in one update on every device. Only their own; a row without a sequence (written before they were kept) is not matched:
 *  `gt: 0` keeps it out, since Prisma's `lte` alone matches a null. */
export async function markActivityThreadRead(db: PrismaClient, read: { tabId: string; personId: string; conversationId: string; threadId: string
  sequence: number; now: number }): Promise<number> {
  const { tabId, personId, conversationId, threadId, sequence, now } = read
  const moved = await db.superTabActivity.updateMany({ where: { tabId, personId, conversationId, threadId, kind: 'reply', sequence: { gt: 0, lte: sequence }, ...unread },
    data: { readAt: new Date(now) } })
  return moved.count
}

/** Marks the person's unread reply rows of a chat read when their chat mark stands at `sequence`: those also shown in the chat at or
 *  below it. A reply only in its thread waits for its thread's mark, as the chat read leaves it unread (threadMarkSeeds.ts). */
export async function markActivityChatRead(db: PrismaClient, read: { tabId: string; personId: string; conversationId: string; sequence: number; now: number }):
  Promise<number> {
  const { tabId, personId, conversationId, sequence, now } = read
  const moved = await db.superTabActivity.updateMany({ where: { tabId, personId, conversationId, kind: 'reply', alsoInChat: true, sequence: { gt: 0, lte: sequence }, ...unread },
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
