import { expect, it } from 'vitest'
import { dailyProductPeople } from './dailyProductPeople.js'
const r = (day: string, metric: string, value: number) => ({ dayUtc: new Date(day), metric, value })

it('says people are not collected instead of printing zeros', () => {
  expect(dailyProductPeople([r('2026-10-12', 'turns_started', 3)], 3, new Date('2026-10-14T01:00:00Z')).status).toBe('not collected')
})

it('reports DAU per day and retention cells with numerator, denominator and immature nulls', () => {
  const p = dailyProductPeople([
    r('2026-10-11', 'people_active', 10), r('2026-10-11', 'people_working', 4), r('2026-10-11', 'people_active_desktop', 7),
    r('2026-10-11', 'people_active_d1_returned', 6), r('2026-10-11', 'people_working_d1_returned', 3),
    r('2026-10-11', 'people_new', 0), r('2026-10-11', 'people_new_d1_returned', 0),
  ], 4, new Date('2026-10-14T01:00:00Z'))
  expect(p.status).toBe('collected')
  expect(p.daily.find(d => d.day === '2026-10-11')).toMatchObject({ active: 10, working: 4, surfaces: { desktop: 7 } })
  expect(p.daily.find(d => d.day === '2026-10-14')).toBeUndefined() // today is left out
  const cohort = p.retention.active.find(c => c.day === '2026-10-11')!
  expect(cohort).toMatchObject({ size: 10, d1: { returned: 6, percent: 60 }, d7: null })
  expect(p.retention.working.find(c => c.day === '2026-10-11')!.d1).toEqual({ returned: 3, percent: 75 })
  expect(p.retention.new.find(c => c.day === '2026-10-11')!.d1).toEqual({ returned: 0, percent: null }) // no denominator
})
