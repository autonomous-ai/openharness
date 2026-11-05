/** The stored scorecard days (prisma SuperTabScorecard): one row per project and local day. */
import type { Prisma, PrismaClient } from '@prisma/client'
import { stableId } from '../model.js'
import { readBy } from '../parts/indexed.js'
import { ms } from '../parts/light.js'
import type { ScorecardFigures } from './figures.js'

/** How long a project's days are kept: enough to compare a quarter of daily changes. */
export const SCORECARD_DAYS_KEPT = 120
/** The most days one read returns per project. */
export const SCORECARD_READ_DAYS = 14

export interface ScorecardDay { projectId: string; on: string; timeZone: string; figures: ScorecardFigures; computedAt: number }

export const scorecardId = (tabId: string, projectId: string, on: string): string => stableId('scorecard', tabId, projectId, on)

/** The local date `days` before `on` (YYYY-MM-DD). */
export function daysBefore(on: string, days: number): string {
  const [y, m, d] = on.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10)
}

/** Whether the project's row for `on` is stored. */
export async function hasScorecard(db: PrismaClient, tabId: string, projectId: string, on: string): Promise<boolean> {
  return !!await db.superTabScorecard.findUnique({ where: { id: scorecardId(tabId, projectId, on) }, select: { id: true } })
}

/** Stores the day by its id, so a pass that runs twice writes one row, and deletes the project's days past the kept ones. */
export async function writeScorecard(db: PrismaClient, tabId: string, day: ScorecardDay): Promise<void> {
  const id = scorecardId(tabId, day.projectId, day.on)
  await db.$runCommandRaw({ update: 'SuperTabScorecard', updates: [{ q: { _id: id }, upsert: true, u: { $set: { tabId, projectId: day.projectId, on: day.on,
    timeZone: day.timeZone, figures: day.figures as unknown as Prisma.InputJsonValue, computedAt: { $date: new Date(day.computedAt).toISOString() } } } }] })
  await db.$runCommandRaw({ delete: 'SuperTabScorecard', deletes: [{ q: { tabId, projectId: day.projectId, on: { $lt: daysBefore(day.on, SCORECARD_DAYS_KEPT) } }, limit: 0 }] })
}

/** These projects' days, newest first, at most `days` each. */
export async function readScorecards(tx: Prisma.TransactionClient, tabId: string, projectIds: string[], days = SCORECARD_READ_DAYS): Promise<ScorecardDay[]> {
  const rows: ScorecardDay[] = []
  for (const projectId of projectIds) {
    const found = await readBy(tx, 'SuperTabScorecard', 'day', [{ $match: { tabId, projectId } }, { $sort: { on: -1 } }, { $limit: days }])
    rows.push(...found.map(row => ({ projectId, on: String(row.on), timeZone: String(row.timeZone), figures: row.figures as ScorecardFigures,
      computedAt: ms(row.computedAt) })))
  }
  return rows
}
