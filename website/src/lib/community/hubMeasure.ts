import { sessionHeaders } from './client';
import { entrySource, hubReportMaxValue, type HubMetric } from './hubMetrics';

/**
 * Counts what readers do on the Hub as daily totals, kept in this tab's memory and sent to the
 * website's server (`/api/hub-usage`) every so often and when the tab is hidden. The request carries
 * no cookies; a sign-in only lets the server leave out a reader who turned sharing off, and is never
 * passed on. Nothing is counted under Global Privacy Control or Do Not Track, for a staging account, or in development.
 * Counts lost to a failed send stay lost: measurement never retries into the reader's way.
 */
/**
 * A minute per tab, and once as it hides: the backend admits 240 Hub reports a minute per process, so
 * this holds about 200 tabs open at once before counts are dropped.
 * TODO(BE): past that, add the reports up on the website's server and send one a minute.
 */
const flushMs = 60_000, visitKey = 'harness.hub.visit';
const counts = new Map<HubMetric, number>();
let day = '', timer: ReturnType<typeof setTimeout> | null = null, listening = false;

const utcDay = () => new Date().toISOString().slice(0, 10);

function measuring(): boolean {
  // `next dev` reads the production Hub: a developer's clicks are not readers'.
  if (typeof window === 'undefined' || process.env.NODE_ENV === 'development') return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl === true || nav.doNotTrack === '1') return false;
  return sessionHeaders()['x-autonomous-env'] !== 'stag';
}

/** Sends what is counted so far, once; called on a timer, when the day turns, and as the tab hides. */
export function flushHub(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!counts.size) return;
  const report = { schemaVersion: 1, id: crypto.randomUUID(), day, counters: Object.fromEntries(counts) };
  counts.clear();
  const auth = sessionHeaders().Authorization;
  void fetch('/api/hub-usage', {
    method: 'POST', keepalive: true, credentials: 'omit', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(report),
  }).catch(() => undefined);
}

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('pagehide', flushHub);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushHub(); });
}

/** One more of `metric` today. */
export function countHub(metric: HubMetric): void {
  if (!measuring()) return;
  listen();
  if (day && day !== utcDay()) flushHub();
  day = utcDay();
  counts.set(metric, Math.min((counts.get(metric) ?? 0) + 1, hubReportMaxValue));
  timer ??= setTimeout(flushHub, flushMs);
}

/** The first Hub page of this tab's visit says where the visit came from; a reload or the next page does not. */
export function countHubEntry(): void {
  try {
    if (sessionStorage.getItem(visitKey)) return;
    sessionStorage.setItem(visitKey, '1');
  } catch { return; }
  countHub(`hub_entry_${entrySource(document.referrer, window.location.hostname)}`);
}
