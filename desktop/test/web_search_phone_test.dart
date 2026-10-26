// The search overlay on a phone (the web below compactBelow): its Close and
// preview buttons, its scope chips and its command rows are a finger's size
// (audit finding S1). A wide window keeps the mouse's 32 px.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/web/shell/web_chrome.dart';

import '../tool/web_ux_seed.dart';
import 'support/real_fonts.dart';

Future<void> _openSearch(WidgetTester tester, Size size) async {
  final app = withPanes(signedIn(), 2);
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
  await tester.tap(find.byKey(const ValueKey('swarm-search-button')));
  await tester.pump(const Duration(milliseconds: 300));
}

Future<void> _close(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(seconds: 1));
}

const _controls = [
  'search-close',
  'search-toggle-preview',
  'search-category-Harnesses',
  'search-category-Commands',
];

void main() {
  setUpAll(loadRealFonts);

  testWidgets('a phone\'s search is pressed with a finger', (tester) async {
    await _openSearch(tester, const Size(390, 844));
    for (final key in _controls) {
      final size = tester.getSize(find.byKey(ValueKey(key)));
      expect(size.width, greaterThanOrEqualTo(44), reason: key);
      expect(size.height, greaterThanOrEqualTo(44), reason: key);
    }

    // The commands: one line a row.
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      '>',
    );
    await tester.pump(const Duration(milliseconds: 300));
    final row = find.byType(ListTile);
    expect(tester.getSize(row.first).height, greaterThanOrEqualTo(44));
    await _close(tester);
  });

  testWidgets('a wide window keeps the mouse-sized search controls', (
    tester,
  ) async {
    await _openSearch(tester, const Size(1280, 800));
    for (final key in _controls) {
      expect(tester.getSize(find.byKey(ValueKey(key))).height, lessThan(44));
    }
    await _close(tester);
  });
}
