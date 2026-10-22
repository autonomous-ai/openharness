import { PRODUCT_USAGE_METRICS, PRODUCT_USAGE_SETUP_METRICS } from '../types/productUsage.js'

const DAY = 86_400_000
export const DAILY_PRODUCT_METRICS = [...PRODUCT_USAGE_METRICS, ...PRODUCT_USAGE_SETUP_METRICS,
  'relay_desktop_opens', 'relay_tui_opens', 'relay_mobile_opens', 'relay_mobile_debug_opens', 'relay_web_opens',
  'relay_harness-os_opens', 'relay_harness-os-pi_opens',
  'relay_device_connections', 'relay_machine_connections', 'relay_remote_sessions', 'relay_turns_started',
] as const
type Row = { dayUtc: Date; metric: string; value: number }
const key = (stamp: number) => new Date(stamp).toISOString().slice(0, 10)
const percentage = (n: number, d: number): number | null => d > 0 && n <= d ? Math.round(n / d * 1000) / 10 : null

/** Only additive fleet totals enter here. Missing reports never become a claim of zero users. */
export function dailyProductUsage(rows: Row[], days: number, now: Date) {
  const today = Math.floor(now.getTime() / DAY) * DAY
  const byDay = new Map<string, Record<string, number>>()
  for (const row of rows) {
    if (!DAILY_PRODUCT_METRICS.includes(row.metric as typeof DAILY_PRODUCT_METRICS[number])
        || !Number.isSafeInteger(row.value) || row.value < 0) continue
    const day = row.dayUtc.toISOString().slice(0, 10)
    const counts = byDay.get(day) ?? {}
    counts[row.metric] = (counts[row.metric] ?? 0) + row.value
    byDay.set(day, counts)
  }
  const daily = Array.from({ length: days }, (_, i) => {
    const stamp = today - (days - 1 - i) * DAY, day = key(stamp), c = byDay.get(day) ?? {}
    // Feedback and backdated cohort counters alone do not establish current-day activity coverage.
    const observed = c.active_installation_days !== undefined
    const count = (metric: string) => observed ? c[metric] ?? 0 : null
    const ended = (c.turns_ended ?? 0) + (c.turns_interrupted ?? 0)
    return { day, period: stamp === today ? 'incomplete' : 'ended; late reports possible',
      clientCoverage: observed ? 'reports received; participation unknown' : 'no client measurements',
      activeComputers: count('active_installation_days'), workingComputers: count('working_installation_days'),
      firstMeasuredWork: count('first_work_installations'), repeatWorkingComputers: count('repeat_work_installation_days'),
      workingPctOfActive: percentage(c.working_installation_days ?? 0, c.active_installation_days ?? 0),
      turnsStarted: count('turns_started'), turnsEnded: count('turns_ended'), turnsInterrupted: count('turns_interrupted'),
      interruptedPctOfObservedEnds: percentage(c.turns_interrupted ?? 0, ended),
      counters: c,
    }
  })
  const thisMonday = today - ((now.getUTCDay() + 6) % 7) * DAY
  const weekTotal = (monday: number, metric: string) => Array.from({ length: 7 }, (_, i) => byDay.get(key(monday + i * DAY))?.[metric] ?? 0).reduce((a, b) => a + b, 0)
  const priorWorkers = weekTotal(thisMonday - 14 * DAY, 'weekly_working_installations')
  const weekObserved = weekTotal(thisMonday - 7 * DAY, 'weekly_working_installations') > 0
  const returned = weekTotal(thisMonday - 7 * DAY, 'weekly_returning_installations')
  return { daily, previousCompleteWeek: {
    starting: key(thisMonday - 7 * DAY), denominatorWeekStarting: key(thisMonday - 14 * DAY),
    priorWorkingComputers: priorWorkers || null, returnedWorkingComputers: priorWorkers && weekObserved ? returned : null,
    returningPct: weekObserved ? percentage(returned, priorWorkers) : null,
    interpretation: 'Consecutive-week working computers among participating installations; not signup-cohort or person retention. Opt-outs, reinstalls and missing reports can change this estimate.',
  } }
}
