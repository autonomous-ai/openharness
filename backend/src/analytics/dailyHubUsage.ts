import { HUB_ACTIONS, HUB_DWELL, HUB_ENTRY_SOURCES, HUB_METRICS, HUB_READERS, HUB_SHARED_OPENS, HUB_VIEW_PAGES } from '../lib/hubMetricsContract.js'

const DAY = 86_400_000
type Row = { dayUtc: Date; metric: string; value: number }
type Ratio = { numerator: number; denominator: number; ratio: number | null }
const readable = new Set<string>(HUB_METRICS)

/** Two unlinked daily totals side by side; a click can come from a view counted on another day. */
const ratio = (numerator: number, denominator: number): Ratio =>
  ({ numerator, denominator, ratio: denominator > 0 ? Math.round(numerator / denominator * 1000) / 1000 : null })

const pick = <K extends string>(keys: readonly K[], name: (key: K) => string, c: Record<string, number>) =>
  Object.fromEntries(keys.map(key => [key, c[name(key)] ?? 0])) as Record<K, number>

/** One day's Hub totals, or null when no Hub report arrived: missing is not zero. */
function hubDay(c: Record<string, number> | undefined) {
  if (!c) return null
  const views = Object.fromEntries(HUB_VIEW_PAGES.map(page =>
    [page, pick(HUB_READERS, reader => `hub_view_${page}_${reader}`, c)])) as Record<typeof HUB_VIEW_PAGES[number], Record<typeof HUB_READERS[number], number>>
  const actions = pick(HUB_ACTIONS, action => `hub_${action}`, c)
  return {
    views, entries: pick(HUB_ENTRY_SOURCES, source => `hub_entry_${source}`, c), actions,
    harnessDwell: pick(HUB_DWELL, bucket => `hub_harness_dwell_${bucket}`, c),
    sharedOpens: pick(HUB_SHARED_OPENS, open => `hub_shared_open_${open}`, c),
    sharedDwell: pick(HUB_DWELL, bucket => `hub_shared_dwell_${bucket}`, c),
    forkClicksPerHarnessView: ratio(actions.fork, views.harness.visitor + views.harness.member),
    signInClicksPerPromptShown: ratio(actions.sign_in_prompt_click, actions.sign_in_prompt_shown),
  }
}

/** The `hub` section of `usage:daily`: anonymous totals the website's server forwards. Visits and clicks, never people. */
export function dailyHubUsage(rows: Row[], days: number, now: Date) {
  const today = Math.floor(now.getTime() / DAY) * DAY
  const byDay = new Map<string, Record<string, number>>()
  for (const row of rows) {
    if (!readable.has(row.metric) || !Number.isSafeInteger(row.value) || row.value < 0) continue
    const day = row.dayUtc.toISOString().slice(0, 10)
    const counts = byDay.get(day) ?? {}
    counts[row.metric] = (counts[row.metric] ?? 0) + row.value
    byDay.set(day, counts)
  }
  return {
    status: byDay.size ? 'collected' as const : 'not collected' as const,
    definitions: {
      population: 'Hub page views, visit entries, clicks and dwell buckets from browsers, as unlinked daily totals. These are visits and clicks, not people, and not a funnel. Browsers with Global Privacy Control or Do Not Track, and signed-in readers who turned sharing off, are not counted.',
      views: 'A Hub page drawn, once per navigation; visitor is signed out, member signed in.',
      entries: 'The first Hub page of a browser tab\'s visit, by where it came from, classified in the browser; no referrer is sent.',
      harnessDwell: 'How long a harness page stayed visible, once per view.',
      sharedOpens: 'What a shared link (`/s/:id`) showed, each outcome at most once per page: live, the owner\'s machine offline, private before sign-in, no access, or failed.',
      sharedDwell: 'How long a live shared harness stayed visible, once per page.',
      ratios: 'Two separate daily totals divided; a click can follow a view counted on another day. Keep the numerator and denominator.',
      trust: 'Public, credential-free counts: they can be fabricated. Directional only; no margins are kept, so no suppression applies.',
    },
    daily: Array.from({ length: days }, (_, i) => {
      const stamp = today - (days - 1 - i) * DAY, day = new Date(stamp).toISOString().slice(0, 10)
      return { day, period: stamp === today ? 'incomplete' : 'ended; late reports possible', totals: hubDay(byDay.get(day)) }
    }),
  }
}
