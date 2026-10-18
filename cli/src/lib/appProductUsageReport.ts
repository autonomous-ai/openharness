import { cleanUsageContext, HEALTH_MEASURES, CLI_REPORT_FAILURES } from './productHealthContract.js'
import { PRODUCT_USAGE_UI_METRICS, type ProductUsageReport } from './productUsageContract.js'

// hn's counts reach the daemon's own queue only through hn's `product_observe`; no app can file them.
const uiMetrics = new Set<string>(PRODUCT_USAGE_UI_METRICS.filter(metric => !metric.startsWith('ui_tui_')))
const desktopMetrics = new Set<string>([
  ...PRODUCT_USAGE_UI_METRICS.filter(metric => metric.startsWith('ui_desktop_')),
  ...HEALTH_MEASURES.map(measure => `health_desktop_${measure}`),
  ...CLI_REPORT_FAILURES.map(reason => `health_desktop_report_failure_${reason}`),
])
const fields = new Set(['schemaVersion', 'revision', 'id', 'day', 'counters', 'context'])
const contextFields = new Set(['surface', 'release', 'platform', 'channel'])
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The local proxy must admit the native Desktop format as well as older UI-only reports.
 * Keep this narrower than the backend contract: an app cannot submit daemon counters or labels.
 * The caller also bounds the complete JSON body to 8 KiB before parsing it.
 */
export function isAppProductUsageReport(value: unknown): value is ProductUsageReport {
  if (!object(value) || Object.keys(value).some(key => !fields.has(key)) || value.schemaVersion !== 1
      || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
      || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id)
      || typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)
      || !object(value.counters) || Object.keys(value.counters).length > 32) return false
  let allowed = uiMetrics
  if ('context' in value) {
    const context = value.context
    if (!object(context) || Object.keys(context).length !== 4
        || Object.keys(context).some(key => !contextFields.has(key)) || context.surface !== 'desktop') return false
    const clean = cleanUsageContext(context)
    if (!clean || clean.release !== context.release) return false
    allowed = desktopMetrics
  }
  return Object.entries(value.counters).every(([key, count]) => allowed.has(key)
    && typeof count === 'number' && Number.isSafeInteger(count) && count >= 1 && count <= 1000)
}
