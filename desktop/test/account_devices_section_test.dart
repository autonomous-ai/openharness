import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/sections/account_devices_section.dart';
import 'package:harness/state/account_devices.dart';
import 'package:harness/state/app_state.dart';

/// Settings ▸ Your devices: opening it is reviewing the devices the banner announced.
void main() {
  testWidgets('opening the devices list takes the new-device banner down', (tester) async {
    final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession(), configStore: null);
    addTearDown(app.dispose);
    app.newDevices.add(const NewDeviceNotice(pub: 'p1', label: 'Test iPad', kind: 'viewer'));
    app.newDevices.add(const NewDeviceNotice(pub: 'p2', label: 'box9', kind: 'machine'));
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: AccountDevicesSection(notifier: app))));
    await tester.pump();
    expect(app.newDevices, isEmpty);
    // Let the list's read (no daemon in a test) run out before the tree goes.
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 1));
  });
}
