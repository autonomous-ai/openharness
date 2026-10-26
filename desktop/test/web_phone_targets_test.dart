// The web workspace on a phone: the controls a finger presses below the tab
// bar — the footer's Status menu and its actions, and the error band's Retry
// — are 44x44 at least (audit finding S1).
// A computer's browser keeps the mouse's sizes.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/web/shell/web_chrome.dart';

import '../tool/web_ux_seed.dart';
import 'support/real_fonts.dart';
import 'support/web_ux_app.dart';

Future<WebUxApp> _mount(
  WidgetTester tester,
  Size size,
  WebUxApp Function() seed,
) async {
  final app = seed();
  addTearDown(app.dispose);
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: SwarmScreen(
        notifier: app,
        nativeTabs: false,
        chrome: webWorkspaceChrome(app),
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 200));
  return app;
}

Future<void> _unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(seconds: 1));
}

/// The box the accessibility tree gives [control], which is what the web_ux
/// tap-size check measures: a Material button's padded hit area is not in it.
Size _target(WidgetTester tester, Finder control) =>
    tester.getSemantics(control).rect.size;

Matcher get _finger => predicate<Size>(
  (size) => size.width >= 44 && size.height >= 44,
  'at least 44x44',
);

WebUxApp _withError() => withPanes(signedIn(), 2)
  ..error = 'Could not start Claude Code on Studio Mac: the folder is gone.';

void main() {
  setUpAll(loadRealFonts);

  testWidgets('a phone footer is a finger tall at its Status menu', (
    tester,
  ) async {
    await _mount(tester, const Size(360, 740), () => withPanes(signedIn(), 2));
    final status = find.byKey(const ValueKey('web-footer-menu-button'));
    expect(tester.getSize(status), _finger);
    final bar = tester.getRect(
      find.byKey(const ValueKey('workspace-status-bar')),
    );
    expect(bar.contains(tester.getRect(status).topLeft), isTrue);
    await _unmount(tester);
  });

  testWidgets('a narrow computer browser\'s Download app in the footer too', (
    tester,
  ) async {
    await _mount(tester, const Size(600, 800), () => withPanes(signedIn(), 2));
    expect(
      tester.getSize(find.widgetWithText(Semantics, 'Download app').first),
      _finger,
    );
    await _unmount(tester);
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets('the error band\'s Retry is a finger\'s size on a phone', (
    tester,
  ) async {
    await _mount(tester, const Size(360, 740), _withError);
    expect(_target(tester, find.widgetWithText(TextButton, 'Retry')), _finger);
    await _unmount(tester);
  });

  testWidgets('a wide window keeps the mouse-sized Retry', (tester) async {
    await _mount(tester, const Size(1280, 800), _withError);
    expect(
      tester.getSize(find.widgetWithText(TextButton, 'Retry')).height,
      lessThan(44),
    );
    await _unmount(tester);
  });
}
