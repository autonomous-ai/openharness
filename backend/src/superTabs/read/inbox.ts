/**
 * A person's inbox in one Swarm (phone Home and Buddies): the threads with replies past their read mark, and each chat's
 * latest message, in one read instead of a page of 100 messages per chat. The chats are exactly those the messages read
 * gives this person (projects.ts readConversation), among the Swarm's active ones, and the rows are those a page shows a
 * person (store.ts messages): never an agent-only notice or a delivered copy of a Lead's notice.
 *
 * Cost: every message read is bounded by the tabId+conversationId+sequence index or the id index, and capped: the newest
 * UNREAD_SCAN rows past the mark in at most THREAD_CHATS chats, LATEST_SCAN rows per chat at its newest main message, and
 * the roots those replies name. `more` says a cap was reached. Apps call it when the change feed moves, never on a timer.
 */
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { isTeamSession, TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE } from '../../lib/teamSession.js'
import { agentOnly, author, fail, SuperTabError, type Actor, type Author, type Conversation, type SuperTabState } from '../model.js'
import { canReadGroup, readConversation } from '../projects.js'
import { deliveredCopies, type ThreadReply } from '../pageReads.js'
import { threadSummaries } from '../threads.js'
import { readMarks } from '../readMarks.js'
import { readBy } from '../parts/indexed.js'
import { ms } from '../parts/light.js'
import type { SuperTabStore } from '../store.js'

/** Rows past the read mark read per chat: the newest ones, so the latest replies are always counted. */
export const UNREAD_SCAN = 100
/** Chats whose unread rows are read, those active most recently first. */
export const THREAD_CHATS = 30
/** Threads answered, newest reply first. */
export const MAX_THREADS = 50
/** Rows read back from a chat's newest main message: it is that row unless an older backend stored a hidden copy there. */
export const LATEST_SCAN = 5
/** A preview's text, in characters. */
export const PREVIEW_CHARS = 280

export interface InboxMessage { id: string; sequence: number; author: Author; text: string; createdAt: string; attachments: number }
export interface InboxThread {
  conversationId: string
  rootId: string
  root: InboxMessage
  lastReplyAt: string
  lastReplySequence: number
  /** The newest reply's author who can still read the chat, as thread summaries name them; null when none can. */
  lastReplier: Author | null
  /** Replies past the person's read mark by anyone else. */
  unreadReplies: number
}
export interface InboxLatest { conversationId: string; message: InboxMessage }
export interface Inbox { threads: InboxThread[]; latest: InboxLatest[]; more: boolean }

interface Row { id: string; sequence: number; author: Author; text: string; createdAt: Date; attachments: number; thread: string | null
  alsoInChat: boolean; source: unknown; recipientIds: string[] }

const FIELDS = { sequence: 1, author: 1, text: 1, createdAt: 1, attachments: 1, thread: 1, alsoInChat: 1, source: 1, recipientIds: 1 }
/** A scan for unread replies: what a reply is counted and named by, never its text. */
const SCAN_FIELDS = { sequence: 1, author: 1, createdAt: 1, thread: 1, source: 1, recipientIds: 1 }
const row = (raw: Record<string, unknown>): Row => ({ id: raw._id as string, sequence: raw.sequence as number, author: raw.author as Author,
  text: (raw.text ?? '') as string, createdAt: new Date(ms(raw.createdAt)), attachments: Array.isArray(raw.attachments) ? raw.attachments.length : 0,
  thread: (raw.thread ?? null) as string | null, alsoInChat: raw.alsoInChat === true, source: raw.source ?? null, recipientIds: (raw.recipientIds ?? []) as string[] })
const preview = (m: Row): InboxMessage => ({ id: m.id, sequence: m.sequence, author: m.author, text: [...m.text].slice(0, PREVIEW_CHARS).join(''),
  createdAt: m.createdAt.toISOString(), attachments: m.attachments })
/** A thread reply: in a thread whose root is another row. */
const isReply = (m: Row) => !!m.thread && m.thread !== m.id
/** A row of the chat's main stream (parts/commit.ts numberMessages): a top-level message, or a reply also sent to the chat. */
const isMain = (m: Row) => !isReply(m) || m.alsoInChat

/** The rows of `rows` a person reads, as a page filters them for a person (store.ts messages, readsRow): no agent-only notice,
 *  and no task chat copy of a Lead's notice that reached the Lead (pageReads.ts deliveredCopies). */
async function readable(db: PrismaClient, tabId: string, rows: Row[]): Promise<Row[]> {
  const shown = rows.filter(m => !agentOnly(m.source, m.recipientIds))
  const copies = shown.length ? await deliveredCopies(db, tabId, shown) : new Set<string>()
  return shown.filter(m => !copies.has(m.id))
}

/** Whether the messages read lets `actor` read `group`: the same check. Only its "unavailable" answer means this chat is not
 *  theirs; any other refusal (no longer a member) refuses the whole read, as it refuses every chat's page. */
function readsChat(state: SuperTabState, actor: Actor, group: Conversation): boolean {
  try {
    readConversation(state, actor, group.id)
    return true
  } catch (error) {
    if (error instanceof SuperTabError && error.code === 'NOT_FOUND') return false
    throw error
  }
}

/** The chat's newest main message the person reads: the row at its stored main sequence, read alone first; the few rows
 *  before it only when an older backend stored a hidden copy there. */
async function latestIn(db: PrismaClient, tabId: string, group: Conversation): Promise<InboxLatest | null> {
  const top = group.lastMainSequence ?? group.lastMessageSequence
  if (!top) return null
  const read = async (limit: number) => (await readBy(db, 'SuperTabMessage', 'sequence', [{ $match: { tabId, conversationId: group.id, sequence: { $lte: top } } },
    { $sort: { sequence: -1, _id: -1 } }, { $limit: limit }, { $project: FIELDS }])).map(row)
  const newest = (await readable(db, tabId, await read(1))).find(isMain) ?? (await readable(db, tabId, await read(LATEST_SCAN))).find(isMain)
  return newest ? { conversationId: group.id, message: preview(newest) } : null
}

/** The threads of one chat with replies past `mark` by someone other than `personId`, from its newest UNREAD_SCAN rows. */
async function threadsIn(db: PrismaClient, tabId: string, state: SuperTabState, group: Conversation, personId: string, mark: number):
  Promise<{ threads: InboxThread[]; more: boolean }> {
  const scanned = (await readBy(db, 'SuperTabMessage', 'sequence', [{ $match: { tabId, conversationId: group.id, sequence: { $gt: mark } } },
    { $sort: { sequence: -1, _id: -1 } }, { $limit: UNREAD_SCAN + 1 }, { $project: SCAN_FIELDS }])).map(row)
  const more = scanned.length > UNREAD_SCAN
  const replies = (await readable(db, tabId, scanned.slice(0, UNREAD_SCAN).filter(isReply)))
  const own = (m: Row) => m.author.kind === 'person' && m.author.id === personId
  const rootIds = [...new Set(replies.filter(m => !own(m)).map(m => m.thread!))]
  if (!rootIds.length) return { threads: [], more }
  // Each root by its id, in this chat: one the person cannot read hides its thread, as on a page (review 2 of #2168).
  const roots = await readable(db, tabId, (await readBy(db, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: rootIds }, tabId, conversationId: group.id } },
    { $project: FIELDS }])).map(row).filter(m => !isReply(m)))
  const threads = roots.flatMap(root => {
    const inThread = replies.filter(m => m.thread === root.id)
    // Named as a page's thread summary names them: only authors who can still read the chat (threads.ts).
    const rows: ThreadReply[] = [root, ...inThread.toReversed()].map(m => ({ thread: root.id, id: m.id, author: m.author, mentions: [],
      sequence: m.sequence, createdAt: m.createdAt, agentOnly: false, routing: false }))
    const [summary] = threadSummaries(state, group, rows)
    if (!summary) return []
    return [{ conversationId: group.id, rootId: root.id, root: preview(root), lastReplyAt: summary.lastAt.toISOString(),
      lastReplySequence: summary.lastSequence, lastReplier: summary.authors[0] ?? null, unreadReplies: inThread.filter(m => !own(m)).length }]
  })
  return { threads, more }
}

/** The inbox of the signed-in person: never an agent's (they have no read marks) or a Team session's (marks are the person's). */
export async function readInbox(store: SuperTabStore, user: AuthUser, tabId: string): Promise<Inbox> {
  if (isTeamSession(user)) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
  const db = store.db
  const { state } = await store.readLoad(user, tabId)
  const actor = await store.actor(db, user, state)
  // A person no longer in the Swarm is refused here, as the messages read refuses them, before any chat is looked at.
  author(state, actor)
  const chats = state.conversations.filter(g => !g.dormant && readsChat(state, actor, g))
  const marks = await readMarks(db, tabId, user.sub)
  const unread = chats.filter(g => g.lastMessageSequence > (marks.get(g.id) ?? 0))
    .sort((a, b) => Date.parse(b.lastActivityAt ?? '') - Date.parse(a.lastActivityAt ?? '') || (a.id < b.id ? -1 : 1))
  const [latest, threaded] = await Promise.all([
    Promise.all(chats.map(g => latestIn(db, tabId, g))),
    Promise.all(unread.slice(0, THREAD_CHATS).map(g => threadsIn(db, tabId, state, g, user.sub, marks.get(g.id) ?? 0))),
  ])
  const threads = threaded.flatMap(t => t.threads)
    .sort((a, b) => Date.parse(b.lastReplyAt) - Date.parse(a.lastReplyAt) || (a.rootId < b.rootId ? -1 : 1))
  const more = unread.length > THREAD_CHATS || threaded.some(t => t.more) || threads.length > MAX_THREADS
  return { threads: threads.slice(0, MAX_THREADS), latest: latest.filter(l => l !== null), more }
}
