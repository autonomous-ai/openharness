import { cleanUsageContext, HEALTH_MEASURES, CLI_REPORT_FAILURES } from './productHealthContract.js'
import { PRODUCT_USAGE_ADD_PHONE_METRICS, PRODUCT_USAGE_METRICS, PRODUCT_USAGE_UI_METRICS,
  type ProductUsageReport } from './productUsageContract.js'

/** The contract revision this proxy forwards, sent on each of its answers as `x-harness-usage-vocabulary`.
 * 2: the Desktop's frame-phase counters (`frame_slow_*`, `frame_long_collector`). 3: its Add Phone card
 * (`ui_desktop_phone_offer_*`) and the ways Add Phone opened (`ui_desktop_add_phone_*`). 4: the card offered
 * after work or after time away (`ui_desktop_phone_offer_after_work_*`, `ui_desktop_phone_offer_away_*`). The
 * Desktop sends a name newer than revision 1 only once a proxy has announced it, so an older CLI never sees one.
 * 5: first-arrival episodes and shared-tab invitation outcomes.
 * Raise it with each name the Desktop gates on it (`ProductHealthMeasure.vocabulary`, `ProductFlow.vocabulary`). */
export const APP_USAGE_VOCABULARY = 5
export const APP_USAGE_VOCABULARY_HEADER = 'x-harness-usage-vocabulary'

// hn's counts reach the daemon's own queue only through hn's `product_observe`; no app can file them.
const uiMetrics = new Set<string>(PRODUCT_USAGE_UI_METRICS.filter(metric => !metric.startsWith('ui_tui_')))
const desktopMetrics = new Set<string>([
  ...PRODUCT_USAGE_UI_METRICS.filter(metric => metric.startsWith('ui_desktop_')),
  ...PRODUCT_USAGE_ADD_PHONE_METRICS,
  ...HEALTH_MEASURES.map(measure => `health_desktop_${measure}`),
  ...CLI_REPORT_FAILURES.map(reason => `health_desktop_report_failure_${reason}`),
])
const knownMetrics = new Set<string>(PRODUCT_USAGE_METRICS)
const fields = new Set(['schemaVersion', 'revision', 'id', 'day', 'counters', 'context'])
const contextFields = new Set(['surface', 'release', 'platform', 'channel'])
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The report this local proxy forwards for an app, or undefined to refuse it.
 * It admits the native Desktop format as well as older UI-only reports, and stays narrower than the
 * backend contract: an app cannot submit daemon counters or labels. The caller bounds the complete JSON
 * body to 8 KiB before parsing it.
 *
 * A Desktop a release ahead of this CLI can name a counter this contract does not have yet. This proxy
 * refused such a report whole, and the Desktop drops a refused packet for good
 * (desktop/lib/measurement/product_report_failure.dart: a 400 is permanent), losing up to 32 counters for
 * one new name. As the backend does (`withoutUnknownCounters`, backend/src/routes/productUsage.ts), the
 * unknown names are dropped, never forwarded or logged, and a Desktop report says so once with
 * `health_desktop_report_unknown_metric`. A known name an app may not file still refuses the report, as
 * does one with no known counter left; values and every other field are checked as before. */
export function appProductUsageReport(value: unknown): ProductUsageReport | undefined {
  if (!object(value) || Object.keys(value).some(key => !fields.has(key)) || value.schemaVersion !== 1
      || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
      || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id)
      || typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)
      || !object(value.counters) || Object.keys(value.counters).length > 32) return
  let allowed = uiMetrics
  if ('context' in value) {
    const context = value.context
    if (!object(context) || Object.keys(context).length !== 4
        || Object.keys(context).some(key => !contextFields.has(key)) || context.surface !== 'desktop') return
    const clean = cleanUsageContext(context)
    if (!clean || clean.release !== context.release) return
    allowed = desktopMetrics
  }
  const all = Object.entries(value.counters)
  const known = all.filter(([key]) => knownMetrics.has(key))
  // An empty report is the legacy form's own; one with nothing known left is not.
  if (all.length && !known.length) return
  if (!known.every(([key, count]) => allowed.has(key)
    && typeof count === 'number' && Number.isSafeInteger(count) && count >= 1 && count <= 1000)) return
  if (known.length === all.length) return value as unknown as ProductUsageReport
  const counters = Object.fromEntries(known) as Record<string, number>
  // Only a Desktop report has a surface to count it under, as at the backend.
  if (allowed === desktopMetrics) counters.health_desktop_report_unknown_metric = 1
  return { ...value, counters } as unknown as ProductUsageReport
}

/** Whether [appProductUsageReport] forwards the report at all. */
export function isAppProductUsageReport(value: unknown): value is ProductUsageReport {
  return appProductUsageReport(value) !== undefined
}
