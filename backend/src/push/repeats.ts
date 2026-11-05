import type { PrismaClient } from '@prisma/client'
import type { PhoneNotice } from './sender.js'

type Unread = { _id: string; personId: string; createdAt?: { $date: string } }
/** SuperTabActivity's `@@index([tabId, personId, conversationId, threadId])` (prisma/schema.prisma). */
const THREAD_INDEX = { tabId: 1, personId: 1, conversationId: 1, threadId: 1 }

/**
 * Tony's rule for a thread's replies (task #3248): a reply's push sounds only when its person had no unread reply in that
 * thread before it. Otherwise it goes quietly, replacing the thread's one notification (its slot) without a sound or a
 * banner; once the person reads the thread, the next reply sounds again. Of one person's notices for one thread in `notices`,
 * only the earliest can sound.
 *
 * One read per thread the reply notices are in, by the Activity thread index (tabId, personId, conversationId, threadId),
 * as a plain $match: Prisma sends `in` as $expr, which no index bounds (backend/AGENTS.md rule 3). Tags and decisions are
 * never quieted here, and nothing is read when no reply is pushed.
 */
export async function quietRepeats(db: PrismaClient, notices: PhoneNotice[]): Promise<PhoneNotice[]> {
  const threads = new Map<string, PhoneNotice[]>()
  for (const notice of notices) {
    if (notice.thread && !notice.quiet) threads.set(notice.slot, [...threads.get(notice.slot) ?? [], notice])
  }
  if (!threads.size) return notices
  const quiet = new Set<PhoneNotice>()
  for (const group of threads.values()) {
    const { tabId, conversationId, threadId } = group[0]!.thread!
    const latest = Math.max(...group.map(n => n.thread!.at))
    const rows = await db.superTabActivity.aggregateRaw({ pipeline: [
      { $match: { tabId, personId: { $in: [...new Set(group.map(n => n.personId))] }, conversationId, threadId, kind: 'reply', readAt: null,
        createdAt: { $lt: { $date: new Date(latest).toISOString() } } } },
      { $project: { _id: 1, personId: 1, createdAt: 1 } },
    // The thread's rows, read or not, are a few; the person's unread rows (the digest's index, which the planner may race
    // it against) can be hundreds across the Swarm.
    ], options: { hint: THREAD_INDEX } }) as unknown as Unread[]
    const earlier = (n: PhoneNotice) => rows.some(row => row.personId === n.personId && row._id !== n.thread!.rowId
      && Date.parse(row.createdAt?.$date ?? '') < n.thread!.at)
    const first = new Map<string, PhoneNotice>()
    for (const notice of [...group].sort((a, b) => a.thread!.at - b.thread!.at)) {
      if (earlier(notice) || first.has(notice.personId)) quiet.add(notice)
      else first.set(notice.personId, notice)
    }
  }
  return notices.map(notice => quiet.has(notice) ? { ...notice, quiet: true as const } : notice)
}
