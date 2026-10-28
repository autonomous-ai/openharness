import type { Prisma, SuperTabDelivery } from '@prisma/client'
import { ms } from './parts/light.js'
import type { ReactionRow } from './reactions.js'

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
