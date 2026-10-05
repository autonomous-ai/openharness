// One device in full (Settings ▸ Your devices ▸ a row, the banner's Review, a notification click):
// its facts, its whole key code, how to compare it, and what can be done about it.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/settings/sections/account_device_detail.dart';
import 'package:harness/shared/widgets/fingerprint_text.dart';
import 'package:harness/state/account_devices.dart';
import 'package:harness/theme/app_theme.dart' show AppColors;

import 'support/devices_app.dart';

const fp = fakeFingerprint;

void main() {
  late FakeDevicesApp app;

  setUp(() => app = FakeDevicesApp());
  tearDown(() => app.dispose());

  /// Opens the detail from a button, as the list and the banner do; [mine] counts `onMine` calls.
  Future<List<String>> open(
    WidgetTester tester, {
    required String pub,
    AccountDevice? device,
    bool isNew = false,
  }) async {
    final mine = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => unawaited(
                showAccountDeviceDetail(
                  context,
                  app,
                  pub: pub,
                  device: device,
                  isNew: isNew,
                  onMine: () => mine.add(pub),
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pump();
    await tester.pump();
    return mine;
  }

  testWidgets(
    'a device the log still has as new offers It’s mine even when the caller did not say so',
    (tester) async {
      // A notification's click lands before the banner has been rebuilt from the log.
      final mine = await open(
        tester,
        pub: 'p1',
        device: fakeDevice('p1', pending: true),
      );
      await tester.tap(find.byKey(const Key('device-detail-mine')));
      await tester.pump();
      expect(app.dismissCalls, [('p1', false)]);
      expect(mine, ['p1']);
    },
  );

  testWidgets('a device that is not new offers no It’s mine', (tester) async {
    await open(tester, pub: 'p1', device: fakeDevice('p1'));
    expect(find.byKey(const Key('device-detail-mine')), findsNothing);
  });

  testWidgets(
    'an app: kind, added, last active, the code and how to check it on the app',
    (tester) async {
      final seen = DateTime.now().subtract(const Duration(days: 2, hours: 1));
      await open(
        tester,
        pub: 'p1',
        device: fakeDevice(
          'p1',
          seen: seen,
          added: DateTime(2026, 9, 1, 9, 30),
        ),
      );
      expect(find.text('iPad'), findsOneWidget);
      expect(find.text('Kind'), findsOneWidget);
      expect(find.text('App'), findsOneWidget);
      expect(find.text('1 Sep 2026, 09:30'), findsOneWidget);
      expect(find.text('2 days ago'), findsOneWidget);
      expect(find.text('Machine'), findsNothing);
      expect(find.text(fp), findsOneWidget);
      expect(find.byKey(const Key('device-detail-copy')), findsOneWidget);
      expect(
        find.text(fingerprintHowToCompare(computer: false)),
        findsOneWidget,
      );
      expect(find.byKey(const Key('device-detail-remove')), findsOneWidget);
      expect(find.byKey(const Key('device-detail-mine')), findsNothing);
      expect(app.loads, 0, reason: 'the row it came from is used as is');
    },
  );

  testWidgets(
    'a computer: its machine, no last active when unknown, the CLI route',
    (tester) async {
      await open(
        tester,
        pub: 'box',
        device: fakeDevice('box', label: 'box9', kind: 'machine'),
      );
      expect(find.text('Computer'), findsOneWidget);
      expect(find.text('abcdef01'), findsOneWidget);
      expect(find.text('Last active'), findsNothing);
      expect(
        find.text(fingerprintHowToCompare(computer: true)),
        findsOneWidget,
      );
    },
  );

  testWidgets('this device: no Remove, only Close', (tester) async {
    await open(tester, pub: 'me', device: fakeDevice('me', self: true));
    expect(find.byKey(const Key('device-detail-remove')), findsNothing);
    await tester.tap(find.byKey(const Key('device-detail-close')));
    await tester.pump();
    expect(find.text(fp), findsNothing);
  });

  testWidgets('It’s mine dismisses the notice, tells the list, and closes', (
    tester,
  ) async {
    app.newDevices.add(
      const NewDeviceNotice(pub: 'p1', label: 'iPad', kind: 'viewer'),
    );
    final mine = await open(
      tester,
      pub: 'p1',
      device: fakeDevice('p1'),
      isNew: true,
    );
    await tester.tap(find.byKey(const Key('device-detail-mine')));
    await tester.pump();
    expect(app.newDevices, isEmpty);
    expect(mine, ['p1']);
    // Nothing here said the key is suspended, so "mine" lifts nothing.
    expect(app.dismissCalls, [('p1', false)]);
    expect(find.text(fp), findsNothing);
  });

  testWidgets(
    'It’s mine on a suspended device, whose Suspended text is shown, lifts the suspension',
    (tester) async {
      app.newDevices.add(
        const NewDeviceNotice(
          pub: 'sus',
          label: 'Odd Mac',
          kind: 'viewer',
          suspended: true,
        ),
      );
      await open(
        tester,
        pub: 'sus',
        device: fakeDevice('sus', suspended: true),
        isNew: true,
      );
      expect(find.byKey(const Key('device-detail-suspended')), findsOneWidget);
      await tester.tap(find.byKey(const Key('device-detail-mine')));
      await tester.pump();
      expect(app.dismissCalls, [('sus', true)]);
    },
  );

  testWidgets(
    'It’s mine before the device has loaded (so no Suspended text) keeps the suspension',
    (tester) async {
      // Opened from the banner's Review: the list that says the key is suspended has not answered, and
      // whoever delays it must not get the suspension lifted for a page that never showed it.
      app.loadGate = Completer<void>();
      app.newDevices.add(
        const NewDeviceNotice(
          pub: 'sus',
          label: 'Odd Mac',
          kind: 'viewer',
          suspended: true,
        ),
      );
      app.devices = AccountDevices(
        devices: [fakeDevice('sus', suspended: true)],
      );
      await open(tester, pub: 'sus', isNew: true);
      expect(find.byKey(const Key('device-detail-suspended')), findsNothing);
      await tester.tap(find.byKey(const Key('device-detail-mine')));
      await tester.pump();
      expect(app.dismissCalls, [('sus', false)]);
      app.loadGate!.complete();
      await tester.pump();
    },
  );

  testWidgets('Remove asks first; a no leaves the device alone', (
    tester,
  ) async {
    await open(tester, pub: 'p1', device: fakeDevice('p1'));
    await tester.tap(find.byKey(const Key('device-detail-remove')));
    await tester.pump();
    expect(find.text('Remove iPad?'), findsOneWidget);
    expect(find.text(removeDeviceDetail), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pump();
    expect(app.removed, isEmpty);
    expect(find.text(fp), findsOneWidget);
  });

  testWidgets('Remove, confirmed, takes the device out and closes', (
    tester,
  ) async {
    await open(tester, pub: 'p1', device: fakeDevice('p1'));
    await tester.tap(find.byKey(const Key('device-detail-remove')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('account-device-confirm')));
    await tester.pump();
    await tester.pump();
    expect(app.removed, ['p1']);
    expect(find.text(fp), findsNothing);
    expect(find.text('Remove iPad?'), findsNothing);
  });

  testWidgets('a removal that fails says why and stays open to try again', (
    tester,
  ) async {
    app.removeError = 'UNAVAILABLE';
    await open(tester, pub: 'p1', device: fakeDevice('p1'));
    await tester.tap(find.byKey(const Key('device-detail-remove')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('account-device-confirm')));
    await tester.pump();
    await tester.pump();
    expect(app.removed, ['p1']);
    expect(
      find.text('Couldn’t remove iPad (UNAVAILABLE). Try again.'),
      findsOneWidget,
    );
    expect(find.text(fp), findsOneWidget);
    expect(find.text('Remove'), findsOneWidget);
    // A failure, not a state to review again: red.
    expect(
      tester
          .widget<Text>(find.byKey(const Key('device-detail-error')))
          .style
          ?.color,
      AppColors.danger,
    );
  });

  testWidgets(
    'from the banner: the notice stands in while the list loads, then the list row takes over',
    (tester) async {
      app.loadGate = Completer<void>();
      app.newDevices.add(
        const NewDeviceNotice(
          pub: 'p1',
          label: 'Test iPad',
          kind: 'viewer',
          frameFingerprint: fp,
        ),
      );
      app.devices = AccountDevices(
        devices: [
          fakeDevice(
            'p1',
            label: 'Test iPad',
            added: DateTime(2026, 9, 30, 8, 5),
          ),
        ],
      );
      await open(tester, pub: 'p1', isNew: true);
      expect(find.text('Test iPad'), findsOneWidget);
      expect(find.text(fp), findsOneWidget);
      expect(find.text('Added'), findsNothing);
      expect(find.byKey(const Key('device-detail-mine')), findsOneWidget);
      app.loadGate!.complete();
      await tester.pump();
      await tester.pump();
      expect(app.loads, 1);
      expect(find.text('30 Sep 2026, 08:05'), findsOneWidget);
      expect(find.text(fp), findsOneWidget);
    },
  );

  testWidgets('a list that cannot be read leaves the notice standing in', (
    tester,
  ) async {
    app.loadError = StateError('daemon down');
    app.newDevices.add(
      const NewDeviceNotice(
        pub: 'p1',
        label: 'Test iPad',
        kind: 'machine',
        frameFingerprint: fp,
      ),
    );
    await open(tester, pub: 'p1', isNew: true);
    await tester.pump();
    expect(find.text('Test iPad'), findsOneWidget);
    expect(find.text('Computer'), findsOneWidget);
    expect(find.text(fp), findsOneWidget);
  });

  testWidgets('a device no longer on the account says so, with only Close', (
    tester,
  ) async {
    app.devices = AccountDevices(devices: [fakeDevice('other')]);
    await open(tester, pub: 'gone');
    await tester.pump();
    expect(
      find.text('This device is no longer on your account.'),
      findsOneWidget,
    );
    expect(find.byKey(const Key('device-detail-remove')), findsNothing);
    expect(find.byKey(const Key('device-detail-mine')), findsNothing);
    expect(find.byKey(const Key('device-detail-close')), findsOneWidget);
    expect(find.byType(FingerprintText), findsNothing);
  });
}
