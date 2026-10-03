import 'usage_source.dart';
import 'usage_window.dart';

/// What Codex's usage endpoint said, as the rail draws it — asked by a linked machine with its own
/// `codex login` token and handed back over the relay (`usage_read`, see `remote_usage.dart`).
///
/// ⚠️ Undocumented, on the same terms as Claude's (`claude_usage_source.dart`): this is the backend the
/// Codex CLI itself asks, and it can change without notice.
///
/// Codex numbers its windows rather than naming them — a primary and a
/// secondary, whose real durations arrive in the payload — so the labels here
/// are derived from `limit_window_seconds` instead of hardcoded. A build that
/// printed "5h" for a window the server had quietly changed to 24h would be
/// confidently wrong, which is worse than saying nothing.
ProviderUsage codexUsageFromAnswer({
  required int? statusCode,
  required Object? body,
  String? account,
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
  return _codexWindows(body, account: account);
}

ProviderUsage _codexWindows(Map<Object?, Object?> data, {String? account}) {
  final limits = data['rate_limit'];
  final windows = limits is Map
      ? <UsageWindow>[
          ?_codexWindow(limits['primary_window']),
          ?_codexWindow(limits['secondary_window']),
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
  );
}

UsageWindow? _codexWindow(Object? raw) {
  if (raw is! Map) return null;
  final used = parseUsedPercent([raw['used_percent']]);
  if (used == null) return null;
  return UsageWindow(
    label: _codexLabelFor(raw['limit_window_seconds']),
    usedPercent: used,
    resetsAt: parseResetTimestamp(raw['reset_at']),
  );
}

/// Names a window by how long it actually is.
///
/// Falls back to the neutral "Limit" rather than guessing: a window whose
/// duration the server did not send is one this build knows nothing about,
/// and a made-up "5h" beside a real percentage would be read as measured.
String _codexLabelFor(Object? seconds) {
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
