import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'

// Ken's prod profile (2026-10-28): a person's invitation list spent 313 ms planning its SuperTab read. Prisma sends
// `invitedEmails: { has }` as $expr, which bounds only the autonomousEnv prefix every SuperTab index shares: the planner raced
// them all and picked the _id index, reading every Swarm of the environment. This read is a plain match that names the
// invitedEmails index, so it is never planned and examines only the Swarms that invite the person. Prisma sorted by id before
// its cap; the index holds each address's Swarms in id order, so the same first 100 come off it without a sort
// (integration/superTabInvitationPlans.test.ts).

/** The SuperTab index the read names, as prisma/schema.prisma declares it. */
const INVITED = { autonomousEnv: 1, invitedEmails: 1, _id: 1 }

/** The first `limit` Swarms by id of `autonomousEnv` with a pending invitation for `email` (already lowercased), as Prisma read them. */
export async function invitedSwarms(db: Pick<PrismaClient, 'superTab'>, autonomousEnv: string, email: string, limit: number):
  Promise<Array<{ id: string; format: number }>> {
  const pipeline = [{ $match: { autonomousEnv, invitedEmails: email } }, { $sort: { _id: 1 } }, { $limit: limit }, { $project: { format: 1 } }]
  const read = async (hint?: Record<string, number>) => await db.superTab.aggregateRaw({ pipeline, ...hint ? { options: { hint } } : {} }) as unknown as
    Array<Record<string, unknown>>
  let rows: Array<Record<string, unknown>>
  try {
    rows = await read(INVITED)
  } catch (error) {
    // A database without the index (a rollback, never pushed): naming it fails the read, which then plans as before.
    if (!/hint provided does not correspond to an existing index/.test(error instanceof Error ? error.message : String(error))) throw error
    logger.error('[swarm-reads] SuperTab lacks the invitedEmails index; invitation lists read without it', { index: INVITED })
    rows = await read()
  }
  // A Swarm stored before `format` existed is whole in `state` (schema default 1).
  return rows.map(row => ({ id: row._id as string, format: Number(row.format ?? 1) }))
}
