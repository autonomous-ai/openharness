import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/usage/claude_usage_source.dart';
import 'package:harness_mobile/usage/codex_usage_source.dart';
import 'package:harness_mobile/usage/remote_usage.dart';
import 'package:harness_mobile/usage/usage_source.dart';
import 'package:harness_mobile/usage/usage_window.dart';

/// What a machine's `usage_read_result` turns into on the phone.
///
/// Every figure the Usage page and the model sheet draw came in through here:
/// a phone has no Claude or Codex login of its own, so a linked machine asks
/// with ITS tokens and hands back the vendors' replies verbatim. Each way that
/// reply can be partial, refused or malformed has to land as a state the page
/// can say a sentence about — never as a missing machine or a thrown error.
void main() {
  group('a finished request, as the state it leaves', () {
    test('no status at all: the vendor was not reached', () {
      final failure = usageFailureFor(UsageProvider.codex, null)!;
      expect(failure.status, UsageStatus.failed);
      expect(failure.message, 'Could not reach Codex');
    });

    test('401 and 403 are a missing session, not a failure to retry', () {
      for (final code in [401, 403]) {
        final failure = usageFailureFor(UsageProvider.claude, code)!;
        expect(failure.status, UsageStatus.signedOut, reason: '$code');
        expect(failure.message, 'Sign in to Claude to see usage');
      }
    });

    test('any other 4xx or 5xx names the status it answered with', () {
      final failure = usageFailureFor(UsageProvider.claude, 429)!;
      expect(failure.status, UsageStatus.failed);
      expect(failure.message, 'Claude answered 429');
      expect(
        usageFailureFor(UsageProvider.codex, 503)!.message,
        contains('503'),
      );
    });

    test('a success is no failure — the body decides', () {
      expect(usageFailureFor(UsageProvider.claude, 200), isNull);
    });

    test('signed out, in the sentence the page prints', () {
      final reading = signedOut(UsageProvider.codex);
      expect(reading.status, UsageStatus.signedOut);
      expect(reading.message, 'Sign in to Codex to see usage');
    });
  });

  group('Claude', () {
    test('reads its three windows, in the order they bite', () {
      final reading = claudeUsageFromAnswer(
        statusCode: 200,
        account: 'acct',
        body: {
          'five_hour': {'utilization': 12, 'resets_at': '2026-09-27T15:00:00Z'},
          'seven_day': {'used_percentage': '41.5'},
          'fable_weekly': {'utilization': 3},
        },
      );
      expect(reading.status, UsageStatus.ok);
      expect(reading.account, 'acct');
      expect(reading.fetchedAt, isNotNull);
      expect(
        [for (final w in reading.windows) w.label],
        ['Session', kWeeklyWindowLabel, 'Fable'],
      );
      expect(reading.windows[1].usedPercent, 41.5);
      expect(reading.windows.first.resetsAt, isNotNull);
    });

    test('finds Fable under either of its older spellings', () {
      for (final key in ['fable_seven_day', 'seven_day_fable']) {
        final reading = claudeUsageFromAnswer(
          statusCode: 200,
          body: {
            key: {'utilization': 9},
          },
        );
        expect(reading.windows.single.label, 'Fable', reason: key);
      }
    });

    test('a window with no figure is dropped, not drawn as zero', () {
      final reading = claudeUsageFromAnswer(
        statusCode: 200,
        body: {
          'five_hour': {'utilization': null},
          'seven_day': {'utilization': 50},
          'seven_day_opus': null,
        },
      );
      expect(reading.windows.single.label, kWeeklyWindowLabel);
    });

    test('an answer with no window at all is a failure that says so', () {
      final reading = claudeUsageFromAnswer(statusCode: 200, body: const {});
      expect(reading.status, UsageStatus.failed);
      expect(reading.message, 'Claude reported no limits');
    });

    test('a body that is not an object is a shape this build cannot read', () {
      final reading = claudeUsageFromAnswer(statusCode: 200, body: 'oops');
      expect(reading.status, UsageStatus.failed);
      expect(reading.message, contains('cannot read'));
    });

    test('a refused request never reaches the body', () {
      expect(
        claudeUsageFromAnswer(statusCode: 401, body: const {}).status,
        UsageStatus.signedOut,
      );
    });
  });

  group('Codex', () {
    Map<String, Object?> window(Object? seconds, {Object? used = 30}) => {
      'used_percent': used,
      'limit_window_seconds': seconds,
      'reset_at': 1790000000,
    };

    ProviderUsage answer(Map<String, Object?> primary) => codexUsageFromAnswer(
      statusCode: 200,
      body: {
        'rate_limit': {'primary_window': primary},
      },
    );

    test('names each window by how long it really is', () {
      expect(answer(window(18000)).windows.single.label, '5h');
      expect(answer(window(1800)).windows.single.label, '30m');
      expect(answer(window(604800)).windows.single.label, kWeeklyWindowLabel);
      expect(answer(window(86400 * 30)).windows.single.label, '30d');
    });

    test('a window whose length was not sent is a neutral "Limit"', () {
      for (final seconds in <Object?>[null, 0, -60, 'soon', double.nan]) {
        expect(
          answer(window(seconds)).windows.single.label,
          'Limit',
          reason: '$seconds',
        );
      }
    });

    test('reads its primary and secondary windows, and the account', () {
      final reading = codexUsageFromAnswer(
        statusCode: 200,
        account: 'acct',
        body: {
          'rate_limit': {
            'primary_window': window(18000),
            'secondary_window': window(604800, used: 64),
          },
        },
      );
      expect(reading.status, UsageStatus.ok);
      expect(reading.account, 'acct');
      expect(reading.windows, hasLength(2));
      expect(reading.railWindow!.usedPercent, 64);
      expect(reading.windows.first.resetsAt, isNotNull);
    });

    test('no readable window is a failure that says so', () {
      for (final body in <Object?>[
        const {},
        const {'rate_limit': 'x'},
        {
          'rate_limit': {
            'primary_window': window(18000, used: null),
            'secondary_window': 'x',
          },
        },
      ]) {
        final reading = codexUsageFromAnswer(statusCode: 200, body: body);
        expect(reading.status, UsageStatus.failed, reason: '$body');
        expect(reading.message, 'Codex reported no limits');
      }
    });

    test('a body that is not an object, or a refusal', () {
      expect(
        codexUsageFromAnswer(statusCode: 200, body: null).message,
        contains('cannot read'),
      );
      expect(
        codexUsageFromAnswer(statusCode: 500, body: null).message,
        'Codex answered 500',
      );
    });
  });

  group('parseUsageReadResult', () {
    test('an answer with no provider list has nothing to add', () {
      expect(parseUsageReadResult(const {}), isEmpty);
      expect(parseUsageReadResult(const {'providers': 'x'}), isEmpty);
    });

    test('each provider read by the same mapper this phone would use', () {
      final readings = parseUsageReadResult({
        'providers': [
          {
            'provider': 'claude',
            'outcome': 'answered',
            'httpStatus': 200,
            'account': 'a1',
            'body': {
              'seven_day': {'utilization': 20},
            },
          },
          {
            'provider': 'codex',
            'outcome': 'answered',
            'httpStatus': 200,
            'account': '',
            'body': {
              'rate_limit': {
                'primary_window': {
                  'used_percent': 5,
                  'limit_window_seconds': 18000,
                },
              },
            },
          },
        ],
      });
      expect(readings, hasLength(2));
      expect(readings[0].provider, UsageProvider.claude);
      expect(readings[0].account, 'a1');
      expect(readings[1].provider, UsageProvider.codex);
      // An empty key is no key: it must never merge two accounts.
      expect(readings[1].account, isNull);
    });

    test('a provider or entry this build has never heard of is dropped', () {
      final readings = parseUsageReadResult({
        'providers': [
          'not a map',
          {'provider': 'grok', 'outcome': 'answered'},
          {'provider': 'codex', 'outcome': 'signedOut'},
        ],
      });
      expect(readings.single.provider, UsageProvider.codex);
    });

    test('signed out there: the machine\'s own sentence when it sent one', () {
      final readings = parseUsageReadResult({
        'providers': [
          {
            'provider': 'claude',
            'outcome': 'signedOut',
            'message': 'Claude session expired on Studio',
          },
          {'provider': 'codex', 'outcome': 'signedOut', 'message': ''},
        ],
      });
      expect(readings[0].status, UsageStatus.signedOut);
      expect(readings[0].message, 'Claude session expired on Studio');
      expect(readings[1].message, 'Sign in to Codex to see usage');
    });

    test('unreachable, or an outcome from a newer CLI, is a failure', () {
      final readings = parseUsageReadResult({
        'providers': [
          {'provider': 'claude', 'outcome': 'unreachable'},
          {'provider': 'codex', 'outcome': 'rate_limited_somewhere_new'},
        ],
      });
      expect(readings.map((r) => r.status), [
        UsageStatus.failed,
        UsageStatus.failed,
      ]);
      expect(readings.first.message, 'Could not reach Claude');
    });

    test('an answered entry with no status reads as unreached', () {
      final reading = parseUsageReadResult({
        'providers': [
          {'provider': 'claude', 'outcome': 'answered', 'httpStatus': '200'},
        ],
      }).single;
      expect(reading.status, UsageStatus.failed);
    });

    test('one odd timestamp costs its window, not the machine\'s answer', () {
      // The regression behind the RangeError guard in `parseResetTimestamp`:
      // the caller (`AppNotifier.readRemoteUsage`) catches anything thrown
      // here by dropping the MACHINE, so a Claude reset time in the wrong unit
      // used to take the machine's Codex figure down with it.
      final readings = parseUsageReadResult({
        'providers': [
          {
            'provider': 'claude',
            'outcome': 'answered',
            'httpStatus': 200,
            'body': {
              'seven_day': {
                'utilization': 20,
                'resets_at': 1790000000000000000,
              },
            },
          },
          {
            'provider': 'codex',
            'outcome': 'answered',
            'httpStatus': 200,
            'body': {
              'rate_limit': {
                'primary_window': {'used_percent': 5},
              },
            },
          },
        ],
      });
      expect(readings, hasLength(2));
      expect(readings.first.hasFigures, isTrue);
      expect(readings.first.windows.single.resetsAt, isNull);
      expect(readings.last.hasFigures, isTrue);
    });
  });
}
