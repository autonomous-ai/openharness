/**
 * A person's inbox in one Swarm (phone Home and Buddies): the threads with replies they have not read, and each chat's latest
 * message, in one read instead of a page of 100 messages per chat. The chats are exactly those the messages read gives this
 * person (projects.ts readConversation), among the Swarm's active, unarchived ones, and the rows are those a page shows a
 * person (store.ts messages): never an agent-only notice or a delivered copy of a Lead's notice.
 *
 * A thread is unread as Desktop marks it (desktop super_tabs/controller.dart threadUnread): the person started it, replied in
 * it or was tagged in it; its newest reply is someone else's; and it has replies by others after both the person's read mark
 * on the chat and their own newest reply there. A chat they never marked read counts as read, as Desktop opens it at its end.
 * A thread the person read on any device (their thread mark, readMarks.ts) counts only replies past that mark too.
 *
 * Cost: every message read is bounded by an index range and a limit: the newest UNREAD_SCAN rows past the mark in at most
 * THREAD_CHATS chats; the roots of the newest CANDIDATE_THREADS threads; MEMBER_SCAN rows before the mark of a thread whose
 * newer rows do not show the person in it; one row (LATEST_SCAN for an older chat) at each of LATEST_CHATS chats' newest main
 * message. Text is cut to PREVIEW_CHARS by the database. `more` says a cap was reached. The route allows a person
 * INBOX_READS per INBOX_WINDOW_MS in each Swarm, counted by every pod together.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { createRateLimiter } from '../../lib/rateLimit.js'
import { isTeamSession, TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE } from '../../lib/teamSession.js'
import { agentOnly, author, fail, SuperTabError, type Actor, type Author, type Conversation, type SuperTabState } from '../model.js'
import { readConversation } from '../projects.js'
import { deliveredCopies, type ThreadReply } from '../pageReads.js'
import { threadSummaries } from '../threads.js'
import { sessionReadsRow } from '../buddySessions.js'
import { readMarks, readThreadMarks } from '../readMarks.js'
import { readBy } from '../parts/indexed.js'
import { ms } from '../parts/light.js'
import type { SuperTabStore } from '../store.js'

/** Rows past the read mark read per chat: the newest ones, so the latest replies are always counted. */
export const UNREAD_SCAN = 100
/** Chats whose unread rows are read, those active most recently first. */
export const THREAD_CHATS = 30
/** Threads answered, newest reply first. */
export const MAX_THREADS = 50
/** Threads with unread replies whose roots are read, newest reply first: room for those the person turns out not to be in. */
export const CANDIDATE_THREADS = 2 * MAX_THREADS
/** Rows before the read mark read per thread, newest first, to learn whether the person wrote or was tagged there. */
export const MEMBER_SCAN = 100
/** Chats whose latest message is answered, those active most recently first. */
export const LATEST_CHATS = 100
/** Rows read back from an older chat's newest message for its newest main one: a chat written before the server kept its
 *  main stream's newest number (lastMainSequence), or one where an older backend stored a hidden copy there. */
export const LATEST_SCAN = 50
/** A preview's text, in characters. */
export const PREVIEW_CHARS = 280
/** Inbox reads a person may make in one Swarm per window: about one a second. */
export const INBOX_READS = 10
export const INBOX_WINDOW_MS = 10_000

export interface InboxMessage { id: string; sequence: number; author: Author; text: string; createdAt: string; attachments: number }
export interface InboxThread {
  conversationId: string
  rootId: string
  root: InboxMessage
  lastReplyAt: string
  lastReplySequence: number
  /** The newest reply's author who can still read the chat, as thread summaries name them; null when none can. */
  lastReplier: Author | null
  /** Replies by anyone else after the person's read mark and their own newest reply in the thread. */
  unreadReplies: number
}
export interface InboxLatest { conversationId: string; message: InboxMessage }
export interface Inbox { threads: InboxThread[]; latest: InboxLatest[]; more: boolean }

interface Row { id: string; conversationId: string; sequence: number; author: Author; text: string; createdAt: Date; attachments: number; thread: string | null
  alsoInChat: boolean; mentions: string[]; source: unknown; recipientIds: string[]; buddyProject: string | null }

/** A preview's fields, its text cut by the database so a long message never leaves it whole. */
const FIELDS = { sequence: 1, author: 1, text: { $substrCP: [{ $ifNull: ['$text', ''] }, 0, PREVIEW_CHARS] }, createdAt: 1, attachments: { $size: { $ifNull: ['$attachments', []] } },
  thread: 1, alsoInChat: 1, mentions: 1, source: 1, recipientIds: 1, buddyProject: 1 }
/** A scan for unread replies: what a reply is counted, named and placed by, never its text. */
const SCAN_FIELDS = { sequence: 1, author: 1, createdAt: 1, thread: 1, mentions: 1, source: 1, recipientIds: 1, buddyProject: 1 }
const row = (raw: Record<string, unknown>): Row => ({ id: raw._id as string, conversationId: raw.conversationId as string, sequence: raw.sequence as number, author: raw.author as Author,
  text: (raw.text ?? '') as string, createdAt: new Date(ms(raw.createdAt)), attachments: typeof raw.attachments === 'number' ? raw.attachments : 0,
  thread: (raw.thread ?? null) as string | null, alsoInChat: raw.alsoInChat === true, mentions: (raw.mentions ?? []) as string[], source: raw.source ?? null,
  recipientIds: (raw.recipientIds ?? []) as string[], buddyProject: typeof raw.buddyProject === 'string' ? raw.buddyProject : null })
const preview = (m: Row): InboxMessage => ({ id: m.id, sequence: m.sequence, author: m.author, text: m.text,
  createdAt: m.createdAt.toISOString(), attachments: m.attachments })
/** A thread reply: in a thread whose root is another row. */
const isReply = (m: Row) => !!m.thread && m.thread !== m.id
/** A row of the chat's main stream (parts/commit.ts numberMessages): a top-level message, or a reply also sent to the chat. */
const isMain = (m: Row) => !isReply(m) || m.alsoInChat
const threadKey = (conversationId: string, root: string) => `${conversationId}\u0000${root}`
const newestFirst = (a: { at: number; id: string }, b: { at: number; id: string }) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const activity = (g: Conversation) => Date.parse(g.lastActivityAt ?? '') || 0
/** `rows` by `key`, each list in the rows' order. */
function groupBy(rows: Row[], key: (m: Row) => string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>()
  for (const m of rows) {
    const group = groups.get(key(m))
    if (group) group.push(m)
    else groups.set(key(m), [m])
  }
  return groups
}

/** The rows of `rows` a person reads, as a page filters them for a person (store.ts messages, readsRow): no agent-only notice,
 *  no row of a project they no longer read in their one Buddy chat (buddySessions.ts sessionReadsRow: its PM's lines and its
 *  sessions' threads; security review 1 of #2435, a lost private project's PM line showed as the chat's preview), and no task
 *  chat copy of a Lead's notice that reached the Lead (pageReads.ts deliveredCopies). */
async function readable(db: PrismaClient, tabId: string, rows: Row[], state: SuperTabState): Promise<Row[]> {
  const checks = new Map<string, (row: Row) => boolean>()
  const sessionRead = (m: Row) => {
    let check = checks.get(m.conversationId)
    if (!check) {
      const group = state.conversations.find(g => g.id === m.conversationId)
      // A chat this read does not hold reads nothing: the rows come from the chats it chose.
      check = group ? sessionReadsRow(undefined, group, state) : () => false
      checks.set(m.conversationId, check)
    }
    return check(m)
  }
  const shown = rows.filter(m => !agentOnly(m.source, m.recipientIds) && sessionRead(m))
  const copies = shown.length ? await deliveredCopies(db, tabId, shown) : new Set<string>()
  return shown.filter(m => !copies.has(m.id))
}

/** Whether the messages read lets `actor` read `group`: the same check. Only its "unavailable" or "removed" answer (an older
 *  Swarm's stored Leads conversation, model.ts leadsRemoved) means this chat is not theirs; any other refusal (no longer a
 *  member) refuses the whole read, as it refuses every chat's page. */
function readsChat(state: SuperTabState, actor: Actor, group: Conversation): boolean {
  try {
    readConversation(state, actor, group.id)
    return true
  } catch (error) {
    if (error instanceof SuperTabError && (error.code === 'NOT_FOUND' || error.code === 'LEADS_CONVERSATION_REMOVED')) return false
    throw error
  }
}

/** Ranges one read covers: each is a few stages of its pipeline, well under Mongo's limit on stages. */
export const CHATS_PER_READ = 100

/** Runs each range's own pipeline inside one aggregate per CHATS_PER_READ ranges ($unionWith), so the reads stay few whatever
 *  the chat count, and each range's rows are still bounded by its own index range and limit: one $in over every chat could not
 *  bound each by its own read mark, and would walk a busy chat's history for a chat never opened. */
async function perRange(db: PrismaClient, pipelines: Prisma.InputJsonValue[][]): Promise<Row[]> {
  const rows: Row[] = []
  for (let i = 0; i < pipelines.length; i += CHATS_PER_READ) {
    const [first, ...rest] = pipelines.slice(i, i + CHATS_PER_READ)
    const raw = await db.superTabMessage.aggregateRaw({ pipeline: [...first!,
      ...rest.map(pipeline => ({ $unionWith: { coll: 'SuperTabMessage', pipeline } }))] }) as unknown as Array<Record<string, unknown>>
    rows.push(...raw.map(row))
  }
  return rows
}

/** Up to `limit` rows of one chat, newest first, in its (sequence, id) index range. */
const newestIn = (tabId: string, conversationId: string, sequence: Record<string, number>, limit: number, fields: Record<string, unknown>): Prisma.InputJsonValue[] =>
  [{ $match: { tabId, conversationId, sequence } }, { $sort: { sequence: -1, _id: -1 } }, { $limit: limit }, { $project: { ...fields, conversationId: 1 } }] as Prisma.InputJsonValue[]

/** Each chat's newest main message the person reads: the row at its stored main sequence, read alone; the LATEST_SCAN rows
 *  before it only for a chat where that row is not one (an older chat's newest row may be a thread reply or a hidden copy).
 *  `more` when such a chat has none in that range. */
async function latestIn(db: PrismaClient, tabId: string, state: SuperTabState, chats: Conversation[]): Promise<{ latest: Map<string, Row>; more: boolean }> {
  const tops = chats.flatMap(g => { const top = g.lastMainSequence ?? g.lastMessageSequence; return top ? [{ id: g.id, top }] : [] })
  const pick = async (rows: Row[]) => {
    const shown = (await readable(db, tabId, rows, state)).filter(isMain)
    const newest = new Map<string, Row>()
    for (const m of shown) if (!newest.has(m.conversationId)) newest.set(m.conversationId, m)
    return newest
  }
  const read = (of: typeof tops, limit: number) => perRange(db, of.map(c => newestIn(tabId, c.id, { $lte: c.top }, limit, FIELDS)))
  const latest = await pick(await read(tops, 1))
  const missing = tops.filter(c => !latest.has(c.id))
  if (!missing.length) return { latest, more: false }
  const deeper = await read(missing, LATEST_SCAN)
  for (const [id, m] of await pick(deeper)) latest.set(id, m)
  // A chat with LATEST_SCAN rows and none of them a main row the person reads may have one further back.
  const full = new Set([...groupBy(deeper, m => m.conversationId)].filter(([, rows]) => rows.length >= LATEST_SCAN).map(([id]) => id))
  return { latest, more: missing.some(c => !latest.has(c.id) && full.has(c.id)) }
}

interface Candidate { conversationId: string; root: string; mark: number; replies: Row[]; unread: number; member: boolean; at: number; id: string }

/** The threads of `chats` the person has unread replies in (see the file's comment), from each chat's newest UNREAD_SCAN rows
 *  past their mark. */
async function threadsIn(db: PrismaClient, tabId: string, state: SuperTabState, chats: Conversation[], personId: string, marks: Map<string, number>,
  threadMarks: Map<string, Map<string, number>>): Promise<{ threads: InboxThread[]; more: boolean }> {
  if (!chats.length) return { threads: [], more: false }
  const own = (a: Pick<Author, 'kind' | 'id'>) => a.kind === 'person' && a.id === personId
  const inIt = (m: Row) => own(m.author) || m.mentions.includes(personId)
  const scanned = await perRange(db, chats.map(g => newestIn(tabId, g.id, { $gt: marks.get(g.id)! }, UNREAD_SCAN + 1, SCAN_FIELDS)))
  const byChat = groupBy(scanned, m => m.conversationId)
  // A chat whose newest UNREAD_SCAN rows do not reach its mark: older unread replies are not counted.
  let more = [...byChat.values()].some(rows => rows.length > UNREAD_SCAN)
  const replies = await readable(db, tabId, [...byChat.values()].flatMap(rows => rows.slice(0, UNREAD_SCAN)).filter(isReply), state)
  // Newest first within each thread, as the scan reads them.
  const byThread = groupBy(replies, m => threadKey(m.conversationId, m.thread!))
  const candidates: Candidate[] = []
  for (const rows of byThread.values()) {
    const newest = rows[0]!
    // The person answered last: nothing in it waits for them.
    if (own(newest.author)) continue
    // Read through the later of their own newest reply and their mark of this thread from any device.
    const seen = Math.max(rows.find(m => own(m.author))?.sequence ?? 0, threadMarks.get(newest.conversationId)?.get(newest.thread!) ?? 0)
    const unread = rows.filter(m => !own(m.author) && m.sequence > seen).length
    if (!unread) continue
    candidates.push({ conversationId: newest.conversationId, root: newest.thread!, mark: marks.get(newest.conversationId)!, replies: rows, unread,
      member: rows.some(inIt), at: newest.createdAt.getTime(), id: newest.id })
  }
  candidates.sort(newestFirst)
  if (candidates.length > CANDIDATE_THREADS) more = true
  const picked = candidates.slice(0, CANDIDATE_THREADS)
  if (!picked.length) return { threads: [], more }
  // Every root by its id, in one read: one the person cannot read hides its thread, as on a page (review 2 of #2168), and a
  // root counts only in the chat its replies are in.
  const found = (await readBy(db, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: picked.map(c => c.root) }, tabId } }, { $project: { ...FIELDS, conversationId: 1 } }])).map(row)
  const roots = new Map((await readable(db, tabId, found.filter(m => !isReply(m)), state)).map(m => [threadKey(m.conversationId, m.id), m]))
  const withRoot = picked.filter(c => roots.has(threadKey(c.conversationId, c.root)))
  for (const c of withRoot) if (inIt(roots.get(threadKey(c.conversationId, c.root))!)) c.member = true
  // The rest: did the person write or get tagged before their mark? Each thread's newest MEMBER_SCAN rows there, by its thread
  // index range; only the rows that name them come back.
  const unknown = withRoot.filter(c => !c.member)
  if (unknown.length) {
    const named = await perRange(db, unknown.map(c => [{ $match: { tabId, conversationId: c.conversationId, thread: c.root, sequence: { $lte: c.mark } } },
      { $sort: { sequence: -1 } }, { $limit: MEMBER_SCAN },
      { $match: { $or: [{ 'author.kind': 'person', 'author.id': personId }, { mentions: personId }] } }, { $project: { ...SCAN_FIELDS, conversationId: 1 } }]))
    const members = new Set((await readable(db, tabId, named, state)).map(m => threadKey(m.conversationId, m.thread!)))
    for (const c of unknown) if (members.has(threadKey(c.conversationId, c.root))) c.member = true
  }
  const groups = new Map(chats.map(g => [g.id, g]))
  const threads = withRoot.filter(c => c.member).flatMap(c => {
    const root = roots.get(threadKey(c.conversationId, c.root))!, group = groups.get(c.conversationId)!
    // Named as a page's thread summary names them: only authors who can still read the chat (threads.ts).
    const rows: ThreadReply[] = [root, ...c.replies.toReversed()].map(m => ({ thread: c.root, id: m.id, author: m.author, mentions: m.mentions,
      sequence: m.sequence, createdAt: m.createdAt, agentOnly: false, routing: false }))
    const [summary] = threadSummaries(state, group, rows)
    if (!summary) return []
    return [{ conversationId: group.id, rootId: root.id, root: preview(root), lastReplyAt: summary.lastAt.toISOString(),
      lastReplySequence: summary.lastSequence, lastReplier: summary.authors[0] ?? null, unreadReplies: c.unread }]
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
  const chats = state.conversations.filter(g => !g.dormant && readsChat(state, actor, g)).filter(g => !g.archived)
    .sort((a, b) => newestFirst({ at: activity(a), id: a.id }, { at: activity(b), id: b.id }))
  const marks = await readMarks(db, tabId, user.sub)
  // A chat never marked read counts as read: its threads wait for the person's first visit.
  const unread = chats.filter(g => { const mark = marks.get(g.id) ?? 0; return mark > 0 && g.lastMessageSequence > mark })
  const shown = chats.slice(0, LATEST_CHATS)
  // The person's thread marks: one indexed read (readMarks.ts), beside the latest messages'.
  const [latest, threaded] = await Promise.all([latestIn(db, tabId, state, shown),
    readThreadMarks(db, tabId, user.sub).then(threadMarks => threadsIn(db, tabId, state, unread.slice(0, THREAD_CHATS), user.sub, marks, threadMarks))])
  const threads = threaded.threads.sort((a, b) => newestFirst({ at: Date.parse(a.lastReplyAt), id: a.rootId }, { at: Date.parse(b.lastReplyAt), id: b.rootId }))
  const more = chats.length > LATEST_CHATS || latest.more || unread.length > THREAD_CHATS || threaded.more || threads.length > MAX_THREADS
  return { threads: threads.slice(0, MAX_THREADS), more,
    latest: shown.flatMap(g => { const m = latest.latest.get(g.id); return m ? [{ conversationId: g.id, message: preview(m) }] : [] }) }
}

const inboxReads = createRateLimiter('swarm-inbox', INBOX_WINDOW_MS, INBOX_READS)

/** Seconds a person must wait before reading this Swarm's inbox again, or 0 when they may now. Apps read it when the change
 *  feed moves, which in a busy Swarm is several times a second; this keeps one person's reads to about one a second. */
export async function inboxWait(user: AuthUser, tabId: string, now = Date.now()): Promise<number> {
  if (await inboxReads.allows(`${user.sub}:${tabId}`, now)) return 0
  return Math.max(1, Math.ceil((INBOX_WINDOW_MS - now % INBOX_WINDOW_MS) / 1000))
}
/** Test seam: forget this process's counts. */
export const resetInboxReads = () => inboxReads.reset()
