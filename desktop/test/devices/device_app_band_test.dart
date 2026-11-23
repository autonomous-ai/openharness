import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/device_app.dart';
import 'package:harness/devices/device_app_offer.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/device_app_band.dart';

import '../support/device_app.dart';

const _text = Key('device-app-band');
const _install = Key('device-app-band-install');
const _dismiss = Key('device-app-band-dismiss');

/// The band above the rest of the window, as `app_shell.dart` places it.
Future<void> _mount(
  WidgetTester tester,
  DeviceAppFixture fixture, {
  Size size = const Size(1200, 900),
  double textScale = 1,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  addTearDown(fixture.offer.dispose);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(),
      home: MediaQuery.withClampedTextScaling(
        minScaleFactor: textScale,
        maxScaleFactor: textScale,
        child: Column(
          children: [
            DeviceAppBand(offer: fixture.offer),
            const Expanded(child: SizedBox()),
          ],
        ),
      ),
    ),
  );
}

String _label(WidgetTester tester, Key key) {
  final text = find.descendant(
    of: find.byKey(key),
    matching: find.byType(Text),
  );
  return tester.widget<Text>(text).data!;
}

ButtonStyleButton _button(WidgetTester tester, Key key) =>
    tester.widget<ButtonStyleButton>(find.byKey(key));

void main() {
  testWidgets('the offer: its sentence, Not now, then Install', (tester) async {
    final fixture = await DeviceAppFixture.inState(DeviceAppOfferState.offer);
    await _mount(tester, fixture);

    expect(
      tester.widget<Text>(find.byKey(_text)).data,
      'Your dial follows apps and terminal tabs with the Harness menu-bar app.',
    );
    expect(_label(tester, _dismiss), 'Not now');
    expect(_label(tester, _install), 'Install');
    expect(
      tester.getTopLeft(find.byKey(_dismiss)).dx,
      lessThan(tester.getTopLeft(find.byKey(_install)).dx),
    );
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets(
    'on Windows and Linux the sentence names the tray app',
    (tester) async {
      final fixture = await DeviceAppFixture.inState(DeviceAppOfferState.offer);
      await _mount(tester, fixture);

      expect(
        tester.widget<Text>(find.byKey(_text)).data,
        'Your dial follows apps with the Harness tray app.',
      );
      expect(_label(tester, _dismiss), 'Not now');
      expect(_label(tester, _install), 'Install');
    },
    variant: TargetPlatformVariant({
      TargetPlatform.windows,
      TargetPlatform.linux,
    }),
  );

  testWidgets('Install installs once and reads Installing…', (tester) async {
    final fixture = await DeviceAppFixture.inState(DeviceAppOfferState.offer);
    final gate = fixture.install.gate = Completer<void>();
    await _mount(tester, fixture);

    await tester.tap(find.byKey(_install));
    await tester.pump();
    expect(_label(tester, _install), 'Installing…');
    expect(_button(tester, _install).onPressed, isNull);
    expect(_button(tester, _dismiss).onPressed, isNull);
    expect(fixture.install.calls, 1);

    gate.complete();
    await tester.pump();
    expect(find.byKey(_text), findsNothing);
  });

  testWidgets('a failure shows its line and Retry', (tester) async {
    final fixture = await DeviceAppFixture.inState(
      DeviceAppOfferState.failed,
      step: DeviceAppInstallStep.download,
    );
    await _mount(tester, fixture);

    expect(
      tester.widget<Text>(find.byKey(_text)).data,
      'Couldn’t download the app.',
    );
    expect(_label(tester, _install), 'Retry');
    await tester.tap(find.byKey(_install));
    await tester.pump();
    expect(fixture.install.calls, 2);
  });

  testWidgets('installed but not opened: Retry opens it', (tester) async {
    final fixture = await DeviceAppFixture.inState(
      DeviceAppOfferState.failed,
      step: DeviceAppInstallStep.open,
    );
    await _mount(tester, fixture);

    expect(
      tester.widget<Text>(find.byKey(_text)).data,
      'Installed. Couldn’t open it.',
    );
    expect(_label(tester, _install), 'Retry');
    await tester.tap(find.byKey(_install));
    await tester.pump();
    expect(fixture.open.paths, ['/t/Harness Device.app']);
    expect(fixture.install.calls, 1);
  });

  testWidgets('Not now hides it and keeps the answer', (tester) async {
    final fixture = await DeviceAppFixture.inState(DeviceAppOfferState.offer);
    await _mount(tester, fixture);

    await tester.tap(find.byKey(_dismiss));
    await tester.pump();
    expect(find.byKey(_text), findsNothing);
    expect(fixture.store.values, {'device_app.offer_dismissed': 'true'});
  });

  testWidgets('installed and not running: no band', (tester) async {
    final fixture = await DeviceAppFixture.inState(
      DeviceAppOfferState.notRunning,
    );
    await _mount(tester, fixture);

    expect(find.byKey(_text), findsNothing);
    expect(find.byKey(_install), findsNothing);
  });

  testWidgets('200% text in an 880-point window: nothing overflows', (
    tester,
  ) async {
    for (final (state, step) in [
      (DeviceAppOfferState.offer, null),
      (DeviceAppOfferState.failed, DeviceAppInstallStep.open),
    ]) {
      final fixture = await DeviceAppFixture.inState(state, step: step);
      await _mount(tester, fixture, size: const Size(880, 700), textScale: 2);

      expect(tester.takeException(), isNull, reason: '$state');
      expect(
        find.byKey(_dismiss).hitTestable(),
        findsOneWidget,
        reason: '$state',
      );
      expect(
        find.byKey(_install).hitTestable(),
        findsOneWidget,
        reason: '$state',
      );
    }
  });

  testWidgets('the failure line is announced', (tester) async {
    final semantics = tester.ensureSemantics();
    try {
      final fixture = await DeviceAppFixture.inState(
        DeviceAppOfferState.failed,
        step: DeviceAppInstallStep.checksum,
      );
      await _mount(tester, fixture);

      expect(
        tester
            .getSemantics(find.byKey(_text))
            .getSemanticsData()
            .flagsCollection
            .isLiveRegion,
        isTrue,
      );
    } finally {
      semantics.dispose();
    }
  });
}
