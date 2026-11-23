import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/device_app.dart';
import 'package:harness/devices/device_app_offer.dart';
import 'package:harness/devices/device_app_row.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/theme/app_theme.dart';

import '../support/device_app.dart';

const _title = 'Menu-bar app';
const _detail = 'Follows the app and terminal tab in front.';
const _action = Key('device-app-row-action');
const _failure = Key('device-app-row-failure');

final _mac = TargetPlatformVariant.only(TargetPlatform.macOS);

/// The offer brought to [state], its disposal registered.
Future<DeviceAppFixture> _fixture(
  DeviceAppOfferState state, {
  DeviceAppInstallStep? step,
}) async {
  final fixture = await DeviceAppFixture.inState(state, step: step);
  addTearDown(fixture.offer.dispose);
  return fixture;
}

/// The row at the top of a column [width] points wide, as the Devices tab's settings column.
Future<void> _mount(
  WidgetTester tester,
  DeviceAppOffer offer, {
  double width = 480,
  double textScale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1200, 900);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: Brightness.light),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: Material(
        child: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: width,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [DeviceAppRow(offer: offer)],
            ),
          ),
        ),
      ),
    ),
  );
}

OutlinedButton _button(WidgetTester tester) =>
    tester.widget<OutlinedButton>(find.byKey(_action));

void _expectRow(WidgetTester tester, String label) {
  expect(find.byKey(const Key('device-app-row')), findsOneWidget);
  expect(find.text(_title), findsOneWidget);
  expect(find.text(_detail), findsOneWidget);
  expect(
    find.descendant(of: find.byKey(_action), matching: find.text(label)),
    findsOneWidget,
  );
}

/// The failure line: its text, announced, in the error colour.
void _expectFailure(WidgetTester tester, String line) {
  expect(tester.widget<Text>(find.byKey(_failure)).data, line);
  expect(
    find.ancestor(
      of: find.byKey(_failure),
      matching: find.byWidgetPredicate(
        (widget) => widget is Semantics && widget.properties.liveRegion == true,
      ),
    ),
    findsOneWidget,
  );
  expect(
    tester.widget<Text>(find.byKey(_failure)).style?.color,
    AppColors.danger,
  );
}

void main() {
  testWidgets('not installed: Install installs', (tester) async {
    final fixture = await _fixture(DeviceAppOfferState.offer);
    await _mount(tester, fixture.offer);

    _expectRow(tester, 'Install');
    expect(find.byKey(_failure), findsNothing);
    expect(_button(tester).onPressed, isNotNull);
    // A SettingRow with 10 points under it, as the rows below it.
    expect(
      tester.getSize(find.byType(DeviceAppRow)).height,
      tester.getSize(find.byKey(const Key('device-app-row'))).height + 10,
    );

    await tester.tap(find.byKey(_action));
    await tester.pump();
    expect(fixture.install.calls, 1);
    expect(fixture.open.paths, isEmpty);
  }, variant: _mac);

  testWidgets('installing: Installing…, disabled', (tester) async {
    final fixture = await _fixture(DeviceAppOfferState.installing);
    await _mount(tester, fixture.offer);

    _expectRow(tester, 'Installing…');
    expect(find.byKey(_failure), findsNothing);
    expect(_button(tester).onPressed, isNull);
    expect(fixture.install.calls, 1);
  }, variant: _mac);

  testWidgets('a failure shows its line and Retry installs again', (
    tester,
  ) async {
    final fixture = await _fixture(
      DeviceAppOfferState.failed,
      step: DeviceAppInstallStep.signature,
    );
    await _mount(tester, fixture.offer);

    _expectRow(tester, 'Retry');
    _expectFailure(tester, 'Couldn’t verify the download.');

    await tester.tap(find.byKey(_action));
    await tester.pump();
    expect(fixture.install.calls, 2);
    expect(fixture.open.paths, isEmpty);
  }, variant: _mac);

  testWidgets('installed but not opened: Open opens it', (tester) async {
    final fixture = await _fixture(
      DeviceAppOfferState.failed,
      step: DeviceAppInstallStep.open,
    );
    await _mount(tester, fixture.offer);

    _expectRow(tester, 'Open');
    _expectFailure(tester, 'Installed. Couldn’t open it.');

    await tester.tap(find.byKey(_action));
    await tester.pump();
    expect(fixture.open.paths, ['/t/Harness Device.app']);
    expect(fixture.install.calls, 1);
  }, variant: _mac);

  testWidgets('installed and not running: Open', (tester) async {
    final fixture = await _fixture(DeviceAppOfferState.notRunning);
    await _mount(tester, fixture.offer);

    _expectRow(tester, 'Open');
    expect(find.byKey(_failure), findsNothing);

    await tester.tap(find.byKey(_action));
    await tester.pump();
    expect(fixture.open.paths, [null]);
    expect(fixture.install.calls, 0);
  }, variant: _mac);

  testWidgets('installed and running: nothing', (tester) async {
    final fixture = await _fixture(DeviceAppOfferState.hidden);
    await _mount(tester, fixture.offer);

    expect(tester.getSize(find.byType(DeviceAppRow)).height, 0);
    expect(find.text(_title), findsNothing);
  }, variant: _mac);

  testWidgets('Not now on the band leaves the row', (tester) async {
    final fixture = await _fixture(DeviceAppOfferState.offer);
    await _mount(tester, fixture.offer);

    await fixture.offer.dismiss();
    await tester.pump();
    _expectRow(tester, 'Install');
  }, variant: _mac);

  testWidgets('a press while installing does nothing', (tester) async {
    final fixture = await _fixture(DeviceAppOfferState.offer);
    fixture.install.gate = Completer<void>();
    await _mount(tester, fixture.offer);

    await tester.tap(find.byKey(_action));
    await tester.pump();
    await tester.tap(find.byKey(_action));
    await tester.pump();
    _expectRow(tester, 'Installing…');
    expect(fixture.install.calls, 1);
  }, variant: _mac);

  testWidgets('200% text in a 320-point column: the button goes under the '
      'text', (tester) async {
    final fixture = await _fixture(
      DeviceAppOfferState.failed,
      step: DeviceAppInstallStep.download,
    );
    await _mount(tester, fixture.offer, width: 320, textScale: 2);

    expect(tester.takeException(), isNull);
    expect(
      tester.getRect(find.byKey(_action)).top,
      greaterThan(tester.getRect(find.text(_detail)).bottom),
    );
  }, variant: _mac);

  testWidgets(
    'on Windows and Linux the row is the tray app',
    (tester) async {
      final fixture = await _fixture(DeviceAppOfferState.offer);
      await _mount(tester, fixture.offer);

      expect(find.text('Tray app'), findsOneWidget);
      expect(find.text('Follows the app in front.'), findsOneWidget);
      expect(find.text(_title), findsNothing);
      expect(find.text(_detail), findsNothing);
      // The button is announced by the row's title.
      expect(
        find.ancestor(
          of: find.byKey(_action),
          matching: find.byWidgetPredicate(
            (widget) =>
                widget is Semantics && widget.properties.label == 'Tray app',
          ),
        ),
        findsOneWidget,
      );
    },
    variant: TargetPlatformVariant({
      TargetPlatform.windows,
      TargetPlatform.linux,
    }),
  );
}
