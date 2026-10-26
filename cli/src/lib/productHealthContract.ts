/** Fixed health vocabulary. Keep the CLI/backend copies identical. No arbitrary labels. */
// `phone`: the phone app's requests, which it marks itself (`usageSurface`) — over the relay it is a
// remote app client like the browser, and only it can say which one it is.
export const HEALTH_SOURCES = ['app', 'tool', 'automatic', 'unknown', 'phone'] as const
export const HEALTH_ACTIONS = ['create', 'resume', 'restart', 'model_change', 'history', 'fork', 'close', 'delete',
  'search', 'history_page', 'store_list', 'store_install', 'store_update', 'store_remove',
  'model_list', 'model_download', 'model_start', 'model_stop', 'browser_open', 'message'] as const
export const HEALTH_RESULTS = ['started', 'ok', 'failed', 'pending', 'cancelled', 'unknown'] as const
/** The fixed polls an app makes on its own, which count under `automatic` whichever app makes them
 *  (`PRODUCT_USAGE_AUTOMATIC_ACTIONS`); the phone's are counted again, apart, under `phone_automatic`. */
export const AUTOMATIC_POLL_ACTIONS = ['history', 'history_page', 'store_list', 'model_list'] as const
export const HEALTH_FAILURES = ['setup', 'auth', 'unavailable', 'invalid', 'not_found', 'conflict', 'timeout', 'other'] as const
export const HEALTH_FLOWS = ['app_start', 'workspace_ready', 'viewer_load', 'update_apply', 'update_relaunch',
  'connect_user', 'connect_auto', 'resume_recovery'] as const
export const HEALTH_MEASURES = [
  'collector_days', 'report_failed', 'report_rejected', 'report_expired', 'report_late', 'queue_capped', 'observation_overflow',
  'unclean_restart', 'framework_error', 'async_error',
  'rss_under_256m', 'rss_256m_to_1g', 'rss_over_1g',
  'cpu_under_10pct', 'cpu_10pct_to_50pct', 'cpu_over_50pct',
  'frame_under_16ms', 'frame_16ms_to_50ms', 'frame_50ms_to_250ms', 'frame_over_250ms',
  'feedback_outcome_shown', 'feedback_outcome_answered', 'feedback_outcome_dismissed',
  'feedback_reason_shown', 'feedback_reason_answered', 'feedback_reason_dismissed',
  'funnel_setup_seen', 'funnel_sign_in_seen', 'funnel_workspace_ready', 'funnel_first_work', 'funnel_first_response',
  'first_work_under_1m', 'first_work_1m_to_5m', 'first_work_over_5m',
  'first_response_under_1m', 'first_response_1m_to_5m', 'first_response_over_5m',
  'install_new', 'install_upgrade', 'install_unknown',
  'connect_error_auth', 'connect_error_unlinked', 'connect_error_offline', 'connect_error_timeout', 'connect_error_other',
  'interactive_turns_started', 'tool_turns_started', 'unclassified_turns_started',
  'interactive_work_days', 'first_interactive_work', 'first_work_d1_return', 'first_work_d7_return', 'first_work_d28_return',
  'week_worked_1day', 'week_worked_2to3days', 'week_worked_4to5days', 'week_worked_6to7days',
  // Vocabulary 2 (`x-harness-usage-vocabulary`, cli/src/lib/appProductUsageReport.ts): a sampled Desktop frame of
  // 50 ms or more by its longest phase, and one per collector day whose sampled frames included one over 250 ms.
  // The Desktop counts them only once its CLI's report proxy has said it knows them.
  'frame_slow_wait', 'frame_slow_build', 'frame_slow_raster', 'frame_long_collector',
  // Vocabulary 5: first-arrival app episodes, scoped to the harness opened by onboarding.
  'first_run_started', 'first_run_ready', 'first_run_work', 'first_run_response',
  'first_run_response_under_1m', 'first_run_response_1m_to_5m', 'first_run_response_over_5m',
  'shared_invites_sent', 'shared_invites_refused',
] as const
// Delivery attempts, including retries; separate from the cross-surface app measures.
export const CLI_REPORT_FAILURES = ['invalid', 'too_large', 'auth', 'rate_limited', 'timeout', 'unreachable',
  'write_conflict', 'transaction', 'server', 'other'] as const
export type CliReportFailure = typeof CLI_REPORT_FAILURES[number]
// Fixed resume conditions, separate from raw errors and from whether a request actually failed.
export const RESUME_REASONS = ['runtime_unavailable', 'saved_state_missing', 'project_missing', 'harness_missing',
  'credentials_missing', 'busy', 'changed', 'unconfirmed', 'preparation_failed', 'launch_failed', 'invalid', 'other'] as const
export type ResumeReason = typeof RESUME_REASONS[number]
export const PRODUCT_HEALTH_METRICS = [
  ...CLI_REPORT_FAILURES.map(reason => `health_cli_report_failure_${reason}` as const),
  ...CLI_REPORT_FAILURES.map(reason => `health_desktop_report_failure_${reason}` as const),
  ...HEALTH_SOURCES.flatMap(source => RESUME_REASONS.map(reason => `request_${source}_resume_reason_${reason}` as const)),
  // hn's (`tui`) come through its daemon's queue, under that daemon's context, never one of their own.
  ...(['cli', 'desktop', 'tui'] as const).flatMap(surface => HEALTH_MEASURES.map(m => `health_${surface}_${m}` as const)),
  // The phone reports only its coverage (the threshold its breakdowns need) and late deliveries.
  'health_phone_collector_days', 'health_phone_report_late',
  ...HEALTH_SOURCES.flatMap(source => HEALTH_ACTIONS.flatMap(action => [
    ...HEALTH_RESULTS.map(result => `request_${source}_${action}_${result}` as const),
    ...HEALTH_FAILURES.map(failure => `request_${source}_${action}_error_${failure}` as const),
  ])),
  // Of `automatic`, the phone's own again: until then the Desktop's and the phone's polls read as one total.
  ...AUTOMATIC_POLL_ACTIONS.flatMap(action => [
    ...HEALTH_RESULTS.map(result => `request_phone_automatic_${action}_${result}` as const),
    ...HEALTH_FAILURES.map(failure => `request_phone_automatic_${action}_error_${failure}` as const),
  ]),
] as const
export type ProductHealthMetric = typeof PRODUCT_HEALTH_METRICS[number]
export type HealthSource = typeof HEALTH_SOURCES[number]
export interface ProductUsageContext {
  surface: 'cli' | 'desktop' | 'phone'
  release: string
  platform: 'macos' | 'linux' | 'windows' | 'ios' | 'android' | 'other'
  // `testing`: a tester's build of a store release (the phone from TestFlight), kept apart from the totals.
  channel: 'production' | 'development' | 'testing'
}
/** Public numeric release only. Custom build names, hashes and suffixes cannot become labels. */
export function releaseBucket(value: unknown): string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.test(value) ? value : 'unknown'
}
export function cleanUsageContext(value: unknown): ProductUsageContext | undefined {
  if (!value || typeof value !== 'object') return
  const c = value as ProductUsageContext
  if (!['cli', 'desktop', 'phone'].includes(c.surface) || !['macos', 'linux', 'windows', 'ios', 'android', 'other'].includes(c.platform)
      || !['production', 'development', 'testing'].includes(c.channel)) return
  return { surface: c.surface, release: releaseBucket(c.release), platform: c.platform, channel: c.channel }
}

