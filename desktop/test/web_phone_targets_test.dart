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
  WebUxApp Function() seed, {
  bool desktop = false,
}) async {
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
        // Desktop sets no chrome.
        chrome: desktop ? null : webWorkspaceChrome(app),
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

/// The New tab page's rows (its recent harnesses, its commands and the
/// phone's) and its Appearance, each at least once.
Iterable<double> _newTabRowHeights(WidgetTester tester) {
  final rows = find.byWidgetPredicate(
    (w) =>
        w is TextButton &&
        w.key is ValueKey<String> &&
        (w.key! as ValueKey<String>).value.startsWith('welcome-'),
  );
  final appearance = find.byKey(const ValueKey('welcome-customize'));
  expect(rows, findsWidgets);
  expect(appearance, findsOneWidget);
  return [
    for (var i = 0; i < rows.evaluate().length; i++)
      tester.getSize(rows.at(i)).height,
    tester.getSize(appearance).height,
  ];
}

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

  // Desktop sets no compactBelow: a narrow window is no phone.
  testWidgets('Desktop at 600 keeps the bar\'s mouse sizes', (tester) async {
    Future<List<Size>> bar(Size window) async {
      await _mount(
        tester,
        window,
        () => withPanes(signedIn(), 2),
        desktop: true,
      );
      final sizes = [
        for (final key in [
          'swarm-search-button',
          'workspace-notifications-button',
        ])
          tester.getSize(find.byKey(ValueKey(key))),
      ];
      await _unmount(tester);
      return sizes;
    }

    final narrow = await bar(const Size(600, 800));
    for (final size in narrow) {
      expect(size.height, lessThan(44));
    }
    expect(narrow, await bar(const Size(1280, 800)));
  });

  testWidgets('a phone\'s New tab page rows are a finger tall', (tester) async {
    await _mount(tester, const Size(360, 740), () => withPanes(signedIn(), 3));
    await tester.tap(find.byKey(const ValueKey('web-new-tab-button')));
    await tester.pump(const Duration(milliseconds: 500));
    for (final height in _newTabRowHeights(tester)) {
      expect(height, greaterThanOrEqualTo(44));
    }
    expect(tester.takeException(), isNull);
    await _unmount(tester);
  });

  // Desktop sets no compactBelow: a narrow window is no phone.
  testWidgets('Desktop at 600 keeps the New tab page\'s rows', (tester) async {
    await _mount(
      tester,
      const Size(600, 800),
      () => withPanes(signedIn(), 3)..newSwarm(newTabPage: true),
      desktop: true,
    );
    for (final height in _newTabRowHeights(tester)) {
      expect(height, lessThan(44));
    }
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
