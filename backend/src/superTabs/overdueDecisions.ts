import type { PrismaClient } from '@prisma/client'
import { REFLECTION_DECISION } from './decisions.js'

/** A decision its person leaves unanswered this long goes to the PM (spec: Diego, 2026-11-04). The clock never restarts. */
export const OVERDUE_DECISION_MS = 24 * 60 * 60_000
/** A pass reads decisions asked within this reach: older ones are never taken, so a row that keeps failing stops being retried. */
export const OVERDUE_REACH_MS = 8 * 24 * 60 * 60_000
export const OVERDUE_PER_PASS = 500
const at = (ms: number) => ({ $date: new Date(ms).toISOString() })

/**
 * The still-waiting decisions asked in `(now - 8 days, now - 24h]`, oldest first, at most `limit` a pass. One `aggregateRaw` on the
 * `decision_waiting_created` index, never a Prisma `in` (backend/AGENTS.md). `answeredAt: null` matches a missing field too, as intended.
 * No cursor is kept: a row that fails or exceeds the cap is read again by every later pass until it is 8 days old, and a person
 * answering removes it from the index range. Routing proposals (`kind`) and withdrawn decisions are never the PM's to take.
 */
export async function overdueDecisions(db: PrismaClient, now: number, limit = OVERDUE_PER_PASS): Promise<Array<{ tabId: string; id: string; personId: string }>> {
  const rows = await db.superTabDecision.aggregateRaw({ pipeline: [
    { $match: { answeredAt: null, createdAt: { $gt: at(now - OVERDUE_REACH_MS), $lte: at(now - OVERDUE_DECISION_MS) }, withdrawn: { $ne: true }, kind: { $ne: REFLECTION_DECISION } } },
    { $sort: { createdAt: 1 } }, { $limit: limit }, { $project: { _id: 1, tabId: 1, personId: 1 } }] }) as unknown as Array<Record<string, unknown>>
  return rows.map(row => ({ tabId: String(row.tabId), id: String(row._id), personId: String(row.personId) }))
}
