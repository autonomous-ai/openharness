import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/device_detail_page.dart';
import 'package:harness_mobile/phone/devices_page.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';

import 'devices_fixture.dart';

/// A [DevicesApp] whose listing waits on [gate], to take the navigator away mid-read.
class _SlowApp extends DevicesApp {
  _SlowApp({super.rows});

  final gate = Completer<void>();

  @override
  Future<DeviceLogListing> deviceListing() async {
    await gate.future;
    return super.deviceListing();
  }
}

/// A device's page from the log's own listing, on the navigator it is handed — which may be gone by
/// the time the log has been read.
void main() {
  final key = GlobalKey<NavigatorState>();

  Future<void> pumpApp(WidgetTester tester) => tester.pumpWidget(
    MaterialApp(
      navigatorKey: key,
      home: const Scaffold(body: Text('home')),
    ),
  );

  testWidgets('opens the device; one the log does not list opens the list', (
    tester,
  ) async {
    final m = member(pubOf(3), label: 'iPad', addedAt: 1);
    final app = DevicesApp(rows: [row(m, pending: true)]);
    addTearDown(app.dispose);
    await pumpApp(tester);

    unawaited(openDeviceFromLog(key.currentState!, app, m.pub));
    await tester.pumpAndSettle();
    expect(find.byType(DeviceDetailPage), findsOneWidget);

    key.currentState!.pop();
    await tester.pumpAndSettle();
    unawaited(openDeviceFromLog(key.currentState!, app, pubOf(99)));
    await tester.pumpAndSettle();
    expect(find.byType(DevicesPage), findsOneWidget);
  });

  testWidgets('a listing that throws opens the list, no error', (tester) async {
    final app = DevicesApp()..listingFailures = 1;
    addTearDown(app.dispose);
    await pumpApp(tester);
    unawaited(openDeviceFromLog(key.currentState!, app, pubOf(3)));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byType(DevicesPage), findsOneWidget);
  });

  testWidgets('a navigator that went away while the log was read is left '
      'alone: no throw', (tester) async {
    final m = member(pubOf(3), label: 'iPad', addedAt: 1);
    final app = _SlowApp(rows: [row(m, pending: true)]);
    addTearDown(app.dispose);
    await pumpApp(tester);
    final nav = key.currentState!;
    final opened = openDeviceFromLog(nav, app, m.pub);
    await tester.pumpWidget(const SizedBox());
    app.gate.complete();
    await opened;
    expect(tester.takeException(), isNull);
  });
}
