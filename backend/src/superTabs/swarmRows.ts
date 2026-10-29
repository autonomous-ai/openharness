import type { Prisma } from '@prisma/client'
import { readBy } from './parts/indexed.js'
import { ms } from './parts/light.js'

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

/**
 * The ids of up to `limit` Swarms in parts that list `machineId`, as a machine or for its cleanup, most recently written
 * first. Two reads on the machine indexes: through Prisma, the `has` OR `has` was one $expr the planner bounded by the
 * environment alone, 17 Swarms examined per one returned on the host poll (roadmap Phase 3.1).
 */
export async function machineSwarms(db: Transaction, autonomousEnv: string, machineId: string, limit: number): Promise<string[]> {
  const read = (index: 'machines' | 'cleanup', field: 'machineIds' | 'cleanupMachineIds') => readBy(db, 'SuperTab', index, [
    { $match: { autonomousEnv, [field]: machineId, format: 2 } }, { $sort: { updatedAt: -1 } }, { $limit: limit }, { $project: { updatedAt: 1 } }])
  const newest = new Map<string, number>()
  for (const row of [...await read('machines', 'machineIds'), ...await read('cleanup', 'cleanupMachineIds')]) {
    newest.set(row._id as string, Math.max(newest.get(row._id as string) ?? 0, ms(row.updatedAt)))
  }
  return [...newest].sort(([a, at], [b, bt]) => bt - at || (a < b ? -1 : 1)).slice(0, limit).map(([id]) => id)
}

/** Of these Swarm ids, those in `autonomousEnv`: a plain $in on the id index, never Prisma's $expr $or of each id. */
export async function swarmsIn(db: Transaction, autonomousEnv: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return []
  return (await readBy(db, 'SuperTab', 'id', [{ $match: { _id: { $in: ids }, autonomousEnv } }, { $project: { _id: 1 } }])).map(row => row._id as string)
}
