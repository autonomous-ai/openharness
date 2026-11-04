/** Loading for the leaderboard read (read/service.ts): the dormant groups of the weeks it sums. */
import type { Prisma } from '@prisma/client'
import type { Conversation } from '../model.js'
import { fail } from '../model.js'
import type { CacheView } from '../cache.js'
import { boardRule } from '../cachePatch.js'
import { indexOrder, lastActive, loadBoardGroups } from './boardGroups.js'
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

/** The quiet conversations of these projects last active since [since], board fields only (boardGroups.ts): a request shipped
 *  in a week the board sums wrote its Done row then. Through the read cache (cachePatch.ts boardRule): held from the Monday the
 *  window starts in, patched from each change, so a board read at an unchanged stamp reads none (task #2674). Answered in the
 *  project index's order, as the read straight from Mongo gives them. */
export async function recentDormantGroups(tx: Prisma.TransactionClient, cached: CacheView, tabId: string, projectId: string | string[],
  since: number): Promise<Conversation[]> {
  const projects = [...new Set([projectId].flat())].sort()
  const floor = weekStart(since)
  const held = await cached.get(tabId, `board:${floor}:${projects.join(',')}`, 'main', () => loadBoardGroups(tx, tabId, projects, floor),
    boardRule(projects, floor))
  return held.filter(p => lastActive(p.data!) >= since).sort(indexOrder).map(p => {
    const { lastActivityAt: _lastActivityAt, ...data } = p.data!
    return data as Conversation
  })
}

/** The profile names of the board's people (contract.ts displayName), one read by id for the few people of a Swarm. A member id
 *  that is not an account id (an older fixture) has no name and goes by its email. */
export async function profileNames(tx: Prisma.TransactionClient, personIds: string[]): Promise<Map<string, string>> {
  const ids = personIds.filter(id => /^[0-9a-f]{24}$/.test(id))
  if (!ids.length) return new Map()
  const rows = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
  return new Map(rows.flatMap(row => row.name ? [[row.id, row.name] as const] : []))
}
