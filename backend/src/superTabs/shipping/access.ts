import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { SuperTabError } from '../model.js'
import { readBy } from '../parts/indexed.js'

/** The Swarm's people, which a deleted Swarm has none of. */
export type Members = ReadonlySet<string>

/**
 * The people of the Swarm, for a reader or a reporter who must be one of them. A Swarm that does not exist, one that was deleted
 * (it lists nobody) and one that does not list the person all get the one answer, as every Swarm route gives it (routes/
 * superTabs.ts NOT_AVAILABLE): it never says which.
 */
export async function membersOf(db: PrismaClient, user: AuthUser, tabId: string): Promise<Members> {
  const [row] = await readBy(db, 'SuperTab', 'id', [{ $match: { _id: tabId } }, { $project: { memberIds: 1, autonomousEnv: 1 } }])
  const members = new Set(Array.isArray(row?.memberIds) ? row.memberIds as string[] : [])
  if (!row || row.autonomousEnv !== user.autonomousEnv || !members.has(user.sub)) {
    throw new SuperTabError('NOT_FOUND', 'This is not available to you. It may have been removed, or your access changed.', 404, true)
  }
  return members
}
