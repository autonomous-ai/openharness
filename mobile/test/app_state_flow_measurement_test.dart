import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/measurement/launch_measurement.dart';
import 'package:harness_mobile/measurement/onboarding_measurement.dart';
import 'package:harness_mobile/measurement/product_measurement.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'viewer_app_fixture.dart';
import 'voice_fakes.dart' show MemoryKeyValueStore;

/// The flows the phone counts as the desktop does — its dials, a stopped harness resumed — as the
/// app itself reports them, through the account's own sharing.
void main() {
  late ProductMeasurement usage;

  setUp(() {
    usage = ProductMeasurement(
      surface: 'phone',
      automatic: false,
      sendSetup: (_) async => {'accepted': true},
    );
  });

  /// A signed-in phone whose account shares product usage.
  Future<ViewerRig> sharing(
    Map<String, List<String>> agents, {
    MemoryKeyValueStore? storage,
  }) async {
    final rig = await signedInWith(
      agents,
      storage: storage,
      productMeasurement: usage,
    );
    addTearDown(rig.app.dispose);
    await usage.flush();
    expect(usage.sharing, isTrue);
    return rig;
  }

  /// The [flow] counters the rig's account was sent, summed across reports.
  Future<Map<String, int>> sent(ViewerRig rig, String flow) async {
    await usage.flush();
    await usage.flush();
    final total = <String, int>{};
    for (final report in rig.api.usageReports) {
      (report['counters'] as Map).forEach((metric, value) {
        if ('$metric'.startsWith('ui_phone_${flow}_')) {
          total[metric as String] = (total[metric] ?? 0) + (value as int);
        }
      });
    }
    return total;
  }

  /// A launch that came back signed in, its computers [machines], counted as the app counts one.
  /// [observeLifecycle]: the launch listens to the app's own lifecycle, as in the shipped app.
  Future<ViewerRig> launching(
    Future<List<Machine>> Function() machines, {
    bool observeLifecycle = false,
  }) async {
    final rig = viewerApp(productMeasurement: usage);
    addTearDown(rig.app.dispose);
    rig.app.launchMeasurement = LaunchMeasurement(
      usage,
      observeLifecycle: observeLifecycle,
      sinceLaunch: () => const Duration(seconds: 3),
    );
    rig.api.onMachines = machines;
    await rig.app.bootstrap();
    await settle();
    return rig;
  }

  group('leaving the screen', () {
    // iOS suspends an app within seconds and may end it unannounced; counts still in RAM go with
    // it. The once-a-minute report is not waited for.

    /// A sharing phone that counted a dial and has not reported it yet; [send] as given.
    Future<(ViewerRig, int)> dialled({required bool send}) async {
      final rig = await sharing({'m': []});
      final before = rig.api.usageReports.length;
      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
      rig.app.sendMeasurementBeforeBackground = send;
      return (rig, before);
    }

    Iterable<Object?> sentSince(ViewerRig rig, int before) => rig
        .api
        .usageReports
        .skip(before)
        .expand((report) => (report['counters'] as Map).keys);

    test(
      'sends the queued counts when the app goes to the background',
      () async {
        final (rig, before) = await dialled(send: true);
        rig.app.handleAppPaused();
        await pumpEventQueue();
        expect(sentSince(rig, before), contains('ui_phone_remote_connect_ok'));
      },
    );

    test('and when it loses the foreground (the app switcher)', () async {
      final (rig, before) = await dialled(send: true);
      rig.app.handleAppInactive();
      await pumpEventQueue();
      expect(sentSince(rig, before), contains('ui_phone_remote_connect_ok'));
    });

    test('sends nothing when that is switched off', () async {
      final (rig, before) = await dialled(send: false);
      rig.app.handleAppPaused();
      rig.app.handleAppInactive();
      await pumpEventQueue();
      expect(sentSince(rig, before), isEmpty);
    });
  });

  group('a dial still going when the app goes to the background', () {
    // The OS suspends the app within seconds, so the socket's answer may never be heard; the dial
    // is cancelled by the person leaving, before the counts are sent.

    const outcomes = ['started', 'ok', 'failed', 'cancelled', 'unknown'];

    /// How many `remote_connect` dials started and ended each way, apart from the duration buckets.
    Future<Map<String, int>> dials(ViewerRig rig) async {
      final all = await sent(rig, 'remote_connect');
      return {
        for (final outcome in outcomes)
          if (all.containsKey('ui_phone_remote_connect_$outcome'))
            outcome: all['ui_phone_remote_connect_$outcome']!,
      };
    }

    test('is cancelled, once, and that goes out with the pause', () async {
      final rig = await sharing({'m': []});
      final before = rig.api.usageReports.length;
      rig.app.sendMeasurementBeforeBackground = true;
      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);

      rig.app.handleAppPaused();
      rig.app.handleAppPaused();
      await pumpEventQueue();

      // In the report the pause itself sent, not one of a later flush.
      final reported = <String, int>{};
      for (final report in rig.api.usageReports.skip(before)) {
        (report['counters'] as Map).forEach((metric, value) {
          reported['$metric'] = (reported['$metric'] ?? 0) + (value as int);
        });
      }
      expect(reported, containsPair('ui_phone_remote_connect_started', 1));
      expect(reported, containsPair('ui_phone_remote_connect_cancelled', 1));
      expect(reported, isNot(contains('ui_phone_remote_connect_ok')));
      expect(reported, isNot(contains('ui_phone_remote_connect_failed')));
    });

    test('is no second outcome when the socket answers after all', () async {
      final rig = await sharing({'m': [], 'n': []});
      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
      rig.app.connectionStatusForTest('n', ConnectionStatus.reconnecting);
      rig.app.handleAppPaused();

      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
      rig.app.connectionStatusForTest('n', ConnectionStatus.disconnected);

      expect(await dials(rig), {'started': 2, 'cancelled': 2});
    });

    test('every machine still dialling is cancelled, each once', () async {
      final rig = await sharing({'m': [], 'n': [], 'o': []});
      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
      rig.app.connectionStatusForTest('n', ConnectionStatus.reconnecting);
      rig.app.connectionStatusForTest('o', ConnectionStatus.connecting);
      rig.app.connectionStatusForTest('o', ConnectionStatus.connected);

      rig.app.handleAppPaused();

      expect(await dials(rig), {'started': 3, 'ok': 1, 'cancelled': 2});
    });

    test('that had connected before stays ok, and only ok', () async {
      final rig = await sharing({'m': []});
      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);

      rig.app.handleAppPaused();

      expect(await dials(rig), {'started': 1, 'ok': 1});
    });

    test('that failed before stays failed, and only failed', () async {
      final rig = await sharing({'m': []});
      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
      rig.app.connectionStatusForTest('m', ConnectionStatus.disconnected);

      rig.app.handleAppPaused();

      expect(await dials(rig), {'started': 1, 'failed': 1});
    });

    test(
      'is followed by a new count when the app dials after resuming',
      () async {
        final rig = await sharing({'m': []});
        rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
        rig.app.handleAppPaused();
        rig.app.handleAppResumed();
        await settle();

        rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
        rig.app.connectionStatusForTest('m', ConnectionStatus.connected);

        expect(await dials(rig), {'started': 2, 'cancelled': 1, 'ok': 1});
      },
    );

    test('is not cancelled by losing the foreground for a moment', () async {
      // A system sheet or the app switcher does not stop the dial; only the background does.
      final rig = await sharing({'m': []});
      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);

      rig.app.handleAppInactive();
      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);

      expect(await dials(rig), {'started': 1, 'ok': 1});
    });
  });

  /// The [flow]'s started and ended counts, apart from its duration buckets and (for a launch) its waits.
  Future<Map<String, int>> outcomes(ViewerRig rig, String flow) async {
    final all = await sent(rig, flow);
    return {
      for (final outcome in const [
        'started',
        'ok',
        'failed',
        'cancelled',
        'unknown',
      ])
        if (all.containsKey('ui_phone_${flow}_$outcome'))
          outcome: all['ui_phone_${flow}_$outcome']!,
    };
  }

  group(
    'connect_auto and connect_user when the app goes to the background',
    () {
      // The same dials as remote_connect's, counted by ProductConnections: the app's own, and the
      // person's ("Try again").

      test('the app\'s own dial still going is cancelled, once', () async {
        final rig = await sharing({'m': []});
        rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);

        rig.app.handleAppPaused();
        rig.app.handleAppPaused();

        expect(await outcomes(rig, 'connect_auto'), {
          'started': 1,
          'cancelled': 1,
        });
        expect(await outcomes(rig, 'connect_user'), isEmpty);
      });

      test('a dial the person asked for is cancelled, not failed', () async {
        final rig = await sharing({'m': []});
        rig.app.connectionStatusForTest('m', ConnectionStatus.disconnected);
        final retry = rig.app.retryMachine('m');
        await settle();
        rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);

        rig.app.handleAppPaused();
        rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
        await retry;

        expect(await outcomes(rig, 'connect_user'), {
          'started': 1,
          'cancelled': 1,
        });
        expect(await outcomes(rig, 'connect_auto'), isEmpty);
      });

      test('is no second outcome when the socket answers after all', () async {
        final rig = await sharing({'m': [], 'n': []});
        rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
        rig.app.connectionStatusForTest('n', ConnectionStatus.reconnecting);
        rig.app.handleAppPaused();

        rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
        rig.app.connectionStatusForTest('n', ConnectionStatus.disconnected);

        expect(await outcomes(rig, 'connect_auto'), {
          'started': 2,
          'cancelled': 2,
        });
      });

      test('that had finished before keeps its outcome', () async {
        final rig = await sharing({'m': [], 'n': []});
        rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
        rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
        rig.app.connectionStatusForTest('n', ConnectionStatus.connecting);
        rig.app.connectionStatusForTest('n', ConnectionStatus.disconnected);

        rig.app.handleAppPaused();

        expect(await outcomes(rig, 'connect_auto'), {
          'started': 2,
          'ok': 1,
          'unknown': 1,
        });
      });

      test(
        'is followed by a new count when the app dials after resuming',
        () async {
          final rig = await sharing({'m': []});
          rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
          rig.app.handleAppPaused();
          rig.app.handleAppResumed();
          await settle();

          rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
          rig.app.connectionStatusForTest('m', ConnectionStatus.connected);

          expect(await outcomes(rig, 'connect_auto'), {
            'started': 2,
            'cancelled': 1,
            'ok': 1,
          });
        },
      );

      test('is not ended by losing the foreground for a moment', () async {
        final rig = await sharing({'m': []});
        rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);

        rig.app.handleAppInactive();
        rig.app.connectionStatusForTest('m', ConnectionStatus.connected);

        expect(await outcomes(rig, 'connect_auto'), {'started': 1, 'ok': 1});
      });
    },
  );

  group('app_start when the app goes to the background', () {
    // A launch whose computers have not answered when the phone leaves is `unknown`: whatever the
    // wait took from there was not the launch's.

    test('a launch still open is unknown, once', () async {
      final rig = await launching(() async => [remoteMachine('m')]);
      expect(await outcomes(rig, 'app_start'), {'started': 1});

      rig.app.handleAppPaused();
      rig.app.handleAppPaused();

      expect(await outcomes(rig, 'app_start'), {'started': 1, 'unknown': 1});
    });

    test('is no second outcome when a computer answers after all', () async {
      final rig = await launching(() async => [remoteMachine('m')]);
      rig.app.handleAppPaused();

      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);

      expect(await outcomes(rig, 'app_start'), {'started': 1, 'unknown': 1});
    });

    test('a launch a computer had answered stays ok, and only ok', () async {
      final rig = await launching(() async => [remoteMachine('m')]);
      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);

      rig.app.handleAppPaused();

      expect(await outcomes(rig, 'app_start'), {'started': 1, 'ok': 1});
    });

    test('is not ended by losing the foreground for a moment', () async {
      final rig = await launching(() async => [remoteMachine('m')]);

      rig.app.handleAppInactive();
      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);

      expect(await outcomes(rig, 'app_start'), {'started': 1, 'ok': 1});
    });

    test('a pause after the launch was counted unknown adds nothing', () async {
      // The shipped app also ends the launch by its own lifecycle listener, when the app is hidden.
      final rig = await launching(() async => [remoteMachine('m')]);
      rig.app.launchMeasurement!.foreground(false);
      expect(await outcomes(rig, 'app_start'), {'started': 1, 'unknown': 1});

      rig.app.handleAppPaused();

      expect(await outcomes(rig, 'app_start'), {'started': 1, 'unknown': 1});
    });

    test('in the shipped app, the lifecycle alone has ended the launch before the pause', () async {
      final binding = TestWidgetsFlutterBinding.ensureInitialized();
      // The launch listens to the app's lifecycle itself and the shell calls the notifier on
      // `inactive` and `paused`; the framework passes through `hidden` between the two.
      final rig = await launching(
        () async => [remoteMachine('m')],
        observeLifecycle: true,
      );
      final shell = _ShellLifecycle(rig.app);
      WidgetsBinding.instance.addObserver(shell);
      addTearDown(() => WidgetsBinding.instance.removeObserver(shell));
      addTearDown(
        () => binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed),
      );
      binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      expect(await outcomes(rig, 'app_start'), {'started': 1});

      binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      expect(await outcomes(rig, 'app_start'), {'started': 1});

      binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      expect(await outcomes(rig, 'app_start'), {'started': 1, 'unknown': 1});

      binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      expect(await outcomes(rig, 'app_start'), {'started': 1, 'unknown': 1});
    });
  });

  group('dials', () {
    test('a socket coming back by itself is the app\'s own', () async {
      final rig = await sharing({'m': []});
      rig.app.connectionStatusForTest('m', ConnectionStatus.reconnecting);
      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);

      expect(
        await sent(rig, 'connect_auto'),
        allOf([
          containsPair('ui_phone_connect_auto_started', 1),
          containsPair('ui_phone_connect_auto_ok', 1),
        ]),
      );
      expect(await sent(rig, 'connect_user'), isEmpty);
      // Still counted as before, beside the split.
      expect(
        await sent(rig, 'remote_connect'),
        containsPair('ui_phone_remote_connect_ok', 1),
      );
    });

    test('Try again on a dropped computer is the person\'s', () async {
      final rig = await sharing({'m': []});
      rig.app.connectionStatusForTest('m', ConnectionStatus.disconnected);

      final retry = rig.app.retryMachine('m');
      await settle();
      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
      await retry;

      expect(
        await sent(rig, 'connect_user'),
        allOf([
          containsPair('ui_phone_connect_user_started', 1),
          containsPair('ui_phone_connect_user_ok', 1),
        ]),
      );
      expect(await sent(rig, 'connect_auto'), isEmpty);
    });

    test('Try again on a computer already up is answered at once', () async {
      final rig = await sharing({'m': []});
      await rig.app.retryMachine('m');

      expect(
        await sent(rig, 'connect_user'),
        containsPair('ui_phone_connect_user_ok', 1),
      );
    });
  });

  group('resuming a stopped harness', () {
    Map<String, dynamic> stopped(String id) =>
        agentJson(id, status: 'stopped', terminal: false, sessionId: 's-$id');

    Future<ViewerRig> withStopped() async {
      final rig = await sharing({'m': []});
      await push(rig, 'm', 'agent_synced', {'agent': stopped('a')});
      return rig;
    }

    test(
      'is recovered by its first live turn, not by a replayed one',
      () async {
        final rig = await withStopped();
        rig.conn('m').answers['agent_resume'] = (p) => {
          'creationId': p['creationId'],
          'state': 'created',
          'agent': agentJson('a', sessionId: 's-a'),
        };

        expect((await rig.app.resumeAgent('m', 'a')).error, isNull);
        await push(
          rig,
          'm',
          'turn_started',
          {'agentId': 'a'},
          {'replay': true},
        );
        expect(await sent(rig, 'resume_recovery'), {
          'ui_phone_resume_recovery_started': 1,
        });

        await push(rig, 'm', 'turn_started', {'agentId': 'a'});
        expect(
          await sent(rig, 'resume_recovery'),
          containsPair('ui_phone_resume_recovery_ok', 1),
        );
      },
    );

    test(
      'a refusal is failed, and a status check is no second resume',
      () async {
        final rig = await withStopped();
        rig.conn('m').answers['agent_resume'] = (_) =>
            throw refusal('AGENT_BUSY');
        await rig.app.resumeAgent('m', 'a');

        expect(
          await sent(rig, 'resume_recovery'),
          allOf([
            containsPair('ui_phone_resume_recovery_started', 1),
            containsPair('ui_phone_resume_recovery_failed', 1),
          ]),
        );

        // A lost reply is checked on the next tap, under the same receipt: not counted again.
        rig.conn('m').answers['agent_resume'] = (_) =>
            throw refusal('INTERNAL');
        await rig.app.resumeAgent('m', 'a');
        rig.conn('m').answers['agent_create_status'] = (p) => {
          'creationId': p['creationId'],
          'state': 'pending',
        };
        await rig.app.resumeAgent('m', 'a');
        expect(
          (await sent(
            rig,
            'resume_recovery',
          ))['ui_phone_resume_recovery_started'],
          2,
        );
      },
    );
  });

  group('the signed-out choice, carried to the account as on the desktop', () {
    String? kept(MemoryKeyValueStore storage) =>
        storage.values[ProductMeasurement.setupPreferenceKey];

    test(
      'an opt-out made signed out turns the account off, asked once',
      () async {
        final storage = MemoryKeyValueStore()
          ..values[ProductMeasurement.setupPreferenceKey] =
              ProductMeasurement.pendingSetupOptOut;
        final rig = await signedInWith({'m': []}, storage: storage);
        addTearDown(rig.app.dispose);
        final usage = rig.app.productMeasurement;

        await usage.flush();
        await usage.setupChoiceSaved;
        expect(rig.api.usageChoiceAsks, [false]);
        expect(usage.accountOptOutPending, isFalse);
        expect(usage.sharing, isFalse);
        expect(kept(storage), 'false');

        await usage.flush();
        expect(rig.api.usageChoiceAsks, [
          false,
          null,
        ], reason: 'then only read');
      },
    );

    test(
      'left on, the account keeps its own choice, and the phone remembers it',
      () async {
        final storage = MemoryKeyValueStore();
        final rig = await signedInWith({'m': []}, storage: storage);
        addTearDown(rig.app.dispose);
        rig.api.usageChoice = {'enabled': false, 'revision': 2};
        final usage = rig.app.productMeasurement;

        await usage.flush();
        await usage.setupChoiceSaved;
        expect(rig.api.usageChoiceAsks, [null]);
        expect(usage.signedOutSharing, isFalse);
        expect(kept(storage), 'false');
      },
    );
  });

  group('what the account itself tells the onboarding', () {
    test(
      'a wait an earlier launch left open, its computer now on the account',
      () async {
        final storage = MemoryKeyValueStore()
          ..values[OnboardingMeasurement.waitingKey] = '1';
        final rig = await sharing({'m': []}, storage: storage);
        expect(await sent(rig, 'computer_wait'), {
          'ui_phone_computer_wait_joined_after_leaving': 1,
        });
        expect(
          storage.values,
          isNot(contains(OnboardingMeasurement.waitingKey)),
        );

        await rig.app.refreshMachines();
        await settle();
        expect(await sent(rig, 'computer_wait'), {
          'ui_phone_computer_wait_joined_after_leaving': 1,
        }, reason: 'once');
      },
    );

    test('a wait left open, still with no computer, is kept', () async {
      final storage = MemoryKeyValueStore()
        ..values[OnboardingMeasurement.waitingKey] = '1';
      final rig = await sharing({}, storage: storage);
      expect(await sent(rig, 'computer_wait'), isEmpty);
      expect(storage.values[OnboardingMeasurement.waitingKey], '1');
    });

    Future<ViewerRig> signingIn(DateTime createdAt) async {
      final rig = viewerApp(signedIn: false, productMeasurement: usage);
      addTearDown(rig.app.dispose);
      rig.api.profile = {
        'user': {
          'id': 'u1',
          'email': 'pat@example.com',
          'createdAt': createdAt.toUtc().toIso8601String(),
        },
      };
      await rig.app.signInWithCode(email: 'pat@example.com', code: '1234');
      await settle();
      return rig;
    }

    test('a sign-in that made its account says so', () async {
      final rig = await signingIn(
        DateTime.now().subtract(const Duration(seconds: 5)),
      );
      expect(
        await sent(rig, 'sign_in'),
        allOf([
          containsPair('ui_phone_sign_in_ok', 1),
          containsPair('ui_phone_sign_in_new_account', 1),
        ]),
      );
    });

    test('a sign-in to an older account is a return', () async {
      final rig = await signingIn(
        DateTime.now().subtract(const Duration(days: 30)),
      );
      final signIn = await sent(rig, 'sign_in');
      expect(signIn, containsPair('ui_phone_sign_in_ok', 1));
      expect(signIn, isNot(contains('ui_phone_sign_in_new_account')));
    });

    test('a launch already signed in made no account', () async {
      final rig = viewerApp(productMeasurement: usage);
      addTearDown(rig.app.dispose);
      rig.api.profile = {
        'user': {
          'id': 'u1',
          'email': 'pat@example.com',
          'createdAt': DateTime.now().toUtc().toIso8601String(),
        },
      };
      await rig.app.bootstrap();
      await settle();
      expect(await sent(rig, 'sign_in'), isEmpty);
    });
  });

  group('what a launch back to work waited on', () {
    Future<Set<String>> waits(ViewerRig rig) async => {
      for (final metric in (await sent(rig, 'app_start')).keys)
        for (final why in LaunchWait.values)
          if (metric == 'ui_phone_app_start_${why.wire}') why.wire,
    };

    test('an account with no computer', () async {
      final rig = await launching(() async => const []);
      expect(
        await sent(rig, 'app_start'),
        containsPair('ui_phone_app_start_started', 1),
      );
      expect(await waits(rig), {'no_computer'});
    });

    test('every computer reported offline', () async {
      final rig = await launching(
        () async => [
          remoteMachine('m', status: 'offline'),
          remoteMachine('n', status: 'stopped'),
        ],
      );
      expect(await waits(rig), {'offline'});
    });

    test('one computer still online is not offline', () async {
      final rig = await launching(
        () async => [remoteMachine('m', status: 'offline'), remoteMachine('n')],
      );
      expect(await waits(rig), isEmpty);
    });

    test('a list that cannot be read', () async {
      final rig = await launching(() async => throw StateError('offline'));
      expect(await waits(rig), {'list_failed'});
    });

    test('a computer that wants this phone\'s password', () async {
      final rig = await launching(() async => [remoteMachine('m')]);
      rig.app.trustSettleRound = const Duration(milliseconds: 20);
      // Each dial again is refused again: nothing vouches for this phone there.
      rig.app.onRedialForTest = (id) => scheduleMicrotask(
        () => rig.app.localFailureForTest(id, 4404, 'NO_PEER_LINK'),
      );
      rig.app.localFailureForTest('m', 4404, 'NO_PEER_LINK');
      for (var i = 0; i < 100 && !rig.app.stateOf('m')!.needsLink; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(rig.app.stateOf('m')!.needsLink, isTrue);
      expect(await waits(rig), {'locked'});
    });

    test(
      'a dial to a computer said to be online that fails, until one answers',
      () async {
        final rig = await launching(
          () async => [
            remoteMachine('m'),
            remoteMachine('n', status: 'offline'),
          ],
        );
        rig.app.connectionStatusForTest('n', ConnectionStatus.connecting);
        rig.app.connectionStatusForTest('n', ConnectionStatus.reconnecting);
        expect(await waits(rig), isEmpty, reason: 'n is offline');

        rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
        rig.app.connectionStatusForTest('m', ConnectionStatus.reconnecting);
        rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
        expect(await waits(rig), {'connect_failed'});
        expect(
          await sent(rig, 'app_start'),
          containsPair('ui_phone_app_start_ok', 1),
        );

        // Answered: what follows is not the launch's.
        rig.app.connectionStatusForTest('m', ConnectionStatus.reconnecting);
        rig.app.localFailureForTest('m', 4404, 'NO_PEER_LINK');
        expect(await waits(rig), {'connect_failed'});
      },
    );
  });
}

/// What `PhoneShell` does with the app's lifecycle (`lib/phone/phone_shell.dart`).
class _ShellLifecycle with WidgetsBindingObserver {
  _ShellLifecycle(this.app);
  final AppNotifier app;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.inactive:
        app.handleAppInactive();
      case AppLifecycleState.paused:
        app.handleAppPaused();
      case AppLifecycleState.resumed:
        app.handleAppResumed();
      case AppLifecycleState.hidden:
      case AppLifecycleState.detached:
        break;
    }
  }
}
