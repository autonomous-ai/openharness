/** Loading for the leaderboard read (read/service.ts): the dormant groups of the weeks it sums. */
import type { Prisma } from '@prisma/client'
import type { Conversation } from '../model.js'
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

/** What the board reads of a group (stats.ts, record.ts waitsNow) and its read check (projects.ts canReadGroup). */
const BOARD_FIELDS = ['id', 'kind', 'projectId', 'audience', 'requesterId', 'reviewOf', 'archived', 'pullRequestUrls', 'ledger',
  'assignment.id', 'assignment.status'] as const

/** Dormant groups of one project active since [since]: a request shipped in a week the board sums wrote its Done row then.
 *  Only the fields the board reads: every open board reads them once a minute (Diego's issue file, 2026-10-27). */
export async function recentDormantGroups(tx: Prisma.TransactionClient, tabId: string, projectId: string, since: number): Promise<Conversation[]> {
  // A group stored with no project belongs to the default one (projects.ts groupProject), as in a Swarm from before projects;
  // a null match is a missing field too.
  const project = projectId === 'lead' ? { $or: [{ projectId: 'lead' }, { projectId: null }] } : { projectId }
  const rows = await tx.swarmGroup.aggregateRaw({ pipeline: [
    { $match: { tabId, deleted: false, dormant: true, lastActivityAt: { $gte: { $date: new Date(since).toISOString() } }, ...project } },
    { $project: { _id: 0, ...Object.fromEntries(BOARD_FIELDS.map(field => [`data.${field}`, 1])) } },
  ] }) as unknown as Array<{ data: Conversation }>
  return rows.map(row => row.data)
}
