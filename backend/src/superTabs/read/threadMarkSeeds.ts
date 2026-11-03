/**
 * Reading a chat never reads a reply only in a thread (inbox.ts, the file's comment). The inbox and Threads count a thread from
 * the person's own mark of it when that mark is behind the chat's (inbox.ts behindMarks), but a thread they never opened had
 * none, so once the chat's mark passed its replies they were gone (Diego, 11-01). So before the chat's mark moves from `old` to
 * `next`, each thread with a reply only in it in that range by someone else, that the person is in (started it, replied in it,
 * was tagged in it, or follows it) and has no mark of, gets one at `old`: what they had read of the chat. A thread they opened
 * keeps its own mark, and one they unfollowed gets none. A chat never marked read gets none: it counts as read (inbox.ts).
 *
 * Privacy: only rows a page shows the person count (inbox.ts readable): never an agent-only notice, a delivered copy, or a row
 * of a project they no longer read in their Buddy chat. A thread whose root they cannot read gets no mark, so its id never
 * reaches their marks. The caller has checked they read the chat, as a person reading as themselves.
 *
 * Cost: one read of the range's first SEED_SCAN rows from `old` upward by the (tabId, conversationId, sequence) index, answering
 * only thread replies. Only when one is someone else's reply only in its thread: the delivered-copy check, the threads' mark rows
 * and roots by id, the look-back for the person in at most SEED_THREADS threads (MEMBER_SCAN rows each, one read), then one
 * conditional write per thread. A reply past the range's first SEED_SCAN rows, or in more than SEED_THREADS threads, is not
 * marked; the server logs it.
 */
import type { PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import { stableId, type Author, type SuperTabState } from '../model.js'
import { seedThreadMark } from '../readMarks.js'
import { readBy } from '../parts/indexed.js'
import { BEHIND_THREADS, groupBy, isReply, MEMBER_SCAN, perRange, readable, row, SCAN_FIELDS, UNREAD_SCAN, type Row } from './inbox.js'

/** Rows of the range one chat read looks at, from the old mark upward. */
export const SEED_SCAN = 5 * UNREAD_SCAN
/** Threads one chat read marks at most, newest reply first: as many as the inbox reads behind their chat's mark. */
export const SEED_THREADS = BEHIND_THREADS

export interface SeedInput { tabId: string; state: SuperTabState; personId: string; conversationId: string; old: number; next: number; now: number }

/** A row is a thread reply: the root is another row. */
const REPLY = { $and: [{ $ne: [{ $ifNull: ['$thread', null] }, null] }, { $ne: ['$thread', '$_id'] }] }

/** Marks the threads described above and answers how many it marked. */
export async function seedThreadMarks(db: PrismaClient, input: SeedInput): Promise<number> {
  const { tabId, state, personId, conversationId, old, next } = input
  if (old <= 0 || next <= old) return 0
  const [scan] = await db.superTabMessage.aggregateRaw({ pipeline: [
    { $match: { tabId, conversationId, sequence: { $gt: old, $lte: next } } }, { $sort: { sequence: 1, _id: 1 } }, { $limit: SEED_SCAN },
    { $project: { ...SCAN_FIELDS, alsoInChat: 1 } },
    { $group: { _id: null, scanned: { $sum: 1 }, last: { $last: '$sequence' }, replies: { $push: { $cond: [REPLY, '$$ROOT', '$$REMOVE'] } } } },
  ] }) as unknown as Array<{ scanned: number; last: number; replies: Array<Record<string, unknown>> }>
  if (!scan) return 0
  if (scan.scanned >= SEED_SCAN && scan.last < next) logger.warn('[swarm-read-marks] thread replies past the scan not marked', { tabId, conversationId, old, next })
  const own = (a: Pick<Author, 'kind' | 'id'>) => a.kind === 'person' && a.id === personId
  const inIt = (m: Row) => own(m.author) || m.mentions.includes(personId)
  const waits = (m: Row) => !m.alsoInChat && !own(m.author)
  const rows = scan.replies.map(raw => row({ ...raw, conversationId }))
  if (!rows.some(waits)) return 0
  const shown = await readable(db, tabId, rows, state)
  // Newest reply first.
  const byThread = [...groupBy(shown.toReversed(), m => m.thread!)].filter(([, replies]) => replies.some(waits))
  if (!byThread.length) return 0
  if (byThread.length > SEED_THREADS) logger.warn('[swarm-read-marks] threads past the cap not marked', { tabId, conversationId, threads: byThread.length })
  const threads = new Map(byThread.slice(0, SEED_THREADS))
  // The person's rows of these threads, by id: one with a mark keeps it, an unfollowed one gets none.
  const held = new Map((await db.superTabThreadMark.aggregateRaw({ pipeline: [
    { $match: { _id: { $in: [...threads.keys()].map(thread => stableId(tabId, conversationId, thread, personId)) } } },
    { $project: { _id: 0, threadId: 1, sequence: 1, follow: 1 } },
  ] }) as unknown as Array<{ threadId: string; sequence: number; follow?: boolean | null }>).map(r => [r.threadId, r]))
  const open = [...threads.keys()].filter(thread => { const mark = held.get(thread); return !mark || (Number(mark.sequence) <= 0 && mark.follow !== false) })
  if (!open.length) return 0
  // Each root by its id, in this chat, one the person reads.
  const found = (await readBy(db, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: open }, tabId, conversationId } }, { $project: { ...SCAN_FIELDS, conversationId: 1 } }])).map(row)
  const roots = new Map((await readable(db, tabId, found.filter(m => !isReply(m)), state)).map(m => [m.id, m]))
  const withRoot = open.filter(thread => roots.has(thread))
  const member = new Set(withRoot.filter(thread => held.get(thread)?.follow === true || inIt(roots.get(thread)!) || threads.get(thread)!.some(inIt)))
  // The rest: did the person write or get tagged before the old mark? Each thread's newest MEMBER_SCAN rows there, by its
  // thread index range; only the rows that name them come back.
  const unknown = withRoot.filter(thread => !member.has(thread))
  if (unknown.length) {
    const named = await perRange(db, unknown.map(thread => [{ $match: { tabId, conversationId, thread, sequence: { $lte: old } } },
      { $sort: { sequence: -1 } }, { $limit: MEMBER_SCAN },
      { $match: { $or: [{ 'author.kind': 'person', 'author.id': personId }, { mentions: personId }] } }, { $project: { ...SCAN_FIELDS, conversationId: 1 } }]))
    for (const m of await readable(db, tabId, named, state)) member.add(m.thread!)
  }
  let marked = 0
  for (const thread of withRoot.filter(t => member.has(t))) {
    if (await seedThreadMark(db, { tabId, personId, conversationId, threadId: thread, sequence: old, now: input.now })) marked++
  }
  return marked
}
