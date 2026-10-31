/**
 * A person's followed threads in one Swarm (Desktop's Threads view, as Slack's): those with replies they have not read, exactly
 * the inbox's threads (inbox.ts), then those they follow and have read, newest reply first. Both honor the person's own Follow
 * and Unfollow (readMarks.ts writeThreadFollow): an unfollowed thread is never listed, a followed one is as if they were in it.
 *
 * A read thread is listed only from the person's thread mark rows (a thread they opened on some device, or followed), in chats
 * they read now (the inbox's chats: active, unarchived, the messages read's check), most recently moved first, at most
 * READ_CANDIDATES. One is listed when they follow it, or started it, replied in it or were tagged in it (root or reply), and it
 * has a reply. Rows are those a page shows a person (inbox.ts readable): never an agent-only notice or a delivered copy.
 *
 * Cost: the inbox's reads (without the chats' latest messages); the candidates' roots by id in one read; each candidate thread's
 * newest THREAD_SCAN rows by the thread index, CHATS_PER_READ threads per read (inbox.ts perRange). `replies` counts what that
 * scan read, so a longer thread says THREAD_SCAN at most. The route allows a person THREADS_READS per THREADS_WINDOW_MS in each
 * Swarm, counted by every pod together, as the inbox's.
 */
import type { AuthUser } from '../../lib/ssoAuth.js'
import { createRateLimiter } from '../../lib/rateLimit.js'
import type { Author } from '../model.js'
import type { ThreadReply } from '../pageReads.js'
import { threadSummaries } from '../threads.js'
import { readBy } from '../parts/indexed.js'
import type { SuperTabStore } from '../store.js'
import { FIELDS, inboxRead, INBOX_READS, INBOX_WINDOW_MS, isReply, MEMBER_SCAN, newestFirst, perRange, preview, readable, row, SCAN_FIELDS, threadKey,
  type InboxMessage, type InboxThread, type Row } from './inbox.js'

/** Read threads answered, newest reply first. */
export const MAX_READ_THREADS = 30
/** Thread mark rows checked for read threads, most recently moved first: room for those the person turns out not to be in. */
export const READ_CANDIDATES = 2 * MAX_READ_THREADS
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

export async function readFollowedThreads(store: SuperTabStore, user: AuthUser, tabId: string): Promise<FollowedThreads> {
  const db = store.db, personId = user.sub
  const { inbox, state, chats, marks, threadRows } = await inboxRead(store, user, tabId, { latest: false })
  const follows = new Map(threadRows.map(r => [threadKey(r.conversationId, r.threadId), r]))
  const unread = inbox.threads.map(t => ({ ...t, follow: follows.get(threadKey(t.conversationId, t.rootId))?.follow ?? null }))
  const listed = new Set(unread.map(t => threadKey(t.conversationId, t.rootId)))
  const groups = new Map(chats.map(g => [g.id, g]))
  const eligible = threadRows.filter(r => r.follow !== false && groups.has(r.conversationId) && !listed.has(threadKey(r.conversationId, r.threadId)))
  const candidates = eligible.slice(0, READ_CANDIDATES)
  let more = inbox.more || eligible.length > READ_CANDIDATES
  if (!candidates.length) return { unread, read: [], more }
  // Every root by its id, in one read; a root counts only in the chat its mark names, and only one the person reads.
  const found = (await readBy(db, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: candidates.map(c => c.threadId) }, tabId } },
    { $project: { ...FIELDS, conversationId: 1 } }])).map(row)
  const roots = new Map((await readable(db, tabId, found.filter(m => !isReply(m)))).map(m => [threadKey(m.conversationId, m.id), m]))
  const withRoot = candidates.filter(c => roots.has(threadKey(c.conversationId, c.threadId)))
  if (!withRoot.length) return { unread, read: [], more }
  // Each thread's newest rows, the root among them in a short thread, by its thread index range.
  const scanned = await perRange(db, withRoot.map(c => [{ $match: { tabId, conversationId: c.conversationId, thread: c.threadId } },
    { $sort: { sequence: -1 } }, { $limit: THREAD_SCAN }, { $project: { ...SCAN_FIELDS, conversationId: 1 } }]))
  const byThread = new Map<string, Row[]>()
  for (const m of await readable(db, tabId, scanned.filter(isReply))) {
    const key = threadKey(m.conversationId, m.thread!)
    byThread.set(key, [...byThread.get(key) ?? [], m])
  }
  const own = (a: Pick<Author, 'kind' | 'id'>) => a.kind === 'person' && a.id === personId
  const inIt = (m: Row) => own(m.author) || m.mentions.includes(personId)
  const read: Array<FollowedThread & { at: number }> = []
  for (const c of withRoot) {
    const key = threadKey(c.conversationId, c.threadId), root = roots.get(key)!
    // Newest first, as the scan reads them.
    const replies = byThread.get(key) ?? []
    const newest = replies[0]
    if (!newest || !(c.follow === true || inIt(root) || replies.some(inIt))) continue
    // Unread by the inbox's rule but past its caps: it is not a read thread, and the inbox says there are more. A thread mark
    // counts from itself, even behind the chat's (inbox.ts behindMarks); a Follow alone (0) is none.
    const mark = marks.get(c.conversationId) ?? 0
    const seen = Math.max(c.sequence > 0 ? c.sequence : mark, replies.find(m => own(m.author))?.sequence ?? 0)
    if (mark > 0 && !own(newest.author) && replies.some(m => !own(m.author) && m.sequence > seen)) { more = true; continue }
    // Named as a page's thread summary names them: only authors who can still read the chat (threads.ts).
    const rows: ThreadReply[] = [root, ...replies.toReversed()].map(m => ({ thread: c.threadId, id: m.id, author: m.author, mentions: m.mentions,
      sequence: m.sequence, createdAt: m.createdAt, agentOnly: false, routing: false }))
    const [summary] = threadSummaries(state, groups.get(c.conversationId)!, rows)
    if (!summary) continue
    read.push({ conversationId: c.conversationId, rootId: root.id, root: preview(root), replies: summary.replies, lastReplyAt: summary.lastAt.toISOString(),
      lastReplySequence: summary.lastSequence, lastReplier: summary.authors[0] ?? null, follow: c.follow, at: summary.lastAt.getTime() })
  }
  read.sort((a, b) => newestFirst({ at: a.at, id: a.rootId }, { at: b.at, id: b.rootId }))
  if (read.length > MAX_READ_THREADS) more = true
  return { unread, read: read.slice(0, MAX_READ_THREADS).map(({ at: _at, ...thread }) => thread), more }
}

const threadsReads = createRateLimiter('swarm-threads', THREADS_WINDOW_MS, THREADS_READS)

/** Seconds a person must wait before reading this Swarm's followed threads again, or 0 when they may now (as inboxWait). */
export async function threadsWait(user: AuthUser, tabId: string, now = Date.now()): Promise<number> {
  if (await threadsReads.allows(`${user.sub}:${tabId}`, now)) return 0
  return Math.max(1, Math.ceil((THREADS_WINDOW_MS - now % THREADS_WINDOW_MS) / 1000))
}
/** Test seam: forget this process's counts. */
export const resetThreadsReads = () => threadsReads.reset()
