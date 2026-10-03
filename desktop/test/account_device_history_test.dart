// Settings ▸ Your devices ▸ History…: the log's adds and removes, newest first.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/settings/sections/account_device_history.dart';
import 'package:harness/state/account_devices.dart';
import 'package:harness/theme/app_theme.dart' show AppColors;
import 'package:harness/viewer/device_history.dart';

import 'support/devices_app.dart';

DevLogHistoryRow _row(
  int seq,
  String op,
  String label, {
  String pub = 'p',
  String kind = 'viewer',
  String? previous,
  DevLogHistoryBy? by,
  bool thisDevice = false,
  bool pending = false,
  bool active = false,
  bool whileFrozen = false,
}) => DevLogHistoryRow(
  seq: seq,
  op: op,
  pub: pub,
  kind: kind,
  machineId: '',
  label: label,
  previousLabel: previous,
  fingerprint: 'AAAA·BBBB',
  by: by,
  at: DateTime(2026, 10, 1, 14, 5).millisecondsSinceEpoch,
  thisDevice: thisDevice,
  afterJoin: false,
  pending: pending,
  active: active,
  whileFrozen: whileFrozen,
);

void main() {
  late FakeDevicesApp app;

  setUp(() => app = FakeDevicesApp());
  tearDown(() => app.dispose());

  Future<void> open(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showAccountDeviceHistory(context, app),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pump();
    await tester.pump();
  }

  testWidgets(
    'each row says what happened, in order, with the date and the key code',
    (tester) async {
      app.history = DeviceLogHistory(
        complete: true,
        rows: [
          _row(
            5,
            'removed',
            'Old iPad',
            by: const DevLogHistoryBy(
              pub: 'm',
              label: 'MacBook',
              fingerprint: 'X',
            ),
            whileFrozen: true,
          ),
          _row(4, 'signedOut', 'Phone'),
          _row(3, 'renamed', 'Mac', previous: 'Old Mac', kind: 'machine'),
          _row(
            2,
            'added',
            'Test iPad',
            pub: 'new',
            pending: true,
            active: true,
          ),
          _row(1, 'added', 'MacBook', thisDevice: true),
        ],
      );
      await open(tester);
      expect(find.text('Device history'), findsOneWidget);
      expect(
        find.text(
          'Every device added to or removed from your account, newest first, as this device verified it.',
        ),
        findsOneWidget,
      );
      expect(
        find.text(
          'Old iPad removed by MacBook · applied while the list was frozen',
        ),
        findsOneWidget,
      );
      expect(find.text('Phone signed out'), findsOneWidget);
      expect(find.text('Old Mac renamed to Mac'), findsOneWidget);
      expect(find.text('Test iPad added'), findsOneWidget);
      expect(find.text('MacBook added'), findsOneWidget);
      expect(find.text('(this device)'), findsOneWidget);
      expect(find.text('New'), findsOneWidget);
      expect(
        find.text('1 Oct 2026, 14:05 · App · AAAA·BBBB'),
        findsNWidgets(4),
      );
      double top(int seq) =>
          tester.getTopLeft(find.byKey(ValueKey('device-history-$seq'))).dy;
      expect(top(5), lessThan(top(4)));
      expect(top(2), lessThan(top(1)));
      expect(find.byKey(const Key('device-history-incomplete')), findsNothing);
    },
  );

  testWidgets(
    'an active row opens that device, offering It’s mine when it is still new',
    (tester) async {
      app.history = DeviceLogHistory(
        complete: true,
        rows: [
          _row(
            2,
            'added',
            'Test iPad',
            pub: 'new',
            pending: true,
            active: true,
          ),
        ],
      );
      app.devices = AccountDevices(
        devices: [fakeDevice('new', label: 'Test iPad')],
      );
      await open(tester);
      await tester.tap(find.text('Test iPad added'));
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const Key('device-detail-mine')), findsOneWidget);
    },
  );

  testWidgets(
    'offline: what is kept, and the line that says it is not all of it',
    (tester) async {
      app.history = DeviceLogHistory(
        complete: false,
        rows: [_row(2, 'added', 'Test iPad')],
      );
      await open(tester);
      expect(find.text('Test iPad added'), findsOneWidget);
      expect(find.text('Older history needs a connection.'), findsOneWidget);
    },
  );

  testWidgets('an empty log says so', (tester) async {
    app.history = const DeviceLogHistory(complete: true, rows: []);
    await open(tester);
    expect(find.text('No history yet.'), findsOneWidget);
  });

  testWidgets('a read that fails says so and can be tried again', (
    tester,
  ) async {
    await open(tester);
    expect(find.text('Couldn’t load the history. Try again.'), findsOneWidget);
    expect(
      tester
          .widget<Text>(find.byKey(const Key('device-history-error')))
          .style
          ?.color,
      AppColors.danger,
    );
    app.history = DeviceLogHistory(
      complete: true,
      rows: [_row(1, 'added', 'MacBook')],
    );
    await tester.tap(find.byKey(const Key('device-history-retry')));
    await tester.pump();
    await tester.pump();
    expect(find.text('MacBook added'), findsOneWidget);
    expect(find.byKey(const Key('device-history-error')), findsNothing);
  });
}
