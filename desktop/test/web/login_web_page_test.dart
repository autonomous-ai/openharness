@TestOn('browser')
library;

import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/login_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/login_fleet_map.dart';
import 'package:harness/widgets/web_download_button.dart';

import '../support/web_ux_app.dart';

const _failure = 'Could not complete sign-in. Please sign in again.';

/// The browser's sign-in page in a window [size] big, as `main.dart` frames it.
Future<WebUxApp> _open(
  WidgetTester tester, {
  Size size = const Size(1440, 900),
  Brightness brightness = Brightness.dark,
  String? error,
}) async {
  tester.view
    ..physicalSize = size
    ..devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final saved = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = saved);
  final app = WebUxApp()
    ..status = AppStatus.unauthenticated
    ..error = error;
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      home: grid.BrightnessScope(child: LoginScreen(notifier: app)),
    ),
  );
  await tester.pump(const Duration(seconds: 1));
  return app;
}

/// WCAG contrast of two opaque colours.
double _contrast(Color a, Color b) {
  final (light, dark) = (
    math.max(a.computeLuminance(), b.computeLuminance()),
    math.min(a.computeLuminance(), b.computeLuminance()),
  );
  return (light + .05) / (dark + .05);
}

void main() {
  // Audit finding S9: the store bar already offers the phone app there.
  for (final platform in [TargetPlatform.iOS, TargetPlatform.android]) {
    testWidgets('a ${platform.name} browser gets no Download app at the top', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = platform;
      await _open(tester, size: const Size(390, 844));
      expect(find.text('Download app'), findsNothing);
      debugDefaultTargetPlatformOverride = null;
    });
  }

  for (final platform in [
    TargetPlatform.macOS,
    TargetPlatform.windows,
    TargetPlatform.linux,
  ]) {
    testWidgets(
      'a ${platform.name} browser keeps Download app at the top, at any width',
      (tester) async {
        debugDefaultTargetPlatformOverride = platform;
        await _open(tester, size: const Size(390, 844));
        expect(find.text('Download app'), findsOneWidget);
        await _open(tester);
        expect(find.text('Download app'), findsOneWidget);
        debugDefaultTargetPlatformOverride = null;
      },
    );
  }

  // Audit finding S15.
  testWidgets('at 1440x900 a failed sign-in shows its reason and Try again '
      'without scrolling', (tester) async {
    await _open(tester, error: _failure);
    for (final shown in [
      find.text('Could not sign in'),
      find.text(_failure),
      find.text('Try again'),
    ]) {
      final rect = tester.getRect(shown);
      expect(rect.top, greaterThanOrEqualTo(0));
      expect(rect.bottom, lessThanOrEqualTo(900), reason: '$shown');
    }
    // Above the ways in, where the eye lands when the page comes back.
    expect(
      tester.getRect(find.text('Try again')).bottom,
      lessThan(tester.getRect(find.text('Continue with Google')).top),
    );
  });

  // Found in review: Try again was 32 px tall on a phone.
  testWidgets('on a phone Try again is a finger\'s size; wide, as it was', (
    tester,
  ) async {
    Size retry() => tester.getSize(
      find.ancestor(
        of: find.text('Try again'),
        matching: find.byType(OutlinedButton),
      ),
    );
    for (final phone in [const Size(360, 740), const Size(390, 844)]) {
      await _open(tester, size: phone, error: _failure);
      expect(retry().height, greaterThanOrEqualTo(44), reason: '$phone');
      expect(retry().width, greaterThanOrEqualTo(44), reason: '$phone');
    }
    await _open(tester, error: _failure);
    expect(retry().height, lessThan(44));
  });

  testWidgets('without a failure the page has no error tile', (tester) async {
    await _open(tester);
    expect(find.text('Could not sign in'), findsNothing);
    expect(find.text('Try again'), findsNothing);
  });

  // Audit finding P1: small text a person reads, at 4.5:1 on the page.
  for (final brightness in Brightness.values) {
    testWidgets('"End-to-end encrypted" reads at 4.5:1 in ${brightness.name}', (
      tester,
    ) async {
      await _open(tester, brightness: brightness);
      final seal = tester.widget<Text>(find.text('End-to-end encrypted'));
      expect(
        _contrast(seal.style!.color!, grid.AppPalette.panelBg),
        greaterThanOrEqualTo(4.5),
      );
    });
  }

  // Audit finding P7: a phone's map keeps the machine names, not the lines
  // under them, which are cut off at that width.
  testWidgets('below 480 px the map drops the line under each machine', (
    tester,
  ) async {
    await _open(tester, size: const Size(360, 740));
    expect(
      tester.widget<LoginFleetMap>(find.byType(LoginFleetMap)).pinDetails,
      isFalse,
    );
    await _open(tester, size: const Size(480, 900));
    expect(
      tester.widget<LoginFleetMap>(find.byType(LoginFleetMap)).pinDetails,
      isTrue,
    );
  });

  // Found in review: Tab never reached Download app at the top.
  testWidgets('Tab reaches Download app at the top', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    await _open(tester);
    bool focused() => Focus.of(
      tester.element(
        find.descendant(
          of: find.byType(WebDownloadButton),
          matching: find.byType(Text),
        ),
      ),
    ).hasFocus;
    var reached = false;
    for (var i = 0; i < 20 && !reached; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      reached = focused();
    }
    expect(reached, isTrue);
    debugDefaultTargetPlatformOverride = null;
  });
}
