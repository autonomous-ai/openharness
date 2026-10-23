// Fixed scalar vocabulary; mirrored by the backend contract and checked in tests.
enum ProductHealthMeasure {
  collectorDays('collector_days'),
  reportFailed('report_failed'),
  reportRejected('report_rejected'),
  reportExpired('report_expired'),
  reportLate('report_late'),
  reportFailureInvalid('report_failure_invalid'),
  reportFailureTooLarge('report_failure_too_large'),
  reportFailureAuth('report_failure_auth'),
  reportFailureRateLimited('report_failure_rate_limited'),
  reportFailureTimeout('report_failure_timeout'),
  reportFailureUnreachable('report_failure_unreachable'),
  reportFailureWriteConflict('report_failure_write_conflict'),
  reportFailureTransaction('report_failure_transaction'),
  reportFailureServer('report_failure_server'),
  reportFailureOther('report_failure_other'),
  queueCapped('queue_capped'),
  observationOverflow('observation_overflow'),
  uncleanRestart('unclean_restart'),
  frameworkError('framework_error'),
  asyncError('async_error'),
  rssUnder256m('rss_under_256m'),
  rss256mTo1g('rss_256m_to_1g'),
  rssOver1g('rss_over_1g'),
  cpuUnder10pct('cpu_under_10pct'),
  cpu10pctTo50pct('cpu_10pct_to_50pct'),
  cpuOver50pct('cpu_over_50pct'),
  frameUnder16ms('frame_under_16ms'),
  frame16msTo50ms('frame_16ms_to_50ms'),
  frame50msTo250ms('frame_50ms_to_250ms'),
  frameOver250ms('frame_over_250ms'),
  feedbackOutcomeShown('feedback_outcome_shown'),
  feedbackOutcomeAnswered('feedback_outcome_answered'),
  feedbackOutcomeDismissed('feedback_outcome_dismissed'),
  feedbackReasonShown('feedback_reason_shown'),
  feedbackReasonAnswered('feedback_reason_answered'),
  feedbackReasonDismissed('feedback_reason_dismissed'),
  funnelSetupSeen('funnel_setup_seen'),
  funnelSignInSeen('funnel_sign_in_seen'),
  funnelWorkspaceReady('funnel_workspace_ready'),
  funnelFirstWork('funnel_first_work'),
  funnelFirstResponse('funnel_first_response'),
  firstWorkUnder1m('first_work_under_1m'),
  firstWork1mTo5m('first_work_1m_to_5m'),
  firstWorkOver5m('first_work_over_5m'),
  firstResponseUnder1m('first_response_under_1m'),
  firstResponse1mTo5m('first_response_1m_to_5m'),
  firstResponseOver5m('first_response_over_5m'),
  installNew('install_new'),
  installUpgrade('install_upgrade'),
  installUnknown('install_unknown'),
  connectErrorAuth('connect_error_auth'),
  connectErrorUnlinked('connect_error_unlinked'),
  connectErrorOffline('connect_error_offline'),
  connectErrorTimeout('connect_error_timeout'),
  connectErrorOther('connect_error_other'),
  interactiveTurnsStarted('interactive_turns_started'),
  toolTurnsStarted('tool_turns_started'),
  unclassifiedTurnsStarted('unclassified_turns_started'),
  interactiveWorkDays('interactive_work_days'),
  firstInteractiveWork('first_interactive_work'),
  firstWorkD1Return('first_work_d1_return'),
  firstWorkD7Return('first_work_d7_return'),
  firstWorkD28Return('first_work_d28_return'),
  weekWorked1day('week_worked_1day'),
  weekWorked2to3days('week_worked_2to3days'),
  weekWorked4to5days('week_worked_4to5days'),
  weekWorked6to7days('week_worked_6to7days'),
  // A sampled frame of 50 ms or more by its longest phase, and the first
  // sampled frame over 250 ms of each collector day (product_runtime_health).
  frameSlowWait('frame_slow_wait'),
  frameSlowBuild('frame_slow_build'),
  frameSlowRaster('frame_slow_raster'),
  frameLongCollector('frame_long_collector'),
  firstRunStarted('first_run_started'),
  firstRunReady('first_run_ready'),
  firstRunWork('first_run_work'),
  firstRunResponse('first_run_response'),
  firstRunResponseUnder1m('first_run_response_under_1m'),
  firstRunResponse1mTo5m('first_run_response_1m_to_5m'),
  firstRunResponseOver5m('first_run_response_over_5m'),
  sharedInvitesSent('shared_invites_sent'),
  sharedInvitesRefused('shared_invites_refused');

  const ProductHealthMeasure(this.wire);
  final String wire;

  /// The revision of the local CLI's report proxy that knows this name
  /// (`x-harness-usage-vocabulary`, cli/src/lib/appProductUsageReport.ts).
  /// A signed-in report goes through that proxy, and one older than a name
  /// refused the whole report, which this app then drops for good (a 400 is
  /// permanent). So a newer name is counted only once the proxy has said it
  /// knows it (`ProductMeasurement.proxyVocabulary`).
  int get vocabulary => switch (this) {
    frameSlowWait ||
    frameSlowBuild ||
    frameSlowRaster ||
    frameLongCollector => 2,
    firstRunStarted ||
    firstRunReady ||
    firstRunWork ||
    firstRunResponse ||
    firstRunResponseUnder1m ||
    firstRunResponse1mTo5m ||
    firstRunResponseOver5m ||
    sharedInvitesSent ||
    sharedInvitesRefused => 5,
    _ => 1,
  };
}

class ProductUsageContext {
  ProductUsageContext({
    required String release,
    required this.platform,
    required this.production,
  }) : release =
           RegExp(r'^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$')
               .hasMatch(release)
           ? release
           : 'unknown';
  final String release;
  final String platform;
  final bool production;
  Map<String, dynamic> toJson() => {
    'surface': 'desktop',
    'release': release,
    'platform': const ['macos', 'linux', 'windows'].contains(platform)
        ? platform
        : 'other',
    'channel': production ? 'production' : 'development',
  };
}
