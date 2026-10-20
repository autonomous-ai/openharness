/**
 * The Hub's anonymous usage counters: fixed daily totals only, no cookies, identifiers, URLs, content
 * or per-person history. The website's server forwards them to `POST /api/product-usage/hub` with
 * cookies and auth stripped; its test imports this file directly, so keep it free of imports.
 */

/** Hub pages counted when drawn, once per navigation. `shared`: a harness someone shared live (`/s/:id`, the web app). */
export const HUB_VIEW_PAGES = ['feed', 'harness', 'creator', 'publish', 'notifications', 'fork', 'shared'] as const
/** Who drew the page: signed out (`visitor`) or signed in (`member`). */
export const HUB_READERS = ['visitor', 'member'] as const
/** Where the first Hub page of a browser tab's visit came from, classified in the browser; the referrer is never sent. */
export const HUB_ENTRY_SOURCES = ['direct', 'search', 'social', 'internal', 'other'] as const
/** How long a harness page, or a live shared harness, stayed visible, once per view. */
export const HUB_DWELL = ['under_10s', '10s_to_1m', 'over_1m'] as const
/** What a shared link first showed, each at most once per page: the harness live, its owner's machine offline,
 * a private link before sign-in, an account not invited or a link stopped, or a link or connection that failed. */
export const HUB_SHARED_OPENS = ['live', 'offline', 'private', 'no_access', 'failed'] as const
/** One per click or submit. `get_app`: Explore's link to the Harness desktop app. `shared_*` happen on a shared
 * link: `viewer_shown` once when its live viewer first draws, `product_page` its Harness link. */
export const HUB_ACTIONS = [
  'feed_search', 'feed_category', 'feed_sort_newest', 'feed_sort_popular', 'feed_sort_trending', 'feed_more', 'card_open',
  'like', 'comment_post', 'comments_open', 'files_open', 'fullscreen',
  'share_open', 'share_copy', 'share_x', 'share_facebook', 'share_linkedin', 'share_sheet',
  'fork', 'fork_need_app', 'follow', 'report',
  'sign_in_prompt_shown', 'sign_in_prompt_click', 'get_app', 'publish_started', 'publish_ok', 'publish_failed',
  'shared_viewer_shown', 'shared_comments_open', 'shared_comment_post', 'shared_sign_in_click', 'shared_retry',
  'shared_get_app', 'shared_product_page',
] as const
export const HUB_METRICS = [
  ...HUB_VIEW_PAGES.flatMap(page => HUB_READERS.map(reader => `hub_view_${page}_${reader}` as const)),
  ...HUB_ENTRY_SOURCES.map(source => `hub_entry_${source}` as const),
  ...HUB_ACTIONS.map(action => `hub_${action}` as const),
  ...HUB_DWELL.map(bucket => `hub_harness_dwell_${bucket}` as const),
  ...HUB_SHARED_OPENS.map(open => `hub_shared_open_${open}` as const),
  ...HUB_DWELL.map(bucket => `hub_shared_dwell_${bucket}` as const),
] as const
export type HubMetric = typeof HUB_METRICS[number]
/** A report may carry every counter once. */
export const HUB_REPORT_MAX_COUNTERS = HUB_METRICS.length
export const HUB_REPORT_MAX_VALUE = 1000
