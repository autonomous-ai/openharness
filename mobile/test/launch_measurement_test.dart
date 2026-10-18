import 'dart:convert';

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
}
