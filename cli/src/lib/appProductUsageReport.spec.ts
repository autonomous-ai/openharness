import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { appProductUsageReport, APP_USAGE_VOCABULARY, isAppProductUsageReport } from './appProductUsageReport.js'
import { HEALTH_MEASURES, CLI_REPORT_FAILURES } from './productHealthContract.js'
import { PRODUCT_USAGE_ADD_PHONE_METRICS, PRODUCT_USAGE_UI_METRICS } from './productUsageContract.js'

const native = JSON.parse(readFileSync(new URL('../../../tests/fixtures/desktop-product-usage-report.json', import.meta.url), 'utf8'))
const { context: _context, ...legacy } = native
const old = { ...legacy, counters: { ui_desktop_sign_in_ok: 1 } }

it('admits the current native report and every fixed Desktop health measure', () => {
  expect(isAppProductUsageReport(native)).toBe(true)
  const dart = readFileSync(new URL('../../../desktop/lib/measurement/product_health_contract.dart', import.meta.url), 'utf8')
  const wires = [...dart.split('class ProductUsageContext')[0].matchAll(/\('([^']+)'\)/g)].map(match => match[1])
  expect(wires.toSorted()).toEqual([...HEALTH_MEASURES,
    ...CLI_REPORT_FAILURES.map(reason => `report_failure_${reason}`)].toSorted())
  for (const wire of wires) expect(isAppProductUsageReport({ ...native, counters: { [`health_desktop_${wire}`]: 1000 } })).toBe(true)
  for (const platform of ['macos', 'windows', 'linux', 'other']) for (const channel of ['production', 'development']) {
    expect(isAppProductUsageReport({ ...native, context: { ...native.context, platform, channel, release: 'unknown' } })).toBe(true)
  }
})

const appMetrics = PRODUCT_USAGE_UI_METRICS.filter(metric => !metric.startsWith('ui_tui_'))
it('keeps all legacy app UI counters compatible, in bounded batches', () => {
  for (let i = 0; i < appMetrics.length; i += 32) {
    const counters = Object.fromEntries(appMetrics.slice(i, i + 32).map(key => [key, 1000]))
    expect(isAppProductUsageReport({ ...old, counters })).toBe(true)
  }
  expect(isAppProductUsageReport({ ...native, counters: old.counters })).toBe(true)
  expect(isAppProductUsageReport({ ...old, counters: {} })).toBe(true)
})

it('refuses arbitrary context, non-Desktop attribution, daemon counts and malformed values', () => {
  const counters = (key: string, count: unknown = 1) => ({ ...native, counters: { [key]: count } })
  const context = (change: object) => ({ ...native, context: { ...native.context, ...change } })
  const invalid = [null, [], {}, { ...native, prompt: 'PRIVATE_CANARY' }, { ...native, revision: -1 },
    { ...native, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...native, schemaVersion: 2 },
    { ...native, id: 'PRIVATE_CANARY' }, { ...native, day: 'PRIVATE_CANARY' },
    { ...native, context: null }, { ...native, context: [] }, { ...native, context: {} },
    context({ userId: 'PRIVATE_CANARY' }), context({ release: '1.2.75-PRIVATE_CANARY' }), context({ release: '1000.1.1' }),
    context({ release: '01.2.75' }), context({ surface: 'cli' }), context({ platform: 'PRIVATE_CANARY' }),
    context({ channel: 'PRIVATE_CANARY' }), context({ release: undefined }),
    counters('turns_started'), counters('request_app_create_started'), counters('health_cli_collector_days'),
    counters('setup_desktop_sign_in_ok'), counters('ui_phone_sign_in_ok'), counters('ui_web_sign_in_ok'),
    // hn's are the daemon's to count from hn's own frame, never an app's report.
    counters('ui_tui_sign_in_ok'), counters('health_tui_funnel_first_work'),
    { ...old, counters: { ui_tui_sign_in_ok: 1 } }, { ...old, counters: { health_tui_funnel_first_work: 1 } },
    counters('PRIVATE_CANARY'), counters('health_desktop_collector_days', 'PRIVATE_CANARY'),
    ...[0, -1, 1001, 1.5, NaN, Infinity].map(value => counters('health_desktop_collector_days', value)),
    { ...old, counters: { health_desktop_collector_days: 1 } },
    { ...native, counters: [] }, { ...native, counters: null },
    { ...old, counters: Object.fromEntries(PRODUCT_USAGE_UI_METRICS.slice(0, 33).map(key => [key, 1])) },
  ]
  for (const value of invalid) expect(isAppProductUsageReport(value), JSON.stringify(value)).toBe(false)
  for (const key of ['id', 'revision', 'schemaVersion', 'day', 'counters']) {
    const missing = { ...native }; delete missing[key]
    expect(isAppProductUsageReport(missing)).toBe(false)
  }
})

it('drops names this contract does not know yet, says so once, and refuses everything else as before', () => {
  // A newer Desktop's report used to be refused whole, and the Desktop drops a refused packet for good.
  const counters = { ...native.counters, health_desktop_frame_from_the_future: 3, PRIVATE_CANARY: 'any value' }
  const kept = appProductUsageReport({ ...native, counters })
  expect(kept).toEqual({ ...native, counters: { ...native.counters, health_desktop_report_unknown_metric: 1 } })
  expect(JSON.stringify(kept)).not.toMatch(/future|PRIVATE_CANARY/)
  // A UI-only report has no surface to count that under, as at the backend.
  expect(appProductUsageReport({ ...old, counters: { ...old.counters, ui_desktop_from_the_future: 1 } })).toEqual(old)
  // A full report with one unknown name stays within 32 counters once it is counted.
  const full = Object.fromEntries(HEALTH_MEASURES.slice(0, 31).map(m => [`health_desktop_${m}`, 1]))
  expect(Object.keys(appProductUsageReport({ ...native, counters: { ...full, PRIVATE_CANARY: 1 } })!.counters)).toHaveLength(32)
  // Unchanged reports are forwarded as they are.
  expect(appProductUsageReport(native)).toBe(native)
  for (const refused of [
    // Nothing known left.
    { ...native, counters: { PRIVATE_CANARY: 1 } },
    // A known name an app may not file is not unknown: a daemon's, hn's, the phone's, the backend's own.
    ...['turns_started', 'health_cli_collector_days', 'health_tui_funnel_first_work', 'ui_phone_sign_in_ok',
      'health_desktop_report_unknown_metric'].map(key => ({ ...native, counters: { [key]: 1, PRIVATE_CANARY: 1 } })),
    // A known name's bad value, and more than 32 names, unknown ones included.
    { ...native, counters: { health_desktop_collector_days: 0, PRIVATE_CANARY: 1 } },
    { ...native, counters: { ...full, [`health_desktop_${HEALTH_MEASURES[31]}`]: 1, PRIVATE_CANARY: 1 } },
    { ...native, prompt: 'PRIVATE_CANARY', counters: { ...native.counters, PRIVATE_CANARY: 1 } },
  ]) expect(appProductUsageReport(refused), JSON.stringify(refused)).toBeUndefined()
})

it('announces vocabulary 5 including first-arrival, invite and existing Add Phone names', () => {
  expect(APP_USAGE_VOCABULARY).toBe(5)
  for (const measure of ['frame_slow_wait', 'frame_slow_build', 'frame_slow_raster', 'frame_long_collector']) {
    expect(appProductUsageReport({ ...native, counters: { [`health_desktop_${measure}`]: 1 } })).toBeDefined()
  }
  // The Add Phone card's flow and each way into Add Phone, from a Desktop, forwarded as they are.
  const addPhone = { ...native, counters: { ui_desktop_phone_offer_started: 1, ui_desktop_phone_offer_ok: 1,
    ui_desktop_phone_offer_after_work_started: 1, ui_desktop_phone_offer_after_work_cancelled: 1,
    ui_desktop_phone_offer_away_waited_ok: 1, ui_desktop_phone_offer_away_finished_unknown: 1,
    ui_desktop_phone_offer_cancelled: 1, ui_desktop_phone_offer_over_1m: 1,
    ...Object.fromEntries(PRODUCT_USAGE_ADD_PHONE_METRICS.map(metric => [metric, 1])) } }
  expect(appProductUsageReport(addPhone)).toBe(addPhone)
  expect(PRODUCT_USAGE_ADD_PHONE_METRICS).toEqual(['ui_desktop_add_phone_offer', 'ui_desktop_add_phone_titlebar',
    'ui_desktop_add_phone_menu', 'ui_desktop_add_phone_account', 'ui_desktop_add_phone_machines', 'ui_desktop_add_phone_command'])
  // Only a Desktop report with its context files them: not the legacy UI-only form.
  expect(appProductUsageReport({ ...old, counters: { ui_desktop_add_phone_menu: 1 } })).toBeUndefined()
})
