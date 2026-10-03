import 'usage_source.dart';
import 'usage_window.dart';

/// What Claude's usage endpoint said, as the rail draws it. A phone has no Claude login of its own:
/// a linked machine asks with its own token and hands back exactly what the endpoint sent
/// (`usage_read`, see `remote_usage.dart`), and this reads that answer.
///
/// ⚠️ **The endpoint is undocumented.** It is what the CLI itself asks when it prints `/usage`, and
/// it answers only to a token minted for the CLI. It can change without notice, and when it does the
/// failure is a parse error or a 4xx, both of which this reports as a state rather than a crash.
ProviderUsage claudeUsageFromAnswer({
  required int? statusCode,
  required Object? body,
  String? account,
}) {
  final failure = usageFailureFor(UsageProvider.claude, statusCode);
  if (failure != null) return failure;
  if (body is! Map) {
    return const ProviderUsage(
      provider: UsageProvider.claude,
      status: UsageStatus.failed,
      message: 'Claude answered in a shape this build cannot read',
    );
  }
  return _claudeWindows(body, account: account);
}

/// The three windows the CLI itself shows, in the order they bite.
///
/// Fable's weekly allowance has been spelled three ways across releases, so
/// all three are tried — an absent window is simply not drawn, which is why
/// a build reading a newer server loses a row rather than the whole panel.
ProviderUsage _claudeWindows(Map<Object?, Object?> data, {String? account}) {
  final windows = <UsageWindow>[
    ?_claudeWindow('Session', data['five_hour']),
    ?_claudeWindow(kWeeklyWindowLabel, data['seven_day']),
    ?_claudeWindow(
      'Fable',
      data['fable_weekly'] ??
          data['fable_seven_day'] ??
          data['seven_day_fable'],
    ),
  ];
  if (windows.isEmpty) {
    return const ProviderUsage(
      provider: UsageProvider.claude,
      status: UsageStatus.failed,
      message: 'Claude reported no limits',
    );
  }
  return ProviderUsage(
    provider: UsageProvider.claude,
    status: UsageStatus.ok,
    windows: windows,
    fetchedAt: DateTime.now(),
    account: account,
  );
}

UsageWindow? _claudeWindow(String label, Object? raw) {
  if (raw is! Map) return null;
  final used = parseUsedPercent([raw['utilization'], raw['used_percentage']]);
  if (used == null) return null;
  return UsageWindow(
    label: label,
    usedPercent: used,
    resetsAt: parseResetTimestamp(raw['resets_at']),
  );
}
