// The band a new device raises across the window: one device goes straight to its key code, several
// go to Settings ▸ Your devices, where each is a row.
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/settings/sections/account_devices_section.dart';
import 'package:harness/state/account_devices.dart' hide NewDeviceNotice;
import 'package:harness/viewer/device_history.dart'
    show DevLogHistoryRow, DeviceLogHistory;
import 'package:harness/viewer/device_log_sync.dart'
    show DeviceLogDeparted, DeviceRemovalNotice;
import 'package:harness/state/account_devices.dart'
    as model
    show NewDeviceNotice;
import 'package:harness/widgets/new_device_notice.dart';

import 'support/devices_app.dart';

void main() {
  late FakeDevicesApp app;

  setUp(() => app = FakeDevicesApp());
  tearDown(() => app.dispose());

  Future<void> mount(WidgetTester tester, {double width = 1200}) async {
    tester.view.physicalSize = Size(width, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          // As the app shell draws it: rebuilt whenever the app changes.
          body: ListenableBuilder(
            listenable: app,
            builder: (context, _) => Column(
              children: [
                NewDeviceNotice(notifier: app),
                DeviceRemovalNoticeBand(notifier: app),
                DeviceDepartedNoticeBand(notifier: app),
                DeviceConflictNoticeBand(notifier: app),
                const Expanded(child: SizedBox()),
              ],
            ),
          ),
        ),
      ),
    );
  }

  testWidgets(
    'It’s mine on the banner dismisses the notice but keeps a fork suspension',
    (tester) async {
      app.newDevices.add(
        const model.NewDeviceNotice(
          pub: 'p1',
          label: 'Test iPad',
          kind: 'viewer',
        ),
      );
      await mount(tester);
      await tester.tap(find.byKey(const Key('new-device-dismiss')));
      await tester.pump();
      expect(app.newDevices, isEmpty);
      // The banner never says a key is suspended, so it must not lift that: only the detail page does.
      expect(app.dismissCalls, [('p1', false)]);
    },
  );

  testWidgets(
    'It’s mine on a suspended entry opens the device instead of dismissing it',
    (tester) async {
      // A fork's suspension keeps the key pending, so a dismissal would be back on the next read: the
      // device's own page shows the suspension, and lifts it there.
      app.newDevices.add(
        const model.NewDeviceNotice(
          pub: 'sus',
          label: 'Odd Mac',
          kind: 'viewer',
          suspended: true,
        ),
      );
      app.devices = AccountDevices(
        devices: [fakeDevice('sus', label: 'Odd Mac', suspended: true)],
      );
      await mount(tester);
      await tester.tap(find.byKey(const Key('new-device-dismiss')));
      await tester.pump();
      await tester.pump();
      expect(app.dismissCalls, isEmpty);
      expect(app.newDevices, hasLength(1));
      expect(find.byKey(const Key('device-detail-suspended')), findsOneWidget);
      await tester.tap(find.byKey(const Key('device-detail-mine')));
      await tester.pump();
      expect(app.dismissCalls, [('sus', true)]);
    },
  );

  testWidgets('one new device: Review opens that device, offering It’s mine', (
    tester,
  ) async {
    app.newDevices.add(
      const model.NewDeviceNotice(
        pub: 'p1',
        label: 'Test iPad',
        kind: 'viewer',
        frameFingerprint: 'AAAA·BBBB·CCCC·DDDD',
      ),
    );
    app.devices = AccountDevices(
      devices: [
        fakeDevice(
          'p1',
          label: 'Test iPad',
          fingerprint: 'AAAA·BBBB·CCCC·DDDD',
        ),
      ],
    );
    await mount(tester);
    final review = find.byKey(const Key('new-device-review'));
    expect(
      find.descendant(of: review, matching: find.text('Review')),
      findsOneWidget,
    );
    // The banner's sentence carries no key code.
    expect(find.textContaining('AAAA'), findsNothing);
    await tester.tap(review);
    await tester.pump();
    await tester.pump();
    expect(find.text('AAAA·BBBB·CCCC·DDDD'), findsOneWidget);
    expect(find.byKey(const Key('device-detail-mine')), findsOneWidget);
    expect(find.byType(AccountDevicesSection), findsNothing);
    // It’s mine there is the banner's It’s mine.
    await tester.tap(find.byKey(const Key('device-detail-mine')));
    await tester.pump();
    expect(app.newDevices, isEmpty);
    expect(find.byKey(const Key('new-device-notice')), findsNothing);
  });

  testWidgets(
    'two new devices: Review devices opens the list, the new ones on top',
    (tester) async {
      final now = DateTime.now();
      app.newDevices
        ..add(
          const model.NewDeviceNotice(
            pub: 'p1',
            label: 'Test iPad',
            kind: 'viewer',
          ),
        )
        ..add(
          const model.NewDeviceNotice(
            pub: 'p2',
            label: 'box9',
            kind: 'machine',
          ),
        );
      app.devices = AccountDevices(
        devices: [
          fakeDevice(
            'old',
            label: 'Old phone',
            added: now.subtract(const Duration(days: 90)),
            seen: now,
          ),
          fakeDevice(
            'p1',
            label: 'Test iPad',
            added: now.subtract(const Duration(hours: 2)),
          ),
          fakeDevice(
            'p2',
            label: 'box9',
            kind: 'machine',
            added: now.subtract(const Duration(hours: 1)),
          ),
        ],
      );
      await mount(tester);
      expect(find.textContaining('(+1 more)'), findsOneWidget);
      final review = find.byKey(const Key('new-device-review'));
      expect(
        find.descendant(of: review, matching: find.text('Review devices')),
        findsOneWidget,
      );
      await tester.tap(review);
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(find.byType(AccountDevicesSection), findsOneWidget);
      double top(String pub) =>
          tester.getTopLeft(find.byKey(ValueKey('account-device-$pub'))).dy;
      expect(top('p2'), lessThan(top('p1')));
      expect(top('p1'), lessThan(top('old')));
      expect(find.text('New'), findsNWidgets(2));
      expect(app.newDevices, isEmpty);
    },
  );

  DeviceRemovalNotice removal({
    String label = 'Old iPad',
    bool selfRemoved = false,
    bool signerPending = false,
    String signer = 'signer',
  }) => DeviceRemovalNotice(
    pub: 'gone-$label',
    label: label,
    kind: 'viewer',
    fingerprint: 'AAAA·BBBB',
    signer: signer,
    signerLabel: 'MacBook',
    signerFingerprint: 'E2FB·0DF5·5FD8·E6C7',
    signerPending: signerPending,
    selfRemoved: selfRemoved,
    at: 1,
  );

  group('a device taken out of the account', () {
    testWidgets(
      'removed by a device the owner knows: a plain notice, Got it takes it down',
      (tester) async {
        app.deviceRemovals.add(removal());
        await mount(tester);
        expect(
          find.text(
            'Device removed. Old iPad was removed from your account by MacBook.',
          ),
          findsOneWidget,
        );
        expect(find.byKey(const Key('device-removal-review')), findsNothing);
        await tester.tap(find.byKey(const Key('device-removal-dismiss')));
        await tester.pump();
        expect(app.deviceRemovals, isEmpty);
        expect(find.byKey(const Key('device-removal-notice')), findsNothing);
      },
    );

    testWidgets('a device that signed out says so', (tester) async {
      app.deviceRemovals.add(removal(selfRemoved: true));
      await mount(tester);
      expect(
        find.text('Device signed out. Old iPad signed out of your account.'),
        findsOneWidget,
      );
    });

    testWidgets(
      'removed by a new device nobody looked at: red, and Review opens that device',
      (tester) async {
        app.deviceRemovals.add(removal(signerPending: true, signer: 'signer'));
        app.devices = AccountDevices(
          devices: [
            fakeDevice(
              'signer',
              label: 'MacBook',
              fingerprint: 'E2FB·0DF5·5FD8·E6C7',
            ),
          ],
        );
        await mount(tester);
        expect(
          find.text(
            'Removed by a new device. Old iPad was removed from your account by a new device you haven’t looked at (MacBook · E2FB·0DF5…).',
          ),
          findsOneWidget,
        );
        await tester.tap(find.byKey(const Key('device-removal-review')));
        await tester.pump();
        await tester.pump();
        expect(find.text('E2FB·0DF5·5FD8·E6C7'), findsOneWidget);
      },
    );

    testWidgets('more than one: the first, and how many are behind it', (
      tester,
    ) async {
      app.deviceRemovals
        ..add(removal())
        ..add(removal(label: 'Other'));
      await mount(tester);
      expect(find.textContaining('(+1 more)'), findsOneWidget);
    });

    testWidgets(
      'a red one behind an older neutral one is the one shown, with its Review',
      (tester) async {
        app.deviceRemovals
          ..add(removal(label: 'Calm'))
          ..add(removal(label: 'Alarm', signerPending: true, signer: 'signer'));
        app.devices = AccountDevices(
          devices: [
            fakeDevice(
              'signer',
              label: 'MacBook',
              fingerprint: 'E2FB·0DF5·5FD8·E6C7',
            ),
          ],
        );
        await mount(tester);
        final text = tester
            .widget<Text>(find.byKey(const Key('device-removal-notice')))
            .data!;
        expect(text, startsWith('Removed by a new device. Alarm was removed'));
        expect(text, endsWith('(+1 more)'));
        expect(find.byKey(const Key('device-removal-review')), findsOneWidget);
        // Got it takes down the one shown; the neutral one is then what is left.
        await tester.tap(find.byKey(const Key('device-removal-dismiss')));
        await tester.pump();
        expect(app.deviceRemovals.map((n) => n.label), ['Calm']);
        expect(find.textContaining('Calm was removed'), findsOneWidget);
        expect(find.byKey(const Key('device-removal-review')), findsNothing);
      },
    );

    testWidgets('only neutral ones: the first, in order', (tester) async {
      app.deviceRemovals
        ..add(removal(label: 'First'))
        ..add(removal(label: 'Second'));
      await mount(tester);
      expect(find.textContaining('First was removed'), findsOneWidget);
    });
  });

  DeviceLogDeparted departed({
    String pub = 'gone',
    String label = 'Old iPad',
    String by = 'signer',
    String byLabel = 'MacBook',
    bool self = false,
  }) => DeviceLogDeparted(
    pub: pub,
    label: label,
    kind: 'viewer',
    machineId: '',
    fingerprint: 'AAAA·BBBB',
    addedAt: 1,
    removedAt: 2,
    removedBy: self ? pub : by,
    removedByLabel: byLabel,
    selfRemoved: self,
  );

  group('a device that joined and left before anyone looked', () {
    testWidgets(
      'removed by another key: says who, and Got it clears the flag',
      (tester) async {
        app.departedDevices.add(departed());
        await mount(tester);
        expect(
          find.text(
            'Old iPad joined your account and left before you looked. Removed by MacBook.',
          ),
          findsOneWidget,
        );
        await tester.tap(find.byKey(const Key('device-departed-dismiss')));
        await tester.pump();
        expect(app.dismissedDeparted, ['gone']);
        expect(find.byKey(const Key('device-departed-notice')), findsNothing);
      },
    );

    testWidgets('its own sign-out names no one', (tester) async {
      app.departedDevices.add(departed(self: true));
      await mount(tester);
      expect(
        find.text('Old iPad joined your account and left before you looked.'),
        findsOneWidget,
      );
    });

    testWidgets('more than one: the first, and how many are behind it', (
      tester,
    ) async {
      app.departedDevices
        ..add(departed())
        ..add(departed(pub: 'gone2'));
      await mount(tester);
      expect(find.textContaining('(+1 more)'), findsOneWidget);
    });

    testWidgets(
      'more than one: Got it clears them all, the ones behind it too',
      (tester) async {
        app.departedDevices
          ..add(departed())
          ..add(departed(pub: 'gone2'));
        await mount(tester);
        await tester.tap(find.byKey(const Key('device-departed-dismiss')));
        await tester.pump();
        expect(app.dismissedDeparted, unorderedEquals(['gone', 'gone2']));
        expect(find.byKey(const Key('device-departed-notice')), findsNothing);
      },
    );

    testWidgets('more than one: a red one is the one shown', (tester) async {
      app.newDevices.add(
        const model.NewDeviceNotice(
          pub: 'intruder',
          label: 'Chrome',
          kind: 'viewer',
        ),
      );
      app.departedDevices
        ..add(departed())
        ..add(
          departed(
            pub: 'gone2',
            label: 'Phone',
            by: 'intruder',
            byLabel: 'Chrome',
          ),
        );
      await mount(tester);
      expect(
        find.text(
          'Phone joined your account and left before you looked. Removed by Chrome, a new device you haven’t looked at. (+1 more)',
        ),
        findsOneWidget,
      );
    });

    testWidgets('Review opens the History, where the key is flagged', (
      tester,
    ) async {
      app.departedDevices.add(departed());
      app.history = DeviceLogHistory(
        complete: true,
        rows: [
          DevLogHistoryRow(
            seq: 3,
            op: 'removed',
            pub: 'gone',
            kind: 'viewer',
            machineId: '',
            label: 'Old iPad',
            fingerprint: 'AAAA·BBBB',
            at: 2,
            thisDevice: false,
            afterJoin: true,
            pending: true,
            active: false,
            whileFrozen: false,
          ),
        ],
      );
      await mount(tester);
      await tester.tap(find.byKey(const Key('device-departed-review')));
      await tester.pump();
      await tester.pump();
      expect(find.text('Device history'), findsOneWidget);
      expect(find.text('Left before you looked'), findsOneWidget);
      // Opening it does not clear the flag: only "Got it" does.
      expect(app.dismissedDeparted, isEmpty);
    });

    testWidgets(
      'removed by a new device that is still on the account: red, and Review opens that device',
      (tester) async {
        app.newDevices.add(
          const model.NewDeviceNotice(
            pub: 'signer',
            label: 'MacBook',
            kind: 'viewer',
          ),
        );
        app.departedDevices.add(departed());
        app.devices = AccountDevices(
          devices: [
            fakeDevice(
              'signer',
              label: 'MacBook',
              fingerprint: 'E2FB·0DF5·5FD8·E6C7',
            ),
          ],
        );
        await mount(tester);
        expect(
          find.text(
            'Old iPad joined your account and left before you looked. Removed by MacBook, a new device you haven’t looked at.',
          ),
          findsOneWidget,
        );
        expect(find.text('Review'), findsWidgets);
        await tester.tap(find.byKey(const Key('device-departed-review')));
        await tester.pump();
        await tester.pump();
        expect(find.text('E2FB·0DF5·5FD8·E6C7'), findsOneWidget);
      },
    );
  });

  group('another key holds this computer’s id', () {
    DeviceConflict conflict({required bool afterJoin}) => DeviceConflict(
      pub: 'holder',
      label: 'Old install',
      fingerprint: 'AAAA·BBBB',
      addedAt: DateTime.now().subtract(const Duration(days: 3)),
      afterJoin: afterJoin,
    );

    testWidgets(
      'before this computer joined: neutral, saying it joins on its own once the holder is gone',
      (tester) async {
        app.deviceConflict = conflict(afterJoin: false);
        await mount(tester);
        final text = tester
            .widget<Text>(find.byKey(const Key('device-conflict-notice')))
            .data!;
        expect(
          text,
          startsWith(
            'This computer is held by another key on your account: Old install · AAAA·BBBB. If that was an earlier',
          ),
        );
        expect(text, isNot(contains('added')));
        expect(
          text,
          contains(
            'remove it from another device (Your devices) — this computer joins on its own once it is gone.',
          ),
        );
      },
    );

    for (final afterJoin in [false, true]) {
      testWidgets(
        '${afterJoin ? 'red' : 'neutral'} copy wraps at a narrow window: nothing is cut off, both buttons stay',
        (tester) async {
          app.deviceConflict = conflict(afterJoin: afterJoin);
          await mount(tester, width: 640);
          final paragraph = tester.renderObject<RenderParagraph>(
            find.byKey(const Key('device-conflict-notice')),
          );
          expect(
            paragraph.didExceedMaxLines,
            isFalse,
            reason:
                'the advice at the end of the copy is not cut with an ellipsis',
          );
          // It took more than two lines to say, which is what the old cap cut.
          expect(
            paragraph.size.height,
            greaterThan(paragraph.text.style!.fontSize! * 2 * 1.2),
          );
          expect(
            find.byKey(const Key('device-conflict-dismiss')),
            findsOneWidget,
          );
          expect(
            find.byKey(const Key('device-conflict-review')),
            findsOneWidget,
          );
          expect(tester.takeException(), isNull);
        },
      );
    }

    testWidgets(
      'after it joined: someone took its place, remove that key now',
      (tester) async {
        app.deviceConflict = conflict(afterJoin: true);
        await mount(tester);
        final text = tester
            .widget<Text>(find.byKey(const Key('device-conflict-notice')))
            .data!;
        expect(
          text,
          startsWith(
            'Another key took this computer’s place on your account after it joined: Old install · AAAA·BBBB',
          ),
        );
        expect(
          text,
          contains(
            'If you did not set up Harness here again, remove that key from another device now',
          ),
        );
      },
    );

    testWidgets('Your devices opens the list', (tester) async {
      app.deviceConflict = conflict(afterJoin: false);
      app.devices = AccountDevices(devices: [fakeDevice('holder')]);
      await mount(tester);
      await tester.tap(find.byKey(const Key('device-conflict-review')));
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(find.byType(AccountDevicesSection), findsOneWidget);
    });

    testWidgets('dismissed, it stays down', (tester) async {
      app.deviceConflict = conflict(afterJoin: false);
      await mount(tester);
      await tester.tap(find.byKey(const Key('device-conflict-dismiss')));
      await tester.pump();
      expect(app.deviceConflict, isNull);
      expect(find.byKey(const Key('device-conflict-notice')), findsNothing);
    });
  });
}
