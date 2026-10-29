import type { Prisma, SuperTabDelivery } from '@prisma/client'
import { ms } from './parts/light.js'
import type { ReactionRow } from './reactions.js'
import { agentOnly, stableId, type Author } from './model.js'

type Transaction = Prisma.TransactionClient

// A page's rows are read by a plain {tabId, messageId: {$in}} match. Prisma sends `messageId: { in }` as an $expr $or: Mongo
// cannot bound an index by it, and on 2026-10-28 each page read scanned every delivery of its Swarm (prod at 100% CPU).
// Each read here uses its tabId+messageId index and examines only the rows it returns (integration/superTabIndexes.test.ts).

/** The reactions on one page of messages. */
export async function pageReactions(tx: Transaction, tabId: string, messageIds: string[]): Promise<ReactionRow[]> {
  return await tx.superTabReaction.aggregateRaw({ pipeline: [{ $match: { tabId, messageId: { $in: messageIds } } },
    { $project: { _id: 0, messageId: 1, emoji: 1, actorKind: 1, actorId: 1 } }] }) as unknown as ReactionRow[]
}

export type PageDelivery = Pick<SuperTabDelivery, 'id' | 'messageId' | 'agentId' | 'status' | 'receipt' | 'holdReason' | 'holdSince'
  | 'deliveredAt' | 'answeredAt' | 'createdAt' | 'updatedAt'>

/** The deliveries of one page of messages: who each message went to and how far it got. As Prisma read them: dates as
 *  Dates, and an optional field an older record lacks as null. */
export async function pageDeliveries(tx: Transaction, tabId: string, messageIds: string[]): Promise<PageDelivery[]> {
  const rows = await tx.superTabDelivery.aggregateRaw({ pipeline: [{ $match: { tabId, messageId: { $in: messageIds } } },
    { $project: { messageId: 1, agentId: 1, status: 1, receipt: 1, holdReason: 1, holdSince: 1, deliveredAt: 1, answeredAt: 1, createdAt: 1, updatedAt: 1 } }] }) as
    unknown as Array<Record<string, unknown>>
  const date = (value: unknown) => value == null ? null : new Date(ms(value))
  return rows.map(row => ({ id: row._id as string, messageId: row.messageId as string, agentId: row.agentId as string, status: row.status as string,
    receipt: (row.receipt ?? null) as string | null, holdReason: (row.holdReason ?? null) as string | null, holdSince: date(row.holdSince),
    deliveredAt: date(row.deliveredAt), answeredAt: date(row.answeredAt), createdAt: date(row.createdAt)!, updatedAt: date(row.updatedAt)! }))
}

/** An agent's open deliveries, read by creation time, with each conversation's tied rows put in its message order. One
 *  write's deliveries share a creation time, and Mongo breaks that tie by insertion order alone. Each conversation keeps its
 *  places among the others; only tied rows have their messages' sequences read. */
export async function inConversationOrder<T extends Pick<SuperTabDelivery, 'conversationId' | 'messageId' | 'createdAt'>>(
  tx: Transaction, tabId: string, rows: T[]): Promise<T[]> {
  const ties = new Map<string, number[]>()
  rows.forEach((row, index) => {
    const key = `${row.conversationId}\0${row.createdAt.getTime()}`
    ties.set(key, [...ties.get(key) ?? [], index])
  })
  const tied = [...ties.values()].filter(places => places.length > 1)
  if (!tied.length) return rows
  // Matched by id alone: with tabId in the match, the planner can cover it from the tabId+conversationId+sequence index
  // and walk every message key of the Swarm. The Swarm is checked here instead.
  const found = await tx.superTabMessage.aggregateRaw({ pipeline: [
    { $match: { _id: { $in: tied.flat().map(index => rows[index]!.messageId) } } }, { $project: { tabId: 1, sequence: 1 } }] }) as
    unknown as Array<{ _id: string; tabId: string; sequence: number }>
  const sequence = new Map(found.filter(message => message.tabId === tabId).map(message => [message._id, message.sequence]))
  const ordered = [...rows]
  for (const places of tied) {
    const group = places.map(index => rows[index]!)
      .sort((a, b) => (sequence.get(a.messageId) ?? Infinity) - (sequence.get(b.messageId) ?? Infinity))
    places.forEach((index, at) => { ordered[index] = group[at]! })
  }
  return ordered
}

/** The Lead's notices that leave a copy in a task's chat when the Lead hears them in its own chat (terminal.ts toLead). */
const LEAD_COPY_KINDS = new Set<unknown>(['work-lost', 'work-resumed'])

/** Of `rows`, the task chat copies stored before #2177 marked them (liveness.ts leadNoticeRows) whose project chat copy
 *  reached the Lead: that same notice, so read by no one either (re-check of #2177). A copy whose Lead copy reached no one,
 *  or that has none, stays shown: a person is then the only one who can act. Each Lead copy is read by its id alone, its
 *  Swarm checked here (inConversationOrder), and only when a row could be such a copy. */
export async function deliveredCopies(tx: Transaction, tabId: string, rows: ReadonlyArray<{ id: string; source: unknown; recipientIds: readonly string[] }>):
  Promise<Set<string>> {
  const copies = rows.filter(row => {
    const source = row.source as { kind?: unknown; recipientsOnly?: unknown } | null | undefined
    return !row.recipientIds.length && LEAD_COPY_KINDS.has(source?.kind) && source?.recipientsOnly !== true
  })
  if (!copies.length) return new Set()
  const leads = await tx.superTabMessage.aggregateRaw({ pipeline: [
    { $match: { _id: { $in: copies.map(row => stableId(row.id, 'lead')) } } }, { $project: { tabId: 1, recipientIds: 1 } }] }) as
    unknown as Array<{ _id: string; tabId: string; recipientIds?: string[] }>
  const reached = new Set(leads.filter(lead => lead.tabId === tabId && lead.recipientIds?.length).map(lead => lead._id))
  return new Set(copies.filter(row => reached.has(stableId(row.id, 'lead'))).map(row => row.id))
}

export interface ThreadReply { thread: string; id: string; author: Author; mentions: string[]; sequence: number; createdAt: Date; agentOnly: boolean }

/** Every message of the threads rooted at `roots` in one conversation, roots included, oldest first: what the page's thread
 *  summaries are counted from. Matched as the page reads are, so the tabId+conversationId+thread index bounds it. */
export async function pageThreads(tx: Transaction, tabId: string, conversationId: string, roots: string[]): Promise<ThreadReply[]> {
  // Sorted here: a $sort in the pipeline makes the planner walk the conversation's sequence index instead.
  const rows = await tx.superTabMessage.aggregateRaw({ pipeline: [{ $match: { tabId, conversationId, thread: { $in: roots } } },
    { $project: { thread: 1, author: 1, mentions: 1, sequence: 1, createdAt: 1, source: 1, recipientIds: 1 } }] }) as unknown as Array<Record<string, unknown>>
  const copies = await deliveredCopies(tx, tabId, rows.filter(row => row._id === row.thread)
    .map(row => ({ id: row._id as string, source: row.source, recipientIds: (row.recipientIds ?? []) as string[] })))
  return rows.map(row => ({ thread: row.thread as string, id: row._id as string, author: row.author as Author,
    mentions: (row.mentions ?? []) as string[], sequence: row.sequence as number, createdAt: new Date(ms(row.createdAt)),
    agentOnly: copies.has(row._id as string) || agentOnly(row.source, (row.recipientIds ?? []) as string[]) })).sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : 1))
}
