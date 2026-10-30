import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/demo/sample_runtime.dart';
import 'package:harness_mobile/phone/add_device/add_device_page.dart';
import 'package:harness_mobile/phone/add_device/setup_hotspot.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;

/// Set up Intern 3 for a computer locked as it starts, in the real app on a simulator, against a stand-in
/// device on the Mac (`fake_device.py`, which runs the startup's own page,
/// os/root/usr/lib/harness-os/unlock/http, until "harness" opens it). A screenshot each step.
///
///     python3 <stand-in device on 127.0.0.1:8042> os/root/usr/lib/harness-os/unlock/http &
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/add_device_unlock_test.dart
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('a locked device: its password, then its Wi-Fi', (tester) async {
    var step = 0;
    Future<void> shot(String name) async {
      await tester.pump(const Duration(milliseconds: 300));
      step++;
      await binding.takeScreenshot('${step.toString().padLeft(2, '0')}-$name');
    }

    Future<void> waitFor(Finder finder, {int seconds = 30}) async {
      for (var i = 0; i < seconds * 10; i++) {
        if (finder.evaluate().isNotEmpty) return;
        await tester.pump(const Duration(milliseconds: 100));
      }
      fail('never appeared: $finder');
    }

    final runtime = SampleRuntime();
    final hotspot = SetupHotspot(
      dio: Dio(
        BaseOptions(
          baseUrl: 'http://127.0.0.1:8042',
          connectTimeout: const Duration(seconds: 4),
          receiveTimeout: const Duration(seconds: 50),
          validateStatus: (_) => true,
        ),
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: grid.AppTheme.brightness.value),
        home: AddDevicePage(notifier: runtime.notifier, hotspot: hotspot),
      ),
    );

    // The steps first, nothing looked for until Find the device.
    await waitFor(find.byKey(const Key('add-device-steps')));
    await shot('steps');
    await tester.tap(find.byKey(const Key('add-device-continue')));
    // A simulator joins no Wi-Fi by itself; the page finds the device as soon as it answers.
    await waitFor(find.byKey(const Key('add-device-unlock-password')));
    await shot('locked');

    await tester.enterText(
      find.byKey(const Key('add-device-unlock-password')),
      'not it',
    );
    await tester.tap(find.byKey(const Key('add-device-unlock')));
    await waitFor(find.byKey(const Key('add-device-error')));
    await shot('wrong-password');

    await tester.enterText(
      find.byKey(const Key('add-device-unlock-password')),
      'harness',
    );
    await tester.tap(find.byKey(const Key('add-device-unlock-reveal')));
    await tester.pump(const Duration(milliseconds: 300));
    await shot('typed-shown');
    await tester.tap(find.byKey(const Key('add-device-unlock')));
    await waitFor(find.byKey(const Key('add-device-unlocked-done')));
    await shot('unlocked-starting');

    // Started: its own setup page now, with the Wi-Fi it sees.
    await waitFor(
      find.byKey(const ValueKey('add-device-wifi-Glinks 1')),
      seconds: 60,
    );
    await shot('wifi-list');
    runtime.dispose();
  });
}
