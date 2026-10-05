import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/device_detail_page.dart';
import 'package:harness_mobile/phone/device_history_page.dart';
import 'package:harness_mobile/phone/devices_page.dart';
import 'package:harness_mobile/phone/settings_row.dart';
import 'package:harness_mobile/phone/tty.dart';

import 'package:harness_mobile/viewer/device_history.dart';
import 'package:harness_mobile/viewer/device_log.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';

import 'devices_fixture.dart';

/// Settings ▸ Your devices on the phone: this phone's own code on a card, then the other devices —
/// new ones on top — with no key code in a row unless two rows share a name.
void main() {
  final fullCode = RegExp(r'[0-9A-F]{4}·[0-9A-F]{4}');
  int ago(Duration d) => DateTime.now().subtract(d).millisecondsSinceEpoch;

  late DevicesApp app;
  late String selfPub, oldPub, newPub, twinPub;

  setUp(() {
    selfPub = pubOf(0);
    oldPub = pubOf(1);
    newPub = pubOf(2);
    twinPub = pubOf(3);
    app = DevicesApp(
      rows: [
        row(
          member(
            selfPub,
            label: 'My iPhone',
            addedAt: ago(const Duration(days: 200)),
          ),
          self: true,
        ),
        row(
          member(
            oldPub,
            label: 'mbp',
            kind: 'machine',
            machineId: 'abcdef1234',
            addedAt: ago(const Duration(days: 100)),
          ),
        ),
        row(
          member(newPub, label: 'iPad', addedAt: ago(const Duration(days: 30))),
        ),
        // Shares this phone's name: its row has to say which one it is.
        row(
          member(
            twinPub,
            label: 'My iPhone',
            addedAt: ago(const Duration(days: 150)),
          ),
        ),
      ],
      seen: {
        oldPub: ago(const Duration(minutes: 2)),
        twinPub: ago(const Duration(days: 3)),
      },
    );
    app.newDevices.add(app.rows[2].member);
  });

  tearDown(() => app.dispose());

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(home: DevicesPage(notifier: app)));
    await tester.pumpAndSettle();
  }

  List<String> rowOrder(WidgetTester tester) => [
    for (final r in tester.widgetList<SettingsRow>(
      find.byWidgetPredicate(
        (w) =>
            w is SettingsRow &&
            w.key is ValueKey<String> &&
            (w.key! as ValueKey<String>).value.startsWith('account-device-'),
      ),
    ))
      (r.key! as ValueKey<String>).value.substring('account-device-'.length),
  ];

  SettingsRow rowFor(WidgetTester tester, String pub) =>
      tester.widget<SettingsRow>(find.byKey(ValueKey('account-device-$pub')));

  testWidgets('this phone is a card with its whole code, copyable, and is not '
      'listed again', (tester) async {
    await pump(tester);
    final card = find.byKey(const Key('account-device-this'));
    expect(card, findsOneWidget);
    expect(
      find.descendant(of: card, matching: find.text('This device · My iPhone')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: card, matching: find.text(fpOf(selfPub))),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: card,
        matching: find.text(
          'This is the code your other devices show for this device.',
        ),
      ),
      findsOneWidget,
    );
    expect(find.byKey(const Key('this-device-copy')), findsOneWidget);
    expect(find.byKey(ValueKey('account-device-$selfPub')), findsNothing);
  });

  testWidgets('no row holds a whole key code; a shared name shows only the '
      'first group', (tester) async {
    await pump(tester);
    for (final pub in [oldPub, newPub, twinPub]) {
      final r = rowFor(tester, pub);
      expect(r.title, isNot(contains(fullCode)));
      expect(r.detail, isNot(contains(fullCode)));
      expect(r.detail, isNot(contains(RegExp(r'\d{4}-\d{2}-\d{2}'))));
    }
    expect(rowFor(tester, oldPub).detail, 'Computer · active now');
    expect(rowFor(tester, newPub).detail, 'App · added 4 weeks ago');
    expect(
      rowFor(tester, twinPub).detail,
      'App · last active 3 days ago · ${fpOf(twinPub).split('·').first}…',
    );
  });

  testWidgets('a new device is on top with New; the rest follow by activity', (
    tester,
  ) async {
    await pump(tester);
    expect(rowOrder(tester), [newPub, oldPub, twinPub]);
    expect(rowFor(tester, newPub).value, 'New');
    expect(rowFor(tester, oldPub).value, isNull);
    expect(rowFor(tester, twinPub).value, isNull);
  });

  testWidgets(
    'opening the list clears the banner, yet New stays for this visit',
    (tester) async {
      expect(app.newDevices, hasLength(1));
      await pump(tester);
      expect(app.newDevices, isEmpty);
      expect(rowFor(tester, newPub).value, 'New');
      expect(rowOrder(tester).first, newPub);
    },
  );

  testWidgets(
    'tapping a row opens that device, Remove lives there, and It’s mine '
    'clears its New',
    (tester) async {
      await pump(tester);
      expect(find.text('Remove'), findsNothing, reason: 'no Remove on a row');

      await tester.tap(find.byKey(ValueKey('account-device-$newPub')));
      await tester.pumpAndSettle();
      final page = tester.widget<DeviceDetailPage>(
        find.byType(DeviceDetailPage),
      );
      expect(page.row.member.pub, newPub);
      expect(page.isNew, isTrue);
      expect(find.text(fpOf(newPub)), findsOneWidget);
      expect(find.byKey(const Key('device-detail-remove')), findsOneWidget);

      await tester.tap(find.byKey(const Key('device-detail-mine')));
      await tester.pumpAndSettle();
      expect(find.byType(DeviceDetailPage), findsNothing);
      expect(rowFor(tester, newPub).value, isNull);
    },
  );

  testWidgets('a device opened and closed without a choice keeps its New', (
    tester,
  ) async {
    await pump(tester);
    await tester.tap(find.byKey(ValueKey('account-device-$newPub')));
    await tester.pumpAndSettle();
    Navigator.of(tester.element(find.byType(DeviceDetailPage))).pop();
    await tester.pumpAndSettle();
    expect(rowFor(tester, newPub).value, 'New');
  });

  testWidgets('a device removed from its page leaves the list', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(ValueKey('account-device-$oldPub')));
    await tester.pumpAndSettle();
    final page = tester.widget<DeviceDetailPage>(find.byType(DeviceDetailPage));
    expect(page.isNew, isFalse);
    expect(page.lastSeen, app.seen[oldPub]);
    await tester.tap(find.byKey(const Key('device-detail-remove')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
    await tester.pumpAndSettle();

    expect(app.removed, [oldPub]);
    expect(find.byType(DeviceDetailPage), findsNothing);
    expect(find.byKey(ValueKey('account-device-$oldPub')), findsNothing);
  });

  testWidgets('no row for this phone: no card', (tester) async {
    app.rows = app.rows.where((r) => !r.self).toList();
    await pump(tester);
    expect(find.byKey(const Key('account-device-this')), findsNothing);
    expect(rowOrder(tester), hasLength(3));
  });

  testWidgets('a pending device from the log shows New though the banner list '
      'is empty, and opening the list marks it seen', (tester) async {
    app.newDevices.clear();
    app.rows = [
      for (final r in app.rows)
        row(r.member, self: r.self, pending: r.member.pub == newPub),
    ];
    await pump(tester);
    expect(rowFor(tester, newPub).value, 'New');
    expect(rowOrder(tester).first, newPub);
    expect(app.seenPending, [
      [newPub],
    ]);
  });

  testWidgets('a suspended device says Suspended, which wins over New', (
    tester,
  ) async {
    app.rows = [
      for (final r in app.rows)
        row(r.member, self: r.self, suspended: r.member.pub == newPub),
    ];
    await pump(tester);
    expect(rowFor(tester, newPub).value, 'Suspended');
    await tester.tap(find.byKey(ValueKey('account-device-$newPub')));
    await tester.pumpAndSettle();
    expect(
      find.textContaining('Not trusted here: added after this device’s list'),
      findsOneWidget,
    );
  });

  testWidgets('"Already on your account" lists what was there before this '
      'device joined, and Got it is persisted once', (tester) async {
    app
      ..baselineSeen = false
      ..joinedSeq = 2;
    app.rows = [
      row(member(selfPub, label: 'My iPhone', addedAt: 1, seq: 3), self: true),
      row(
        member(
          oldPub,
          label: 'mbp',
          kind: 'machine',
          machineId: 'abcdef1234',
          addedAt: 1,
          seq: 1,
        ),
      ),
      row(member(newPub, label: 'iPad', addedAt: 2, seq: 4)),
    ];
    await pump(tester);
    final panel = find.byKey(const Key('account-devices-baseline'));
    expect(panel, findsOneWidget);
    expect(
      find.descendant(
        of: panel,
        matching: find.text('Already on your account'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: panel,
        matching: find.text(
          'These were on your account before this device joined. If one isn’t yours, remove it.',
        ),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: panel,
        matching: find.text('mbp · Computer · ${fpOf(oldPub)}'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(of: panel, matching: find.text('iPad')),
      findsNothing,
    );

    await tester.tap(find.text('Got it'));
    await tester.pumpAndSettle();
    expect(app.baselineSeenCalls, 1);
    expect(panel, findsNothing);
  });

  testWidgets('no baseline panel once it was seen', (tester) async {
    await pump(tester);
    expect(find.byKey(const Key('account-devices-baseline')), findsNothing);
  });

  testWidgets('History opens the history page', (tester) async {
    app.history = DeviceLogHistory(
      rows: [historyRow(2, 'added', newPub, label: 'iPad')],
      complete: true,
    );
    await pump(tester);
    await tester.tap(find.byKey(const Key('account-devices-history')));
    await tester.pumpAndSettle();
    expect(find.byType(DeviceHistoryPage), findsOneWidget);
    expect(find.text('iPad added'), findsOneWidget);
  });

  testWidgets('the baseline panel is the set the listing names, not the seq '
      'rule: a key that came after this phone joined but was already trusted '
      'is on it', (tester) async {
    final lateKey = pubOf(9);
    app
      ..baselineSeen = false
      ..joinedSeq = 2
      ..baseline = [oldPub, lateKey];
    app.rows = [
      ...app.rows,
      row(member(lateKey, label: 'Surface', addedAt: 3, seq: 6)),
    ];
    await pump(tester);
    final panel = find.byKey(const Key('account-devices-baseline'));
    expect(
      find.descendant(of: panel, matching: find.textContaining('Surface')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: panel, matching: find.textContaining('mbp')),
      findsOneWidget,
    );
  });

  group('Trust again', () {
    const head = DevLogHead(7, 'hash-7');
    final preview = DeviceLogRebaseline(head, const [], const []);

    Future<void> openFrozen(WidgetTester tester) async {
      app.frozen = const DeviceLogFreeze('fork', 0, DevLogHead(3, 'h3'));
      await pump(tester);
      await tester.tap(find.text('The device list froze'));
      await tester.pumpAndSettle();
    }

    testWidgets('confirms the list that was previewed (its head)', (
      tester,
    ) async {
      final log = ScriptedDeviceLog()..answers.addAll([preview, preview]);
      app.log = log;
      await openFrozen(tester);
      await tester.tap(find.text('Trust again'));
      await tester.pumpAndSettle();
      expect(log.calls, hasLength(2));
      expect(log.calls[0].confirm, isFalse);
      expect(log.calls[1].confirm, isTrue);
      expect(log.calls[1].expectedHead?.seq, 7);
      expect(log.calls[1].expectedHead?.hash, 'hash-7');
    });

    testWidgets('a list that changed meanwhile says so and is previewed '
        'again', (tester) async {
      // preview, confirm refused (the list moved), preview again.
      final log = ScriptedDeviceLog()
        ..answers.addAll([
          preview,
          const DeviceLogRebaseline.changed(),
          preview,
        ]);
      app.log = log;
      await openFrozen(tester);
      await tester.tap(find.text('Trust again'));
      await tester.pumpAndSettle();
      expect(
        find.text(
          'The device list changed while you were reviewing it. Review it again.',
        ),
        findsOneWidget,
      );
      expect(log.calls.map((c) => c.confirm), [false, true, false]);
      // The second preview is on screen, waiting for a choice.
      expect(find.text('Trust this device list again?'), findsOneWidget);
    });
  });

  group('Trust again on another account\'s list says to sign in again', () {
    const message =
        'The device list now belongs to a different account than the one '
        'you signed in with. Sign in again to switch accounts.';

    Future<ScriptedDeviceLog> trust(
      WidgetTester tester,
      List<DeviceLogRebaseline?> answers,
    ) async {
      final log = ScriptedDeviceLog()..answers.addAll(answers);
      app.log = log;
      app.frozen = const DeviceLogFreeze('invalid', 0, DevLogHead(3, 'h3'));
      await pump(tester);
      await tester.tap(find.text('The device list froze')); // the preview
      await tester.pumpAndSettle();
      if (answers.length > 1) {
        await tester.tap(find.text('Trust again')); // the confirm
        await tester.pumpAndSettle();
      }
      return log;
    }

    testWidgets('at the preview: nothing to confirm', (tester) async {
      final log = await trust(tester, [
        const DeviceLogRebaseline.otherAccount(),
      ]);
      expect(find.text(message), findsOneWidget);
      expect(log.calls.map((c) => c.confirm), [false]);
      expect(find.text('Trust this device list again?'), findsNothing);
    });

    testWidgets('at the confirm: said once, not previewed again', (
      tester,
    ) async {
      final log = await trust(tester, [
        const DeviceLogRebaseline(DevLogHead(7, 'hash-7'), [], []),
        const DeviceLogRebaseline.otherAccount(),
      ]);
      expect(find.text(message), findsOneWidget);
      expect(find.textContaining('changed while you were'), findsNothing);
      expect(log.calls.map((c) => c.confirm), [false, true]);
      expect(find.text('Trust this device list again?'), findsNothing);
    });
  });

  group('error text on a narrow phone', () {
    Future<void> narrow(WidgetTester tester) async {
      tester.view.physicalSize = const Size(360, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
    }

    /// [finder]'s text as it is LAID OUT, not as it is configured: no ellipsis, on more than one line,
    /// every line inside [width], and the last line is the end of [full] (nothing cut off after it).
    void expectLaidOutInFull(
      WidgetTester tester,
      Finder finder,
      String full, {
      required double width,
    }) {
      final text = tester.widget<Text>(finder);
      expect(text.data, full);
      final box = tester.renderObject<RenderParagraph>(finder);
      expect(box.didExceedMaxLines, isFalse, reason: 'cut short by maxLines');
      final boxes = box.getBoxesForSelection(
        TextSelection(baseOffset: 0, extentOffset: full.length),
      );
      final tops = {for (final b in boxes) b.top.round()};
      expect(tops.length, greaterThan(1), reason: 'long enough to wrap');
      expect(tester.getRect(finder).right, lessThanOrEqualTo(width));
      // The paragraph is exactly as tall as the lines it wrapped to — none was dropped.
      final bottom = boxes.map((b) => b.bottom).reduce((a, b) => a > b ? a : b);
      expect(box.size.height, inInclusiveRange(bottom - 0.5, bottom + 3));
      // The point at the end of the last line is the end of the text.
      final last = boxes.last;
      final end = box.getPositionForOffset(Offset(last.right, last.top + 1));
      expect(end.offset, full.length);
    }

    testWidgets('the other-account message wraps whole, in amber', (
      tester,
    ) async {
      await narrow(tester);
      final log = ScriptedDeviceLog()
        ..answers.add(const DeviceLogRebaseline.otherAccount());
      app.log = log;
      app.frozen = const DeviceLogFreeze('invalid', 0, DevLogHead(3, 'h3'));
      await pump(tester);
      await tester.tap(find.text('The device list froze'));
      await tester.pumpAndSettle();
      final finder = find.byKey(const Key('account-devices-error'));
      final text = tester.widget<Text>(finder);
      expect(text.data, otherAccountMessage);
      expect(text.maxLines, isNull);
      expect(text.softWrap, isNot(false));
      final tty = Tty.of(tester.element(finder));
      expect(text.style!.color, tty.yellow);
      // Several lines, none wider than the screen.
      expect(
        tester.getSize(finder).height,
        greaterThan(text.style!.fontSize! * 2),
      );
      expect(tester.getRect(finder).right, lessThanOrEqualTo(360));
    });

    for (final width in [360.0, 390.0]) {
      testWidgets('the other-account message is laid out in full at '
          '${width.toInt()}pt, ending "Sign in again to switch accounts."', (
        tester,
      ) async {
        tester.view.physicalSize = Size(width, 900);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        app
          ..log = (ScriptedDeviceLog()
            ..answers.add(const DeviceLogRebaseline.otherAccount()))
          ..frozen = const DeviceLogFreeze('invalid', 0, DevLogHead(3, 'h3'));
        await pump(tester);
        await tester.tap(find.text('The device list froze'));
        await tester.pumpAndSettle();
        final finder = find.byKey(const Key('account-devices-error'));
        expect(
          otherAccountMessage,
          endsWith('Sign in again to switch accounts.'),
        );
        expectLaidOutInFull(tester, finder, otherAccountMessage, width: width);
      });
    }

    testWidgets('a failure is red and wraps too', (tester) async {
      await narrow(tester);
      final log = ScriptedDeviceLog()..answers.add(null);
      app.log = log;
      app.frozen = const DeviceLogFreeze('invalid', 0, DevLogHead(3, 'h3'));
      await pump(tester);
      await tester.tap(find.text('The device list froze'));
      await tester.pumpAndSettle();
      final finder = find.byKey(const Key('account-devices-error'));
      final text = tester.widget<Text>(finder);
      expect(text.maxLines, isNull);
      expect(text.style!.color, Tty.of(tester.element(finder)).red);
    });

    testWidgets('the list-moved message is amber', (tester) async {
      await narrow(tester);
      const head = DevLogHead(7, 'hash-7');
      final preview = DeviceLogRebaseline(head, const [], const []);
      final log = ScriptedDeviceLog()
        // preview, confirm refused (moved), then the preview it opens again.
        ..answers.addAll([
          preview,
          const DeviceLogRebaseline.changed(),
          preview,
        ]);
      app.log = log;
      app.frozen = const DeviceLogFreeze('fork', 0, DevLogHead(3, 'h3'));
      await pump(tester);
      await tester.tap(find.text('The device list froze'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Trust again'));
      await tester.pumpAndSettle();
      final finder = find.byKey(const Key('account-devices-error'));
      expect(
        tester.widget<Text>(finder).style!.color,
        Tty.of(tester.element(finder)).yellow,
      );
    });

    for (final width in [360.0, 390.0]) {
      testWidgets('the frozen card body is laid out in full at '
          '${width.toInt()}pt: wrapped, not clipped to a line', (tester) async {
        tester.view.physicalSize = Size(width, 900);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        app.frozen = const DeviceLogFreeze('fork', 0, DevLogHead(3, 'h3'));
        await pump(tester);
        expectLaidOutInFull(
          tester,
          find.textContaining('Harness served a list'),
          'Harness served a list that does not match what this phone verified. '
          'No device is added until you review it.',
          width: width,
        );
        // The row grew with its text rather than clipping it.
        final row = find.ancestor(
          of: find.text('The device list froze'),
          matching: find.byType(SettingsRow),
        );
        expect(
          tester.getSize(row).height,
          greaterThan(kSettingsRowHeight + 20),
        );
      });
    }

    testWidgets('the frozen card says all of what it has to say, and the page '
        'subtitle wraps', (tester) async {
      await narrow(tester);
      app.frozen = const DeviceLogFreeze('fork', 0, DevLogHead(3, 'h3'));
      await pump(tester);
      final detail = tester.widget<Text>(
        find.textContaining('Harness served a list'),
      );
      expect(detail.maxLines, isNull);
      final subtitle = tester.widget<Text>(
        find.textContaining('Every computer and app signed in'),
      );
      expect(subtitle.maxLines, isNull);
      expect(subtitle.softWrap, isNot(false));
    });
  });

  testWidgets('a removal of unused apps that fails is red, not amber', (
    tester,
  ) async {
    final stale = pubOf(9);
    app
      ..rows = [
        ...app.rows,
        row(
          member(
            stale,
            label: 'Old browser',
            addedAt: ago(const Duration(days: 300)),
          ),
        ),
      ]
      ..seen = {stale: ago(const Duration(days: 120))}
      ..removeError = 'UNAVAILABLE';
    await pump(tester);
    await tester.tap(find.byKey(const Key('account-devices-unused')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
    await tester.pumpAndSettle();
    final finder = find.byKey(const Key('account-devices-error'));
    expect(find.text('Couldn’t remove 1 of them. Try again.'), findsOneWidget);
    expect(
      tester.widget<Text>(finder).style!.color,
      Tty.of(tester.element(finder)).red,
    );
  });

  testWidgets('Trust again that succeeds clears an earlier error', (
    tester,
  ) async {
    const head = DevLogHead(7, 'hash-7');
    final preview = DeviceLogRebaseline(head, const [], const []);
    // preview, confirm refused (moved), preview again, confirm done.
    final log = ScriptedDeviceLog()
      ..answers.addAll([
        preview,
        const DeviceLogRebaseline.changed(),
        preview,
        preview,
      ]);
    app.log = log;
    app.frozen = const DeviceLogFreeze('fork', 0, DevLogHead(3, 'h3'));
    await pump(tester);
    await tester.tap(find.text('The device list froze'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Trust again'));
    await tester.pumpAndSettle();
    expect(find.textContaining('changed while you were'), findsOneWidget);
    await tester.tap(find.text('Trust again'));
    await tester.pumpAndSettle();
    expect(find.textContaining('changed while you were'), findsNothing);
    expect(log.calls.map((c) => c.confirm), [false, true, false, true]);
  });

  testWidgets('Trust again that cannot be confirmed (unreadable, not moved) '
      'says to try later and does not preview again', (tester) async {
    const head = DevLogHead(7, 'hash-7');
    // preview, then a confirm that could not read the list at all.
    final log = ScriptedDeviceLog()
      ..answers.addAll([DeviceLogRebaseline(head, const [], const []), null]);
    app.log = log;
    app.frozen = const DeviceLogFreeze('fork', 0, DevLogHead(3, 'h3'));
    await pump(tester);
    await tester.tap(find.text('The device list froze'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Trust again'));
    await tester.pumpAndSettle();
    expect(
      find.text('Couldn’t trust the device list again. Try again later.'),
      findsOneWidget,
    );
    expect(find.textContaining('changed while you were'), findsNothing);
    expect(log.calls.map((c) => c.confirm), [false, true]);
  });

  testWidgets('opening the list dismisses the banner as it was when the list '
      'was read, not a device announced during the last-seen read', (
    tester,
  ) async {
    final shownPub = app.newDevices.single.pub;
    final lateKey = pubOf(11);
    app.seenGate = Completer<void>();
    await pump(tester);
    app.newDevices.add(member(lateKey, label: 'Late', addedAt: 5, seq: 9));
    app.seenGate!.complete();
    await tester.pumpAndSettle();
    expect(app.seenShown.single, [shownPub]);
    expect(app.newDevices.map((d) => d.pub), [lateKey]);
  });

  testWidgets('opening the list does not mark a departed key the banner '
      'still names (the app has not read it as departed yet)', (tester) async {
    final shownPub = app.newDevices.single.pub;
    final gone = pubOf(12);
    app.newDevices.add(member(gone, label: 'Gone', addedAt: 5, seq: 9));
    app.departed = [departedKey(gone)];
    await pump(tester);
    await tester.pumpAndSettle();
    expect(app.seenShown.single, [shownPub]);
    expect(app.seenPending.single, isNot(contains(gone)));
  });

  testWidgets('Got it that cannot be saved does not throw', (tester) async {
    app
      ..baselineSeen = false
      ..joinedSeq = 2;
    app.rows = [...app.rows];
    app.log = ScriptedDeviceLog()..seeBaselineThrows = true;
    await pump(tester);
    await tester.tap(find.text('Got it'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    // Hidden anyway: it was read.
    expect(find.byKey(const Key('account-devices-baseline')), findsNothing);
  });
}
