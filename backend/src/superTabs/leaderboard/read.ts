/** Loading for the leaderboard read (read/service.ts): the dormant groups of the weeks it sums. */
import type { Prisma } from '@prisma/client'
import type { Conversation } from '../model.js'
import type { AnsweredDecision, ResolvedWait } from './unblocked.js'
import { fail } from '../model.js'
import { LEDGER_WEEKS } from './record.js'
import { WEEK_MS, weekStart } from './week.js'

/** The weeks a reader can ask for: this one and the ones before it whose records are still kept. */
export function readableWeek(week: number | undefined, now: number): number {
  const current = weekStart(now)
  if (week === undefined) return current
  if (weekStart(week) !== week) fail('INVALID_WEEK', 'Ask for a week by its Monday 00:00 UTC.', 400)
  if (week > current || week <= current - (LEDGER_WEEKS - 1) * WEEK_MS) fail('INVALID_WEEK', 'Ask for this week or one of the three before it.', 400)
  return week
}

/** Dormant groups of one project active since [since]: a request shipped in a week the board sums wrote its Done row then. */
export async function recentDormantGroups(tx: Prisma.TransactionClient, tabId: string, projectId: string, since: number): Promise<Conversation[]> {
  // A group stored with no project belongs to the default one (projects.ts groupProject), as in a Swarm from before projects.
  const project = projectId === 'lead' ? { OR: [{ projectId: 'lead' }, { projectId: null }, { projectId: { isSet: false } }] } : { projectId }
  const rows = await tx.swarmGroup.findMany({ where: { tabId, deleted: false, dormant: true, lastActivityAt: { gte: new Date(since) }, ...project },
    select: { data: true } })
  return rows.map(row => row.data as unknown as Conversation)
}

/** The project's decisions answered since [since]: who answered, where and when. Never the question, options or note. */
export async function answeredDecisions(tx: Prisma.TransactionClient, tabId: string, projectId: string, since: number): Promise<AnsweredDecision[]> {
  const rows = await tx.superTabDecision.findMany({ where: { tabId, projectId, answeredAt: { gte: new Date(since) } },
    select: { batchId: true, conversationId: true, personId: true, createdAt: true, answeredAt: true } })
  return rows.map(r => ({ batchId: r.batchId, conversationId: r.conversationId, personId: r.personId, createdAt: r.createdAt.getTime(), answeredAt: r.answeredAt!.getTime() }))
}

/** Of the waits named (each the "Needs a human" row a decision asked with shares as its batch), those whose decision was
 *  answered, however long ago: whether an item still waits must not expire with the weeks the scores keep. */
export async function resolvedWaits(tx: Prisma.TransactionClient, tabId: string, batchIds: string[]): Promise<ResolvedWait[]> {
  if (!batchIds.length) return []
  return tx.superTabDecision.findMany({ where: { tabId, batchId: { in: batchIds }, answeredAt: { not: null } }, select: { batchId: true, conversationId: true },
    distinct: ['batchId'] })
}
