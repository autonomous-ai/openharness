/**
 * A person's inbox in one Swarm (phone Home and Buddies): the threads with replies they have not read, and each chat's latest
 * message, in one read instead of a page of 100 messages per chat. The chats are exactly those the messages read gives this
 * person (projects.ts readConversation), among the Swarm's active, unarchived ones, and the rows are those a page shows a
 * person (store.ts messages): never an agent-only notice or a delivered copy of a Lead's notice.
 *
 * A thread is unread as Desktop marks it (desktop super_tabs/controller.dart threadUnread): the person started it, replied in
 * it or was tagged in it; its newest reply is someone else's; and it has replies by others after both the person's read mark
 * on the chat and their own newest reply there. A chat they never marked read counts as read, as Desktop opens it at its end.
 * A thread the person read on any device (their thread mark, readMarks.ts) counts only replies past that mark too, and only that
 * mark when it is behind the chat's: reading the chat's main stream never reads a reply only in a thread (behindMarks). Their own
 * choice on that row overrides being in it: a thread they unfollowed is never listed, one they follow is as if they were in it.
 *
 * Cost: every message read is bounded by an index range and a limit: the newest UNREAD_SCAN rows past the mark in at most
 * THREAD_CHATS chats; the newest UNREAD_SCAN rows past their own mark in at most BEHIND_THREADS threads; the roots of the
 * newest CANDIDATE_THREADS threads; the summaries of the threads whose newer rows do not show the person in it, by root id in
 * one read (namedInThreads; a Swarm Buddy chat's, or any before the Swarm's backfill, MEMBER_SCAN rows before the mark each);
 * one row (LATEST_SCAN for an older chat) at each of LATEST_CHATS chats' newest main message. Text is cut to PREVIEW_CHARS by
 * the database. `more` says a cap was reached. The route allows a person INBOX_READS per INBOX_WINDOW_MS in each Swarm,
 * counted by every pod together.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { createRateLimiter } from '../../lib/rateLimit.js'
import { isTeamSession, TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE } from '../../lib/teamSession.js'
import { agentOnly, author, fail, SuperTabError, type Actor, type Author, type Conversation, type SuperTabState } from '../model.js'
import { readConversation } from '../projects.js'
import { deliveredCopies, threadsBackfilled, threadsNaming, type ThreadReply } from '../pageReads.js'
import { isSwarmBuddyChat } from '../buddies.js'
import { threadSummaries } from '../threads.js'
import { sessionReadsRow } from '../buddySessions.js'
import { readMarks, readThreadMarkRows, type ThreadMarkRow } from '../readMarks.js'
import { voiceLabel } from '../voiceMessages.js'
import { READ_BATCH, readBy } from '../parts/indexed.js'
import { logger } from '../../utils/logger.js'
import { ms } from '../parts/light.js'
import type { SuperTabStore } from '../store.js'
import { chatTop, chatVersion, rangeCache, rangeKey } from './rangeCache.js'

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

export interface Row { id: string; conversationId: string; sequence: number; author: Author; text: string; createdAt: Date; attachments: number; thread: string | null
  alsoInChat: boolean; mentions: string[]; source: unknown; recipientIds: string[]; buddyProject: string | null }

/** A preview's fields, its text cut by the database so a long message never leaves it whole. */
export const FIELDS = { sequence: 1, author: 1, text: { $substrCP: [{ $ifNull: ['$text', ''] }, 0, PREVIEW_CHARS] }, createdAt: 1, attachments: { $size: { $ifNull: ['$attachments', []] } },
  // A voice message's length: its preview names it rather than quoting its words (voiceMessages.ts voiceLabel).
  voiceMs: { $arrayElemAt: [{ $ifNull: ['$attachments.voice.durationMs', []] }, 0] },
  thread: 1, alsoInChat: 1, mentions: 1, source: 1, recipientIds: 1, buddyProject: 1 }
/** A scan for unread replies: what a reply is counted, named and placed by, never its text. */
export const SCAN_FIELDS = { sequence: 1, author: 1, createdAt: 1, thread: 1, mentions: 1, source: 1, recipientIds: 1, buddyProject: 1 }
export const row = (raw: Record<string, unknown>): Row => ({ id: raw._id as string, conversationId: raw.conversationId as string, sequence: raw.sequence as number, author: raw.author as Author,
  text: typeof raw.voiceMs === 'number' ? voiceLabel(raw.voiceMs) : (raw.text ?? '') as string, createdAt: new Date(ms(raw.createdAt)), attachments: typeof raw.attachments === 'number' ? raw.attachments : 0,
  thread: (raw.thread ?? null) as string | null, alsoInChat: raw.alsoInChat === true, mentions: (raw.mentions ?? []) as string[], source: raw.source ?? null,
  recipientIds: (raw.recipientIds ?? []) as string[], buddyProject: typeof raw.buddyProject === 'string' ? raw.buddyProject : null })
export const preview = (m: Row): InboxMessage => ({ id: m.id, sequence: m.sequence, author: m.author, text: m.text,
  createdAt: m.createdAt.toISOString(), attachments: m.attachments })
/** A thread reply: in a thread whose root is another row. */
export const isReply = (m: Row) => !!m.thread && m.thread !== m.id
/** A row of the chat's main stream (parts/commit.ts numberMessages): a top-level message, or a reply also sent to the chat. */
const isMain = (m: Row) => !isReply(m) || m.alsoInChat
export const threadKey = (conversationId: string, root: string) => `${conversationId}\u0000${root}`
export const newestFirst = (a: { at: number; id: string }, b: { at: number; id: string }) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const activity = (g: Conversation) => Date.parse(g.lastActivityAt ?? '') || 0
/** `rows` by `key`, each list in the rows' order. */
export function groupBy(rows: Row[], key: (m: Row) => string): Map<string, Row[]> {
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
export async function readable(db: PrismaClient, tabId: string, rows: Row[], state: SuperTabState): Promise<Row[]> {
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
export async function perRange(db: PrismaClient, pipelines: Prisma.InputJsonValue[][]): Promise<Row[]> {
  const rows: Row[] = []
  for (let i = 0; i < pipelines.length; i += CHATS_PER_READ) {
    const [first, ...rest] = pipelines.slice(i, i + CHATS_PER_READ)
    // Every row in the first reply (READ_BATCH, as readBy asks): Mongo's default first batch of 101 left the rest of 30 chats'
    // scans to a getMore, 32% of the slow message ops in Ken's log of 11-04 (~419 rows each).
    const raw = await db.superTabMessage.aggregateRaw({ pipeline: [...first!,
      ...rest.map(pipeline => ({ $unionWith: { coll: 'SuperTabMessage', pipeline } }))], options: { batchSize: READ_BATCH } }) as unknown as Array<Record<string, unknown>>
    rows.push(...raw.map(row))
  }
  return rows
}

/** One thread's rows in a sequence range. With `version` (its chat's chatVersion) and bounds no new row can enter (at most
 *  the chat's chatTop), its rows are kept and a re-read of it reads nothing (rangeCache.ts). */
export interface ThreadRange { conversationId: string; thread: string; sequence: Record<string, number>; version?: number }

/** The ranges this process kept (rangeCache.ts): chats' scans and previews, and threads' ranges. */
const kept = rangeCache<Row>()

/** Each chat's `limit` newest rows in its range, newest first, chat by chat, as perRange of each chat's newestIn answers: a range
 *  kept since its chat last changed is not read again, and only the others are, in one perRange. `fields` names the projection
 *  in the key. Each range must be bounded by its chat's chatTop. */
async function chatRanges(db: PrismaClient, tabId: string, of: ReadonlyArray<{ group: Conversation; sequence: Record<string, number> }>,
  limit: number, fields: 'scan' | 'preview'): Promise<Row[]> {
  const keyed = of.map(c => ({ ...c, key: rangeKey(tabId, c.group.id, null, c.sequence, limit, chatVersion(c.group), fields) }))
  const held = new Map<string, Row[]>()
  const misses = keyed.filter(c => {
    const rows = kept.get(c.key)
    if (rows) held.set(c.key, rows)
    return !rows
  })
  if (misses.length) {
    const read = groupBy(await perRange(db, misses.map(c => newestIn(tabId, c.group.id, c.sequence, limit, fields === 'scan' ? SCAN_FIELDS : FIELDS))),
      m => m.conversationId)
    for (const c of misses) {
      const rows = read.get(c.group.id) ?? []
      kept.set(c.key, rows)
      held.set(c.key, rows)
    }
  }
  return keyed.flatMap(c => held.get(c.key)!)
}

/**
 * Each range's newest `limit` rows, newest first, range by range, as `perRange` of each thread's own pipeline answers, or only those
 * of them `namedBy` wrote or is tagged in. Ken's production profile (task #2148): a union plans every branch, racing the sequence
 * index against the thread index, and a hint reaches only its first pipeline. So each batch is one read, hinted to the thread index:
 * nothing to race and one plan, about 200 ms of planning down to 3 for 100 ranges. It reads every row of a range, not only its newest,
 * so past a cap of a quarter of what the ranges' limits allow, a batch of long threads takes the union instead, which bounds each one.
 */
export async function newestInThreads(db: PrismaClient, tabId: string, ranges: ThreadRange[], limit: number, namedBy?: string): Promise<Row[]> {
  // A range kept since its chat last changed is not read again (rangeCache.ts); only the others go to the database.
  const keyOf = (r: ThreadRange) => r.version === undefined ? undefined : rangeKey(tabId, r.conversationId, r.thread, r.sequence, limit, r.version, 'scan', namedBy)
  const held = new Map<ThreadRange, Row[]>()
  const misses = ranges.filter(r => {
    const key = keyOf(r), rows = key === undefined ? undefined : kept.get(key)
    if (rows) held.set(r, rows)
    return !rows
  })
  const read = misses.length ? await readThreadRanges(db, tabId, misses, limit, namedBy) : new Map<string, Row[]>()
  for (const r of misses) {
    const rows = read.get(threadKey(r.conversationId, r.thread)) ?? [], key = keyOf(r)
    if (key !== undefined) kept.set(key, rows)
    held.set(r, rows)
  }
  return ranges.flatMap(r => held.get(r)!)
}

/** newestInThreads' reads, each thread's rows by threadKey. */
async function readThreadRanges(db: PrismaClient, tabId: string, ranges: ThreadRange[], limit: number, namedBy?: string): Promise<Map<string, Row[]>> {
  const rows = new Map<string, Row[]>()
  const named = namedBy === undefined ? [] : [{ $match: { $or: [{ 'author.kind': 'person', 'author.id': namedBy }, { mentions: namedBy }] } }]
  for (let i = 0; i < ranges.length; i += CHATS_PER_READ) {
    const batch = ranges.slice(i, i + CHATS_PER_READ)
    const cap = Math.max(limit, Math.ceil(limit * batch.length / 4))
    const newest = namedBy === undefined ? '$newest' : { $filter: { input: '$newest', as: 'm', cond: { $or: [
      { $and: [{ $eq: ['$$m.author.kind', 'person'] }, { $eq: ['$$m.author.id', { $literal: namedBy }] }] },
      { $in: [{ $literal: namedBy }, { $ifNull: ['$$m.mentions', []] }] }] } } }
    const found = await readBy(db, 'SuperTabMessage', 'thread', [
      { $match: { $or: batch.map(r => ({ tabId, conversationId: r.conversationId, thread: r.thread, sequence: r.sequence })) } },
      { $project: { ...SCAN_FIELDS, conversationId: 1 } }, { $limit: cap + 1 },
      { $group: { _id: { conversationId: '$conversationId', thread: '$thread' }, seen: { $sum: 1 },
        newest: { $topN: { n: limit, sortBy: { sequence: -1 }, output: '$$ROOT' } } } },
      { $project: { seen: 1, newest } }] as Prisma.InputJsonValue[]) as unknown as
      Array<{ _id: { conversationId: string; thread: string }; seen: number; newest: Array<Record<string, unknown>> }>
    if (found.reduce((seen, thread) => seen + Number(thread.seen), 0) > cap) {
      logger.info('[inbox] a batch of thread ranges passed its cap and read by union', { ranges: batch.length, limit })
      const each = await perRange(db, batch.map(r => [{ $match: { tabId, conversationId: r.conversationId, thread: r.thread, sequence: r.sequence } },
        { $sort: { sequence: -1 } }, { $limit: limit }, ...named, { $project: { ...SCAN_FIELDS, conversationId: 1 } }] as Prisma.InputJsonValue[]))
      for (const [key, found] of groupBy(each, m => threadKey(m.conversationId, m.thread!))) rows.set(key, found)
      continue
    }
    for (const thread of found) rows.set(threadKey(thread._id.conversationId, thread._id.thread), thread.newest.map(row))
  }
  return rows
}

/**
 * The threads of `threads` the person wrote in or was tagged in, in rows a page shows them, as threadKey(conversationId, thread).
 * Read from the threads' summaries (pageReads.ts threadsNaming): one read by root id, whatever the threads' length, of only the
 * summaries naming the person and only their parts and tags that do, with what a reader skips marked, so a row of theirs any
 * distance back counts, as the Threads view counts it. It read each thread's newest MEMBER_SCAN rows before the mark, one $or
 * branch per thread and one $unionWith branch past the cap: the threads route's slowest read in Ken's scan of 11-04 (task #2768).
 * A Swarm Buddy chat's threads still read those rows before `sequence`: its summary cannot tell a row of a project its person
 * lost (buddySessions.ts lostProjectRow), which they no longer read. So does a Swarm whose summaries are not backfilled yet
 * (threadBackfill.ts): its summaries would come from every row of the threads (threadFacet), unbounded.
 */
export async function namedInThreads(db: PrismaClient, tabId: string, state: SuperTabState,
  threads: ReadonlyArray<{ conversationId: string; thread: string; sequence: number }>, personId: string): Promise<Set<string>> {
  const named = new Set<string>()
  if (!threads.length) return named
  const ready = await threadsBackfilled(db, tabId)
  const scan = new Set(state.conversations.filter(g => !ready || isSwarmBuddyChat(g)).map(g => g.id))
  const scanned = threads.filter(t => scan.has(t.conversationId)), summed = threads.filter(t => !scan.has(t.conversationId))
  if (summed.length) {
    const naming = await threadsNaming(db, tabId, summed.map(t => ({ conversationId: t.conversationId, root: t.thread })), personId)
    for (const t of summed) if (naming.has(`${t.conversationId}\u0000${t.thread}`)) named.add(threadKey(t.conversationId, t.thread))
  }
  if (scanned.length) {
    const groups = new Map(state.conversations.map(g => [g.id, g]))
    const rows = await newestInThreads(db, tabId, scanned.map(t => {
      const group = groups.get(t.conversationId)
      return { conversationId: t.conversationId, thread: t.thread, ...group
        ? { sequence: { $lte: Math.min(t.sequence, chatTop(group)) }, version: chatVersion(group) } : { sequence: { $lte: t.sequence } } }
    }), MEMBER_SCAN, personId)
    for (const m of await readable(db, tabId, rows, state)) named.add(threadKey(m.conversationId, m.thread!))
  }
  return named
}

/** Up to `limit` rows of one chat, newest first, in its (sequence, id) index range. */
const newestIn = (tabId: string, conversationId: string, sequence: Record<string, number>, limit: number, fields: Record<string, unknown>): Prisma.InputJsonValue[] =>
  [{ $match: { tabId, conversationId, sequence } }, { $sort: { sequence: -1, _id: -1 } }, { $limit: limit }, { $project: { ...fields, conversationId: 1 } }] as Prisma.InputJsonValue[]

/** Each chat's newest main message the person reads: the row at its stored main sequence, read alone; the LATEST_SCAN rows
 *  before it only for a chat where that row is not one (an older chat's newest row may be a thread reply or a hidden copy).
 *  `more` when such a chat has none in that range. */
export async function latestIn(db: PrismaClient, tabId: string, state: SuperTabState, chats: Conversation[]): Promise<{ latest: Map<string, Row>; more: boolean }> {
  const tops = chats.flatMap(g => { const top = g.lastMainSequence ?? g.lastMessageSequence; return top ? [{ id: g.id, top, group: g }] : [] })
  const pick = async (rows: Row[]) => {
    const shown = (await readable(db, tabId, rows, state)).filter(isMain)
    const newest = new Map<string, Row>()
    for (const m of shown) if (!newest.has(m.conversationId)) newest.set(m.conversationId, m)
    return newest
  }
  const read = (of: typeof tops, limit: number) => chatRanges(db, tabId, of.map(c => ({ group: c.group, sequence: { $lte: Math.min(c.top, chatTop(c.group)) } })), limit, 'preview')
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

/** Threads read behind their chat's mark whose rows past their own mark are read, most recently moved mark first. */
export const BEHIND_THREADS = 50

/** The thread marks behind their chat's mark, in a chat with rows past them, most recently moved first: a thread opened, then
 *  the chat read further on. Reading the chat's main stream never reads a reply only in the thread, so those count from the
 *  thread's own mark (as Slack). A row a Follow alone wrote (sequence 0) is no mark; an unfollowed thread is never listed. */
function behindMarks(chats: Conversation[], marks: Map<string, number>, threadRows: ThreadMarkRow[]): ThreadMarkRow[] {
  const groups = new Map(chats.map(g => [g.id, g]))
  return threadRows.filter(r => {
    const group = groups.get(r.conversationId)
    return group && r.sequence > 0 && r.follow !== false && r.sequence < (marks.get(r.conversationId) ?? 0) && group.lastMessageSequence > r.sequence
  })
}

/** The threads the person has unread replies in (see the file's comment): from each of `chats`' newest UNREAD_SCAN rows past
 *  their mark, and from each thread whose own mark is behind its chat's (behindMarks: at most BEHIND_THREADS, of `readable`
 *  chats) its newest UNREAD_SCAN rows past that mark, by the thread index. */
async function threadsIn(db: PrismaClient, tabId: string, state: SuperTabState, chats: Conversation[], readableChats: Conversation[], personId: string,
  marks: Map<string, number>, threadRows: ThreadMarkRow[]): Promise<{ threads: InboxThread[]; more: boolean }> {
  const behind = behindMarks(readableChats, marks, threadRows)
  if (!chats.length && !behind.length) return { threads: [], more: false }
  const held = new Map(threadRows.map(r => [threadKey(r.conversationId, r.threadId), r]))
  const own = (a: Pick<Author, 'kind' | 'id'>) => a.kind === 'person' && a.id === personId
  const inIt = (m: Row) => own(m.author) || m.mentions.includes(personId)
  const lagging = behind.slice(0, BEHIND_THREADS)
  // Each range bounded by its chat's newest row and kept (rangeCache.ts): a re-read reads only the chats that moved.
  const chatOf = new Map(readableChats.map(g => [g.id, g]))
  const [scanned, past] = await Promise.all([chatRanges(db, tabId, chats.map(g => ({ group: g, sequence: { $gt: marks.get(g.id)!, $lte: chatTop(g) } })),
    UNREAD_SCAN + 1, 'scan'),
    newestInThreads(db, tabId, lagging.map(r => {
      const group = chatOf.get(r.conversationId)!
      return { conversationId: r.conversationId, thread: r.threadId, sequence: { $gt: r.sequence, $lte: chatTop(group) }, version: chatVersion(group) }
    }), UNREAD_SCAN + 1)])
  const byChat = groupBy(scanned, m => m.conversationId)
  const pastByThread = groupBy(past, m => threadKey(m.conversationId, m.thread!))
  // A chat or thread whose newest UNREAD_SCAN rows do not reach its mark: older unread replies are not counted.
  let more = behind.length > BEHIND_THREADS || [...byChat.values(), ...pastByThread.values()].some(rows => rows.length > UNREAD_SCAN)
  // Each row once, though both scans read it.
  const rowsOf = [...byChat.values(), ...pastByThread.values()].flatMap(rows => rows.slice(0, UNREAD_SCAN)).filter(isReply)
  const replies = await readable(db, tabId, [...new Map(rowsOf.map(m => [m.id, m])).values()], state)
  // Newest first within each thread.
  const byThread = groupBy(replies.sort((a, b) => b.sequence - a.sequence), m => threadKey(m.conversationId, m.thread!))
  const behindKeys = new Set(lagging.map(r => threadKey(r.conversationId, r.threadId)))
  const candidates: Candidate[] = []
  for (const [key, rows] of byThread) {
    const newest = rows[0]!
    const mark = held.get(key)
    // The person answered last: nothing in it waits for them. Nor in a thread they unfollowed, wherever they are in it.
    if (own(newest.author) || mark?.follow === false) continue
    // Read through the later of their own newest reply and their mark of this thread from any device.
    const seen = Math.max(rows.find(m => own(m.author))?.sequence ?? 0, mark?.sequence ?? 0)
    const unread = rows.filter(m => !own(m.author) && m.sequence > seen).length
    if (!unread) continue
    // A thread read behind its chat's mark: what is before its own mark was looked at for the person, not the chat's.
    candidates.push({ conversationId: newest.conversationId, root: newest.thread!, mark: behindKeys.has(key) ? mark!.sequence : marks.get(newest.conversationId)!,
      replies: rows, unread, member: mark?.follow === true || rows.some(inIt), at: newest.createdAt.getTime(), id: newest.id })
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
  // The rest: did the person write or get tagged in it before? From the threads' summaries, in one read (namedInThreads).
  const unknown = withRoot.filter(c => !c.member)
  if (unknown.length) {
    const members = await namedInThreads(db, tabId, state, unknown.map(c => ({ conversationId: c.conversationId, thread: c.root, sequence: c.mark })), personId)
    for (const c of unknown) if (members.has(threadKey(c.conversationId, c.root))) c.member = true
  }
  const groups = new Map(readableChats.map(g => [g.id, g]))
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

/** What one inbox read found besides the inbox, for the followed threads read (followedThreads.ts) to go on from. */
export interface InboxRead {
  inbox: Inbox
  state: SuperTabState
  /** The chats the person reads now, active and unarchived, most recently active first. */
  chats: Conversation[]
  marks: Map<string, number>
  /** Every thread mark row of the person, most recently moved first (readMarks.ts readThreadMarkRows). */
  threadRows: ThreadMarkRow[]
}

/** The inbox of the signed-in person: never an agent's (they have no read marks) or a Team session's (marks are the person's).
 *  Without `latest`, the chats' latest messages are not read and `latest` is empty. */
export async function inboxRead(store: SuperTabStore, user: AuthUser, tabId: string, options: { latest: boolean }): Promise<InboxRead> {
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
  const shown = options.latest ? chats.slice(0, LATEST_CHATS) : []
  // The person's thread marks and follows: one indexed read (readMarks.ts), beside the latest messages'.
  const threadRows = readThreadMarkRows(db, tabId, user.sub)
  const [latest, threaded] = await Promise.all([latestIn(db, tabId, state, shown),
    threadRows.then(rows => threadsIn(db, tabId, state, unread.slice(0, THREAD_CHATS), chats, user.sub, marks, rows))])
  const threads = threaded.threads.sort((a, b) => newestFirst({ at: Date.parse(a.lastReplyAt), id: a.rootId }, { at: Date.parse(b.lastReplyAt), id: b.rootId }))
  const more = (options.latest && chats.length > LATEST_CHATS) || latest.more || unread.length > THREAD_CHATS || threaded.more || threads.length > MAX_THREADS
  const inbox = { threads: threads.slice(0, MAX_THREADS), more,
    latest: shown.flatMap(g => { const m = latest.latest.get(g.id); return m ? [{ conversationId: g.id, message: preview(m) }] : [] }) }
  return { inbox, state, chats, marks, threadRows: await threadRows }
}

export const readInbox = async (store: SuperTabStore, user: AuthUser, tabId: string): Promise<Inbox> => (await inboxRead(store, user, tabId, { latest: true })).inbox

const inboxReads = createRateLimiter('swarm-inbox', INBOX_WINDOW_MS, INBOX_READS)

/** Seconds a person must wait before reading this Swarm's inbox again, or 0 when they may now. Apps read it when the change
 *  feed moves, which in a busy Swarm is several times a second; this keeps one person's reads to about one a second. */
export async function inboxWait(user: AuthUser, tabId: string, now = Date.now()): Promise<number> {
  if (await inboxReads.allows(`${user.sub}:${tabId}`, now)) return 0
  return Math.max(1, Math.ceil((INBOX_WINDOW_MS - now % INBOX_WINDOW_MS) / 1000))
}
/** Test seam: forget this process's counts. */
export const resetInboxReads = () => inboxReads.reset()
