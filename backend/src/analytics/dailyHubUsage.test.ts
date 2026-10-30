import { expect, it } from 'vitest'
import { dailyHubUsage } from './dailyHubUsage.js'
const r = (day: string, metric: string, value: number) => ({ dayUtc: new Date(day), metric, value })
const now = new Date('2026-10-14T01:00:00Z')

it('says the Hub is not collected, and keeps a day without reports null instead of zero', () => {
  const hub = dailyHubUsage([r('2026-10-13', 'turns_started', 3), r('2026-10-13', 'setup_desktop_sign_in_ok', 1)], 2, now)
  expect(hub.status).toBe('not collected')
  expect(hub.daily.map(d => d.totals)).toEqual([null, null])
  expect(hub.definitions.population).toContain('not people')
})

it('splits views by reader, counts entries, actions and dwell, and keeps both sides of each ratio', () => {
  const hub = dailyHubUsage([
    r('2026-10-13', 'hub_view_harness_visitor', 30), r('2026-10-13', 'hub_view_harness_member', 10),
    r('2026-10-13', 'hub_view_feed_visitor', 50), r('2026-10-13', 'hub_entry_search', 12), r('2026-10-13', 'hub_entry_direct', 8),
    r('2026-10-13', 'hub_fork', 4), r('2026-10-13', 'hub_share_copy', 2),
    r('2026-10-13', 'hub_sign_in_prompt_shown', 20), r('2026-10-13', 'hub_sign_in_prompt_click', 5),
    r('2026-10-13', 'hub_harness_dwell_over_1m', 7), r('2026-10-13', 'hub_harness_dwell_over_1m', 1),
    r('2026-10-13', 'PRIVATE_CANARY', 1), r('2026-10-13', 'hub_like', -1),
    r('2026-10-14', 'hub_view_feed_member', 1),
  ], 2, now)
  expect(hub.status).toBe('collected')
  const [ended, today] = hub.daily
  expect(ended).toMatchObject({ day: '2026-10-13', period: 'ended; late reports possible' })
  expect(ended.totals).toMatchObject({
    views: { harness: { visitor: 30, member: 10 }, feed: { visitor: 50, member: 0 }, fork: { visitor: 0, member: 0 } },
    entries: { search: 12, direct: 8, social: 0 },
    actions: { fork: 4, share_copy: 2, like: 0 },
    harnessDwell: { under_10s: 0, over_1m: 8 },
    forkClicksPerHarnessView: { numerator: 4, denominator: 40, ratio: 0.1 },
    signInClicksPerPromptShown: { numerator: 5, denominator: 20, ratio: 0.25 },
  })
  expect(today).toMatchObject({ day: '2026-10-14', period: 'incomplete', totals: { views: { feed: { member: 1 } } } })
  // No denominator is no ratio, not zero or infinity.
  expect(today.totals?.forkClicksPerHarnessView).toEqual({ numerator: 0, denominator: 0, ratio: null })
  expect(JSON.stringify(hub)).not.toContain('PRIVATE_CANARY')
})

it('reads a shared link apart: what it showed, how long it stayed, and its clicks', () => {
  const [day] = dailyHubUsage([
    r('2026-10-13', 'hub_view_shared_visitor', 9), r('2026-10-13', 'hub_shared_open_live', 6), r('2026-10-13', 'hub_shared_open_offline', 3),
    r('2026-10-13', 'hub_shared_dwell_10s_to_1m', 4), r('2026-10-13', 'hub_shared_get_app', 2),
  ], 1, new Date('2026-10-13T12:00:00Z')).daily
  expect(day.totals).toMatchObject({
    views: { shared: { visitor: 9, member: 0 } },
    sharedOpens: { live: 6, offline: 3, private: 0, no_access: 0, failed: 0 },
    sharedDwell: { under_10s: 0, '10s_to_1m': 4, over_1m: 0 },
    harnessDwell: { '10s_to_1m': 0 },
    actions: { shared_get_app: 2, get_app: 0 },
  })
})
