import { ACTIVITY_SURFACES } from '../types/productUsageActivity.js'
import { PEOPLE_METRICS } from './peopleCounters.js'

const DAY = 86_400_000
type Row = { dayUtc: Date; metric: string; value: number }
type Cell = { returned: number; percent: number | null } | null

/** The `people` section of `usage:daily`: read from the rollup's anonymous totals, never the marks. */
export function dailyProductPeople(rows: Row[], days: number, now: Date) {
  const today = Math.floor(now.getTime() / DAY) * DAY
  const values = new Map<string, number>()
  for (const row of rows) if (PEOPLE_METRICS.includes(row.metric)) values.set(`${row.dayUtc.toISOString().slice(0, 10)}:${row.metric}`, row.value)
  const get = (day: string, metric: string) => values.get(`${day}:${metric}`) ?? null
  const dayList = Array.from({ length: days }, (_, i) => new Date(today - (days - i) * DAY).toISOString().slice(0, 10))
  const kinds: Record<string, string> = { active: 'people_active', working: 'people_working', new: 'people_new',
    ...Object.fromEntries(ACTIVITY_SURFACES.map(s => [s, `people_active_${s}`])) }
  const cell = (day: string, base: string, n: number): Cell => {
    const returned = get(day, `${base}_d${n}_returned`)
    if (returned === null) return null
    const size = get(day, base)
    return { returned, percent: size ? Math.round(returned / size * 1000) / 10 : null }
  }
  return {
    status: values.size ? 'collected' as const : 'not collected' as const,
    definitions: {
      population: 'People whose account shares product usage, staff excluded. A lower bound for all users.',
      active: 'Any signed-in client reached Harness that UTC day; an app left open across midnight counts on both days.',
      working: 'At least one agent turn their own session started that day. Prefer working retention: it is not inflated by open apps or by Swarm agents on their Mac.',
      hosting: 'At least one Swarm agent turn ran on a Mac they own that day. A daily count, with no returns.',
      returns: 'Dn: in the cohort on day C and back on C+n (same surface for a surface cohort). null until C+n has ended.',
    },
    daily: dayList.filter(day => get(day, 'people_active') !== null).map(day => ({
      day, active: get(day, 'people_active'), working: get(day, 'people_working'), hosting: get(day, 'people_hosting'), new: get(day, 'people_new'),
      staff: get(day, 'people_staff_active'),
      surfaces: Object.fromEntries(ACTIVITY_SURFACES.map(s => [s, get(day, `people_active_${s}`)])),
    })),
    retention: Object.fromEntries(Object.entries(kinds).map(([kind, base]) => [kind,
      dayList.filter(day => get(day, base) !== null).map(day => ({
        day, size: get(day, base),
        d1: cell(day, base, 1), d2: cell(day, base, 2), d3: cell(day, base, 3), d7: cell(day, base, 7),
      })),
    ])),
  }
}
