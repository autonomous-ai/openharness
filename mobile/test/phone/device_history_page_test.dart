import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/device_detail_page.dart';
import 'package:harness_mobile/phone/device_history_page.dart';
import 'package:harness_mobile/phone/devices_page.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/viewer/device_history.dart';

import 'devices_fixture.dart';

/// Settings ▸ Your devices ▸ History: every add and remove, newest first, in the app's own words.
void main() {
  late DevicesApp app;
  late String selfPub, ipadPub, gonePub;
  final at = DateTime(2026, 10, 1, 14, 5).millisecondsSinceEpoch;

  setUp(() {
    selfPub = pubOf(0);
    ipadPub = pubOf(1);
    gonePub = pubOf(2);
    app = DevicesApp(
      rows: [
        row(member(selfPub, label: 'My iPhone', addedAt: at), self: true),
        row(member(ipadPub, label: 'iPad', addedAt: at), pending: true),
      ],
    );
  });
  tearDown(() => app.dispose());

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(home: DeviceHistoryPage(notifier: app)),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('rows read as sentences, newest first, with New and (this '
      'device)', (tester) async {
    app.history = DeviceLogHistory(
      rows: [
        historyRow(5, 'added', ipadPub, label: 'iPad', pending: true, at: at),
        historyRow(
          4,
          'removed',
          gonePub,
          label: 'Pixel',
          active: false,
          at: at,
          by: DevLogHistoryBy(
            pub: selfPub,
            label: 'My iPhone',
            fingerprint: '',
          ),
        ),
        historyRow(3, 'signedOut', gonePub, label: 'Old Mac', active: false),
        historyRow(
          2,
          'renamed',
          ipadPub,
          label: 'iPad Pro',
          previousLabel: 'iPad',
        ),
        historyRow(1, 'added', selfPub, label: 'My iPhone', thisDevice: true),
      ],
      complete: true,
    );
    await pump(tester);
    expect(find.text('Device history'), findsOneWidget);
    expect(
      find.text(
        'Every device added to or removed from your account, newest first, as this device verified it.',
      ),
      findsOneWidget,
    );
    expect(find.text('iPad added'), findsOneWidget);
    expect(find.text('Pixel removed by My iPhone'), findsOneWidget);
    expect(find.text('Old Mac signed out'), findsOneWidget);
    expect(find.text('iPad renamed to iPad Pro'), findsOneWidget);
    expect(find.text('My iPhone added (this device)'), findsOneWidget);
    expect(find.text('New'), findsOneWidget);
    expect(find.byKey(const Key('device-history-incomplete')), findsNothing);
    final top = tester.getTopLeft(
      find.byKey(const ValueKey('device-history-5')),
    );
    final bottom = tester.getTopLeft(
      find.byKey(const ValueKey('device-history-1')),
    );
    expect(top.dy, lessThan(bottom.dy));
  });

  testWidgets('a frozen-time removal says so; incomplete says older history '
      'needs a connection', (tester) async {
    app.history = DeviceLogHistory(
      rows: [
        historyRow(
          4,
          'removed',
          gonePub,
          label: 'Pixel',
          active: false,
          whileFrozen: true,
          by: DevLogHistoryBy(pub: selfPub, label: '', fingerprint: ''),
        ),
      ],
      complete: false,
    );
    await pump(tester);
    expect(
      find.text(
        'Pixel removed by another device · applied while the list was frozen',
      ),
      findsOneWidget,
    );
    expect(find.text('Older history needs a connection.'), findsOneWidget);
  });

  testWidgets('no rows: No history yet.', (tester) async {
    await pump(tester);
    expect(find.text('No history yet.'), findsOneWidget);
  });

  testWidgets('a failed load says so and Try again reloads', (tester) async {
    app.historyError = true;
    await pump(tester);
    expect(find.text('Couldn’t load the history. Try again.'), findsOneWidget);
    // A failure is red.
    final failed = find.byKey(const Key('device-history-failed'));
    expect(
      tester.widget<Text>(failed).style!.color,
      Tty.of(tester.element(failed)).red,
    );
    app
      ..historyError = false
      ..history = DeviceLogHistory(
        rows: [historyRow(2, 'added', ipadPub, label: 'iPad')],
        complete: true,
      );
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('iPad added'), findsOneWidget);
    expect(find.byKey(const Key('device-history-failed')), findsNothing);
  });

  testWidgets('an active device opens its page, as new while pending', (
    tester,
  ) async {
    app.history = DeviceLogHistory(
      rows: [historyRow(2, 'added', ipadPub, label: 'iPad', pending: true)],
      complete: true,
    );
    await pump(tester);
    await tester.tap(find.text('iPad added'));
    await tester.pumpAndSettle();
    final page = tester.widget<DeviceDetailPage>(find.byType(DeviceDetailPage));
    expect(page.row.member.pub, ipadPub);
    expect(page.isNew, isTrue);
  });

  testWidgets('offline and empty: only "Older history needs a connection", '
      'not "No history yet." with it', (tester) async {
    app.history = const DeviceLogHistory(rows: [], complete: false);
    await pump(tester);
    expect(find.text('Older history needs a connection.'), findsOneWidget);
    expect(find.text('No history yet.'), findsNothing);
  });

  testWidgets('a key that left before anyone looked stays flagged on both its '
      'rows; an ordinary removal is not', (tester) async {
    app.history = DeviceLogHistory(
      rows: [
        historyRow(
          4,
          'signedOut',
          gonePub,
          label: 'Pixel',
          active: false,
          pending: true,
        ),
        historyRow(
          3,
          'added',
          gonePub,
          label: 'Pixel',
          active: false,
          pending: true,
        ),
        historyRow(2, 'signedOut', pubOf(3), label: 'Old Mac', active: false),
      ],
      complete: true,
    );
    await pump(tester);
    expect(find.text('Left before you looked'), findsNWidgets(2));
    expect(find.text('New'), findsNothing);
  });

  testWidgets('a device that cannot be listed opens no error: the list is '
      'what is left', (tester) async {
    app.history = DeviceLogHistory(
      rows: [historyRow(2, 'added', ipadPub, label: 'iPad', pending: true)],
      complete: true,
    );
    app.listingFailures = 1;
    await pump(tester);
    await tester.tap(find.text('iPad added'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byType(DeviceDetailPage), findsNothing);
    expect(find.byType(DevicesPage), findsOneWidget);
  });

  testWidgets('the flag sits under the date, so a long sentence keeps the '
      'row\'s width', (tester) async {
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    app.history = DeviceLogHistory(
      rows: [
        historyRow(
          4,
          'signedOut',
          gonePub,
          label: 'Ghost Tablet',
          active: false,
          pending: true,
          at: at,
        ),
      ],
      complete: true,
    );
    await pump(tester);
    final sentence = tester.getRect(find.text('Ghost Tablet signed out'));
    final flag = tester.getRect(find.byKey(const Key('device-history-flag')));
    // One line for the sentence, with the flag below the whole row's text.
    expect(sentence.height, lessThan(30));
    expect(flag.top, greaterThanOrEqualTo(sentence.bottom));
    expect(
      tester.widget<Text>(find.byKey(const Key('device-history-flag'))).data,
      'Left before you looked',
    );
  });

  testWidgets('it refreshes while open: a Got it elsewhere clears the flag, a '
      'new add shows', (tester) async {
    app.history = DeviceLogHistory(
      rows: [
        historyRow(
          3,
          'added',
          gonePub,
          label: 'Ghost',
          active: false,
          pending: true,
          at: at,
        ),
      ],
      complete: true,
    );
    await pump(tester);
    expect(find.text('Left before you looked'), findsOneWidget);

    app.history = DeviceLogHistory(
      rows: [
        historyRow(4, 'added', ipadPub, label: 'iPad', at: at),
        historyRow(3, 'added', gonePub, label: 'Ghost', active: false, at: at),
      ],
      complete: true,
    );
    app.devicesRevision++;
    app.poke();
    await tester.pumpAndSettle();
    expect(find.text('Left before you looked'), findsNothing);
    expect(find.text('iPad added'), findsOneWidget);

    // A change that does not touch the devices does not re-read.
    app.history = const DeviceLogHistory(rows: [], complete: true);
    app.poke();
    await tester.pumpAndSettle();
    expect(find.text('iPad added'), findsOneWidget);
  });

  testWidgets('a failed refresh keeps what is on screen', (tester) async {
    app.history = DeviceLogHistory(
      rows: [historyRow(2, 'added', ipadPub, label: 'iPad', at: at)],
      complete: true,
    );
    await pump(tester);
    app.historyError = true;
    app.devicesRevision++;
    app.poke();
    await tester.pumpAndSettle();
    expect(find.text('iPad added'), findsOneWidget);
    expect(find.byKey(const Key('device-history-failed')), findsNothing);
  });

  testWidgets('a refresh that fails while the first read is still in flight '
      'says so, not a blank page', (tester) async {
    final gate = Completer<void>();
    app.historyGate = gate;
    await tester.pumpWidget(
      MaterialApp(home: DeviceHistoryPage(notifier: app)),
    );
    // The log changes before the first read lands: a quiet re-read supersedes it.
    app.devicesRevision++;
    app.poke();
    await tester.pump();
    app.historyError = true;
    gate.complete();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('device-history-failed')), findsOneWidget);
  });
}
