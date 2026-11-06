import type { Prisma } from '@prisma/client'
import { readBy } from './parts/indexed.js'

/** One covered range for the singleton worker: old/dormant cards still keep their deadline. */
export async function dueProposalCards(db: Prisma.TransactionClient, now: number, limit = 200): Promise<Array<{ tabId: string; key: string }>> {
  const rows = await readBy(db, 'SwarmGroup', 'proposalDue', [
    { $match: { deleted: false, proposalDueAt: { $gt: { $date: new Date(0).toISOString() }, $lte: { $date: new Date(now).toISOString() } } } },
    { $sort: { proposalDueAt: 1, tabId: 1, key: 1 } }, { $limit: Math.max(1, Math.min(limit, 200)) },
    { $project: { _id: 0, tabId: 1, key: 1 } },
  ])
  return rows.map(row => ({ tabId: row.tabId as string, key: row.key as string }))
}
