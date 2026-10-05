import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/settings/sections/account_devices_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/account_devices.dart';
import 'package:harness/theme/app_theme.dart' show AppColors;
import 'package:harness/shared/widgets/fingerprint_text.dart';
import 'package:harness/viewer/device_log.dart' show DevLogHead;
import 'package:harness/viewer/device_log_sync.dart' show DeviceLogRebaseline;

import 'support/devices_app.dart';

/// Settings ▸ Your devices: opening it is reviewing the devices the banner announced.
void main() {
  test('the daemon\'s OTHER_ACCOUNT answer and the viewer\'s are a refusal of another account\'s list', () {
    final daemon = DevicesRebaseline.fromDaemon({'error': 'OTHER_ACCOUNT'})!;
    expect([daemon.otherAccount, daemon.logChanged, daemon.refused], [true, false, true]);
    expect(DevicesRebaseline.fromDaemon({'error': 'LOG_CHANGED'})!.otherAccount, isFalse);
    final viewer = DevicesRebaseline.fromViewer(const DeviceLogRebaseline.otherAccount());
    expect([viewer.otherAccount, viewer.logChanged, viewer.head], [true, false, null]);
  });
  test('a listing carries its departed keys, from the daemon and from the viewer alike', () {
    final fromDaemon = AccountDevices.fromDaemon({
      'members': <Object>[],
      'pending': <Object>[],
      'departed': [
        {
          'pub': 'gone', 'label': 'Phone', 'kind': 'viewer', 'machineId': '', 'fingerprint': 'AAAA',
          'addedAt': 1, 'removedAt': 2, 'removedBy': 'gone', 'removedByLabel': 'Phone', 'selfRemoved': true,
        },
      ],
    })!;
    expect(fromDaemon.departed, ['gone']);
    expect(AccountDevices.fromDaemon({'members': <Object>[], 'pending': <Object>[]})!.departed, isEmpty);
    expect(fromDaemon.withLastSeen(const {}).departed, ['gone']);
  });
  testWidgets('opening the devices list takes the new-device banner down', (tester) async {
    final app = FakeDevicesApp();
    addTearDown(app.dispose);
    app.newDevices.add(const NewDeviceNotice(pub: 'p1', label: 'Test iPad', kind: 'viewer'));
    app.newDevices.add(const NewDeviceNotice(pub: 'p2', label: 'box9', kind: 'machine'));
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: AccountDevicesSection(notifier: app))));
    await tester.pump();
    // Marking the devices seen waits for the list's read, so the pending keys it holds are badged first.
    await tester.pump();
    expect(app.newDevices, isEmpty);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 1));
  });
  group('the list', () {
    final now = DateTime.now();
    late FakeDevicesApp app;

    setUp(() {
      app = FakeDevicesApp()
        ..devices = AccountDevices(devices: [
          fakeDevice('old', label: 'Old laptop', kind: 'machine', added: now.subtract(const Duration(days: 300)),
              seen: now.subtract(const Duration(days: 40)), fingerprint: 'AAAA·0001·0001·0001'),
          fakeDevice('me', label: 'MacBook', kind: 'machine', self: true, added: now.subtract(const Duration(days: 200)),
              seen: now, fingerprint: 'E2FB·0DF5·5FD8·E6C7'),
          fakeDevice('phone-a', label: 'iPhone', added: now.subtract(const Duration(days: 100)),
              seen: now.subtract(const Duration(minutes: 2)), fingerprint: 'BBBB·0002·0002·0002'),
          fakeDevice('phone-b', label: 'iPhone', added: now.subtract(const Duration(days: 50)), fingerprint: 'CCCC·0003·0003·0003'),
          fakeDevice('twin', label: 'MacBook', added: now.subtract(const Duration(days: 30)),
              seen: now.subtract(const Duration(days: 3)), fingerprint: 'DDDD·0004·0004·0004'),
          fakeDevice('new', label: 'Test iPad', added: now.subtract(const Duration(hours: 3)), fingerprint: 'EEEE·0005·0005·0005'),
        ]);
      app.newDevices.add(const NewDeviceNotice(pub: 'new', label: 'Test iPad', kind: 'viewer'));
    });
    tearDown(() => app.dispose());

    Future<void> openList(WidgetTester tester) async {
      tester.view.physicalSize = const Size(1200, 1600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: AccountDevicesSection(notifier: app))));
      await tester.pump();
      await tester.pump();
    }

    String detailOf(WidgetTester tester, String pub) {
      final row = find.byKey(ValueKey('account-device-$pub'));
      return tester.widgetList<Text>(find.descendant(of: row, matching: find.byType(Text))).map((t) => t.data ?? '').join('\n');
    }

    testWidgets('this device is a card on top with its whole code, and is not a row again', (tester) async {
      await openList(tester);
      final card = find.byKey(const Key('account-device-this'));
      expect(card, findsOneWidget);
      expect(find.descendant(of: card, matching: find.text('MacBook')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.text('This is the code your other devices show for this device.')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.text('E2FB·0DF5·5FD8·E6C7')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.byKey(const Key('this-device-copy'))), findsOneWidget);
      expect(find.byKey(const ValueKey('account-device-me')), findsNothing);
      expect(find.text('This device'), findsOneWidget);
    });

    testWidgets('rows: new first with a badge, then by activity; no whole code, the start of it only for a shared name', (tester) async {
      await openList(tester);
      double top(String pub) => tester.getTopLeft(find.byKey(ValueKey('account-device-$pub'))).dy;
      final order = ['new', 'phone-a', 'twin', 'old', 'phone-b'];
      for (var i = 1; i < order.length; i++) {
        expect(top(order[i - 1]), lessThan(top(order[i])), reason: '${order[i - 1]} above ${order[i]}');
      }
      expect(top('new'), greaterThan(tester.getTopLeft(find.byKey(const Key('account-device-this'))).dy));
      // Opening the list took the banner down, but this visit still shows which device was new.
      expect(app.newDevices, isEmpty);
      expect(find.descendant(of: find.byKey(const ValueKey('account-device-new')), matching: find.text('New')), findsOneWidget);
      expect(find.text('New'), findsOneWidget);

      expect(detailOf(tester, 'new'), contains('App · added 3 hours ago'));
      expect(detailOf(tester, 'phone-a'), contains('App · active now · BBBB…'));
      expect(detailOf(tester, 'phone-b'), contains('App · added 7 weeks ago · CCCC…'));
      // Shares its name with this device's card.
      expect(detailOf(tester, 'twin'), contains('App · last active 3 days ago · DDDD…'));
      expect(detailOf(tester, 'old'), contains('Computer · last active 5 weeks ago'));
      expect(detailOf(tester, 'old'), isNot(contains('AAAA')));
      expect(detailOf(tester, 'new'), isNot(contains('EEEE')));
      for (final pub in order) {
        expect(detailOf(tester, pub), isNot(matches(RegExp(r'[0-9A-F]{4}·[0-9A-F]{4}'))), reason: pub);
      }
      final everything = tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? '').join('\n');
      expect(everything, isNot(matches(RegExp(r'\d{4}-\d{2}-\d{2}'))));
    });

    testWidgets('a row, or its Details button, opens that device with its whole code', (tester) async {
      await openList(tester);
      await tester.tap(find.descendant(of: find.byKey(const ValueKey('account-device-old')), matching: find.text('Old laptop')));
      await tester.pump();
      await tester.pump();
      expect(find.text('AAAA·0001·0001·0001'), findsOneWidget);
      expect(find.text(fingerprintHowToCompare(computer: true)), findsOneWidget);
      expect(find.byKey(const Key('device-detail-mine')), findsNothing);
      await tester.tap(find.byKey(const Key('device-detail-close')));
      await tester.pump();
      expect(find.text('AAAA·0001·0001·0001'), findsNothing);

      await tester.tap(find.byKey(const ValueKey('account-device-details-phone-b')));
      await tester.pump();
      await tester.pump();
      expect(find.text('CCCC·0003·0003·0003'), findsOneWidget);
      expect(find.text(fingerprintHowToCompare(computer: false)), findsOneWidget);
      expect(app.loads, 1, reason: 'the detail uses the row, it does not read the list again');
    });

    testWidgets('It’s mine in a new device’s detail takes its badge off; closing without it does not', (tester) async {
      await openList(tester);
      final badge = find.descendant(of: find.byKey(const ValueKey('account-device-new')), matching: find.text('New'));
      await tester.tap(find.byKey(const ValueKey('account-device-details-new')));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('device-detail-close')));
      await tester.pump();
      expect(badge, findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('account-device-details-new')));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('device-detail-mine')));
      await tester.pump();
      expect(find.text('EEEE·0005·0005·0005'), findsNothing);
      expect(badge, findsNothing);
    });

    testWidgets('Remove on a row still asks first, then takes the device out of the list', (tester) async {
      await openList(tester);
      await tester.tap(find.descendant(of: find.byKey(const ValueKey('account-device-old')), matching: find.text('Remove')));
      await tester.pump();
      expect(find.text('Remove Old laptop?'), findsOneWidget);
      await tester.tap(find.byKey(const Key('account-device-confirm')));
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(app.removed, ['old']);
      expect(find.byKey(const ValueKey('account-device-old')), findsNothing);
    });
  });

  group('what the log kept', () {
    late FakeDevicesApp app;
    tearDown(() => app.dispose());

    Future<void> open(WidgetTester tester, AccountDevices devices) async {
      app = FakeDevicesApp()..devices = devices;
      tester.view.physicalSize = const Size(1200, 1600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: AccountDevicesSection(notifier: app))));
      await tester.pump();
      await tester.pump();
    }

    testWidgets('a device the daemon kept as pending is badged New though no banner is up', (tester) async {
      await open(tester, AccountDevices(
        devices: [fakeDevice('me', self: true), fakeDevice('old'), fakeDevice('late', label: 'Late iPad')],
        pending: const ['late'],
      ));
      expect(find.descendant(of: find.byKey(const ValueKey('account-device-late')), matching: find.text('New')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('account-device-old')), matching: find.text('New')), findsNothing);
      // Looking at the list is seeing them: what it read as pending is written back, once.
      expect(app.seenPending, [['late']]);
    });

    testWidgets('a device that turns up while the list is open is badged New too (it is pending)', (tester) async {
      // E2E 2026-10-01: a forged key added while Your devices was open stayed pending (the banner came
      // back on leaving) but its row had no badge — `New` must follow `pending`, as on the phone.
      await open(tester, AccountDevices(devices: [fakeDevice('me', self: true), fakeDevice('old')], pending: const []));
      app.devices = AccountDevices(
        devices: [fakeDevice('me', self: true), fakeDevice('old'), fakeDevice('evil', label: 'Evil Chrome')],
        pending: const ['evil'],
      );
      app.devicesRevision++;
      app.notifyListeners();
      await tester.pump();
      await tester.pump();
      expect(find.descendant(of: find.byKey(const ValueKey('account-device-evil')), matching: find.text('New')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('account-device-old')), matching: find.text('New')), findsNothing);
      // Only the first read of the visit is written back as seen.
      expect(app.seenPending, [<String>[]]);
    });

    testWidgets('the baseline panel names what was there before this device joined; Got it persists and hides it', (tester) async {
      await open(tester, AccountDevices(
        devices: [
          AccountDevice(pub: 'me', label: 'MacBook', kind: 'machine', machineId: 'm', addedAt: DateTime(2026, 9, 1), fingerprint: 'AAAA·1', self: true, seq: 1),
          AccountDevice(pub: 'old', label: 'Old iPad', kind: 'viewer', machineId: '', addedAt: DateTime(2026, 9, 1), fingerprint: 'BBBB·2', self: false, seq: 2),
          AccountDevice(pub: 'later', label: 'Later', kind: 'viewer', machineId: '', addedAt: DateTime(2026, 9, 2), fingerprint: 'CCCC·3', self: false, seq: 5),
        ],
        joinedSeq: 3,
        baselineSeen: false,
      ));
      final panel = find.byKey(const Key('account-devices-baseline'));
      expect(find.descendant(of: panel, matching: find.text('Already on your account')), findsOneWidget);
      expect(find.descendant(of: panel, matching: find.text('These were on your account before this device joined. If one isn’t yours, remove it.')), findsOneWidget);
      expect(find.descendant(of: panel, matching: find.text('Old iPad · App · BBBB·2')), findsOneWidget);
      expect(find.descendant(of: panel, matching: find.textContaining('Later')), findsNothing);
      await tester.tap(find.byKey(const Key('account-devices-baseline-gotit')));
      await tester.pump();
      expect(app.baselineSeenCalls, 1);
      expect(panel, findsNothing);
    });

    testWidgets('no panel once the baseline was seen, or when the daemon sends no joined point', (tester) async {
      await open(tester, AccountDevices(
        devices: [fakeDevice('me', self: true), fakeDevice('old')],
        joinedSeq: 3,
      ));
      expect(find.byKey(const Key('account-devices-baseline')), findsNothing);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      await open(tester, AccountDevices(devices: [fakeDevice('me', self: true), fakeDevice('old')], baselineSeen: false));
      expect(find.byKey(const Key('account-devices-baseline')), findsNothing);
    });

    testWidgets('a suspended device wears Suspended instead of New, and its detail says why', (tester) async {
      await open(tester, AccountDevices(
        devices: [
          fakeDevice('me', self: true),
          AccountDevice(pub: 'sus', label: 'Odd Mac', kind: 'machine', machineId: 'abcdef0123456789', addedAt: DateTime(2026, 9, 1), fingerprint: 'DDDD·4', self: false, suspended: true, pending: true),
        ],
        pending: const ['sus'],
      ));
      final row = find.byKey(const ValueKey('account-device-sus'));
      expect(find.descendant(of: row, matching: find.text('Suspended')), findsOneWidget);
      expect(find.descendant(of: row, matching: find.text('New')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('account-device-details-sus')));
      await tester.pump();
      await tester.pump();
      expect(
        find.text('Not trusted here: added after this device’s list and another’s split. Review the list to trust it again.'),
        findsOneWidget,
      );
    });

    testWidgets('Trust again confirms the previewed head; a list that changed meanwhile says so and is previewed again', (tester) async {
      await open(tester, AccountDevices(devices: [fakeDevice('me', self: true)], frozenReason: 'fork'));
      app.previews
        ..add(const DevicesRebaseline(added: ['iPad'], removed: [], head: DevLogHead(7, 'h7')))
        ..add(const DevicesRebaseline(added: ['iPad', 'Mac'], removed: [], head: DevLogHead(8, 'h8')));
      app.confirmAnswer = const DevicesRebaseline.changed();
      await tester.tap(find.text('Review…'));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('account-device-confirm')));
      await tester.pump();
      await tester.pump();
      expect(app.confirmedHeads.single?.seq, 7);
      expect(find.text('The device list changed while you were reviewing it. Review it again.'), findsOneWidget);
      // The new preview is up, with the extra device.
      expect(find.textContaining('+ Mac'), findsOneWidget);
    });

    group('Trust again on another account\'s list says to sign in again', () {
      const message =
          'The device list now belongs to a different account than the one you signed in with. Sign in again to switch accounts.';

      testWidgets('at the preview: nothing to confirm', (tester) async {
        await open(tester, AccountDevices(devices: [fakeDevice('me', self: true)], frozenReason: 'invalid'));
        app.previews.add(const DevicesRebaseline.otherAccount());
        await tester.tap(find.text('Review…'));
        await tester.pump();
        await tester.pump();
        expect(find.text(message), findsOneWidget);
        expect(find.byKey(const Key('account-device-confirm')), findsNothing);
        expect(app.confirmedHeads, isEmpty);
      });

      testWidgets('at the confirm: said once, not previewed again', (tester) async {
        await open(tester, AccountDevices(devices: [fakeDevice('me', self: true)], frozenReason: 'invalid'));
        app.previews.add(const DevicesRebaseline(added: [], removed: [], head: DevLogHead(7, 'h7')));
        app.confirmAnswer = const DevicesRebaseline.otherAccount();
        await tester.tap(find.text('Review…'));
        await tester.pump();
        await tester.pump();
        await tester.tap(find.byKey(const Key('account-device-confirm')));
        await tester.pump();
        await tester.pump();
        expect(find.text(message), findsOneWidget);
        expect(find.text('The device list changed while you were reviewing it. Review it again.'), findsNothing);
        expect(find.byKey(const Key('account-device-confirm')), findsNothing);
        expect(app.confirmedHeads, hasLength(1));
      });
    });

    // One convention: what is only a state to review again (another account's list, a list that changed
    // while it was reviewed) is the warning amber; every other failure is red.
    testWidgets('error colours: unreadable list, a failed trust and a failed remove are red; a list that changed is amber', (tester) async {
      await open(tester, AccountDevices(devices: [fakeDevice('me', self: true), fakeDevice('b')], frozenReason: 'fork'));
      Color? colourOf(String text) => tester.widget<Text>(find.text(text)).style?.color;
      // The preview cannot be read.
      await tester.tap(find.text('Review…'));
      await tester.pump();
      await tester.pump();
      expect(colourOf('Couldn’t read a valid device list. Try again later.'), AppColors.danger);
      // The trust is refused for another reason than the list changing.
      app.previews.add(const DevicesRebaseline(added: ['iPad'], removed: [], head: DevLogHead(7, 'h7')));
      app.confirmAnswer = null;
      await tester.tap(find.text('Review…'));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('account-device-confirm')));
      await tester.pump();
      await tester.pump();
      expect(colourOf('Couldn’t trust the device list again. Try again later.'), AppColors.danger);
      // A removal that fails.
      app.removeError = 'UNAVAILABLE';
      await tester.tap(find.descendant(of: find.byKey(const ValueKey('account-device-b')), matching: find.text('Remove')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('account-device-confirm')));
      await tester.pump();
      await tester.pump();
      expect(colourOf('Couldn’t remove iPad (UNAVAILABLE). Try again.'), AppColors.danger);
      // LOG_CHANGED: amber, and the colour does not stick to the next error.
      app.previews
        ..add(const DevicesRebaseline(added: ['iPad'], removed: [], head: DevLogHead(7, 'h7')))
        ..add(const DevicesRebaseline(added: ['iPad'], removed: [], head: DevLogHead(8, 'h8')));
      app.confirmAnswer = const DevicesRebaseline.changed();
      await tester.tap(find.text('Review…'));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('account-device-confirm')));
      await tester.pump();
      await tester.pump();
      expect(colourOf('The device list changed while you were reviewing it. Review it again.'), AppColors.warning);
    });

    testWidgets('Trust again: an unreadable list says so; a later success clears the message', (tester) async {
      await open(tester, AccountDevices(devices: [fakeDevice('me', self: true)], frozenReason: 'fork'));
      app.previews
        ..add(const DevicesRebaseline(added: ['iPad'], removed: [], head: DevLogHead(7, 'h7')))
        ..add(const DevicesRebaseline(added: ['iPad'], removed: [], head: DevLogHead(7, 'h7')));
      app.confirmAnswer = null;
      await tester.tap(find.text('Review…'));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('account-device-confirm')));
      await tester.pump();
      await tester.pump();
      expect(find.text('Couldn’t trust the device list again. Try again later.'), findsOneWidget);
      expect(find.text('The device list changed while you were reviewing it. Review it again.'), findsNothing);

      app.confirmAnswer = const DevicesRebaseline(added: [], removed: [], head: DevLogHead(7, 'h7'));
      await tester.tap(find.text('Review…'));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('account-device-confirm')));
      await tester.pump();
      await tester.pump();
      expect(find.text('Couldn’t trust the device list again. Try again later.'), findsNothing);
    });

    testWidgets('opening the list marks seen only the banner as it was when the list was read', (tester) async {
      final gate = Completer<void>();
      app = FakeDevicesApp()
        ..devices = AccountDevices(devices: [fakeDevice('me', self: true)])
        ..newDevices.add(const NewDeviceNotice(pub: 'new', label: 'N', kind: 'viewer'));
      app.loadGate = gate;
      // The banner holds `new` when the listing is read.
      app.bannerAtRead = () => ['new'];
      tester.view.physicalSize = const Size(1200, 1600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: AccountDevicesSection(notifier: app))));
      await tester.pump();
      // A device announced while the read waits.
      app.newDevices.add(const NewDeviceNotice(pub: 'late', label: 'L', kind: 'viewer'));
      gate.complete();
      await tester.pump();
      await tester.pump();
      expect(app.seenShown.single, ['new']);
      expect(app.newDevices.map((d) => d.pub), ['late']);
    });

    testWidgets('the departed keys the listing read are handed over, so a banner that still names one does not mark it seen', (tester) async {
      app = FakeDevicesApp()
        ..devices = AccountDevices(devices: [fakeDevice('me', self: true)], departed: ['gone'])
        ..newDevices.add(const NewDeviceNotice(pub: 'gone', label: 'G', kind: 'viewer'));
      tester.view.physicalSize = const Size(1200, 1600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: AccountDevicesSection(notifier: app))));
      await tester.pump();
      await tester.pump();
      expect(app.seenDeparted.single, ['gone']);
    });

    testWidgets('Trust again is confirmed with the destructive (red) button, like Remove', (tester) async {
      await open(tester, AccountDevices(devices: [fakeDevice('me', self: true)], frozenReason: 'fork'));
      app.previews.add(const DevicesRebaseline(added: ['iPad'], removed: [], head: DevLogHead(7, 'h7')));
      await tester.tap(find.text('Review…'));
      await tester.pump();
      await tester.pump();
      final confirm = tester.widget<FilledButton>(find.byKey(const Key('account-device-confirm')));
      expect(confirm.style?.backgroundColor?.resolve(const {}), grid.AppPalette.dangerFill);
    });

    testWidgets('the OTHER_ACCOUNT message is the warning amber', (tester) async {
      await open(tester, AccountDevices(devices: [fakeDevice('me', self: true)], frozenReason: 'invalid'));
      app.previews.add(const DevicesRebaseline.otherAccount());
      await tester.tap(find.text('Review…'));
      await tester.pump();
      await tester.pump();
      final text = tester.widget<Text>(find.text(otherAccountMessage));
      expect(text.style?.color, grid.AppPalette.warn);
    });

    testWidgets('History… opens the history; a daemon that predates it gets the update hint instead', (tester) async {
      await open(tester, AccountDevices(devices: [fakeDevice('me', self: true)]));
      expect(find.byKey(const Key('account-devices-history-hint')), findsNothing);
      expect(find.text('History…'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      await open(tester, AccountDevices(devices: [fakeDevice('me', self: true)], historyAvailable: false));
      expect(find.text('History…'), findsNothing);
      expect(find.text('Update Harness on this computer to see history.'), findsOneWidget);
    });
  });
}
