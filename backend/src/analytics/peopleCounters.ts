import { ACTIVITY_DAYS, ACTIVITY_SURFACES } from '../types/productUsageActivity.js'

const DAY = 86_400_000
export const PEOPLE_RETURN_DAYS = [1, 2, 3, 7] as const
export interface ActivityMark { subject: string; dayUtc: Date; surfaces: string[]; worked: boolean; signupDay: Date; staff: boolean }
type Counter = { day: string; metric: string; value: number }

const KINDS = ['active', 'working', 'new', ...ACTIVITY_SURFACES.map(s => `active_${s}`)] as const
export const PEOPLE_METRICS: readonly string[] = [
  'people_active', 'people_working', 'people_new', 'people_staff_active',
  ...ACTIVITY_SURFACES.map(s => `people_active_${s}`),
  ...KINDS.flatMap(kind => PEOPLE_RETURN_DAYS.map(n => `people_${kind}_d${n}_returned`)),
]

const dayKey = (d: Date) => d.toISOString().slice(0, 10)

/** Distinct people per ended UTC day and their D1/D2/D3/D7 returns. Staff count only as staff. */
export function peopleCounters(marks: ActivityMark[], now: Date): Counter[] {
  const today = Math.floor(now.getTime() / DAY) * DAY
  type Person = { surfaces: Set<string>; worked: boolean; isNew: boolean }
  const byDay = new Map<number, Map<string, Person>>()
  const staffByDay = new Map<number, Set<string>>()
  for (const mark of marks) {
    const day = Math.floor(mark.dayUtc.getTime() / DAY) * DAY
    if (mark.staff) { (staffByDay.get(day) ?? staffByDay.set(day, new Set()).get(day)!).add(mark.subject); continue }
    const people = byDay.get(day) ?? byDay.set(day, new Map()).get(day)!
    const person = people.get(mark.subject) ?? { surfaces: new Set<string>(), worked: false, isNew: false }
    for (const s of mark.surfaces) person.surfaces.add(s)
    person.worked ||= mark.worked
    person.isNew ||= Math.floor(mark.signupDay.getTime() / DAY) * DAY === day
    people.set(mark.subject, person)
  }
  const inKind = (p: Person | undefined, kind: string): boolean => !!p && (kind === 'active' ? true
    : kind === 'working' ? p.worked : kind === 'new' ? p.isNew : p.surfaces.has(kind.slice('active_'.length)))
  // Only ended days whose marks are still whole: C's marks expire at C+ACTIVITY_DAYS and Mongo deletes them
  // in batches, so a later pass could see some of them and shrink C's totals for good. D7 matures at C+8.
  const oldest = today - (ACTIVITY_DAYS - 1) * DAY
  const days = [...new Set([...byDay.keys(), ...staffByDay.keys()])].filter(d => d < today && d >= oldest).sort((a, b) => a - b)
  const out: Counter[] = []
  for (const day of days) {
    const people = byDay.get(day) ?? new Map<string, Person>()
    const key = dayKey(new Date(day))
    const count = (kind: string) => [...people.values()].filter(p => inKind(p, kind)).length
    out.push({ day: key, metric: 'people_active', value: people.size })
    out.push({ day: key, metric: 'people_working', value: count('working') })
    out.push({ day: key, metric: 'people_new', value: count('new') })
    out.push({ day: key, metric: 'people_staff_active', value: staffByDay.get(day)?.size ?? 0 })
    for (const s of ACTIVITY_SURFACES) out.push({ day: key, metric: `people_active_${s}`, value: count(`active_${s}`) })
    for (const n of PEOPLE_RETURN_DAYS) {
      if (day + (n + 1) * DAY > today) continue // C+n has not ended yet
      const later = byDay.get(day + n * DAY) ?? new Map<string, Person>()
      for (const kind of KINDS) {
        // Returning means active again; for working, working again; for a surface, the same surface.
        const back = kind === 'working' ? 'working' : kind.startsWith('active_') ? kind : 'active'
        const value = [...people].filter(([subject, p]) => inKind(p, kind) && inKind(later.get(subject), back)).length
        out.push({ day: key, metric: `people_${kind}_d${n}_returned`, value })
      }
    }
  }
  return out
}
