import 'usage_source.dart';
import 'usage_window.dart';

/// Pure mapping of CLI-reported limit windows; performs no I/O.
abstract final class _ClaudeUsageWindows {
  static ProviderUsage _mapWindows(
    Map<Object?, Object?> data, {
    String? account,
    String? email,
  }) {
    final windows = <UsageWindow>[
      ?_window('Session', data['five_hour']),
      ?_window(kWeeklyWindowLabel, data['seven_day']),
      ?_window(
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
      email: email,
    );
  }

  static UsageWindow? _window(String label, Object? raw) {
    if (raw is! Map) return null;
    final used = parseUsedPercent([raw['utilization'], raw['used_percentage']]);
    if (used == null) return null;
    return UsageWindow(
      label: label,
      usedPercent: used,
      resetsAt: parseResetTimestamp(raw['resets_at']),
    );
  }
}

ProviderUsage claudeUsageFromAnswer({
  required int? statusCode,
  required Object? body,
  String? account,
  String? email,
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
  return _ClaudeUsageWindows._mapWindows(body, account: account, email: email);
}
