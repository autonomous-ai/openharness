import { expect, it } from 'vitest'
import { PEOPLE_METRICS, peopleCounters, type ActivityMark } from './peopleCounters.js'

const m = (subject: string, day: string, over: Partial<ActivityMark> = {}): ActivityMark => ({
  subject, dayUtc: new Date(day), surfaces: ['desktop'], worked: false, signupDay: new Date('2026-09-01'), staff: false, ...over,
})
const asMap = (rows: { day: string; metric: string; value: number }[]) =>
  Object.fromEntries(rows.map(r => [`${r.day}:${r.metric}`, r.value]))

it('counts people per ended day, per surface, working, new and staff apart', () => {
  const c = asMap(peopleCounters([
    m('a', '2026-10-10', { surfaces: ['desktop', 'mobile', 'desktop'], worked: true }),
    m('b', '2026-10-10', { surfaces: ['web'], signupDay: new Date('2026-10-10') }),
    m('s', '2026-10-10', { staff: true, worked: true }),
    m('a', '2026-10-13'),
  ], new Date('2026-10-13T09:00:00Z')))
  expect(c['2026-10-10:people_active']).toBe(2)
  expect(c['2026-10-10:people_working']).toBe(1)
  expect(c['2026-10-10:people_new']).toBe(1)
  expect(c['2026-10-10:people_staff_active']).toBe(1)
  expect(c['2026-10-10:people_active_desktop']).toBe(1) // duplicate surface entries collapse
  expect(c['2026-10-10:people_active_mobile']).toBe(1)
  expect(c['2026-10-10:people_active_web']).toBe(1)
  expect(c['2026-10-10:people_active_tui']).toBe(0)
  expect(c['2026-10-13:people_active']).toBeUndefined() // today has not ended
})

it('writes Dn returns only once day C+n has ended, zero when nobody came back', () => {
  const marks = [
    m('a', '2026-10-01', { worked: true, signupDay: new Date('2026-10-01') }), m('b', '2026-10-01'),
    m('a', '2026-10-02', { worked: true }), m('a', '2026-10-04', { surfaces: ['mobile'] }), m('b', '2026-10-08'),
  ]
  const c = asMap(peopleCounters(marks, new Date('2026-10-08T10:00:00Z')))
  expect(c['2026-10-01:people_active_d1_returned']).toBe(1)
  expect(c['2026-10-01:people_working_d1_returned']).toBe(1)
  expect(c['2026-10-01:people_new_d1_returned']).toBe(1)
  expect(c['2026-10-01:people_active_d2_returned']).toBe(0)
  expect(c['2026-10-01:people_active_d3_returned']).toBe(1)
  expect(c['2026-10-01:people_active_desktop_d3_returned']).toBe(0) // same surface only
  expect(c['2026-10-01:people_active_d7_returned']).toBeUndefined() // 2026-10-08 has not ended
  const later = asMap(peopleCounters(marks, new Date('2026-10-09T00:30:00Z')))
  expect(later['2026-10-01:people_active_d7_returned']).toBe(1)
})

it('leaves staff out of every return and is identical on re-run', () => {
  const marks = [m('s', '2026-10-01', { staff: true }), m('s', '2026-10-02', { staff: true }), m('a', '2026-10-01')]
  const now = new Date('2026-10-05T00:00:00Z')
  const first = peopleCounters(marks, now)
  expect(asMap(first)['2026-10-01:people_active_d1_returned']).toBe(0)
  expect(peopleCounters([...marks].reverse(), now)).toEqual(first)
})

it('names only metrics in PEOPLE_METRICS', () => {
  const rows = peopleCounters([m('a', '2026-10-01'), m('a', '2026-10-08')], new Date('2026-10-10'))
  expect(rows.some(r => r.metric === 'people_active_d7_returned')).toBe(true)
  for (const r of rows) expect(PEOPLE_METRICS).toContain(r.metric)
})

it('never rewrites a day whose marks may be expiring, so its totals cannot shrink', () => {
  // Marks for C expire at C+10 00:00; Mongo's TTL pass removes them in batches, so at C+10 00:30 only
  // some may be left. C's D7 matured at C+8 and nothing about C changes after C+9.
  const c = asMap(peopleCounters([m('half', '2026-10-01'), m('x', '2026-10-02')], new Date('2026-10-11T00:30:00Z')))
  expect(Object.keys(c).filter(k => k.startsWith('2026-10-01:'))).toEqual([])
  expect(c['2026-10-02:people_active']).toBe(1) // C+9 is the last day C=10-02 is rewritten
})
