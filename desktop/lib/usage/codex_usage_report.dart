import 'usage_source.dart';
import 'usage_window.dart';

/// Pure mapping of CLI-reported limit windows; performs no I/O.
abstract final class _CodexUsageWindows {
  static ProviderUsage _mapWindows(
    Map<Object?, Object?> data, {
    String? account,
    String? email,
  }) {
    final limits = data['rate_limit'];
    final windows = limits is Map
        ? <UsageWindow>[
            ?_window(limits['primary_window']),
            ?_window(limits['secondary_window']),
          ]
        : const <UsageWindow>[];
    if (windows.isEmpty) {
      return const ProviderUsage(
        provider: UsageProvider.codex,
        status: UsageStatus.failed,
        message: 'Codex reported no limits',
      );
    }
    return ProviderUsage(
      provider: UsageProvider.codex,
      status: UsageStatus.ok,
      windows: windows,
      fetchedAt: DateTime.now(),
      account: account,
      email: email,
    );
  }

  static UsageWindow? _window(Object? raw) {
    if (raw is! Map) return null;
    final used = parseUsedPercent([raw['used_percent']]);
    if (used == null) return null;
    return UsageWindow(
      label: _labelFor(raw['limit_window_seconds']),
      usedPercent: used,
      resetsAt: parseResetTimestamp(raw['reset_at']),
    );
  }

  /// Names a window by how long it actually is.
  ///
  /// Falls back to the neutral "Limit" rather than guessing: a window whose
  /// duration the server did not send is one this build knows nothing about,
  /// and a made-up "5h" beside a real percentage would be read as measured.
  static String _labelFor(Object? seconds) {
    final value = seconds is num && seconds.isFinite && seconds > 0
        ? seconds.round()
        : null;
    if (value == null) return 'Limit';
    final hours = value ~/ 3600;
    if (hours < 1) return '${value ~/ 60}m';
    if (hours < 24) return '${hours}h';
    final days = hours ~/ 24;
    return days == 7 ? kWeeklyWindowLabel : '${days}d';
  }
}

ProviderUsage codexUsageFromAnswer({
  required int? statusCode,
  required Object? body,
  String? account,
  String? email,
}) {
  final failure = usageFailureFor(UsageProvider.codex, statusCode);
  if (failure != null) return failure;
  if (body is! Map) {
    return const ProviderUsage(
      provider: UsageProvider.codex,
      status: UsageStatus.failed,
      message: 'Codex answered in a shape this build cannot read',
    );
  }
  return _CodexUsageWindows._mapWindows(body, account: account, email: email);
}
