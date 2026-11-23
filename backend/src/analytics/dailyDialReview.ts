import type { PrismaClient } from '@prisma/client'
import { DIAL_FIRST_AGENT_BUCKETS, DIAL_OPEN_FAILURES, DIAL_OTHER_APPS, DIAL_RECOGNITION, DIAL_USAGE_ENGINES, DIAL_USAGE_HOSTS,
  DIAL_USAGE_METRICS, DIAL_VOICE_FAILURES, DIAL_VOICE_OUTCOMES, DIAL_WAIT_BUCKETS } from '../types/dialUsage.js'
import { VOICE_USAGE_METRICS } from '../lib/voiceUsage.js'

/** The `dial` section of usage:daily (docs/plans/2026-11-23-dial-usage-counts-design.md, "Daily review"). */
type Row = { dayUtc: Date; metric: string; value: number }
type Count = number | '<5'
export type Cells = { day: Count; d7: Count; d28: Count }
type Raw = { day: number; d7: number; d28: number }
type Column = keyof Raw
type Measure = (column: Column) => number
type Day = Record<string, number>
/** A computer count and what the "<5" rule tests. Computer-days add up, one computer every day of a week to 7, so a 7- or
 * 28-day column is tested by its largest single day; a period flag or a once-ever count is distinct computers already. */
type Computers = { cells: Measure; fewest: Measure }
export type Section = { name: string; rows: Array<{ name: string; computers: Cells; events?: Cells }> }

const DAY = 86_400_000
// The design's read cost: 28 days of totals at most (Design 3).
const READ_DAYS = 28
const SPAN: Raw = { day: 1, d7: 7, d28: 28 }
const COLUMNS = Object.keys(SPAN) as Column[]
// At G1 30-50 computers, many of them the team's: a smaller cell is a person (design, "Small numbers also identify").
const FEWEST = 5
const RETURN_DAYS = [1, 7, 28] as const
// A return is counted on its return day N+L and rated against the used day N, L days earlier: an N+28 return in the
// 28-day column needs used days 29-56 days back, so they read 28 days more than the rest (Design 3).
const COHORT_NAMES = new Set<string>(['dial_used_installation_days', 'dial_used_outside_app_installation_days'])
const COHORT_READ_DAYS = READ_DAYS + Math.max(...RETURN_DAYS)
const NAMES = new Set<string>([...DIAL_USAGE_METRICS, ...VOICE_USAGE_METRICS, 'health_cli_collector_days'])
/** [names], outside the team and the team's (`staff:`, `testing:`; lib/productUsage.ts apartPrefixes). */
const withTeam = (names: Set<string>) => [...names].flatMap(name => [name, `staff:${name}`, `testing:${name}`])
/** Every dial and voice name, outside the team and the team's. */
export const DIAL_REVIEW_METRICS = withTeam(NAMES)

/** The 28 complete days before [now] of DIAL_REVIEW_METRICS, and the 28 before those of the used days. Plain `$match`es:
 * Prisma sends `in` as `$expr`, which no index bounds (backend/AGENTS.md rule 3). Bounded by the (day, name) unique index:
 * one row a day and name at most. */
export async function readDialRows(db: Pick<PrismaClient, 'productUsageTotal'>, now: Date): Promise<Row[]> {
  const today = Math.floor(now.getTime() / DAY) * DAY
  const read = async (fromDays: number, toDays: number, metrics: string[]) => await db.productUsageTotal.aggregateRaw({ pipeline: [
    { $match: { dayUtc: { $gte: { $date: new Date(today - fromDays * DAY).toISOString() }, $lt: { $date: new Date(today - toDays * DAY).toISOString() } },
      metric: { $in: metrics } } },
    { $project: { _id: 0, day: { $dateToString: { date: '$dayUtc', format: '%Y-%m-%d', timezone: 'UTC' } }, metric: 1, value: 1 } },
  ], options: { maxTimeMS: 15_000, allowDiskUse: false } }) as unknown as Array<{ day: string; metric: string; value: number }>
  const rows = (await Promise.all([read(READ_DAYS, 0, DIAL_REVIEW_METRICS), read(COHORT_READ_DAYS, READ_DAYS, withTeam(COHORT_NAMES))])).flat()
  return rows.map(row => ({ dayUtc: new Date(row.day), metric: row.metric, value: row.value }))
}

/** [cells] with each column under five computers, by [computers], shown as "<5". */
function shown(computers: Raw, cells: Raw): Cells {
  return Object.fromEntries(COLUMNS.map(k => [k, computers[k] < FEWEST ? '<5' : cells[k]])) as Cells
}
const raw = (measure: Measure): Raw => ({ day: measure('day'), d7: measure('d7'), d28: measure('d28') })
const distinct = (cells: Measure): Computers => ({ cells, fewest: cells })
const of = (metric: string) => (day: Day) => day[metric] ?? 0

export function dailyDialReview(rows: Row[], breakdowns: Row[], now: Date) {
  const today = Math.floor(now.getTime() / DAY) * DAY
  const outside = new Map<number, Day>(), team = new Map<number, Day>()
  for (const row of rows) {
    const stamp = row.dayUtc.getTime()
    if (!Number.isSafeInteger(row.value) || row.value < 0 || stamp >= today) continue
    const [, prefix, name] = /^(staff:|testing:)?(.*)$/.exec(row.metric)!
    if (!NAMES.has(name!) || stamp < today - (COHORT_NAMES.has(name!) ? COHORT_READ_DAYS : READ_DAYS) * DAY) continue
    const days = prefix ? team : outside, c = days.get(stamp) ?? {}
    c[name!] = (c[name!] ?? 0) + row.value; days.set(stamp, c)
  }
  /** [value] over [column]'s complete days, [lag] days earlier (the used days a return is rated against), added up; with
   * [most], its largest single day. */
  const over = (days: Map<number, Day>, value: (day: Day) => number, column: Column, lag = 0, most = false) => {
    let n = 0
    for (let i = 1; i <= SPAN[column]; i++) {
      const v = value(days.get(today - (i + lag) * DAY) ?? {})
      n = most ? Math.max(n, v) : n + v
    }
    return n
  }

  const sections = (days: Map<number, Day>): Section[] => {
    const sum = (metric: string, lag = 0): Measure => column => over(days, of(metric), column, lag)
    const computerDays = (metric: string, lag = 0): Computers =>
      ({ cells: sum(metric, lag), fewest: column => over(days, of(metric), column, lag, true) })
    // Dial used: the day's flag, then the period flags, which count a computer once a period (Decision 3).
    const period = (flag: string, week: string, days28: string): Computers => distinct(column =>
      over(days, of(column === 'day' ? flag : column === 'd7' ? week : days28), column))
    const line = (name: string, computers: Computers, events?: Measure) => {
      const c = raw(computers.cells), e = events && raw(events), fewest = raw(computers.fewest)
      if (![c, e].some(r => r && COLUMNS.some(k => r[k] > 0))) return []
      return [{ name, computers: shown(fewest, c), ...e ? { events: shown(fewest, e) } : {} }]
    }
    const voiced = computerDays('dial_voice_installation_days'), opened = computerDays('dial_open_installation_days')
    const used = 'dial_used_installation_days', usedOutside = 'dial_used_outside_app_installation_days'
    return [
      { name: 'Who uses a dial', rows: [
        ...line('Connected (computer-days)', computerDays('dial_connected_installation_days')),
        ...line('Connected outside the app (computer-days)', computerDays('dial_connected_outside_app_installation_days')),
        ...line('Used (day: computers; 7 and 28 days: distinct computers)',
          period(used, 'dial_used_week_installations', 'dial_used_28d_installations')),
        ...line('Used outside the app (day: computers; 7 and 28 days: distinct computers)',
          period(usedOutside, 'dial_used_outside_app_week_installations', 'dial_used_outside_app_28d_installations')),
        // Once ever per computer, so its sums are distinct computers already.
        ...line('First use ever (distinct computers)', distinct(sum('dial_first_use_installations'))),
        ...line('First use ever outside the app (distinct computers)', distinct(sum('dial_first_use_outside_app_installations'))),
      ] },
      { name: 'First agent on the dial, from a dial connected with an agent running', rows: [
        ...DIAL_FIRST_AGENT_BUCKETS.flatMap(b => line(`First connection ever: ${b}`, distinct(sum(`dial_first_agent_first_${b}_installations`)))),
        ...DIAL_FIRST_AGENT_BUCKETS.flatMap(b => line(`Day's first connection: ${b}`, computerDays(`dial_first_agent_day_${b}_installations`))),
      ] },
      { name: 'Engines shown (agents capped per computer a day)',
        rows: DIAL_USAGE_ENGINES.flatMap(e => line(e, computerDays(`dial_engine_${e}_installation_days`), sum(`dial_engine_${e}_agents`))) },
      { name: 'Hosts shown (agents capped per computer a day)',
        rows: DIAL_USAGE_HOSTS.flatMap(h => line(h, computerDays(`dial_host_${h}_installation_days`), sum(`dial_host_${h}_agents`))) },
      { name: 'Hooked agents found, by engine (hooked engines only)', rows: DIAL_USAGE_ENGINES.flatMap(e =>
        DIAL_RECOGNITION.flatMap(r => line(`${e}: ${r}`, computerDays(`dial_hooked_${e}_installation_days`), sum(`dial_hooked_${e}_${r}`)))) },
      { name: 'The Other page, by app',
        rows: DIAL_OTHER_APPS.flatMap(a => line(a, computerDays(`dial_other_app_${a}_installation_days`), sum(`dial_other_app_${a}_agents`))) },
      { name: 'Voice to an agent', rows: [
        ...DIAL_VOICE_OUTCOMES.flatMap(o => line(o, voiced, sum(`dial_voice_${o}`))),
        ...DIAL_VOICE_FAILURES.flatMap(f => line(`failed: ${f}`, voiced, sum(`dial_voice_failed_${f}`))),
        ...DIAL_USAGE_HOSTS.flatMap(h => DIAL_VOICE_OUTCOMES.flatMap(o =>
          line(`${h}: ${o}`, computerDays(`dial_voice_host_${h}_installation_days`), sum(`dial_voice_host_${h}_${o}`)))),
      ] },
      { name: 'Tap to open', rows: [
        ...(['ok', 'failed'] as const).flatMap(o => line(o, opened, sum(`dial_open_${o}`))),
        ...DIAL_OPEN_FAILURES.flatMap(f => line(`failed: ${f}`, opened, sum(`dial_open_failed_${f}`))),
        ...DIAL_USAGE_HOSTS.flatMap(h => (['ok', 'failed'] as const).flatMap(o =>
          line(`${h}: ${o}`, computerDays(`dial_open_host_${h}_installation_days`), sum(`dial_open_host_${h}_${o}`)))),
      ] },
      // Decision 1: a computer with no dial runs no devices component, so the comparison is within dial computers.
      { name: 'Wait for the person: days a dial was used against days it was connected and not used', rows: [
        ...DIAL_WAIT_BUCKETS.flatMap(b => line(`Dial-used days, answered on the dial: ${b}`,
          computerDays('dial_wait_used_day_installation_days'), sum(`dial_wait_used_day_dial_${b}`))),
        ...DIAL_WAIT_BUCKETS.flatMap(b => line(`Dial-used days, answered elsewhere: ${b}`,
          computerDays('dial_wait_used_day_installation_days'), sum(`dial_wait_used_day_elsewhere_${b}`))),
        ...line('Dial-used days, no answer', computerDays('dial_wait_used_day_installation_days'), sum('dial_wait_used_day_none')),
        ...DIAL_WAIT_BUCKETS.flatMap(b => line(`Connected, not-used days, answered elsewhere: ${b}`,
          computerDays('dial_wait_unused_day_installation_days'), sum(`dial_wait_unused_day_elsewhere_${b}`))),
        ...line('Connected, not-used days, no answer', computerDays('dial_wait_unused_day_installation_days'), sum('dial_wait_unused_day_none')),
      ] },
      { name: 'Wrong agent (proxies, not proof)', rows: [
        ...line('Voice, then voice to another agent within 30 s', voiced, sum('dial_voice_redirected_30s')),
        ...line('Delivered voice interrupted within 10 s (hooked agents)', voiced, sum('dial_voice_interrupted_10s')),
        ...DIAL_USAGE_HOSTS.flatMap(h => [
          ...line(`${h}: voice to another agent within 30 s`, computerDays(`dial_voice_host_${h}_installation_days`), sum(`dial_voice_host_${h}_redirected_30s`)),
          ...line(`${h}: interrupted within 10 s`, computerDays(`dial_voice_host_${h}_installation_days`), sum(`dial_voice_host_${h}_interrupted_10s`)),
        ]),
      ] },
      // The gateway counts a return on its return day N+L: each column's returns against the used days L days earlier.
      { name: 'Return (day, d7 and d28 are return days N+L; day N is L days earlier)', rows: RETURN_DAYS.flatMap(lag => [
        ...line(`Used on day N (N+${lag} complete)`, computerDays(used, lag)),
        ...line(`Again on N+${lag}`, computerDays(`dial_d${lag}_returning_installations`)),
        ...line(`Used outside the app on day N (N+${lag} complete)`, computerDays(usedOutside, lag)),
        ...line(`Outside the app, again on N+${lag}`, computerDays(`dial_d${lag}_returning_outside_app_installations`)),
      ]) },
    ].filter(section => section.rows.length)
  }

  const voice = (days: Map<number, Day>) => {
    const cells = (value: (day: Day) => number) => raw(column => over(days, value, column))
    // Account-days add up as computer-days do: a 7- or 28-day column is tested by its largest day.
    const fewest = (value: (day: Day) => number) => raw(column => over(days, value, column, 0, true))
    const bucket = (value: (day: Day) => number) => shown(fewest(value), cells(value))
    const less = (a: (day: Day) => number, b: (day: Day) => number) => (day: Day) => Math.max(0, a(day) - b(day))
    const minutes = (ms: Raw): Raw => ({ day: Math.round(ms.day / 6000) / 10, d7: Math.round(ms.d7 / 6000) / 10, d28: Math.round(ms.d28 / 6000) / 10 })
    const accounts = of('voice_account_days'), over1m = of('voice_account_days_over_1m')
    const over5m = of('voice_account_days_over_5m'), over20m = of('voice_account_days_over_20m')
    const dialComputers = of('dial_voice_installation_days')
    const totals = (surface: 'dial' | 'rest', computers: Raw) => ({ clips: shown(computers, cells(of(`voice_${surface}_clips`))),
      audioMinutes: shown(computers, minutes(cells(of(`voice_${surface}_audio_ms`)))),
      transcribeMinutes: shown(computers, minutes(cells(of(`voice_${surface}_transcribe_ms`)))) })
    return { note: 'Voice from older CLIs counts as the rest until they update.',
      accountDays: { label: 'All voice on the account, dial and the rest: account-days by audio a day.',
        all: bucket(accounts), under1m: bucket(less(accounts, over1m)), m1to5: bucket(less(over1m, over5m)),
        m5to20: bucket(less(over5m, over20m)), over20m: bucket(over20m) },
      // The dial's totals by its own computers. The rest's, the phone and older CLIs, by the accounts with voice less the
      // dial's computers: five dial accounts and one phone would otherwise show that one person's phone.
      dial: totals('dial', fewest(dialComputers)), rest: totals('rest', fewest(less(accounts, dialComputers))) }
  }

  // Release and platform, each on its own (no cross product), where the day's collectors reach the health review's 20.
  const margins = new Map<string, { day: number; dimension: 'platform' | 'release'; bucket: string; collectors: number; used: number }>()
  for (const row of breakdowns) {
    const m = /^breakdown:(release|platform):cli:([^:]+):(dial_used_installation_days|health_cli_collector_days)$/.exec(row.metric)
    const day = row.dayUtc.getTime()
    if (!m || day >= today || !Number.isSafeInteger(row.value) || row.value < 0) continue
    const key = `${day}:${m[1]}:${m[2]}`
    const margin = margins.get(key) ?? { day, dimension: m[1] as 'platform' | 'release', bucket: m[2]!, collectors: 0, used: 0 }
    if (m[3] === 'health_cli_collector_days') margin.collectors += row.value
    else margin.used += row.value
    margins.set(key, margin)
  }
  const margin = (dimension: 'platform' | 'release') => [...margins.values()]
    .filter(m => m.dimension === dimension && m.collectors >= 20 && m.used > 0)
    .sort((a, b) => b.day - a.day || a.bucket.localeCompare(b.bucket))
    .map(m => ({ day: new Date(m.day).toISOString().slice(0, 10), bucket: m.bucket, computers: m.used < FEWEST ? '<5' as const : m.used }))

  /** [value] outside the team, a 7- or 28-day column tested by its largest day. */
  const outsideCells = (value: (day: Day) => number) =>
    shown(raw(column => over(outside, value, column, 0, true)), raw(column => over(outside, value, column)))
  return {
    limits: [
      'Signed-in computers only: voice needs a sign-in, so these lean to voice users and are not all dial users.',
      'Agents found covers hooked engines only: an agent with no hook is invisible to the dial and to these counts.',
      'Computer counts are computer-days unless a row says distinct computers; event counts beside them are not people.',
      'Distinct computers count a computer once a Monday week or fixed 28-day period, on its first use in it: a column across two periods can count it twice, or miss it when that first use fell before the column.',
      "A clip carries no build, so a testing: build's dial clips count outside the team.",
      'Any cell under 5 computers, and the events beside it, shows "<5"; a 7- or 28-day column of computer-days goes by its largest day.',
      'day is the last complete UTC day; d7 and d28 the 7 and 28 complete days before today.',
    ],
    coverage: outsideCells(of('health_cli_collector_days')),
    // Too large or misshapen, once a computer a day: while it is, that computer's dial counts are not sent.
    fileUnreadable: { name: "Devices' file unreadable (computer-days)", computers: outsideCells(of('dial_file_unreadable_installation_days')) },
    outsideTeam: sections(outside), team: sections(team),
    voice: { outsideTeam: voice(outside), team: voice(team) },
    margins: { platform: margin('platform'), release: margin('release') },
  }
}
