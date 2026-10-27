import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { cleanUsageContext, HEALTH_MEASURES, HEALTH_FLOWS, PRODUCT_HEALTH_METRICS } from '../types/productHealthContract.js'
import { PRODUCT_USAGE_ADD_PHONE_OPENINGS, PRODUCT_USAGE_DESKTOP_FLOWS } from '../types/productUsage.js'
import { dailyProductHealth, healthBreakdowns } from './productHealth.js'

const context = { surface: 'desktop', release: '1.2.73', platform: 'macos', channel: 'production' } as const
it('keeps the CLI contract identical and every Desktop enum in the server vocabulary', () => {
  expect(readFileSync('../cli/src/lib/productHealthContract.ts', 'utf8')).toBe(readFileSync('src/types/productHealthContract.ts', 'utf8'))
  const dart = readFileSync('../desktop/lib/measurement/product_health_contract.dart', 'utf8')
  for (const metric of HEALTH_MEASURES) expect(dart).toContain(`'${metric}'`)
  const flows = readFileSync('../desktop/lib/measurement/product_measurement.dart', 'utf8')
  for (const flow of HEALTH_FLOWS) expect(flows).toContain(`'${flow}'`)
})
it('names the Desktop\'s Add Phone card and every way into Add Phone as the Desktop does', () => {
  const dart = readFileSync('../desktop/lib/measurement/product_measurement.dart', 'utf8')
  for (const flow of PRODUCT_USAGE_DESKTOP_FLOWS) expect(dart).toContain(`'${flow}'`)
  const openings = dart.split('enum AddPhoneOpening')[1].split('const AddPhoneOpening(')[0]
  expect([...openings.matchAll(/\w+\('([a-z_]+)'\)/g)].map(match => match[1])).toEqual([...PRODUCT_USAGE_ADD_PHONE_OPENINGS])
})
it('shows hn\'s session milestones beside the Desktop\'s', () => {
  const row = (metric: string, value: number) => ({ dayUtc: new Date('2026-10-01'), metric, value })
  const data = dailyProductHealth([row('health_tui_funnel_first_work', 3), row('health_tui_first_work_under_1m', 2),
    row('health_desktop_funnel_first_work', 7)], new Date('2026-10-04'))
  const [, desktop, tui] = data.daily[0].activation
  expect(desktop.milestones.first_work).toBe(7)
  expect(tui).toMatchObject({ milestones: { first_work: 3, setup_seen: null }, waitBuckets: { first_work_under_1m: 2 } })
  expect(tui.population).toBe('Consented signed-in hn sessions')
})
it('creates two independent margins with no joint dimensions or arbitrary labels', () => {
  expect(healthBreakdowns(context, 'turns_started')).toEqual(['breakdown:release:desktop:1.2.73:turns_started', 'breakdown:platform:desktop:macos:turns_started'])
  expect(healthBreakdowns({ ...context, channel: 'development' }, 'turns_started')).toEqual([])
  expect(healthBreakdowns(context, 'PRIVATE')).toEqual([])
  expect(cleanUsageContext({ ...context, release: 'PRIVATE/custom-build', private: 'PRIVATE' })).toEqual({ ...context, release: 'unknown' })
  expect(cleanUsageContext({ ...context, platform: 'PRIVATE' })).toBeUndefined()
})
it('takes a tester\'s build as its own channel, with no release or platform margins', () => {
  const phone = { surface: 'phone', release: '1.0.7', platform: 'ios', channel: 'testing' } as const
  expect(cleanUsageContext(phone)).toEqual(phone)
  expect(healthBreakdowns(phone, 'ui_phone_computer_wait_started')).toEqual([])
  expect(cleanUsageContext({ ...phone, channel: 'beta' })).toBeUndefined()
})
it('splits phone onboarding counts by release and platform, and drops a development build', () => {
  const phone = { surface: 'phone', release: '1.0.3', platform: 'android', channel: 'production' } as const
  expect(healthBreakdowns(phone, 'ui_phone_computer_wait_started')).toEqual([
    'breakdown:release:phone:1.0.3:ui_phone_computer_wait_started', 'breakdown:platform:phone:android:ui_phone_computer_wait_started'])
  expect(healthBreakdowns({ ...phone, channel: 'development' }, 'ui_phone_computer_wait_started')).toEqual([])
  const row = (metric: string, value: number) => ({ dayUtc: new Date('2026-10-01'), metric, value })
  const data = dailyProductHealth([
    row('health_phone_collector_days', 25),
    row('breakdown:platform:phone:android:health_phone_collector_days', 25),
    row('breakdown:platform:phone:android:ui_phone_computer_wait_started', 12),
  ], new Date('2026-10-04'))
  expect(data.daily[0].coverage.phoneSessions).toBe(25)
  expect(data.breakdowns).toEqual([expect.objectContaining({ dimension: 'platform', surface: 'phone', bucket: 'android',
    counters: expect.objectContaining({ ui_phone_computer_wait_started: 12 }) })])
})

it('reads the relay\'s count of the phone\'s opens by release with the release\'s coverage', () => {
  const row = (metric: string, value: number) => ({ dayUtc: new Date('2026-10-01'), metric, value })
  const data = dailyProductHealth([
    row('breakdown:release:phone:1.0.8:health_phone_collector_days', 25),
    row('breakdown:release:phone:1.0.8:relay_mobile_opens', 344),
    row('breakdown:release:phone:unknown:health_phone_collector_days', 3),
    row('breakdown:release:phone:unknown:relay_mobile_opens', 9000),
    row('breakdown:release:phone:1.0.8:relay_mobile_debug_opens', 15104),
  ], new Date('2026-10-04'))
  expect(data.breakdowns).toEqual([expect.objectContaining({ dimension: 'release', surface: 'phone', bucket: '1.0.8',
    counters: { health_phone_collector_days: 25, relay_mobile_opens: 344 } })])
  expect(data.sparseBreakdownsSuppressed).toBe(1)
})
it('suppresses sparse labels, distinguishes missing from zero, and matures first-work cohorts', () => {
  const row = (day: string, metric: string, value: number) => ({ dayUtc: new Date(day), metric, value })
  const data = dailyProductHealth([
    row('2026-10-01', 'health_cli_first_interactive_work', 10),
    row('2026-10-01', 'health_cli_first_work_d1_return', 4),
    row('2026-10-02', 'health_cli_collector_days', 30),
    row('2026-10-01', 'breakdown:release:desktop:1.2.73:health_desktop_collector_days', 19),
    row('2026-10-01', 'breakdown:platform:desktop:macos:health_desktop_collector_days', 20),
    row('2026-10-01', 'breakdown:release:desktop:PRIVATE:turns_started', 500),
    row('2026-10-01', 'create_requests', 4), row('2026-10-01', 'create_ok', 2),
  ], new Date('2026-10-04'))
  expect(data.breakdowns).toHaveLength(1); expect(JSON.stringify(data)).not.toContain('1.2.73')
  expect(JSON.stringify(data)).not.toContain('PRIVATE')
  expect(data.daily[0].firstWorkRetention[0]).toMatchObject({ denominator: 10, returned: 4, percent: 40, mature: true })
  expect(data.daily[0].firstWorkRetention[1].percent).toBeNull()
  expect(data.daily[0].requestReconciliation[0]).toMatchObject({ starts: 4, outcomes: 2, difference: 2 })
  expect(data.daily[1].firstWorkRetention[0].denominator).toBeNull()
})

it('reports first-run activation only against its own observed episode denominator', () => {
  const row = (metric: string, value: number) => ({ dayUtc: new Date('2026-10-20'), metric: `health_desktop_${metric}`, value })
  const report = dailyProductHealth([row('first_run_started', 10), row('first_run_ready', 9),
    row('first_run_work', 8), row('first_run_response', 7), row('first_run_response_under_1m', 6)], new Date('2026-10-21'))
  expect(report.daily[0].firstRun).toMatchObject({ started: 10, ready: 9, work: 8, response: 7, responsePercent: 70, mature: false })
  expect(dailyProductHealth([row('collector_days', 5)], new Date('2026-10-23')).daily[0].firstRun.responsePercent).toBeNull()
  expect(dailyProductHealth([row('first_run_started', 1), row('first_run_response', 2)], new Date('2026-10-23')).daily[0].firstRun.responsePercent).toBeNull()
})

it('names each resume preparation kind per source', () => {
  for (const kind of ['invalid_json', 'foreign_session', 'not_owned_file', 'changed_during', 'other'])
    expect((PRODUCT_HEALTH_METRICS as readonly string[]).includes(`request_app_resume_preparation_${kind}`), kind).toBe(true)
})
