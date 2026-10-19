/**
 * The Hub's usage counters, as the backend accepts them (`backend/src/lib/hubMetricsContract.ts`;
 * `hubMetrics.spec.ts` fails when the two drift). Fixed daily totals only: no identifiers, URLs or content.
 */
export const hubViewPages = ['feed', 'harness', 'creator', 'publish', 'notifications', 'fork'] as const;
export const hubEntrySources = ['direct', 'search', 'social', 'internal', 'other'] as const;
export const hubDwell = ['under_10s', '10s_to_1m', 'over_1m'] as const;
export const hubActions = [
  'feed_search', 'feed_category', 'feed_sort_newest', 'feed_sort_popular', 'feed_sort_trending', 'feed_more', 'card_open',
  'like', 'comment_post', 'comments_open', 'files_open', 'fullscreen',
  'share_open', 'share_copy', 'share_x', 'share_facebook', 'share_linkedin', 'share_sheet',
  'fork', 'fork_need_app', 'follow', 'report',
  'sign_in_prompt_shown', 'sign_in_prompt_click', 'get_app', 'publish_started', 'publish_ok', 'publish_failed',
] as const;

export type HubViewPage = typeof hubViewPages[number];
export type HubEntrySource = typeof hubEntrySources[number];
export type HubAction = typeof hubActions[number];
export type HubMetric = `hub_view_${HubViewPage}_${'visitor' | 'member'}` | `hub_entry_${HubEntrySource}` | `hub_${HubAction}` | `hub_harness_dwell_${typeof hubDwell[number]}`;

export const hubReportMaxValue = 1000;

/** How long a harness page stayed in view, as the backend buckets it. */
export const dwellBucket = (ms: number): HubMetric => `hub_harness_dwell_${ms < 10_000 ? 'under_10s' : ms < 60_000 ? '10s_to_1m' : 'over_1m'}`;

const search = /(^|\.)(google|bing|duckduckgo|yahoo|baidu|yandex|ecosia|brave|kagi|naver|startpage)\./;
const social = /(^|\.)(x\.com|twitter\.com|t\.co|facebook\.com|fb\.com|m\.facebook\.com|linkedin\.com|lnkd\.in|reddit\.com|news\.ycombinator\.com|threads\.net|bsky\.app|mastodon\.social|youtube\.com|discord\.com|t\.me|instagram\.com)$/;

/** Where a visit came from, from the referrer's host alone; only the class leaves the browser. */
export function entrySource(referrer: string, ownHost: string): HubEntrySource {
  if (!referrer) return 'direct';
  let host: string;
  try { host = new URL(referrer).hostname.toLowerCase(); } catch { return 'other'; }
  if (host === ownHost) return 'internal';
  if (search.test(`${host}.`)) return 'search';
  return social.test(host) ? 'social' : 'other';
}
