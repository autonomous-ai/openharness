import 'dart:convert';
import 'dart:io';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/measurement/launch_measurement.dart';
import 'package:harness_mobile/measurement/product_measurement.dart';

void main() {
  late ProductMeasurement usage;
  late LaunchMeasurement launch;
  late List<Map<String, dynamic>> reports;
  late Duration clock;

  setUp(() {
    reports = [];
    clock = Duration.zero;
    usage = ProductMeasurement(
      surface: 'phone',
      automatic: false,
      now: () => DateTime.utc(2026, 10, 16, 12),
      sendSetup: (_) async => {'accepted': true},
    );
    launch = LaunchMeasurement(
      usage,
      observeLifecycle: false,
      sinceLaunch: () => clock,
    );
  });
  tearDown(() {
    launch.dispose();
    usage.dispose();
  });

  /// Signed in; the account's sharing choice is read, which is when counting can start.
  Future<void> signIn({bool restored = true}) async {
    usage.account(
      'PRIVATE_ACCOUNT',
      choice: () async => {'enabled': true, 'revision': 0},
      send: (r) async {
        reports.add(jsonDecode(jsonEncode(r)));
        return {'accepted': true};
      },
    );
    launch.account(signedIn: true, restored: restored);
    await usage.flush();
  }

  Future<Map<String, int>> sent() async {
    await usage.flush();
    await usage.flush();
    final total = <String, int>{};
    for (final report in reports) {
      (report['counters'] as Map).forEach((metric, value) {
        total[metric as String] = (total[metric] ?? 0) + (value as int);
      });
    }
    return total;
  }

  test('a computer answering before sharing is read is counted with the time it took', () async {
    clock = const Duration(seconds: 4);
    launch.ready();
    clock = const Duration(seconds: 30);
    launch.ready();
    await signIn();
    expect(await sent(), {
      'ui_phone_app_start_started': 1,
      'ui_phone_app_start_ok': 1,
      'ui_phone_app_start_1s_to_10s': 1,
    });
  });

  test(
    'a computer answering after sharing is read ends the launch once',
    () async {
      clock = const Duration(seconds: 2);
      await signIn();
      launch.ready();
      launch.ready();
      final counted = await sent();
      expect(counted['ui_phone_app_start_started'], 1);
      expect(counted['ui_phone_app_start_ok'], 1);
      // Begun two seconds into the launch: the bucket counts from the launch, not from sharing.
      expect(counted['ui_phone_app_start_1s_to_10s'], 1);
    },
  );

  test('leaving the screen before a computer answered is unknown, whenever it is counted', () async {
    launch.foreground(false);
    launch.foreground(true);
    launch.ready();
    await signIn();
    final counted = await sent();
    expect(counted['ui_phone_app_start_unknown'], 1);
    expect(counted, isNot(contains('ui_phone_app_start_ok')));
  });

  test(
    'leaving the screen while waiting ends the open launch as unknown',
    () async {
      await signIn();
      launch.foreground(false);
      launch.ready();
      final counted = await sent();
      expect(counted['ui_phone_app_start_started'], 1);
      expect(counted['ui_phone_app_start_unknown'], 1);
      expect(counted, isNot(contains('ui_phone_app_start_ok')));
    },
  );

  test('a launch that signs in is the onboarding\'s, not one', () async {
    launch.ready();
    await signIn(restored: false);
    expect(
      (await sent()).keys.where((metric) => metric.contains('app_start')),
      isEmpty,
    );
  });

  test('a sign-out before sharing is read leaves no launch to count', () async {
    launch.account(signedIn: true, restored: true);
    launch.account(signedIn: false);
    launch.ready();
    await signIn(restored: false);
    expect(
      (await sent()).keys.where((metric) => metric.contains('app_start')),
      isEmpty,
    );
  });

  group('what a launch waited on', () {
    Map<String, int> waits(Map<String, int> counted) => {
      for (final why in LaunchWait.values)
        why.wire: ?counted['ui_phone_app_start_${why.wire}'],
    };

    test('each is counted once beside the open launch', () async {
      await signIn();
      launch.waiting(LaunchWait.offline);
      launch.waiting(LaunchWait.offline);
      launch.waiting(LaunchWait.connectFailed);
      final counted = await sent();
      expect(counted['ui_phone_app_start_started'], 1);
      expect(waits(counted), {'offline': 1, 'connect_failed': 1});
      launch.waiting(LaunchWait.offline);
      expect(waits(await sent()), {'offline': 1, 'connect_failed': 1});
    });

    test(
      'seen before sharing is read, it is counted once the launch is',
      () async {
        launch.waiting(LaunchWait.noComputer);
        launch.account(signedIn: true, restored: true);
        launch.waiting(LaunchWait.listFailed);
        await signIn();
        expect(waits(await sent()), {'no_computer': 1, 'list_failed': 1});
      },
    );

    test(
      'a computer that answers ends it, and what was seen before stays',
      () async {
        launch.waiting(LaunchWait.offline);
        launch.ready();
        launch.waiting(LaunchWait.connectFailed);
        await signIn();
        final counted = await sent();
        expect(counted['ui_phone_app_start_ok'], 1);
        expect(waits(counted), {'offline': 1});
      },
    );

    test('nothing once the app has left the screen', () async {
      await signIn();
      launch.foreground(false);
      launch.waiting(LaunchWait.offline);
      final counted = await sent();
      expect(counted['ui_phone_app_start_unknown'], 1);
      expect(waits(counted), isEmpty);
    });

    test('nothing for a launch that signs in, or after a sign-out', () async {
      launch.waiting(LaunchWait.locked);
      await signIn(restored: false);
      launch.waiting(LaunchWait.offline);
      expect(waits(await sent()), isEmpty);

      final restored = LaunchMeasurement(
        usage,
        observeLifecycle: false,
        sinceLaunch: () => clock,
      );
      addTearDown(restored.dispose);
      restored.account(signedIn: true, restored: true);
      restored.account(signedIn: false);
      restored.waiting(LaunchWait.locked);
      expect(waits(await sent()), isEmpty);
    });

    test('a minute on screen with no computer answering is said once', () {
      fakeAsync((async) {
        final timed = LaunchMeasurement(
          usage,
          observeLifecycle: false,
          sinceLaunch: () => clock,
        );
        timed.account(signedIn: true, restored: true);
        usage.account(
          'PRIVATE_ACCOUNT',
          choice: () async => {'enabled': true, 'revision': 0},
          send: (r) async {
            reports.add(jsonDecode(jsonEncode(r)));
            return {'accepted': true};
          },
        );
        usage.flush();
        async.elapse(const Duration(seconds: 59));
        usage.flush();
        async.flushMicrotasks();
        expect(
          reports.expand((r) => (r['counters'] as Map).keys),
          isNot(contains('ui_phone_app_start_waited_1m')),
        );
        async.elapse(const Duration(seconds: 2));
        usage.flush();
        async.flushMicrotasks();
        final names = [for (final r in reports) ...(r['counters'] as Map).keys];
        expect(
          names.where((n) => n == 'ui_phone_app_start_waited_1m'),
          hasLength(1),
        );
        timed.dispose();
      });
    });

    test(
      'no minute is said for a launch a computer answered, or once disposed',
      () {
        fakeAsync((async) {
          final answered = LaunchMeasurement(
            usage,
            observeLifecycle: false,
            sinceLaunch: () => clock,
          );
          final disposed = LaunchMeasurement(
            usage,
            observeLifecycle: false,
            sinceLaunch: () => clock,
          );
          answered.ready();
          disposed.dispose();
          expect(async.pendingTimers, hasLength(0));
          answered.dispose();
        });
      },
    );

    test('a launch already a minute old says so at once', () {
      fakeAsync((async) {
        clock = const Duration(minutes: 3);
        final late = LaunchMeasurement(
          usage,
          observeLifecycle: false,
          sinceLaunch: () => clock,
        );
        expect(async.pendingTimers.single.duration, Duration.zero);
        late.dispose();
      });
    });

    test('every reason is in the backend vocabulary', () {
      final vocabulary = File('../backend/src/types/productUsage.ts')
          .readAsStringSync();
      for (final why in LaunchWait.values) {
        expect(
          vocabulary,
          contains("'ui_phone_app_start_${why.wire}'"),
          reason: why.wire,
        );
      }
    });
  });
}
