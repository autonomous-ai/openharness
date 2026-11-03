/**
 * The board's rolling periods, Last 24h, Last 7d and Last 30d, ending now (Dee, 2026-11-02). Ship times, answers and attempts
 * have exact times. Review verdicts and Lent were kept by week only, so they are now also kept finer: verdicts by hour, Lent
 * by day. The weekly rows stay and are still written, because an older app reads weeks and a rollback needs them. What a
 * weekly row holds beyond its finer rows was recorded before those existed: it counts in full at one moment (fallsAt). It
 * ages out with its row, so nothing has to rewrite stored data.
 */
import type { ContributedMachine } from '../machines.js'
import type { GroupLedger, RanOn } from './record.js'
import { DAY_MS, WEEK_MS } from './week.js'

export const HOUR_MS = 3_600_000
export const PERIODS = ['24h', '7d', '30d'] as const
export type PeriodName = typeof PERIODS[number]
const PERIOD_MS: Record<PeriodName, number> = { '24h': DAY_MS, '7d': WEEK_MS, '30d': 30 * DAY_MS }

/** The first day finer rows were written; a weekly row of that week or later has at most that much left unsplit. */
const FINER_ROWS_SINCE = Date.UTC(2026, 10, 2)

/** [start, end). `rolling` reads the finer rows, otherwise the span is a leaderboard week and reads its weekly rows. */
export interface Span { start: number; end: number; rolling: boolean }
export const weekSpan = (week: number): Span => ({ start: week, end: week + WEEK_MS, rolling: false })

/** The period ending now, and the one of the same length before it. Last 30d has none: comparing it would need 60 days of
 *  records and twice the read, and the board keeps LEDGER_WEEKS. */
export function periodSpans(name: PeriodName, now: number): { current: Span; previous: Span | null } {
  const length = PERIOD_MS[name], end = now + 1, start = end - length
  return { current: { start, end, rolling: true }, previous: name === '30d' ? null : { start: start - length, end: start, rolling: true } }
}

export const within = (at: number, span: Span): boolean => at >= span.start && at < span.end

/** Where the unsplit part of a week's row counts: the middle of its week, or the day finer rows began if that came first, so
 *  a week that just ended is no lump in Last 24h, nor the week they began in until Sunday. Never before its week. */
const fallsAt = (week: number): number => Math.max(week, Math.min(week + WEEK_MS / 2, FINER_ROWS_SINCE))

/** What a rolling read of Lent may add: the projects it sums; and whether it may add this machine's unsplit weekly time, which
 *  names no project, so it could be a private one's. A reader gets it only for someone a board they can open already shows,
 *  as the week read does (review of #2499). */
export interface LentReach { projects: ReadonlySet<string>; unsplit: boolean }

/** A machine's busy agent time in [span]. A day's row is shared out evenly over the part of that day that has passed, so a
 *  rolling edge inside a day takes its share: the hours inside a day are not kept (a machine would hold 840 rows). What the
 *  weekly row holds beyond its days is told from all its days, the ones of projects out of reach included: otherwise their
 *  time would come back as unsplit. */
export function lentIn(machine: Pick<ContributedMachine, 'lent' | 'lentDays'>, span: Span, now: number, reach: LentReach): number {
  if (!span.rolling) return machine.lent?.find(l => l.week === span.start)?.busyMs ?? 0
  const days = machine.lentDays ?? []
  let total = 0
  for (const { day, projectId, busyMs } of days) {
    if (!reach.projects.has(projectId)) continue
    const end = Math.min(day + DAY_MS, now + 1)
    total += busyMs * Math.max(0, Math.min(end, span.end) - Math.max(day, span.start)) / Math.max(1, end - day)
  }
  if (reach.unsplit) {
    for (const { week, busyMs = 0 } of machine.lent ?? []) {
      if (!within(fallsAt(week), span)) continue
      total += Math.max(0, busyMs - days.reduce((sum, d) => sum + (d.day >= week && d.day < week + WEEK_MS ? d.busyMs : 0), 0))
    }
  }
  return Math.round(total)
}

const sameModel = (a: RanOn, b: RanOn): boolean => a.engine === b.engine && a.model === b.model && a.effort === b.effort && !!a.grid === !!b.grid

/** A group's review verdicts in [span], one entry for each stored row or unsplit weekly part. */
export function reviewsIn(ledger: Pick<GroupLedger, 'reviews' | 'reviewHours'>, span: Span): Array<RanOn & { count: number }> {
  const weeks = ledger.reviews ?? [], hours = ledger.reviewHours ?? []
  if (!span.rolling) return weeks.filter(r => r.week === span.start)
  const unsplit = weeks.filter(r => within(fallsAt(r.week), span)).map(r => ({ ...r, count: r.count
    - hours.reduce((sum, h) => sum + (h.hour >= r.week && h.hour < r.week + WEEK_MS && sameModel(h, r) ? h.count : 0), 0) }))
  return [...hours.filter(h => within(h.hour, span)), ...unsplit.filter(r => r.count > 0)]
}
