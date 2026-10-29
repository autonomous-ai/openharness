import type { Prisma } from '@prisma/client'
import { readBy } from './parts/indexed.js'

type Transaction = Prisma.TransactionClient

// SuperTab rows found by who is in them. Prisma sends `memberIds: { has }` as $expr, which bounds only the autonomousEnv
// prefix: each list read examined every Swarm of the environment (roadmap Phase 3.3). These name the member index, so they
// examine only the person's Swarms, and take them off it in id order without a sort (integration/superTabNamedReads.test.ts).

export interface MemberSwarm { id: string; ownerId: string; revision: number; format: number; workspaceId: string | null }

/** The Swarms `userId` is in, by id after `after`, up to `limit` (all without one), with the fields lists show; only
 *  `workspaceId`'s when given. */
export async function memberSwarms(db: Transaction, autonomousEnv: string, userId: string,
  page: { after?: string; limit?: number; workspaceId?: string }): Promise<MemberSwarm[]> {
  const rows = await readBy(db, 'SuperTab', 'members', [
    { $match: { autonomousEnv, memberIds: userId, ...page.after ? { _id: { $gt: page.after } } : {},
      ...page.workspaceId ? { workspaceId: page.workspaceId } : {} } },
    { $sort: { _id: 1 } }, ...page.limit ? [{ $limit: page.limit }] : [], { $project: { ownerId: 1, revision: 1, format: 1, workspaceId: 1 } }])
  // A Swarm stored before `format` existed is whole in `state` (schema default 1); one from before Workspaces has none.
  return rows.map(row => ({ id: row._id as string, ownerId: row.ownerId as string, revision: Number(row.revision ?? 0),
    format: Number(row.format ?? 1), workspaceId: (row.workspaceId ?? null) as string | null }))
}
