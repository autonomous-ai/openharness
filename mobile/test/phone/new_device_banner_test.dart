import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/device_detail_page.dart';
import 'package:harness_mobile/phone/device_history_page.dart';
import 'package:harness_mobile/phone/devices_page.dart';
import 'package:harness_mobile/phone/new_device_banner.dart';

import 'package:harness_mobile/viewer/device_log_sync.dart';

import 'devices_fixture.dart';

/// "New device: X" — Review goes to that device when there is one, to the list when there are more.
void main() {
  late DevicesApp app;
  final nav = GlobalKey<NavigatorState>();

  setUp(() => app = DevicesApp());
  tearDown(() => app.dispose());

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        home: Scaffold(
          body: ListenableBuilder(
            listenable: app,
            builder: (_, _) => NewDeviceBanner(notifier: app, navigator: nav),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('one new device: Review opens its page, as new, with its whole '
      'code; the sentence has no code', (tester) async {
    final m = member(
      pubOf(7),
      label: 'iPad',
      addedAt: DateTime.now()
          .subtract(const Duration(hours: 1))
          .millisecondsSinceEpoch,
    );
    // The page is the log's own row, read when Review is tapped.
    app
      ..rows = [row(m, pending: true)]
      ..newDevices.add(m);
    await pump(tester);
    expect(find.text('New device: iPad'), findsOneWidget);
    expect(find.textContaining('·'), findsNothing);

    await tester.tap(find.text('Review'));
    await tester.pumpAndSettle();

    final page = tester.widget<DeviceDetailPage>(find.byType(DeviceDetailPage));
    expect(page.row.member.pub, m.pub);
    expect(page.isNew, isTrue);
    expect(find.text(fpOf(m.pub)), findsOneWidget);
    expect(find.text('Added'), findsOneWidget);
    expect(find.byKey(const Key('device-detail-mine')), findsOneWidget);
    expect(find.byType(DevicesPage), findsNothing);
  });

  testWidgets('two new devices: Review opens the list, the newest on top', (
    tester,
  ) async {
    final now = DateTime.now();
    final older = member(
      pubOf(7),
      label: 'iPad',
      addedAt: now.subtract(const Duration(hours: 5)).millisecondsSinceEpoch,
    );
    final newer = member(
      pubOf(8),
      label: 'Pixel',
      addedAt: now.subtract(const Duration(hours: 1)).millisecondsSinceEpoch,
    );
    app
      ..rows = [row(older), row(newer)]
      ..newDevices.addAll([older, newer]);
    await pump(tester);
    expect(find.text('New device: iPad (+1 more)'), findsOneWidget);

    await tester.tap(find.text('Review'));
    await tester.pumpAndSettle();

    expect(find.byType(DevicesPage), findsOneWidget);
    expect(find.byType(DeviceDetailPage), findsNothing);
    final newerTop = tester.getTopLeft(
      find.byKey(ValueKey('account-device-${newer.pub}')),
    );
    final olderTop = tester.getTopLeft(
      find.byKey(ValueKey('account-device-${older.pub}')),
    );
    expect(newerTop.dy, lessThan(olderTop.dy));
  });

  DeviceRemovalNotice notice({
    bool selfRemoved = false,
    bool signerPending = false,
    String signerLabel = 'Pixel',
  }) => DeviceRemovalNotice(
    pub: pubOf(9),
    label: 'iPad',
    kind: 'viewer',
    fingerprint: 'AAAA·BBBB',
    signer: pubOf(8),
    signerLabel: signerLabel,
    signerFingerprint: 'E2FB·0DF5',
    signerPending: signerPending,
    selfRemoved: selfRemoved,
    at: 0,
  );

  testWidgets('a removal by a known device: Device removed, Got it dismisses', (
    tester,
  ) async {
    app.deviceRemovals.add(notice());
    await pump(tester);
    expect(find.text('Device removed'), findsOneWidget);
    expect(
      find.text('iPad was removed from your account by Pixel.'),
      findsOneWidget,
    );
    expect(find.text('Review'), findsNothing);
    await tester.tap(find.text('Got it'));
    await tester.pumpAndSettle();
    expect(app.deviceRemovals, isEmpty);
    expect(find.text('Device removed'), findsNothing);
  });

  testWidgets('a device that signed out', (tester) async {
    app.deviceRemovals.add(notice(selfRemoved: true));
    await pump(tester);
    expect(find.text('Device signed out'), findsOneWidget);
    expect(find.text('iPad signed out of your account.'), findsOneWidget);
  });

  testWidgets('a removal by a new device: red copy, Review opens that signer', (
    tester,
  ) async {
    final signer = member(pubOf(8), label: 'Pixel', addedAt: 1);
    app
      ..rows = [row(signer, pending: true)]
      ..newDevices.add(signer)
      ..deviceRemovals.add(notice(signerPending: true));
    await pump(tester);
    expect(find.text('Removed by a new device'), findsOneWidget);
    expect(
      find.text(
        'iPad was removed from your account by a new device you haven’t looked at (Pixel · E2FB·0DF5…).',
      ),
      findsOneWidget,
    );
    // The removal band is above the new-device band: its Review is the first.
    await tester.tap(find.text('Review').first);
    await tester.pumpAndSettle();
    final page = tester.widget<DeviceDetailPage>(find.byType(DeviceDetailPage));
    expect(page.row.member.pub, signer.pub);
    expect(page.isNew, isTrue);
    expect(app.deviceRemovals, isEmpty);
  });

  testWidgets('a removal announced while on screen shows up; a device that '
      'signed itself out is never red', (tester) async {
    await pump(tester);
    expect(find.byKey(const Key('device-removed-banner')), findsNothing);
    app.announceDeviceRemoval(notice(selfRemoved: true, signerPending: true));
    await tester.pumpAndSettle();
    expect(find.text('Device signed out'), findsOneWidget);
    expect(find.text('Review'), findsNothing);
  });

  testWidgets('a red removal whose signer is no longer new: Review opens the '
      'list', (tester) async {
    // The signer is still on the account, but nobody has it as news any more.
    app
      ..rows = [row(member(pubOf(8), label: 'Pixel', addedAt: 1))]
      ..deviceRemovals.add(notice(signerPending: true));
    await pump(tester);
    await tester.tap(find.text('Review'));
    await tester.pumpAndSettle();
    expect(find.byType(DeviceDetailPage), findsNothing);
    expect(find.byType(DevicesPage), findsOneWidget);
    expect(app.deviceRemovals, isEmpty);
  });

  testWidgets('two removals: one at a time, with a count', (tester) async {
    app.deviceRemovals
      ..add(notice())
      ..add(
        DeviceRemovalNotice(
          pub: pubOf(10),
          label: 'Mac',
          kind: 'machine',
          fingerprint: '',
          signer: pubOf(8),
          signerLabel: 'Pixel',
          signerFingerprint: '',
          signerPending: false,
          selfRemoved: false,
          at: 0,
        ),
      );
    await pump(tester);
    expect(find.text('Device removed (+1 more)'), findsOneWidget);
    await tester.tap(find.text('Got it'));
    await tester.pumpAndSettle();
    expect(find.text('Device removed'), findsOneWidget);
    expect(
      find.text('Mac was removed from your account by Pixel.'),
      findsOneWidget,
    );
  });

  testWidgets('a removal and a new device share ONE SafeArea: the lower band '
      'is not pushed down by the notch again', (tester) async {
    final m = member(pubOf(7), label: 'iPad', addedAt: 1);
    app
      ..deviceRemovals.add(notice())
      ..newDevices.add(m);
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(padding: const EdgeInsets.only(top: 50)),
          child: child!,
        ),
        home: Scaffold(
          body: ListenableBuilder(
            listenable: app,
            builder: (_, _) => NewDeviceBanner(notifier: app, navigator: nav),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.descendant(
        of: find.byType(NewDeviceBanner),
        matching: find.byType(SafeArea),
      ),
      findsOneWidget,
    );
    final removalBottom = tester
        .getBottomLeft(find.byKey(const Key('device-removed-banner')))
        .dy;
    final newTop = tester
        .getTopLeft(find.byKey(const Key('new-device-banner')))
        .dy;
    // Only the band's own padding (8 + 8) lies between the two texts, not another 50.
    expect(newTop - removalBottom, lessThan(40));
    // And the top band does start below the notch.
    expect(
      tester.getTopLeft(find.byKey(const Key('device-removed-banner'))).dy,
      greaterThanOrEqualTo(50),
    );
  });

  testWidgets(
    'Review opens the log\'s own row: a key a fork suspended says so, '
    'and It\'s mine there lifts it',
    (tester) async {
      final m = member(pubOf(7), label: 'iPad', addedAt: 1);
      app
        ..rows = [row(m, pending: true, suspended: true)]
        ..suspendedNew.add(m.pub)
        ..newDevices.add(m);
      await pump(tester);
      await tester.tap(find.text('Review'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Not trusted here'), findsOneWidget);
      await tester.tap(find.byKey(const Key('device-detail-mine')));
      await tester.pumpAndSettle();
      expect(app.dismissed, [(pub: m.pub, liftSuspension: true)]);
    },
  );

  testWidgets('Mine on a suspended entry opens its page instead of dismissing '
      '(a dismissal could not hold: the next read brings it back)', (
    tester,
  ) async {
    final m = member(pubOf(7), label: 'iPad', addedAt: 1);
    app
      ..rows = [row(m, pending: true, suspended: true)]
      ..suspendedNew.add(m.pub)
      ..newDevices.add(m);
    await pump(tester);
    await tester.tap(find.text('Mine'));
    await tester.pumpAndSettle();

    expect(app.dismissed, isEmpty);
    expect(app.newDevices, [m]);
    final page = tester.widget<DeviceDetailPage>(find.byType(DeviceDetailPage));
    expect(page.row.suspended, isTrue);
    expect(find.textContaining('Not trusted here'), findsOneWidget);
  });

  testWidgets('a red removal\'s Review opens a suspended signer as the log '
      'lists it (Suspended shown)', (tester) async {
    final signer = member(pubOf(8), label: 'Pixel', addedAt: 1);
    app
      ..rows = [row(signer, pending: true, suspended: true)]
      ..newDevices.add(signer)
      ..deviceRemovals.add(notice(signerPending: true));
    await pump(tester);
    await tester.tap(find.text('Review').first);
    await tester.pumpAndSettle();
    final page = tester.widget<DeviceDetailPage>(find.byType(DeviceDetailPage));
    expect(page.row.suspended, isTrue);
    expect(find.textContaining('Not trusted here'), findsOneWidget);
  });

  testWidgets('Mine on the banner keeps a fork suspension (pubs only)', (
    tester,
  ) async {
    final m = member(pubOf(7), label: 'iPad', addedAt: 1);
    app.newDevices.add(m);
    await pump(tester);
    await tester.tap(find.text('Mine'));
    await tester.pumpAndSettle();
    expect(app.dismissed, [(pub: m.pub, liftSuspension: false)]);
    expect(app.newDevices, isEmpty);
  });

  group('a device that joined and left before anyone looked', () {
    testWidgets('self sign-out: the sentence alone, neutral; Got it saves the '
        'dismissal and clears the band', (tester) async {
      // A sign-out is signed by the key itself: no "Removed by".
      app.departedDevices.add(
        departedKey(
          pubOf(5),
          selfRemoved: true,
          removedBy: pubOf(5),
          removedByLabel: 'iPad',
        ),
      );
      await pump(tester);
      expect(
        find.text('iPad joined your account and left before you looked.'),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('device-departed-got-it')));
      await tester.pumpAndSettle();
      expect(app.dismissedDeparted, [pubOf(5)]);
      expect(app.departedDevices, isEmpty);
      expect(find.byKey(const Key('device-departed-banner')), findsNothing);
    });

    testWidgets('removed by another key: names the signer', (tester) async {
      app.departedDevices.add(
        departedKey(pubOf(5), removedBy: pubOf(8), removedByLabel: 'Pixel'),
      );
      await pump(tester);
      expect(
        find.text(
          'iPad joined your account and left before you looked. Removed by Pixel.',
        ),
        findsOneWidget,
      );
      // Its signer is a known device: not red.
      expect(app.departedRed(app.departedDevices.single), isFalse);
    });

    testWidgets('a signer with no name is "another device"; no label is '
        '"A device"', (tester) async {
      app.departedDevices.add(
        departedKey(pubOf(5), label: '', removedBy: pubOf(8)),
      );
      await pump(tester);
      expect(
        find.text(
          'A device joined your account and left before you looked. '
          'Removed by another device.',
        ),
        findsOneWidget,
      );
    });

    test('red only when the removing key is itself new or departed; a '
        'sign-out never is', () {
      final signer = member(pubOf(8), label: 'Pixel', addedAt: 1);
      final byNew = departedKey(pubOf(5), removedBy: pubOf(8));
      final bySelf = departedKey(
        pubOf(5),
        selfRemoved: true,
        removedBy: pubOf(8),
      );
      expect(app.departedRed(byNew), isFalse);
      app.newDevices.add(signer);
      expect(app.departedRed(byNew), isTrue);
      expect(app.departedRed(bySelf), isFalse);
      app.newDevices.clear();
      app.departedDevices.add(departedKey(pubOf(8), selfRemoved: true));
      expect(app.departedRed(byNew), isTrue);
    });

    testWidgets('the band is red when its signer is itself new, neutral '
        'otherwise', (tester) async {
      Color bandColor() => tester
          .widget<Material>(
            find
                .ancestor(
                  of: find.byKey(const Key('device-departed-banner')),
                  matching: find.byType(Material),
                )
                .first,
          )
          .color!;
      app.departedDevices.add(
        departedKey(pubOf(5), removedBy: pubOf(8), removedByLabel: 'Pixel'),
      );
      await pump(tester);
      final neutral = bandColor();
      app.newDevices.add(member(pubOf(8), label: 'Pixel', addedAt: 1));
      app.poke();
      await tester.pumpAndSettle();
      expect(bandColor(), isNot(neutral));
      // Said in words as well, as the desktop says it — not by the colour alone.
      expect(
        find.text(
          'iPad joined your account and left before you looked. '
          'Removed by Pixel, a new device you haven’t looked at.',
        ),
        findsOneWidget,
      );
    });

    testWidgets('History opens the History and leaves the band', (
      tester,
    ) async {
      app.departedDevices.add(departedKey(pubOf(5), selfRemoved: true));
      await pump(tester);
      await tester.tap(find.byKey(const Key('device-departed-review')));
      await tester.pumpAndSettle();
      expect(find.byType(DeviceHistoryPage), findsOneWidget);
      expect(app.dismissedDeparted, isEmpty);
      expect(app.departedDevices, hasLength(1));
    });

    testWidgets('a signed-out notice and the departed mark for the same key '
        'are one ghost: only the departed band shows', (tester) async {
      app
        ..departedDevices.add(departedKey(pubOf(9), selfRemoved: true))
        ..deviceRemovals.add(notice(selfRemoved: true));
      await pump(tester);
      expect(find.byKey(const Key('device-departed-banner')), findsOneWidget);
      expect(find.byKey(const Key('device-removed-banner')), findsNothing);
      expect(find.text('Device signed out'), findsNothing);
      expect(find.text('iPad signed out of your account.'), findsNothing);
      // One Got it, the departed band's: it is the one dismissal.
      expect(find.text('Got it'), findsOneWidget);
      await tester.tap(find.byKey(const Key('device-departed-got-it')));
      await tester.pumpAndSettle();
      expect(app.dismissedDeparted, [pubOf(9)]);
      // Neither band comes back: the notice does not surface once the mark is gone.
      expect(app.deviceRemovals, isEmpty);
      expect(find.byKey(const Key('device-departed-banner')), findsNothing);
      expect(find.byKey(const Key('device-removed-banner')), findsNothing);
      expect(find.text('Device signed out'), findsNothing);
    });

    testWidgets('a signed-out notice for ANOTHER key still shows beside the '
        'departed band', (tester) async {
      app
        ..departedDevices.add(departedKey(pubOf(5), selfRemoved: true))
        ..deviceRemovals.add(notice(selfRemoved: true));
      await pump(tester);
      expect(find.byKey(const Key('device-departed-banner')), findsOneWidget);
      expect(find.text('Device signed out'), findsOneWidget);
    });

    testWidgets('a removal BY another key of a departed key keeps both bands '
        '(it is not one ghost: someone else did it)', (tester) async {
      app
        ..departedDevices.add(departedKey(pubOf(9), removedBy: pubOf(8)))
        ..deviceRemovals.add(notice());
      await pump(tester);
      expect(find.byKey(const Key('device-departed-banner')), findsOneWidget);
      expect(find.text('Device removed'), findsOneWidget);
      // Each band has its own Got it: the departed one leaves the removal notice up.
      await tester.tap(find.byKey(const Key('device-departed-got-it')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('device-departed-banner')), findsNothing);
      expect(app.deviceRemovals, hasLength(1));
      expect(find.text('Device removed'), findsOneWidget);
    });

    testWidgets('the suppressed notice still counts the banner as showing '
        '(the departed band is on screen, so the status-bar inset is taken)', (
      tester,
    ) async {
      app
        ..deviceRemovals.add(notice(selfRemoved: true))
        ..departedDevices.add(departedKey(pubOf(9), selfRemoved: true));
      expect(NewDeviceBanner.removalsShown(app), isEmpty);
      expect(NewDeviceBanner.showing(app), isTrue);
    });

    testWidgets('a red removal\'s Review does not clear the departed mark of '
        'the same device', (tester) async {
      final signer = member(pubOf(8), label: 'Pixel', addedAt: 1);
      app
        ..rows = [row(signer, pending: true)]
        ..newDevices.add(signer)
        ..departedDevices.add(departedKey(pubOf(9), removedBy: pubOf(8)))
        ..deviceRemovals.add(notice(signerPending: true));
      await pump(tester);
      await tester.tap(find.text('Review').first);
      await tester.pumpAndSettle();
      expect(app.deviceRemovals, isEmpty);
      expect(app.dismissedDeparted, isEmpty);
      expect(app.departedDevices, hasLength(1));
    });

    testWidgets('two: one at a time, with a count; Got it clears every one it '
        'counts, each dismissal saved', (tester) async {
      app.departedDevices
        ..add(departedKey(pubOf(5), selfRemoved: true))
        ..add(departedKey(pubOf(6), label: 'Mac', selfRemoved: true));
      await pump(tester);
      expect(
        find.text(
          'iPad joined your account and left before you looked. (+1 more)',
        ),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('device-departed-got-it')));
      await tester.pumpAndSettle();
      expect(app.dismissedDeparted, [pubOf(5), pubOf(6)]);
      expect(app.departedDevices, isEmpty);
      expect(find.byKey(const Key('device-departed-banner')), findsNothing);
    });

    testWidgets('a departed key with no recorded signer (it left in a review) '
        'says no one removed it', (tester) async {
      app.departedDevices.add(departedKey(pubOf(5)));
      await pump(tester);
      expect(
        find.text('iPad joined your account and left before you looked.'),
        findsOneWidget,
      );
      expect(find.textContaining('Removed by'), findsNothing);
    });

    testWidgets('its button is labelled History, where it opens', (
      tester,
    ) async {
      app.departedDevices.add(departedKey(pubOf(5), selfRemoved: true));
      await pump(tester);
      expect(
        find.descendant(
          of: find.byKey(const Key('device-departed-review')),
          matching: find.text('History'),
        ),
        findsOneWidget,
      );
    });
  });

  group('what the bands lead with', () {
    Color bandColor(WidgetTester tester, Key inner) => tester
        .widget<Material>(
          find
              .ancestor(of: find.byKey(inner), matching: find.byType(Material))
              .first,
        )
        .color!;

    DeviceRemovalNotice removal(
      int n, {
      bool signerPending = false,
      String label = 'iPad',
    }) => DeviceRemovalNotice(
      pub: pubOf(n),
      label: label,
      kind: 'viewer',
      fingerprint: '',
      signer: pubOf(8),
      signerLabel: 'Pixel',
      signerFingerprint: '',
      signerPending: signerPending,
      selfRemoved: false,
      at: 0,
    );

    testWidgets('a removal by a new device is shown first, red, though an '
        'older neutral one is queued ahead of it', (tester) async {
      app.deviceRemovals
        ..add(removal(9, label: 'Mac'))
        ..add(removal(10, signerPending: true, label: 'Evil'));
      await pump(tester);
      expect(find.text('Removed by a new device (+1 more)'), findsOneWidget);
      expect(find.text('Device removed (+1 more)'), findsNothing);
      expect(find.text('Review'), findsOneWidget);
      // Got it dismisses the one shown, not the one behind it.
      await tester.tap(find.text('Got it'));
      await tester.pumpAndSettle();
      expect(app.deviceRemovals.map((r) => r.pub), [pubOf(9)]);
      expect(find.text('Device removed'), findsOneWidget);
    });

    testWidgets('a departed key removed by a new device is shown first and '
        'red, ahead of an older neutral one', (tester) async {
      final signer = member(pubOf(8), label: 'Pixel', addedAt: 1);
      app.departedDevices.add(
        departedKey(pubOf(6), label: 'Mac', selfRemoved: true),
      );
      await pump(tester);
      final neutral = bandColor(tester, const Key('device-departed-banner'));
      app
        ..newDevices.add(signer)
        ..departedDevices.add(
          departedKey(pubOf(5), removedBy: pubOf(8), removedByLabel: 'Pixel'),
        )
        ..poke();
      await tester.pumpAndSettle();
      expect(
        find.text(
          'iPad joined your account and left before you looked. '
          'Removed by Pixel, a new device you haven’t looked at. (+1 more)',
        ),
        findsOneWidget,
      );
      expect(
        bandColor(tester, const Key('device-departed-banner')),
        isNot(neutral),
      );
    });

    testWidgets('Got it clears the keys the band counted when it was built, '
        'not one that arrived after', (tester) async {
      app.departedDevices.add(departedKey(pubOf(5), selfRemoved: true));
      await pump(tester);
      // Arrives without a rebuild: never drawn, so never dismissed.
      app.departedDevices.add(
        departedKey(pubOf(6), label: 'Mac', selfRemoved: true),
      );
      await tester.tap(find.byKey(const Key('device-departed-got-it')));
      await tester.pumpAndSettle();
      expect(app.dismissedDeparted, [pubOf(5)]);
      expect(app.departedDevices.map((d) => d.pub), [pubOf(6)]);
      expect(
        find.text('Mac joined your account and left before you looked.'),
        findsOneWidget,
      );
    });

    testWidgets('bands stack in one order: removal, departed, new device', (
      tester,
    ) async {
      app
        ..deviceRemovals.add(removal(9))
        ..departedDevices.add(departedKey(pubOf(5), selfRemoved: true))
        ..newDevices.add(member(pubOf(7), label: 'iPad', addedAt: 1));
      await pump(tester);
      double top(Key k) => tester.getTopLeft(find.byKey(k)).dy;
      expect(
        top(const Key('device-removed-banner')),
        lessThan(top(const Key('device-departed-banner'))),
      );
      expect(
        top(const Key('device-departed-banner')),
        lessThan(top(const Key('new-device-banner'))),
      );
    });

    testWidgets('the new-device sentence wraps beside Mine and Review: '
        '"(+N more)" is not clipped', (tester) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      app.newDevices.addAll([
        member(pubOf(7), label: 'Evil Phone', addedAt: 1),
        member(pubOf(8), label: 'Pixel', addedAt: 2),
        member(pubOf(9), label: 'Mac', addedAt: 3),
      ]);
      await pump(tester);
      final text = find.byKey(const Key('new-device-banner'));
      final widget = tester.widget<Text>(text);
      expect(widget.maxLines, isNull);
      expect(widget.softWrap, isNot(false));
      expect(widget.overflow, isNot(TextOverflow.clip));
      expect(tester.takeException(), isNull);
      // It has the room left of the buttons, and is taller than one line.
      expect(
        tester.getRect(text).right,
        lessThanOrEqualTo(tester.getRect(find.text('Mine')).left),
      );
      expect(find.textContaining('(+2 more)'), findsOneWidget);
    });
  });
}
