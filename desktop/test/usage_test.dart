import 'package:flutter_test/flutter_test.dart';
import 'package:harness/usage/claude_usage_report.dart';
import 'package:harness/usage/codex_usage_report.dart';
import 'package:harness/usage/usage_controller.dart';
import 'package:harness/usage/usage_source.dart';
import 'package:harness/usage/usage_window.dart';

void main() {
  group('reset timestamps', () {
    test('seconds and milliseconds are told apart by magnitude', () {
      final seconds = parseResetTimestamp(1770000000);
      final millis = parseResetTimestamp(1770000000000);
      // 1e10 sits between any plausible seconds epoch and any plausible
      // millisecond one, so both must land on the same instant.
      expect(seconds, millis);
    });

    test(
      'an ISO string is read, and nonsense is null rather than epoch zero',
      () {
        expect(
          parseResetTimestamp('2026-09-08T12:00:00Z'),
          DateTime.utc(2026, 9, 8, 12),
        );
        expect(parseResetTimestamp('not a date'), isNull);
        expect(parseResetTimestamp(null), isNull);
        expect(parseResetTimestamp(''), isNull);
      },
    );
  });

  group('used percent', () {
    test('the first field that is actually a number wins', () {
      expect(parseUsedPercent([null, 'x', 16]), 16);
      expect(parseUsedPercent([null, 'x']), isNull);
    });

    test(
      'a figure outside 0-100 is clamped, not drawn off the end of the bar',
      () {
        expect(parseUsedPercent([140]), 100);
        expect(parseUsedPercent([-3]), 0);
      },
    );
  });

  group('countdown', () {
    final now = DateTime(2026, 9, 8, 12);
    UsageWindow at(Duration left) =>
        UsageWindow(label: 'w', usedPercent: 1, resetsAt: now.add(left));

    test('reads in the largest two units that still say something', () {
      expect(at(const Duration(minutes: 43)).resetsInLabel(now: now), '43m');
      expect(
        at(const Duration(hours: 4, minutes: 34)).resetsInLabel(now: now),
        '4h 34m',
      );
      expect(
        at(const Duration(days: 5, hours: 11)).resetsInLabel(now: now),
        '5d 11h',
      );
    });

    test(
      'a window with no reset time, or one already past, counts nothing',
      () {
        // Null is not zero: "resets in 0m" would be a measurement invented out
        // of a silence.
        expect(
          const UsageWindow(label: 'Fable', usedPercent: 0).resetsInLabel(),
          isNull,
        );
        expect(at(const Duration(seconds: -5)).resetsInLabel(now: now), isNull);
      },
    );
  });

  test('the tightest window is the one closest to stopping the work', () {
    const reading = ProviderUsage(
      provider: UsageProvider.claude,
      status: UsageStatus.ok,
      windows: [
        UsageWindow(label: 'Session', usedPercent: 2),
        UsageWindow(label: 'Weekly', usedPercent: 16),
      ],
    );
    expect(reading.tightest?.label, 'Weekly');
  });

  group('CLI-reported windows', () {
    test('maps Claude windows and preserves CLI account identity', () {
      final reading = claudeUsageFromAnswer(
        statusCode: 200,
        account: 'opaque-account',
        email: 'dev@example.com',
        body: {
          'five_hour': {'utilization': 2, 'resets_at': 1770000000},
          'seven_day': {'used_percentage': 16},
          'fable_weekly': {'utilization': 0},
        },
      );
      expect(reading.status, UsageStatus.ok);
      expect(reading.account, 'opaque-account');
      expect(reading.email, 'dev@example.com');
      expect(
        reading.windows.map((w) => '${w.label} ${w.usedPercent.round()}'),
        ['Session 2', 'Weekly 16', 'Fable 0'],
      );
    });
    test('maps every reported Fable spelling', () {
      for (final key in [
        'fable_weekly',
        'fable_seven_day',
        'seven_day_fable',
      ]) {
        expect(
          claudeUsageFromAnswer(
            statusCode: 200,
            body: {
              key: {'utilization': 7},
            },
          ).windows.single.label,
          'Fable',
        );
      }
    });
    test('names Codex windows from reported durations', () {
      final reading = codexUsageFromAnswer(
        statusCode: 200,
        body: {
          'rate_limit': {
            'primary_window': {
              'used_percent': 9,
              'limit_window_seconds': 18000,
            },
            'secondary_window': {
              'used_percent': 40,
              'limit_window_seconds': 604800,
            },
          },
        },
      );
      expect(reading.windows.map((w) => w.label), ['5h', 'Weekly']);
      expect(reading.windows.first.usedPercent, 9);
      expect(
        codexUsageFromAnswer(
          statusCode: 200,
          body: {
            'rate_limit': {
              'primary_window': {'used_percent': 9},
            },
          },
        ).windows.single.label,
        'Limit',
      );
    });
    test('reported sign-out and failure stay distinct', () {
      expect(
        claudeUsageFromAnswer(statusCode: 401, body: {}).status,
        UsageStatus.signedOut,
      );
      expect(
        codexUsageFromAnswer(statusCode: 500, body: {}).status,
        UsageStatus.failed,
      );
    });
  });

  group('controller', () {
    test('a controller nobody started is not loading', () {
      // A rail that drew a skeleton for it would promise an answer that was
      // never coming.
      final controller = UsageController(sources: const [], autoStart: false);
      expect(controller.loading, isFalse);
      controller.dispose();
    });

    test('the last good reading survives a failed refresh, and goes stale', () async {
      final source = _SwitchableSource();
      final controller = UsageController(sources: [source], autoStart: false);

      await controller.refresh();
      expect(controller.answered.single.windows.single.usedPercent, 2);
      expect(controller.stale, isFalse);
      expect(controller.loading, isFalse);

      source.failing = true;
      await controller.refresh();

      // An account that answered a minute ago has not stopped existing because
      // one request timed out.
      expect(controller.stale, isTrue);
      controller.dispose();
    });
  });
}

/// A source that answers, and then stops answering.
class _SwitchableSource implements UsageSource {
  bool failing = false;

  @override
  UsageProvider get provider => UsageProvider.claude;

  @override
  Future<ProviderUsage> read() async => failing
      ? const ProviderUsage(
          provider: UsageProvider.claude,
          status: UsageStatus.failed,
          message: 'Could not reach Claude',
        )
      : ProviderUsage(
          provider: UsageProvider.claude,
          status: UsageStatus.ok,
          windows: const [UsageWindow(label: 'Session', usedPercent: 2)],
          fetchedAt: DateTime.now(),
        );
}
