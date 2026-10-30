import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/measurement/onboarding_measurement.dart';
import 'package:harness_mobile/measurement/product_measurement.dart';

import 'voice_fakes.dart' show MemoryKeyValueStore;

void main() {
  late ProductMeasurement usage;
  late OnboardingMeasurement onboarding;
  late List<Map<String, dynamic>> reports;
  late Map<String, dynamic> choice;

  setUp(() {
    reports = [];
    choice = {'enabled': true, 'revision': 0};
    usage = ProductMeasurement(
      surface: 'phone',
      automatic: false,
      now: () => DateTime.utc(2026, 10, 14, 12),
      sendSetup: (r) async => {'accepted': true},
    );
    onboarding = OnboardingMeasurement(usage);
  });
  tearDown(() {
    onboarding.dispose();
    usage.dispose();
  });

  Future<void> signIn() async {
    usage.account(
      'PRIVATE_ACCOUNT',
      choice: () async => choice,
      send: (r) async {
        reports.add(jsonDecode(jsonEncode(r)));
        return {'accepted': true};
      },
    );
    await usage.flush();
  }

  Map<String, dynamic> counters([String prefix = '']) => {
    for (final r in reports)
      for (final MapEntry(:key, :value)
          in (r['counters'] as Map<String, dynamic>).entries)
        if (key.startsWith(prefix)) key: value,
  };

  /// This run's sign-in, which the onboarding's steps follow.
  void signedInHere() =>
      onboarding.signedIn(ProductFlow.signInEmail, Duration.zero);

  test('a step started before sharing loads is counted once it does', () async {
    signedInHere();
    onboarding.start(ProductFlow.computerWait);
    await signIn();
    onboarding.end(ProductFlow.computerWait, ProductOutcome.ok);
    await usage.flush();
    expect(counters('ui_phone_computer_wait_'), {
      'ui_phone_computer_wait_started': 1,
      'ui_phone_computer_wait_ok': 1,
      'ui_phone_computer_wait_under_1s': 1,
    });
  });

  test(
    'a step that ends before sharing is confirmed is never counted',
    () async {
      onboarding.start(ProductFlow.computerWait);
      onboarding.end(ProductFlow.computerWait, ProductOutcome.ok);
      await signIn();
      await usage.flush();
      expect(counters(), isEmpty);
    },
  );

  test('nothing is counted while the account does not share', () async {
    choice = {'enabled': false, 'revision': 1};
    await signIn();
    onboarding.start(ProductFlow.sessionOpen);
    onboarding.end(ProductFlow.sessionOpen, ProductOutcome.ok);
    await usage.flush();
    expect(reports, isEmpty);
  });

  test('each step runs once per sign-in; signing out abandons it', () async {
    await signIn();
    signedInHere();
    onboarding.start(ProductFlow.sessionOpen);
    onboarding.start(ProductFlow.sessionOpen);
    onboarding.reset();
    onboarding.end(ProductFlow.sessionOpen, ProductOutcome.ok);
    signedInHere();
    onboarding.start(ProductFlow.sessionOpen);
    await usage.flush();
    expect(counters('ui_phone_session_open_'), {
      'ui_phone_session_open_started': 2,
      'ui_phone_session_open_cancelled': 1,
      'ui_phone_session_open_under_1s': 1,
    });
  });

  test('the notification answer is an outcome, never more', () async {
    await signIn();
    await onboarding.askNotifications(() async => false);
    await onboarding.askNotifications(() async => true);
    await usage.flush();
    expect(counters(), {
      'ui_phone_notify_permission_started': 1,
      'ui_phone_notify_permission_cancelled': 1,
      'ui_phone_notify_permission_under_1s': 1,
    });
  });

  test('time spent waiting for sharing lands in the duration', () async {
    await signIn();
    usage.begin(ProductFlow.firstMessage, elapsed: const Duration(seconds: 12))(
      ProductOutcome.ok,
    );
    await usage.flush();
    expect(counters()['ui_phone_first_message_10s_to_1m'], 1);
  });

  test(
    'a sign-in counts the total and the button, without identifiers',
    () async {
      await signIn();
      usage.beginEach([ProductFlow.signIn, ProductFlow.signInGoogle])(
        ProductOutcome.ok,
      );
      await usage.flush();
      expect(reports.single.keys.toSet(), {
        'schemaVersion',
        'id',
        'day',
        'counters',
        'revision',
      });
      expect(counters(), {
        'ui_phone_sign_in_started': 1,
        'ui_phone_sign_in_ok': 1,
        'ui_phone_sign_in_under_1s': 1,
        'ui_phone_sign_in_google_started': 1,
        'ui_phone_sign_in_google_ok': 1,
        'ui_phone_sign_in_google_under_1s': 1,
      });
      expect(jsonEncode(reports), isNot(contains('PRIVATE_ACCOUNT')));
    },
  );

  test(
    'a sign-in that went through counts under the account once it shares',
    () async {
      onboarding.signedIn(ProductFlow.signInApple, const Duration(seconds: 3));
      await signIn();
      await usage.flush();
      expect(counters(), {
        'ui_phone_sign_in_started': 1,
        'ui_phone_sign_in_ok': 1,
        'ui_phone_sign_in_1s_to_10s': 1,
        'ui_phone_sign_in_apple_started': 1,
        'ui_phone_sign_in_apple_ok': 1,
        'ui_phone_sign_in_apple_1s_to_10s': 1,
      });
    },
  );

  test(
    'a step reopened in a run that did not sign in is marked resumed',
    () async {
      await signIn();
      onboarding.start(ProductFlow.computerWait);
      onboarding.reset();
      signedInHere();
      onboarding.start(ProductFlow.computerWait);
      await usage.flush();
      expect(counters()['ui_phone_computer_wait_started'], 2);
      expect(counters()['ui_phone_computer_wait_resumed'], 1);
    },
  );

  test(
    'a mark counts once per sign-in, only on a started step it is listed under',
    () async {
      await signIn();
      signedInHere();
      onboarding.mark(ProductFlow.computerWait, OnboardingMark.notYou);
      onboarding.start(ProductFlow.computerWait);
      onboarding.mark(ProductFlow.computerWait, OnboardingMark.notYou);
      onboarding.mark(ProductFlow.computerWait, OnboardingMark.notYou);
      onboarding.mark(ProductFlow.computerWait, OnboardingMark.blockedOffline);
      await usage.flush();
      expect(
        counters().keys.where((k) => k.startsWith('ui_phone_computer_wait_')),
        ['ui_phone_computer_wait_started', 'ui_phone_computer_wait_not_you'],
      );
      expect(counters()['ui_phone_computer_wait_not_you'], 1);
    },
  );

  test('a long step also splits its over_1m', () async {
    await signIn();
    usage.begin(ProductFlow.computerWait, elapsed: const Duration(minutes: 20))(
      ProductOutcome.ok,
    );
    usage.begin(ProductFlow.sessionOpen, elapsed: const Duration(minutes: 20))(
      ProductOutcome.ok,
    );
    await usage.flush();
    expect(counters()['ui_phone_computer_wait_over_1m'], 1);
    expect(counters()['ui_phone_computer_wait_15m_to_1h'], 1);
    expect(counters()['ui_phone_session_open_over_1m'], 1);
    expect(
      counters().keys.where((k) => k.startsWith('ui_phone_session_open_15m')),
      isEmpty,
    );
  });

  test('nothing waiting is counted once the choice reads off', () async {
    choice = {'enabled': false, 'revision': 1};
    onboarding.start(ProductFlow.computerWait);
    onboarding.signedIn(ProductFlow.signInGoogle, Duration.zero);
    await signIn();
    usage.savedChoice({'enabled': true, 'revision': 2});
    onboarding.end(ProductFlow.computerWait, ProductOutcome.ok);
    await usage.flush();
    expect(counters(), isEmpty);
  });

  test(
    'a sign-in after a failed try on another button is retried and switched',
    () async {
      onboarding.attempted(ProductFlow.signInGoogle, ProductOutcome.cancelled);
      onboarding.attempted(ProductFlow.signInEmail, ProductOutcome.ok);
      onboarding.signedIn(ProductFlow.signInEmail, Duration.zero);
      await signIn();
      await usage.flush();
      expect(
        counters('ui_phone_sign_in_'),
        allOf(
          containsPair('ui_phone_sign_in_retried', 1),
          containsPair('ui_phone_sign_in_switched', 1),
        ),
      );
    },
  );

  test('a first sign-in that works is neither retried nor switched', () async {
    onboarding.attempted(ProductFlow.signInApple, ProductOutcome.ok);
    onboarding.signedIn(ProductFlow.signInApple, Duration.zero);
    await signIn();
    await usage.flush();
    expect(
      counters('ui_phone_sign_in_'),
      isNot(contains('ui_phone_sign_in_retried')),
    );
    expect(
      counters('ui_phone_sign_in_'),
      isNot(contains('ui_phone_sign_in_switched')),
    );
    expect(
      counters('ui_phone_sign_in_'),
      containsPair('ui_phone_sign_in_ok', 1),
    );
  });

  test('a sign-out sends the step it ended before the queue goes', () async {
    signedInHere();
    onboarding.start(ProductFlow.computerWait);
    await signIn();
    await usage.flush();
    onboarding.mark(ProductFlow.computerWait, OnboardingMark.notYou);
    onboarding.reset();
    await usage.sendBeforeSignOut();
    usage.account(null);
    expect(counters(), containsPair('ui_phone_computer_wait_not_you', 1));
    expect(counters(), containsPair('ui_phone_computer_wait_cancelled', 1));
  });

  test('without sending first, a sign-out loses what was queued', () async {
    signedInHere();
    onboarding.start(ProductFlow.computerWait);
    await signIn();
    await usage.flush();
    onboarding.mark(ProductFlow.computerWait, OnboardingMark.notYou);
    usage.account(null);
    await usage.flush();
    expect(counters(), isNot(contains('ui_phone_computer_wait_not_you')));
  });

  test(
    'the build context rides the account reports, with one collector day',
    () async {
      usage.context = {
        'surface': 'phone',
        'release': '1.0.3',
        'platform': 'ios',
        'channel': 'production',
      };
      signedInHere();
      onboarding.start(ProductFlow.computerWait);
      await signIn();
      onboarding.end(ProductFlow.computerWait, ProductOutcome.ok);
      await usage.flush();
      expect(reports, isNotEmpty);
      for (final report in reports) {
        expect(report['context'], usage.context);
      }
      expect(counters(), containsPair('health_phone_collector_days', 1));
    },
  );

  test('signed-out setup reports never carry the build context', () async {
    final setup = <Map<String, dynamic>>[];
    final guest =
        ProductMeasurement(
            surface: 'phone',
            automatic: false,
            now: () => DateTime.utc(2026, 10, 14, 12),
            sendSetup: (r) async {
              setup.add(r);
              return {'accepted': true};
            },
          )
          ..context = {
            'surface': 'phone',
            'release': '1.0.3',
            'platform': 'android',
            'channel': 'production',
          };
    addTearDown(guest.dispose);
    await guest.setSignedOutSharing(true);
    guest.begin(ProductFlow.signInGoogle)(ProductOutcome.ok);
    await guest.flush();
    expect(setup.single.containsKey('context'), isFalse);
    expect(
      (setup.single['counters'] as Map).keys,
      isNot(contains('health_phone_collector_days')),
    );
  });

  group('a wait for a computer the app left', () {
    late MemoryKeyValueStore store;

    setUp(() => store = MemoryKeyValueStore());

    /// One launch of the app over [store]: its own onboarding, the account's usage shared with it.
    OnboardingMeasurement launch() {
      final run = OnboardingMeasurement(usage, storage: store);
      addTearDown(run.dispose);
      return run;
    }

    Future<void> settled() => Future<void>.delayed(Duration.zero);

    test(
      'is remembered, and the launch that finds the computer counts it once',
      () async {
        await signIn();
        final first = launch()
          ..signedIn(ProductFlow.signInGoogle, Duration.zero)
          ..start(ProductFlow.computerWait);
        await settled();
        expect(store.values[OnboardingMeasurement.waitingKey], '1');
        first.dispose(); // The app is closed with the wait still open.

        final next = launch();
        await next.computersSeen();
        await next.computersSeen();
        await usage.flush();
        expect(counters('ui_phone_computer_wait_joined_after_leaving'), {
          'ui_phone_computer_wait_joined_after_leaving': 1,
        });
        // That wait is over: no `ok` of its own, and nothing left to count.
        expect(counters('ui_phone_computer_wait_ok'), isEmpty);
        await settled();
        expect(store.values, isEmpty);
      },
    );

    test('that ended in its own launch leaves nothing for the next', () async {
      await signIn();
      launch()
        ..signedIn(ProductFlow.signInGoogle, Duration.zero)
        ..start(ProductFlow.computerWait)
        ..end(ProductFlow.computerWait, ProductOutcome.ok);
      await settled();
      expect(store.values, isEmpty);

      await launch().computersSeen();
      await usage.flush();
      expect(counters('ui_phone_computer_wait_joined_after_leaving'), isEmpty);
    });

    test('is not counted again by the launch that has a wait of its own', () async {
      await signIn();
      launch().start(ProductFlow.computerWait);
      await settled();

      // Reopened mid-wait: this launch waits too, and sees the computer itself.
      final next = launch()..start(ProductFlow.computerWait);
      await settled();
      expect(store.values[OnboardingMeasurement.waitingKey], '1');
      await next.computersSeen();
      next.end(ProductFlow.computerWait, ProductOutcome.ok);
      await next.computersSeen();
      await usage.flush();
      expect(counters('ui_phone_computer_wait_joined_after_leaving'), isEmpty);
      expect(counters('ui_phone_computer_wait_ok'), {
        'ui_phone_computer_wait_ok': 1,
      });
      await settled();
      expect(store.values, isEmpty);
    });

    test('is forgotten when the account signs out', () async {
      await signIn();
      final run = launch()..start(ProductFlow.computerWait);
      await settled();
      run.reset();
      await settled();
      expect(store.values, isEmpty);
    });

    test('counts nothing for an account that does not share', () async {
      choice = {'enabled': false, 'revision': 0};
      await signIn();
      store.values[OnboardingMeasurement.waitingKey] = '1';
      await launch().computersSeen();
      await usage.flush();
      expect(reports, isEmpty);
    });
  });

  group('a sign-in that made its account', () {
    final now = DateTime.utc(2026, 10, 20, 9);

    test('counts new_account, once', () async {
      await signIn();
      signedInHere();
      onboarding.accountCreated(
        now.subtract(const Duration(minutes: 2)),
        now: now,
      );
      onboarding.accountCreated(
        now.subtract(const Duration(minutes: 2)),
        now: now,
      );
      await usage.flush();
      expect(counters('ui_phone_sign_in_new_account'), {
        'ui_phone_sign_in_new_account': 1,
      });
    });

    test('allows for this phone\'s clock running behind', () async {
      await signIn();
      signedInHere();
      onboarding.accountCreated(now.add(const Duration(minutes: 5)), now: now);
      await usage.flush();
      expect(counters('ui_phone_sign_in_new_account'), hasLength(1));
    });

    test('counts nothing for an older account, an unknown age, or a launch that did not sign in', () async {
      await signIn();
      // Opened signed in: whatever its age, this launch made nothing.
      onboarding.accountCreated(now, now: now);
      signedInHere();
      onboarding.accountCreated(
        now.subtract(const Duration(days: 3)),
        now: now,
      );
      onboarding.accountCreated(null, now: now);
      await usage.flush();
      expect(counters('ui_phone_sign_in_new_account'), isEmpty);
    });

    /// The marks under the steps after the sign-in, by name.
    Map<String, dynamic> newAccountSteps() => {
      for (final MapEntry(:key, :value) in counters().entries)
        if (key.contains('new_account') && !key.startsWith('ui_phone_sign_in_'))
          key: value,
    };

    test('marks each step of the new account, and how it ended', () async {
      await signIn();
      signedInHere();
      onboarding.accountCreated(
        now.subtract(const Duration(minutes: 1)),
        now: now,
      );
      onboarding.start(ProductFlow.computerWait);
      onboarding.end(ProductFlow.computerWait, ProductOutcome.ok);
      onboarding.start(ProductFlow.sessionOpen);
      onboarding.end(ProductFlow.sessionOpen, ProductOutcome.ok);
      onboarding.start(ProductFlow.firstMessage);
      onboarding.end(ProductFlow.firstMessage, ProductOutcome.cancelled);
      await onboarding.askNotifications(() async => true);
      // A step asked for again in the same sign-in is the same step.
      onboarding.start(ProductFlow.computerWait);
      await usage.flush();
      expect(newAccountSteps(), {
        'ui_phone_computer_wait_new_account': 1,
        'ui_phone_computer_wait_new_account_ok': 1,
        'ui_phone_session_open_new_account': 1,
        'ui_phone_session_open_new_account_ok': 1,
        'ui_phone_first_message_new_account': 1,
      });
    });

    test('marks the steps counted before the profile was read', () async {
      await signIn();
      signedInHere();
      onboarding.start(ProductFlow.computerWait);
      onboarding.end(ProductFlow.computerWait, ProductOutcome.ok);
      onboarding.start(ProductFlow.sessionOpen);
      onboarding.accountCreated(
        now.subtract(const Duration(minutes: 1)),
        now: now,
      );
      onboarding.end(ProductFlow.sessionOpen, ProductOutcome.failed);
      await usage.flush();
      expect(newAccountSteps(), {
        'ui_phone_computer_wait_new_account': 1,
        'ui_phone_computer_wait_new_account_ok': 1,
        'ui_phone_session_open_new_account': 1,
      });
    });

    test('marks nothing for an account signing in again', () async {
      await signIn();
      signedInHere();
      onboarding.accountCreated(
        now.subtract(const Duration(days: 3)),
        now: now,
      );
      onboarding.start(ProductFlow.sessionOpen);
      onboarding.end(ProductFlow.sessionOpen, ProductOutcome.ok);
      await usage.flush();
      expect(counters('ui_phone_session_open_ok'), hasLength(1));
      expect(newAccountSteps(), isEmpty);
    });

    test('marks nothing for a step that was never counted', () async {
      // Sharing not known yet: a step that ends before then is not counted, nor marked.
      signedInHere();
      onboarding.accountCreated(
        now.subtract(const Duration(minutes: 1)),
        now: now,
      );
      onboarding.start(ProductFlow.computerWait);
      onboarding.end(ProductFlow.computerWait, ProductOutcome.ok);
      await signIn();
      await usage.flush();
      expect(counters('ui_phone_computer_wait'), isEmpty);
      expect(counters('ui_phone_sign_in_new_account'), hasLength(1));
    });

    test('a sign-out starts the next sign-in afresh', () async {
      await signIn();
      signedInHere();
      onboarding.accountCreated(
        now.subtract(const Duration(minutes: 1)),
        now: now,
      );
      onboarding.reset();
      signedInHere();
      onboarding.start(ProductFlow.sessionOpen);
      onboarding.end(ProductFlow.sessionOpen, ProductOutcome.ok);
      await usage.flush();
      expect(newAccountSteps(), isEmpty);
    });
  });

  test('every mark is in the backend vocabulary under each step it names', () {
    final vocabulary = File('../backend/src/types/productUsage.ts')
        .readAsStringSync();
    for (final mark in OnboardingMark.values) {
      for (final flow in mark.flows) {
        final metric = 'ui_phone_${flow.wire}_${mark.wire}';
        expect(vocabulary, contains("'$metric'"), reason: metric);
      }
    }
  });

  test('every flow is in the backend vocabulary', () {
    // `PRODUCT_USAGE_FLOWS` spreads the health contract's `HEALTH_FLOWS` (app_start,
    // connect_user, connect_auto, resume_recovery) into its own.
    final vocabulary = [
      '../backend/src/types/productUsage.ts',
      '../backend/src/types/productHealthContract.ts',
    ].map((path) => File(path).readAsStringSync()).join('\n');
    for (final flow in ProductFlow.values) {
      expect(vocabulary, contains("'${flow.wire}'"), reason: flow.wire);
    }
  });
}
