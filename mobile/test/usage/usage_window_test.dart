import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/usage/usage_pressure.dart';
import 'package:harness_mobile/usage/usage_window.dart';

/// The one model both vendors are read into, and the two parsers every figure
/// on the Usage page passes through. A figure here is only ever as right as
/// these are, so the edges are pinned rather than trusted.
void main() {
  final now = DateTime(2026, 9, 27, 12);

  group('UsageProvider', () {
    test(
      'names itself, and is found by the engine id its agents run under',
      () {
        expect(UsageProvider.claude.label, 'Claude');
        expect(UsageProvider.codex.label, 'Codex');
        // `EngineMark` finds the logo by this id; a second spelling would draw
        // an account without its mark.
        expect(UsageProvider.claude.engineId, 'claude');
        expect(UsageProvider.codex.engineId, 'codex');
      },
    );
  });

  group('resetsInLabel', () {
    UsageWindow resetting(Duration? after) => UsageWindow(
      label: 'Session',
      usedPercent: 10,
      resetsAt: after == null ? null : now.add(after),
    );

    test('says nothing when the vendor gave no reset time', () {
      // Null is not zero: "resets in 0m" for an answer never given would be a
      // measurement invented out of a silence.
      expect(resetting(null).resetsInLabel(now: now), isNull);
    });

    test(
      'says nothing once the reset has passed, or is under a minute off',
      () {
        expect(
          resetting(const Duration(minutes: -5)).resetsInLabel(now: now),
          isNull,
        );
        expect(
          resetting(const Duration(seconds: 59)).resetsInLabel(now: now),
          isNull,
        );
      },
    );

    test('minutes under an hour, hours and minutes under a day, then days', () {
      expect(
        resetting(const Duration(minutes: 43)).resetsInLabel(now: now),
        '43m',
      );
      expect(
        resetting(const Duration(hours: 4, minutes: 34))
            .resetsInLabel(now: now),
        '4h 34m',
      );
      expect(
        resetting(const Duration(days: 5, hours: 11)).resetsInLabel(now: now),
        '5d 11h',
      );
    });

    test('reads the wall clock when no time is passed in', () {
      final window = UsageWindow(
        label: 'Weekly',
        usedPercent: 1,
        resetsAt: DateTime.now().add(const Duration(hours: 2, minutes: 30)),
      );
      expect(window.resetsInLabel(), anyOf('2h 29m', '2h 30m'));
    });
  });

  group('ProviderUsage', () {
    const session = UsageWindow(label: 'Session', usedPercent: 71);
    const weekly = UsageWindow(label: kWeeklyWindowLabel, usedPercent: 40);
    const fable = UsageWindow(label: 'Fable', usedPercent: 12);

    test('before its first answer it is loading, with nothing to draw', () {
      const loading = ProviderUsage.loading(UsageProvider.codex);
      expect(loading.status, UsageStatus.loading);
      expect(loading.windows, isEmpty);
      expect(loading.message, isNull);
      expect(loading.fetchedAt, isNull);
      expect(loading.account, isNull);
      expect(loading.hasFigures, isFalse);
      expect(loading.tightest, isNull);
      expect(loading.railWindow, isNull);
    });

    test('has figures only when it answered AND reported a window', () {
      expect(
        const ProviderUsage(
          provider: UsageProvider.claude,
          status: UsageStatus.ok,
        ).hasFigures,
        isFalse,
      );
      expect(
        const ProviderUsage(
          provider: UsageProvider.claude,
          status: UsageStatus.failed,
          windows: [session],
        ).hasFigures,
        isFalse,
      );
    });

    test('the tightest window is the one closest to being spent', () {
      const reading = ProviderUsage(
        provider: UsageProvider.claude,
        status: UsageStatus.ok,
        windows: [weekly, session, fable],
      );
      expect(reading.tightest, same(session));
    });

    test('the rail prints the weekly window, even when another is tighter', () {
      const reading = ProviderUsage(
        provider: UsageProvider.claude,
        status: UsageStatus.ok,
        windows: [session, weekly, fable],
      );
      expect(reading.railWindow, same(weekly));
    });

    test('with no weekly window the rail falls back to the tightest', () {
      const reading = ProviderUsage(
        provider: UsageProvider.codex,
        status: UsageStatus.ok,
        windows: [fable, session],
      );
      expect(reading.railWindow, same(session));
    });
  });

  group('parseResetTimestamp', () {
    test('reads epoch seconds and epoch milliseconds by their size', () {
      final at = DateTime.utc(2026, 9, 27, 12);
      final seconds = at.millisecondsSinceEpoch ~/ 1000;
      expect(parseResetTimestamp(seconds)!.isAtSameMomentAs(at), isTrue);
      expect(
        parseResetTimestamp(at.millisecondsSinceEpoch)!.isAtSameMomentAs(at),
        isTrue,
      );
      // Fractional seconds are a number like any other.
      expect(
        parseResetTimestamp(seconds + 0.5)!.millisecondsSinceEpoch,
        at.millisecondsSinceEpoch + 500,
      );
    });

    test('reads a number sent as a string, and an ISO timestamp', () {
      final at = DateTime.utc(2026, 9, 27, 12);
      expect(
        parseResetTimestamp(' ${at.millisecondsSinceEpoch ~/ 1000} ')!
            .isAtSameMomentAs(at),
        isTrue,
      );
      expect(
        parseResetTimestamp('2026-09-27T12:00:00Z')!.isAtSameMomentAs(at),
        isTrue,
      );
    });

    test('anything else is no reset time rather than a guess', () {
      for (final value in <Object?>[
        null,
        '',
        '   ',
        'soon',
        true,
        double.nan,
        double.infinity,
        const {'at': 1},
      ]) {
        expect(parseResetTimestamp(value), isNull, reason: '$value');
      }
    });

    test('a timestamp past the calendar is dropped, not thrown', () {
      // Nanoseconds, or any unit this build does not expect, reads as a
      // millisecond count past what a DateTime can hold. It used to throw a
      // RangeError out of here — through `parseUsageReadResult`, which
      // promises never to throw — and the caller then dropped the machine's
      // WHOLE answer, every provider on it, over one odd field.
      expect(parseResetTimestamp(1790000000000000000), isNull);
      expect(parseResetTimestamp(-1790000000000000000), isNull);
      expect(parseResetTimestamp('1790000000000000000'), isNull);
    });
  });

  group('parseUsedPercent', () {
    test('the first candidate that is really a number wins', () {
      expect(parseUsedPercent([null, 'n/a', 42]), 42);
      expect(parseUsedPercent(['17.5', 3]), 17.5);
    });

    test('is clamped to the 0-100 the page draws', () {
      expect(parseUsedPercent([-4]), 0);
      expect(parseUsedPercent([140]), 100);
    });

    test('a non-finite figure is no figure', () {
      // `double.tryParse('NaN')` succeeds, and NaN clamps to a number — so the
      // finiteness check is what keeps a hand-edited answer off the page.
      expect(parseUsedPercent(['NaN', double.infinity]), isNull);
      expect(parseUsedPercent(const []), isNull);
    });
  });

  group('usage pressure', () {
    test('calm below 80, amber from 80, red from 90', () {
      expect(usagePressureOf(79.9), UsagePressure.calm);
      expect(usagePressureOf(kUsageWarnPercent), UsagePressure.warn);
      expect(usagePressureOf(89.9), UsagePressure.warn);
      expect(usagePressureOf(kUsageCriticalPercent), UsagePressure.critical);
      expect(
        const UsageWindow(label: 'Weekly', usedPercent: 95).pressure,
        UsagePressure.critical,
      );
    });
  });
}
