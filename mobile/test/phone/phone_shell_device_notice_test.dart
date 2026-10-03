import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/device_detail_page.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/devices_page.dart';
import 'package:harness_mobile/phone/phone_shell.dart';

import 'devices_fixture.dart';

/// A tapped "new device" notice opens that device's page: as new while it is still news, plain once
/// it is only on the list, and the list when the account no longer holds it.
void main() {
  late DevicesApp app;
  final at = DateTime(2026, 9, 30, 8).millisecondsSinceEpoch;

  setUp(() => app = DevicesApp());
  tearDown(() => app.dispose());

  Future<void> pumpShell(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await tester.pump();
  }

  Future<void> tapNotice(WidgetTester tester, String pub) async {
    app.agentNotices.system.openedDevice.value = pub;
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
  }

  testWidgets('a device still news opens as new, and the tap is consumed', (
    tester,
  ) async {
    final m = member(pubOf(3), label: 'iPad', addedAt: at);
    app
      ..rows = [row(m, pending: true)]
      ..newDevices.add(m);
    await pumpShell(tester);

    await tapNotice(tester, m.pub);

    final page = tester.widget<DeviceDetailPage>(find.byType(DeviceDetailPage));
    expect(page.row.member.pub, m.pub);
    expect(page.isNew, isTrue);
    expect(find.text(fpOf(m.pub)), findsOneWidget);
    expect(app.agentNotices.system.openedDevice.value, isNull);
  });

  testWidgets('a tap that launched the app still opens the device', (
    tester,
  ) async {
    // The launch tap is read before the shell exists, so no listener sees it change.
    final m = member(pubOf(5), label: 'iPad', addedAt: at);
    app
      ..rows = [row(m, pending: true)]
      ..newDevices.add(m);
    app.agentNotices.system.openedDevice.value = m.pub;
    await pumpShell(tester);
    await tester.pump(const Duration(seconds: 1));

    final page = tester.widget<DeviceDetailPage>(find.byType(DeviceDetailPage));
    expect(page.row.member.pub, m.pub);
    expect(app.agentNotices.system.openedDevice.value, isNull);
  });

  testWidgets('a launch tap for a device the log still holds as pending opens '
      'as new, before the banner list is rebuilt', (tester) async {
    // After a restart the banner list is empty until the log has been read; the tap can come first.
    final m = member(pubOf(6), label: 'iPad', addedAt: at);
    app.rows = [row(m, pending: true)];
    app.agentNotices.system.openedDevice.value = m.pub;
    await pumpShell(tester);
    await tester.pump(const Duration(seconds: 1));

    final page = tester.widget<DeviceDetailPage>(find.byType(DeviceDetailPage));
    expect(page.row.member.pub, m.pub);
    expect(page.isNew, isTrue);
  });

  testWidgets('a suspended pending device opens as the log lists it: Suspended '
      'shown, and It\'s mine there lifts the suspension', (tester) async {
    // The notice is built from the log's entry; the page is not: it carries the log's own flags.
    final m = member(pubOf(3), label: 'iPad', addedAt: at);
    app
      ..rows = [row(m, pending: true, suspended: true)]
      ..newDevices.add(m);
    await pumpShell(tester);

    await tapNotice(tester, m.pub);

    expect(find.textContaining('Not trusted here'), findsOneWidget);
    await tester.tap(find.byKey(const Key('device-detail-mine')));
    await tester.pumpAndSettle();
    expect(app.dismissed, [(pub: m.pub, liftSuspension: true)]);
  });

  testWidgets('a device only on the list opens plain', (tester) async {
    final m = member(pubOf(4), label: 'Pixel', addedAt: at);
    app.rows = [row(m)];
    await pumpShell(tester);

    await tapNotice(tester, m.pub);

    final page = tester.widget<DeviceDetailPage>(find.byType(DeviceDetailPage));
    expect(page.row.member.pub, m.pub);
    expect(page.isNew, isFalse);
  });

  testWidgets('a device the account no longer holds opens the list', (
    tester,
  ) async {
    await pumpShell(tester);

    await tapNotice(tester, pubOf(5));

    expect(find.byType(DeviceDetailPage), findsNothing);
    expect(find.byType(DevicesPage), findsOneWidget);
  });

  testWidgets('a removal notice (removed:<pub>) opens the list', (
    tester,
  ) async {
    await pumpShell(tester);

    await tapNotice(tester, 'removed:${pubOf(6)}');

    expect(find.byType(DeviceDetailPage), findsNothing);
    expect(find.byType(DevicesPage), findsOneWidget);
  });

  testWidgets('a red removal notice (removedBy:<signer>:<pub>) opens the '
      'signer, as new', (tester) async {
    final signer = member(pubOf(7), label: 'Pixel', addedAt: at);
    app
      ..rows = [row(signer, pending: true)]
      ..newDevices.add(signer);
    await pumpShell(tester);

    await tapNotice(tester, 'removedBy:${signer.pub}:${pubOf(6)}');

    final page = tester.widget<DeviceDetailPage>(find.byType(DeviceDetailPage));
    expect(page.row.member.pub, signer.pub);
    expect(page.isNew, isTrue);
  });

  testWidgets('a red removal notice whose signer is gone opens the list', (
    tester,
  ) async {
    await pumpShell(tester);

    await tapNotice(tester, 'removedBy:${pubOf(7)}:${pubOf(6)}');

    expect(find.byType(DeviceDetailPage), findsNothing);
    expect(find.byType(DevicesPage), findsOneWidget);
  });

  group('the status-bar inset', () {
    Future<void> pumpPadded(WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(padding: const EdgeInsets.only(top: 50)),
            child: child!,
          ),
          home: PhoneShell(notifier: app),
        ),
      );
      await tester.pump();
    }

    double pageTopInset(WidgetTester tester) =>
        MediaQuery.paddingOf(tester.element(find.byType(AgentHome))).top;

    testWidgets('a band takes it, so the pages under it do not take it '
        'again', (tester) async {
      app.newDevices.add(member(pubOf(3), label: 'iPad', addedAt: at));
      await pumpPadded(tester);
      expect(pageTopInset(tester), 0);
    });

    testWidgets('with no band the pages keep it, and it comes back when the '
        'last band goes', (tester) async {
      await pumpPadded(tester);
      expect(pageTopInset(tester), 50);

      app
        ..newDevices.add(member(pubOf(3), label: 'iPad', addedAt: at))
        ..poke();
      await tester.pump();
      expect(pageTopInset(tester), 0);

      app
        ..newDevices.clear()
        ..poke();
      await tester.pump();
      expect(pageTopInset(tester), 50);
    });
  });
}
