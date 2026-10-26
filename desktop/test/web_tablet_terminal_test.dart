// A tablet's two-column workspace (the web at 768): each pane's first
// terminal row sits whole under its header. The review fixture's computer
// answers a resize as a real one does, with the screen at the pane's size, so
// a pane shorter than the 24 rows a screen starts at is not scrolled to its
// end with the first row half under the header.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/web/shell/web_chrome.dart';
import 'package:xterm/xterm.dart';

import '../tool/web_ux_seed.dart';
import 'support/real_fonts.dart';

void main() {
  setUpAll(loadRealFonts);

  testWidgets('at 768 every pane shows its first row whole', (tester) async {
    final app = withPanes(signedIn(), 3);
    addTearDown(app.dispose);
    tester.view.devicePixelRatio = 1;
    // An iPad mini's 1024 less the store bar over the page and the browser's
    // own bars: panes shorter than the 24 rows a screen starts at.
    tester.view.physicalSize = const Size(768, 900);
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
    await tester.pump(const Duration(milliseconds: 200));

    final views = find.byType(TerminalView);
    expect(views, findsNWidgets(3));
    for (final view in views.evaluate()) {
      final scroll = find.descendant(
        of: find.byWidget(view.widget),
        matching: find.byType(Scrollable),
      );
      final position = tester.state<ScrollableState>(scroll.first).position;
      // Not scrolled at all: the first row is at the top of the pane.
      expect(position.pixels, 0, reason: 'scrolled ${position.pixels}');
    }
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
  });
}
