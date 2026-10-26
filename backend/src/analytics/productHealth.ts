import { PRODUCT_USAGE_METRICS, PRODUCT_USAGE_SETUP_METRICS, PRODUCT_USAGE_ACTIONS } from '../types/productUsage.js'
import { cleanUsageContext, type ProductUsageContext } from '../types/productHealthContract.js'

const allowed = new Set<string>(PRODUCT_USAGE_METRICS)
// Read from the margins too, though not reported by the clients: the relay's count of the phone's opens by release
// (lib/dailyTracking.ts mobileOpenMetrics), which shares the phone's release label and its coverage threshold.
const readableMargins = new Set<string>([...PRODUCT_USAGE_METRICS, 'relay_mobile_opens'])
// Two marginal tables in the existing expiring total store. No release/platform cross-product,
// account joins, per-report rows, or arbitrary attributes survive ingestion.
export function healthBreakdowns(context: ProductUsageContext | undefined, metric: string): string[] {
  const c = cleanUsageContext(context)
  if (!c || c.channel !== 'production' || !allowed.has(metric)) return []
  // Backdated returns describe an earlier cohort; the current reporting release did not enroll it.
  if (/^(d\d+_returning_|first_launch_(work|response)_24h_|health_cli_(first_work_d\d+_return|week_worked_))/.test(metric)) return []
  return [`breakdown:release:${c.surface}:${c.release}:${metric}`, `breakdown:platform:${c.surface}:${c.platform}:${metric}`]
}

type Row = { dayUtc: Date; metric: string; value: number }
export function dailyProductHealth(rows: Row[], now: Date) {
  const today = now.toISOString().slice(0, 10)
  const readable = new Set<string>([...PRODUCT_USAGE_METRICS, ...PRODUCT_USAGE_SETUP_METRICS])
  const days = new Map<string, Record<string, number>>()
  const groups = new Map<string, { day: string; dimension: string; surface: string; bucket: string; counters: Record<string, number> }>()
  for (const row of rows) {
    if (!Number.isSafeInteger(row.value) || row.value < 0) continue
    const day = row.dayUtc.toISOString().slice(0, 10)
    if (readable.has(row.metric)) {
      const c = days.get(day) ?? {}; c[row.metric] = (c[row.metric] ?? 0) + row.value; days.set(day, c)
    } else {
      const m = /^breakdown:(release|platform):(cli|desktop|phone):([^:]+):(.+)$/.exec(row.metric)
      if (!m || !readableMargins.has(m[4])) continue
      const context = cleanUsageContext({ surface: m[2], release: m[1] === 'release' ? m[3] : 'unknown',
        platform: m[1] === 'platform' ? m[3] : 'other', channel: 'production' })
      if (!context || (m[1] === 'release' && context.release !== m[3])) continue
      const key = `${day}:${m[1]}:${m[2]}:${m[3]}`
      const g = groups.get(key) ?? { day, dimension: m[1], surface: m[2], bucket: m[3], counters: {} }
      g.counters[m[4]] = (g.counters[m[4]] ?? 0) + row.value; groups.set(key, g)
    }
  }
  const daily = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, c]) => ({
    day, complete: day < today,
    coverage: { cli: c.health_cli_collector_days ?? null, desktopSessions: c.health_desktop_collector_days ?? null,
      phoneSessions: c.health_phone_collector_days ?? null },
    requestReconciliation: PRODUCT_USAGE_ACTIONS.map(action => {
      const starts = c[`${action}_requests`] ?? null
      const outcomes = ['ok', 'failed', 'pending', 'unknown'].reduce((sum, outcome) => sum + (c[`${action}_${outcome}`] ?? 0), 0)
      return { action, starts, outcomes: starts === null ? null : outcomes,
        difference: starts === null ? null : starts - outcomes,
        interpretation: 'Start and result reports can arrive separately or cross a choice/day boundary. A difference is incomplete observation, not a failed action.' }
    }),
    signals: Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith('health_') || k.startsWith('request_'))),
    activation: ['setup_desktop', 'health_desktop', 'health_tui'].map(prefix => ({
      population: prefix === 'setup_desktop' ? 'Voluntary signed-out setup episodes'
        : prefix === 'health_tui' ? 'Consented signed-in hn sessions' : 'Consented signed-in app sessions',
      milestones: Object.fromEntries(['setup_seen', 'sign_in_seen', 'workspace_ready', 'first_work', 'first_response'].map(step => [step, c[`${prefix}_funnel_${step}`] ?? null])),
      waitBuckets: Object.fromEntries(['first_work', 'first_response'].flatMap(step => ['under_1m', '1m_to_5m', 'over_5m'].map(bucket => [`${step}_${bucket}`, c[`${prefix}_${step}_${bucket}`] ?? null]))),
      definition: 'Locally deduplicated episodes, not a joined per-person funnel. Stages can cross UTC days; no daily conversion ratio is inferred.',
    })),
    firstRun: firstRunActivation(c, Date.parse(day) + 2 * 86400000 <= Date.parse(today)),
    firstWorkRetention: [1, 7, 28].map(lag => {
      const mature = Date.parse(day) + (lag + 1) * 86400000 <= Date.parse(today)
      const denominator = c.health_cli_first_interactive_work ?? null
      const followUp = days.get(new Date(Date.parse(day) + lag * 86400000).toISOString().slice(0, 10))
      const observable = !!followUp?.health_cli_collector_days
      const returned = mature && observable && denominator ? c[`health_cli_first_work_d${lag}_return`] ?? 0 : null
      return { lag, mature, followUpObserved: observable, denominator, returned,
        percent: returned !== null && denominator && returned <= denominator ? Math.round(1000 * returned / denominator) / 10 : null }
    }),
  }))
  const breakdowns = [...groups.values()].flatMap(group => {
    const coverage = group.counters[`health_${group.surface}_collector_days`] ?? 0
    // Suppress the label as well as values. Session/installation observations are not distinct people;
    // this threshold limits sparse disclosure but is deliberately not described as k-anonymity.
    if (coverage < 20) return []
    return [{ ...group, coverage, partial: group.day === today }]
  })
  return { daily, breakdowns, sparseBreakdownsSuppressed: groups.size - breakdowns.length,
    definitions: {
      attribution: 'Release and platform are separate aggregate margins. Development-context reports are excluded. Old clients have unknown context; version comparison alone cannot establish causality.',
      sources: 'app/tool describe the request transport; automatic identifies fixed polling operations. Only explicitly marked composer submissions establish interactive work. Raw terminal work remains unclassified.',
      retention: 'Return after first measured interactive work on this installation, not signup retention; resets and missing reports affect coverage.',
      stability: 'Unclean prior runs can be force quits or power loss, not proven crashes. Resource buckets cover the measured process only. Main-frame load is not a judgment of rendered content.',
      timing: 'App start is process launch to first consented observation of a connected workspace; sign-in and preference delay are included. One in 60 rendered frames is sampled; idle freezes and exits before reporting can be missed.',
      habit: 'Weekly work-day bins describe completed UTC weeks from installations that report again; non-returners may be missing. First-work returns are specific to explicitly marked composer work, not all human activity.',
      privacy: 'Fixed aggregate totals; no identity or content joins. Sparse margins require 20 collector observations, which are not 20 distinct people. No guarantee of anonymity is inferred from that threshold.',
    } }
}

/** All stages belong to the start day of one first-arrival app episode. A routine app
 * launch never enrolls; retries in that episode do not add another denominator. */
export function firstRunActivation(c: Record<string, number>, mature: boolean) {
  const started = c.health_desktop_first_run_started ?? null
  const response = started === null ? null : c.health_desktop_first_run_response ?? 0
  return {
    started,
    ready: started === null ? null : c.health_desktop_first_run_ready ?? 0,
    work: started === null ? null : c.health_desktop_first_run_work ?? 0,
    response,
    responsePercent: started && response !== null && response <= started
      ? Math.round(1000 * response / started) / 10 : null,
    responseUnder1m: c.health_desktop_first_run_response_under_1m ?? null,
    response1mTo5m: c.health_desktop_first_run_response_1m_to_5m ?? null,
    responseOver5m: c.health_desktop_first_run_response_over_5m ?? null,
    mature,
    definition: 'Consented first-arrival app episodes reaching a live response in the opened harness, within the same app run and at most 24 hours. Counts belong to the start day; retries share its denominator. Not unique people, all installs, task completion or a cross-restart 24-hour cohort. Immature days and delivery loss are provisional.',
  }
}
