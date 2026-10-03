// The settings pane for the robot on the cable.
//
// Three rules, each of which the device made necessary: the device owns the values, a row that has
// no meaning on this face is hidden rather than greyed, and an unplugged robot is readable but not
// writable. Each gets a test, because each is a thing that looks fine when it is wrong.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/settings/sections/cabled_device_card.dart';
import 'package:harness/state/dial_status.dart';

const _round = DeviceSettings(
  brightness: 60,
  character: 0,
  face: 466,
  muted: false,
  quiet: false,
  straightTitle: false,
  focusFace: false,
  scrollReversed: false,
  round: true,
  voiceLang: 'en',
);

const _square = DeviceSettings(
  brightness: 60,
  character: 1,
  face: 720,
  muted: true,
  quiet: true,
  straightTitle: true,
  focusFace: false,
  scrollReversed: true,
  round: false,
  voiceLang: 'vi',
);

/// The pane is taller than a test viewport, so a control below the fold has to be scrolled to before
/// it can be tapped — otherwise the tap lands at a point outside the viewport and hits whatever is
/// there instead, which looks exactly like a control that did nothing.
Future<void> _tap(WidgetTester tester, Key key) async {
  await tester.ensureVisible(find.byKey(key));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(key));
  await tester.pump();
}

Future<List<(String, Map<String, Object?>)>> _pump(
  WidgetTester tester,
  List<DialStatus> devices, {
  bool showCompanion = false,
}) async {
  final sent = <(String, Map<String, Object?>)>[];
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: CabledDeviceCard(
            devices: devices,
            showCompanion: showCompanion,
            onChanged: (id, patch) => sent.add((id, patch)),
          ),
        ),
      ),
    ),
  );
  return sent;
}

void main() {
  testWidgets('while the robot wears Focus only, nothing offers another face', (
    tester,
  ) async {
    // The firmware ignores a skin or a companion until the companion skins are finished, so
    // neither row is drawn — even with the experimental companion switch on.
    const devices = [
      DialStatus(
        attached: true,
        id: 'dial',
        settings: DeviceSettings(
          brightness: 40,
          character: 2,
          face: 466,
          muted: true,
          quiet: false,
          straightTitle: false,
          focusFace: false,
          scrollReversed: false,
          round: true,
          voiceLang: 'en',
          followCompanion: true,
          companion: 'gnu',
        ),
      ),
    ];
    await _pump(tester, devices, showCompanion: true);
    expect(find.text('Follow desktop companion'), findsNothing);
    expect(find.text('Skin'), findsNothing);
    expect(find.text('Brightness'), findsOneWidget);
  });

  testWidgets('the pane names the robot it is changing, before any row', (
    tester,
  ) async {
    // These rows look exactly like the app's own preferences, so without this they read as settings
    // for Harness itself.
    await _pump(tester, const [
      DialStatus(
        attached: true,
        id: 'AA:01',
        mac: 'aa:bb',
        fw: '0.0.86',
        settings: _round,
      ),
    ]);
    expect(find.text('These settings apply to'), findsOneWidget);
    expect(find.text('Dial'), findsOneWidget);
    expect(find.text('connected'), findsOneWidget);
    expect(find.textContaining('466 round'), findsOneWidget);
    expect(find.textContaining('habitat 0.0.86'), findsOneWidget);
  });

  testWidgets('no robot offers Edge text: titles are straight across', (
    tester,
  ) async {
    await _pump(tester, const [
      DialStatus(attached: true, id: 'AA:01', settings: _round),
    ]);
    expect(find.text('Edge text'), findsNothing);
    expect(find.text('Voice language'), findsOneWidget);
  });

  testWidgets('the voice language shows what the robot holds, of all six', (
    tester,
  ) async {
    // The picker once knew only English and Vietnamese, and read a Japanese dial as English.
    await _pump(tester, const [
      DialStatus(
        attached: true,
        id: 'AA:01',
        settings: DeviceSettings(
          brightness: 60,
          character: 2,
          face: 466,
          muted: false,
          quiet: false,
          straightTitle: false,
          focusFace: false,
          scrollReversed: false,
          round: true,
          voiceLang: 'ja',
        ),
      ),
    ]);
    expect(find.text('日本語'), findsOneWidget);
    expect(find.text('English'), findsNothing);
  });

  testWidgets('a square face HIDES the row it has no meaning for', (
    tester,
  ) async {
    // Greying them out would still claim the settings exist there.
    await _pump(tester, const [
      DialStatus(attached: true, id: 'BB:02', settings: _square),
    ]);
    expect(find.text('Edge text'), findsNothing);
    expect(find.text('Rim scrolling'), findsNothing);
    expect(find.text('Reverse scrolling'), findsOneWidget);
  });

  testWidgets(
    'one field at a time crosses, named the way the device names it',
    (tester) async {
      final sent = await _pump(tester, const [
        DialStatus(attached: true, id: 'AA:01', settings: _round),
      ]);
      await _tap(tester, const ValueKey('device-quiet-AA:01'));
      expect(sent, hasLength(1));
      expect(sent.single.$1, 'AA:01');
      expect(sent.single.$2, {'quiet': true});

      // The switch says "sound on"; the wire field is its opposite, and the flip belongs in the pane.
      await _tap(tester, const ValueKey('device-muted-AA:01'));
      expect(sent.last.$2, {'muted': true});
    },
  );

  testWidgets('an unplugged robot is readable and not writable', (
    tester,
  ) async {
    final sent = await _pump(tester, const [
      DialStatus(attached: false, id: 'AA:01', mac: 'aa:bb', settings: _round),
    ]);
    expect(find.text('Unplugged'), findsOneWidget);
    expect(
      find.text('Brightness'),
      findsOneWidget,
      reason: 'the values stay readable',
    );
    final toggle = tester.widget<Switch>(
      find.byKey(const ValueKey('device-quiet-AA:01')),
    );
    expect(toggle.onChanged, isNull);
    await _tap(tester, const ValueKey('device-quiet-AA:01'));
    expect(sent, isEmpty);
  });

  testWidgets('two robots on one desk get a picker, and the rows follow it', (
    tester,
  ) async {
    // Both are dials, so the name alone cannot separate them: the detail line carries the address.
    // And the rows belong to ONE of them — reading them as account-wide would overwrite one device
    // with the other's taste the first time somebody touched a row.
    final sent = await _pump(tester, const [
      DialStatus(attached: true, id: 'AA:01', mac: 'aa:bb', settings: _round),
      DialStatus(attached: true, id: 'BB:02', mac: 'cc:dd', settings: _square),
    ]);
    expect(find.text('These settings apply to'), findsOneWidget);
    expect(find.textContaining('aa:bb'), findsOneWidget);
    expect(find.textContaining('cc:dd'), findsOneWidget);
    // Opens on the first attached robot, whose voice is English; the second's is Vietnamese.
    expect(find.text('English'), findsOneWidget);

    await tester.tap(find.textContaining('cc:dd'));
    await tester.pumpAndSettle();
    expect(find.text('Tiếng Việt'), findsOneWidget);
    await _tap(tester, const ValueKey('device-quiet-BB:02'));
    expect(
      sent.single.$1,
      'BB:02',
      reason: 'the change goes to the selected robot',
    );
  });

  testWidgets(
    'a robot that has not reported says so instead of showing defaults',
    (tester) async {
      await _pump(tester, const [
        DialStatus(attached: true, id: 'AA:01', fw: '0.0.68'),
      ]);
      expect(
        find.textContaining('keeps its settings on the glass'),
        findsOneWidget,
      );
      expect(find.text('Brightness'), findsNothing);
    },
  );
}
