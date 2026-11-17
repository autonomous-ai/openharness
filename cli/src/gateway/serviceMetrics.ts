/**
 * The gateway admits a service counter only for its authenticated originating feature, from the
 * names the contract declares (lib/productUsageContract.ts): Hachi's, which its services in the edge host count, and the
 * agent browser's, which its process counts. Kept here, not in the contract: the contract is the backend's vocabulary,
 * byte for byte (backend/src/lib/productUsage.test.ts), and which of its names a daemon service may count is the
 * daemon's own rule. Of Hachi's, not the App's (`ui_desktop_*`), and not those the recorder derives itself
 * (gateway/productUsage.ts): the launch twins, from the create, and the days the person typed to Hachi, from
 * `hachi_turns_person`.
 */
import { PRODUCT_USAGE_AGENT_BROWSER_METRICS, PRODUCT_USAGE_HACHI_METRICS } from '../lib/productUsageContract.js'

type HachiMetric = typeof PRODUCT_USAGE_HACHI_METRICS[number]
export const HACHI_DAEMON_METRICS = PRODUCT_USAGE_HACHI_METRICS.filter(
  (metric): metric is Exclude<HachiMetric, `ui_desktop_${string}` | `launch_hachi_${string}` | 'hachi_person_turn_days'> =>
    !metric.startsWith('ui_desktop_') && !metric.startsWith('launch_hachi_') && metric !== 'hachi_person_turn_days')
export type HachiDaemonMetric = typeof HACHI_DAEMON_METRICS[number]

const hachi: ReadonlySet<string> = new Set(HACHI_DAEMON_METRICS)
const browser: ReadonlySet<string> = new Set(PRODUCT_USAGE_AGENT_BROWSER_METRICS)

/** The source is core-authenticated provenance, never a field the observing feature supplies. */
export function serviceMetricAllowed(service: string, metric: string): boolean {
  if (service === 'agentBrowser') return browser.has(metric)
  return (service === 'hachi' || service === 'goals' || service === 'agentCleanup') && hachi.has(metric)
}
