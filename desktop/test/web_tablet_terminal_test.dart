// A tablet's two-column workspace (the web at 768), and a phone's one pane:
// each pane's first terminal row sits whole under its header. The review fixture's computer
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

  /// [size]'s workspace, with every drawn pane's terminal scroll position.
  Future<List<double>> scrolls(
    WidgetTester tester,
    Size size, {
    double settlesShorterBy = 0,
    Size? startsAt,
  }) async {
    final app = withPanes(signedIn(), 3);
    addTearDown(app.dispose);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = startsAt ?? size;
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
    if (startsAt != null) {
      tester.view.physicalSize = size;
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(milliseconds: 200));
    }
    if (settlesShorterBy > 0) {
      // A phone's browser: the store bar over the page, and its own bars,
      // arrive after the first layout and take height from every pane.
      tester.view.physicalSize = Size(
        size.width,
        size.height - settlesShorterBy,
      );
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(milliseconds: 200));
    }
    final out = [
      for (final view in find.byType(TerminalView).evaluate())
        tester
            .state<ScrollableState>(
              find
                  .descendant(
                    of: find.byWidget(view.widget),
                    matching: find.byType(Scrollable),
                  )
                  .first,
            )
            .position
            .pixels,
    ];
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
    return out;
  }

  testWidgets('at 768 every pane shows its first row whole', (tester) async {
    // An iPad mini's 1024 less the store bar over the page and the browser's
    // own bars: panes shorter than the 24 rows a screen starts at.
    final positions = await scrolls(tester, const Size(768, 900));
    // Not scrolled at all: the first row is at the top of each pane.
    expect(positions, [0, 0, 0]);
  });

  testWidgets('at 360 the phone\'s one pane shows its first row whole', (
    tester,
  ) async {
    expect(await scrolls(tester, const Size(360, 740)), [0]);
    expect(await scrolls(tester, const Size(360, 740), settlesShorterBy: 200), [
      0,
    ]);
  });
}
