import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { isAppProductUsageReport } from './appProductUsageReport.js'
import { HEALTH_MEASURES, CLI_REPORT_FAILURES } from './productHealthContract.js'
import { PRODUCT_USAGE_UI_METRICS } from './productUsageContract.js'

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
