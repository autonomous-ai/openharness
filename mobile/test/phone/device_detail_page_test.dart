import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/relative_time.dart';
import 'package:harness_mobile/phone/device_detail_page.dart';
import 'package:harness_mobile/phone/fingerprint_text.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';

import 'devices_fixture.dart';

/// One device in full on the phone: what it is, its whole key code to compare, and what to do.
void main() {
  late List<String?> clipboard;

  setUp(() {
    clipboard = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') {
            clipboard.add((call.arguments as Map)['text'] as String?);
          }
          return null;
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  final addedAt = DateTime(2026, 9, 3, 9, 7);

  DeviceLogRow computer({bool self = false}) => row(
    member(
      pubOf(1),
      label: 'mbp',
      kind: 'machine',
      machineId: 'abcdef1234567890',
      addedAt: addedAt.millisecondsSinceEpoch,
    ),
    self: self,
  );

  DeviceLogRow app() => row(
    member(pubOf(2), label: 'iPad', addedAt: addedAt.millisecondsSinceEpoch),
  );

  /// The detail pushed over a page with an "Opened" marker, so a pop is something to see.
  Future<void> pump(
    WidgetTester tester,
    DevicesApp notifier,
    DeviceLogRow row, {
    int? lastSeen,
    bool isNew = false,
    VoidCallback? onMine,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => DeviceDetailPage(
                    notifier: notifier,
                    row: row,
                    lastSeen: lastSeen,
                    isNew: isNew,
                    onMine: onMine,
                  ),
                ),
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
  }

  testWidgets('a computer: its facts, its whole key code, and how to check it '
      'there', (tester) async {
    final notifier = DevicesApp();
    addTearDown(notifier.dispose);
    final r = computer();
    final seen = DateTime.now().subtract(const Duration(days: 2));
    await pump(tester, notifier, r, lastSeen: seen.millisecondsSinceEpoch);

    expect(find.text('mbp'), findsOneWidget);
    expect(find.text('Computer'), findsOneWidget);
    expect(find.text(fullDateTime(addedAt)), findsOneWidget);
    expect(find.text('3 Sep 2026, 09:07'), findsOneWidget);
    expect(find.text('Last active'), findsOneWidget);
    expect(find.text('2 days ago'), findsOneWidget);
    expect(find.text('Machine'), findsOneWidget);
    expect(find.text('abcdef12'), findsOneWidget);
    expect(find.text(r.fingerprint), findsOneWidget);
    expect(
      find.text(
        'This device’s own key code. Open Your devices on that computer — the code under '
        '“This device” must match — or run harness status on it.',
      ),
      findsOneWidget,
    );
    expect(find.byKey(const Key('device-detail-mine')), findsNothing);
    expect(find.byKey(const Key('device-detail-remove')), findsOneWidget);
  });

  testWidgets('an app: no machine row, no last active when never seen, and the '
      'app wording', (tester) async {
    final notifier = DevicesApp();
    addTearDown(notifier.dispose);
    await pump(tester, notifier, app());

    expect(find.text('App'), findsOneWidget);
    expect(find.text('Added'), findsOneWidget);
    expect(find.text('Last active'), findsNothing);
    expect(find.text('Machine'), findsNothing);
    expect(
      find.text(
        'This device’s own key code. Open Your devices on that device — the code under '
        '“This device” must match.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('Copy puts the exact key code on the clipboard and says Copied '
      'for two seconds; a reader hears it letter by letter', (tester) async {
    final notifier = DevicesApp();
    addTearDown(notifier.dispose);
    final r = app();
    await pump(tester, notifier, r);

    final handle = tester.ensureSemantics();
    expect(find.bySemanticsLabel(fingerprintSpoken(r.fingerprint)), findsOne);
    final groups = r.fingerprint.split('·');
    expect(
      fingerprintSpoken(r.fingerprint),
      'Key code ${groups.map((g) => g.split('').join(' ')).join(', ')}',
    );
    handle.dispose();

    await tester.tap(find.byKey(const Key('device-detail-copy')));
    await tester.pump();
    expect(clipboard, [r.fingerprint]);
    expect(r.fingerprint, contains('·'));
    expect(find.text('Copied'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1900));
    expect(find.text('Copied'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('Copied'), findsNothing);
    expect(find.text('Copy'), findsOneWidget);
  });

  test('fingerprintSpoken spells each group', () {
    expect(
      fingerprintSpoken('E2FB·0DF5·5FD8·E6C7'),
      'Key code E 2 F B, 0 D F 5, 5 F D 8, E 6 C 7',
    );
  });

  testWidgets('It’s mine dismisses the notice, tells the opener, and closes', (
    tester,
  ) async {
    final notifier = DevicesApp();
    addTearDown(notifier.dispose);
    final r = app();
    notifier.newDevices.add(r.member);
    var mine = 0;
    await pump(tester, notifier, r, isNew: true, onMine: () => mine++);

    await tester.tap(find.byKey(const Key('device-detail-mine')));
    await tester.pumpAndSettle();

    expect(notifier.newDevices, isEmpty);
    // Nothing on this page said the key was suspended: "mine" vouches for nothing it did not show.
    expect(notifier.dismissed, [(pub: r.member.pub, liftSuspension: false)]);
    expect(mine, 1);
    expect(find.byType(DeviceDetailPage), findsNothing);
    expect(notifier.removed, isEmpty);
  });

  testWidgets('It’s mine lifts a fork suspension only when the page shows it', (
    tester,
  ) async {
    final notifier = DevicesApp();
    addTearDown(notifier.dispose);
    final r = DeviceLogRow(
      app().member,
      fingerprint: app().fingerprint,
      self: false,
      pending: true,
      suspended: true,
    );
    notifier.newDevices.add(r.member);
    await pump(tester, notifier, r, isNew: true);
    expect(find.textContaining('Not trusted here'), findsOneWidget);

    await tester.tap(find.byKey(const Key('device-detail-mine')));
    await tester.pumpAndSettle();

    expect(notifier.dismissed, [(pub: r.member.pub, liftSuspension: true)]);
  });

  testWidgets('Remove asks first; backing out removes nothing', (tester) async {
    final notifier = DevicesApp();
    addTearDown(notifier.dispose);
    await pump(tester, notifier, app());

    await tester.tap(find.byKey(const Key('device-detail-remove')));
    await tester.pumpAndSettle();
    expect(find.text('Remove iPad?'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(notifier.removed, isEmpty);
    expect(find.byType(DeviceDetailPage), findsOneWidget);
  });

  testWidgets('confirming Remove removes that device and closes', (
    tester,
  ) async {
    final notifier = DevicesApp();
    addTearDown(notifier.dispose);
    final r = app();
    await pump(tester, notifier, r);

    await tester.tap(find.byKey(const Key('device-detail-remove')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
    await tester.pumpAndSettle();

    expect(notifier.removed, [r.member.pub]);
    expect(find.byType(DeviceDetailPage), findsNothing);
  });

  testWidgets('while a removal is in flight the row says Removing… and takes '
      'no second tap', (tester) async {
    final notifier = DevicesApp()..removeGate = Completer<void>();
    addTearDown(notifier.dispose);
    final r = app();
    await pump(tester, notifier, r, isNew: true);

    await tester.tap(find.byKey(const Key('device-detail-remove')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
    await tester.pumpAndSettle();
    expect(find.text('Removing…'), findsOneWidget);
    await tester.tap(find.byKey(const Key('device-detail-remove')));
    await tester.tap(find.byKey(const Key('device-detail-mine')));
    await tester.pumpAndSettle();
    expect(find.text('Remove iPad?'), findsNothing);
    expect(notifier.removed, [r.member.pub]);

    notifier.removeGate!.complete();
    await tester.pumpAndSettle();
    expect(find.byType(DeviceDetailPage), findsNothing);
  });

  testWidgets('a Remove that fails stays open and says so', (tester) async {
    final notifier = DevicesApp()..removeError = 'UNAVAILABLE';
    addTearDown(notifier.dispose);
    await pump(tester, notifier, app());

    await tester.tap(find.byKey(const Key('device-detail-remove')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
    await tester.pumpAndSettle();

    expect(find.byType(DeviceDetailPage), findsOneWidget);
    expect(find.text('Couldn’t remove iPad. Try again.'), findsOneWidget);
    expect(find.text('Remove this device'), findsOneWidget);
    // A failure is red (only advice — another account, a list that moved — is amber).
    final message = find.text('Couldn’t remove iPad. Try again.');
    expect(
      tester.widget<Text>(message).style!.color,
      Tty.of(tester.element(message)).red,
    );
  });

  testWidgets('this phone itself has no Remove and no It’s mine', (
    tester,
  ) async {
    final notifier = DevicesApp();
    addTearDown(notifier.dispose);
    await pump(tester, notifier, computer(self: true));

    expect(find.byKey(const Key('device-detail-remove')), findsNothing);
    expect(find.byKey(const Key('device-detail-mine')), findsNothing);
  });
}
