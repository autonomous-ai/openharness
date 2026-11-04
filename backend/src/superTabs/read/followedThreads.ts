/**
 * A person's followed threads in one Swarm (Desktop's Threads view, as Slack's): those with replies they have not read, exactly
 * the inbox's threads (inbox.ts), then those they follow and have read, newest reply first. Both honor the person's own Follow
 * and Unfollow (readMarks.ts writeThreadFollow): an unfollowed thread is never listed, a followed one is as if they were in it.
 *
 * A read thread is listed only from the person's thread mark rows (a thread they opened on some device, or followed), in chats
 * they read now (the inbox's chats: active, unarchived, the messages read's check), most recently moved first, at most
 * READ_CANDIDATES; and from their own tags (mentions.ts taggedThreads), at most TAGGED_THREADS more, newest tag first: a thread
 * they are tagged in has no mark in a chat they never opened (the inbox counts that chat as read, so it lists none of its
 * threads), and the Threads view promises tagged threads. A thread with a mark row of theirs, an unfollowed one too, is judged by
 * the row alone; a tag only adds the threads they hold none of. The tag list is theirs alone and checked as the Activity list is
 * (chats they read now); the thread's root and replies are checked below as for any candidate. One is listed when they follow it, or started it, replied in it or were tagged in it (root or reply), and it
 * has a reply. Rows are those a page shows a person (inbox.ts readable): never an agent-only notice or a delivered copy.
 *
 * Cost: the inbox's reads (without the chats' latest messages); the candidates' roots by id in one read; the candidates' thread
 * summaries by root id in one read (pageReads.ts threadsAcross), one small row per thread whatever its length, so `replies` is
 * the whole count a chat page shows. A Swarm Buddy chat's candidates read their newest THREAD_SCAN rows by the thread index
 * instead, CHATS_PER_READ threads per read (inbox.ts perRange), and say THREAD_SCAN at most. The route allows a person THREADS_READS per THREADS_WINDOW_MS in each
 * Swarm, counted by every pod together, as the inbox's.
 */
import type { AuthUser } from '../../lib/ssoAuth.js'
import { createRateLimiter } from '../../lib/rateLimit.js'
import type { Author } from '../model.js'
import type { ThreadReply } from '../pageReads.js'
import { threadSummaries } from '../threads.js'
import { threadsAcross } from '../pageReads.js'
import { isSwarmBuddyChat } from '../buddies.js'
import { readBy } from '../parts/indexed.js'
import type { SuperTabStore } from '../store.js'
import { taggedThreads } from '../mentions.js'
import type { ThreadMarkRow } from '../readMarks.js'
import { FIELDS, inboxRead, INBOX_READS, INBOX_WINDOW_MS, isReply, MEMBER_SCAN, newestFirst, perRange, preview, readable, row, SCAN_FIELDS, threadKey,
  type InboxMessage, type InboxThread, type Row } from './inbox.js'

/** Read threads answered, newest reply first, when the client asks for no number (a Desktop before task #2835). */
export const MAX_READ_THREADS = 30
/** The most read threads one read answers when asked (`?read=N`, Activity's Threads 50 at a time, task #2835). */
export const READ_THREADS_ASKED_MAX = 250
/** Thread mark rows checked for read threads, most recently moved first: room for those the person turns out not to be in. */
export const READ_CANDIDATES = 2 * MAX_READ_THREADS
/** Thread mark rows checked to answer [read] read threads: twice as many, as READ_CANDIDATES is for 30. */
export const readCandidates = (read: number) => 2 * read
/** Threads found only by the person's tags that are checked as candidates, newest tag first, besides READ_CANDIDATES. */
export const TAGGED_THREADS = 30
/** Rows read per candidate thread, newest first. */
export const THREAD_SCAN = MEMBER_SCAN
export const THREADS_READS = INBOX_READS
export const THREADS_WINDOW_MS = INBOX_WINDOW_MS

export interface FollowedThread {
  conversationId: string
  rootId: string
  root: InboxMessage
  /** Replies the person reads, of the thread's newest THREAD_SCAN rows. */
  replies: number
  lastReplyAt: string
  lastReplySequence: number
  /** The newest reply's author who can still read the chat, as thread summaries name them; null when none can. */
  lastReplier: Author | null
  /** The person's own choice: true Follow, null none (a followed read thread is never false). */
  follow: boolean | null
}
export interface FollowedThreads { unread: Array<InboxThread & { follow: boolean | null }>; read: FollowedThread[]; more: boolean }

/** [read]: how many read threads to answer (Activity asks 50, then 100, ... as the person scrolls); the cost grows only by the
 *  candidates checked, 2 × read of the person's marks (at most THREAD_MARK_CAP, already read for the inbox), their roots by id and
 *  their summaries by root id. */
export async function readFollowedThreads(store: SuperTabStore, user: AuthUser, tabId: string, read = MAX_READ_THREADS): Promise<FollowedThreads> {
  const db = store.db, personId = user.sub
  const { inbox, state, chats, marks, threadRows } = await inboxRead(store, user, tabId, { latest: false })
  const follows = new Map(threadRows.map(r => [threadKey(r.conversationId, r.threadId), r]))
  const unread = inbox.threads.map(t => ({ ...t, follow: follows.get(threadKey(t.conversationId, t.rootId))?.follow ?? null }))
  const listed = new Set(unread.map(t => threadKey(t.conversationId, t.rootId)))
  const groups = new Map(chats.map(g => [g.id, g]))
  const eligible = threadRows.filter(r => r.follow !== false && groups.has(r.conversationId) && !listed.has(threadKey(r.conversationId, r.threadId)))
  // Threads they are tagged in and hold no mark row of: the inbox lists none in a chat they never opened.
  const held = new Set(threadRows.map(r => threadKey(r.conversationId, r.threadId)))
  // The filters run before the count, so tags in archived chats or in threads they hold a mark of never use up the cap.
  const tagged = await taggedThreads(db, tabId, state, { kind: 'person', userId: personId, email: user.email }, Date.now(), TAGGED_THREADS + 1,
    t => groups.has(t.conversationId) && !held.has(threadKey(t.conversationId, t.threadId)) && !listed.has(threadKey(t.conversationId, t.threadId)))
  const byTag: ThreadMarkRow[] = tagged.slice(0, TAGGED_THREADS).map(t => ({ conversationId: t.conversationId, threadId: t.threadId, sequence: 0, follow: null, updatedAt: t.at }))
  const checked = readCandidates(read)
  const candidates = [...eligible.slice(0, checked), ...byTag]
  let more = inbox.more || eligible.length > checked || tagged.length > TAGGED_THREADS
  if (!candidates.length) return { unread, read: [], more }
  // Every root by its id, in one read; a root counts only in the chat its mark names, and only one the person reads.
  const found = (await readBy(db, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: candidates.map(c => c.threadId) }, tabId } },
    { $project: { ...FIELDS, conversationId: 1 } }])).map(row)
  const roots = new Map((await readable(db, tabId, found.filter(m => !isReply(m)), state)).map(m => [threadKey(m.conversationId, m.id), m]))
  const withRoot = candidates.filter(c => roots.has(threadKey(c.conversationId, c.threadId)))
  if (!withRoot.length) return { unread, read: [], more }
  // Each thread's rows a person reads, newest first: from its summary (pageReads.ts threadsAcross), one small row per thread, which
  // stands for every row of it. A Swarm Buddy chat's are its newest rows by the thread index range instead: its summary cannot
  // tell a row of a project its person lost (buddySessions.ts lostProjectRow), which they no longer read.
  const scannedIn = withRoot.filter(c => isSwarmBuddyChat(groups.get(c.conversationId)!))
  const summedIn = withRoot.filter(c => !isSwarmBuddyChat(groups.get(c.conversationId)!))
  const byThread = new Map<string, ThreadReply[]>()
  const add = (key: string, m: ThreadReply) => byThread.set(key, [...byThread.get(key) ?? [], m])
  const chatOf = new Map(summedIn.map(c => [c.threadId, c.conversationId]))
  for (const m of (await threadsAcross(db, tabId, summedIn.map(c => ({ conversationId: c.conversationId, root: c.threadId })))).toReversed()) {
    if (!m.agentOnly && m.id !== m.thread) add(threadKey(chatOf.get(m.thread)!, m.thread), m)
  }
  const scanned = scannedIn.length ? await perRange(db, scannedIn.map(c => [{ $match: { tabId, conversationId: c.conversationId, thread: c.threadId } },
    { $sort: { sequence: -1 } }, { $limit: THREAD_SCAN }, { $project: { ...SCAN_FIELDS, conversationId: 1 } }])) : []
  for (const m of await readable(db, tabId, scanned.filter(isReply), state)) {
    add(threadKey(m.conversationId, m.thread!), { thread: m.thread!, id: m.id, author: m.author, mentions: m.mentions, sequence: m.sequence,
      createdAt: m.createdAt, agentOnly: false, routing: false })
  }
  const own = (a: Pick<Author, 'kind' | 'id'>) => a.kind === 'person' && a.id === personId
  const inIt = (m: Pick<Row, 'author' | 'mentions'>) => own(m.author) || m.mentions.includes(personId)
  const answered: Array<FollowedThread & { at: number }> = []
  for (const c of withRoot) {
    const key = threadKey(c.conversationId, c.threadId), root = roots.get(key)!
    // Newest first. A summary row stands for `count` rows of one author and kind, its newest and oldest among them: the newest
    // reply, each author's newest and every person's first tag are always there, which is all this reads.
    const replies = byThread.get(key) ?? []
    const newest = replies[0]
    if (!newest || !(c.follow === true || inIt(root) || replies.some(inIt))) continue
    // Unread by the inbox's rule but past its caps: it is not a read thread, and the inbox says there are more. A thread mark
    // counts from itself, even behind the chat's (inbox.ts behindMarks); a Follow alone (0) is none.
    const mark = marks.get(c.conversationId) ?? 0
    const seen = Math.max(c.sequence > 0 ? c.sequence : mark, replies.find(m => own(m.author))?.sequence ?? 0)
    if (mark > 0 && !own(newest.author) && replies.some(m => !own(m.author) && m.sequence > seen)) { more = true; continue }
    // Named as a page's thread summary names them: only authors who can still read the chat (threads.ts).
    const rows: ThreadReply[] = [{ thread: c.threadId, id: root.id, author: root.author, mentions: root.mentions, sequence: root.sequence,
      createdAt: root.createdAt, agentOnly: false, routing: false }, ...replies.toReversed()]
    const [summary] = threadSummaries(state, groups.get(c.conversationId)!, rows)
    if (!summary) continue
    answered.push({ conversationId: c.conversationId, rootId: root.id, root: preview(root), replies: summary.replies, lastReplyAt: summary.lastAt.toISOString(),
      lastReplySequence: summary.lastSequence, lastReplier: summary.authors[0] ?? null, follow: c.follow, at: summary.lastAt.getTime() })
  }
  answered.sort((a, b) => newestFirst({ at: a.at, id: a.rootId }, { at: b.at, id: b.rootId }))
  if (answered.length > read) more = true
  return { unread, read: answered.slice(0, read).map(({ at: _at, ...thread }) => thread), more }
}

const threadsReads = createRateLimiter('swarm-threads', THREADS_WINDOW_MS, THREADS_READS)

/** Seconds a person must wait before reading this Swarm's followed threads again, or 0 when they may now (as inboxWait). */
export async function threadsWait(user: AuthUser, tabId: string, now = Date.now()): Promise<number> {
  if (await threadsReads.allows(`${user.sub}:${tabId}`, now)) return 0
  return Math.max(1, Math.ceil((THREADS_WINDOW_MS - now % THREADS_WINDOW_MS) / 1000))
}
/** Test seam: forget this process's counts. */
export const resetThreadsReads = () => threadsReads.reset()
