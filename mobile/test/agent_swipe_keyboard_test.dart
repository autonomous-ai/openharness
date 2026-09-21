import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:xterm/xterm.dart';

import 'agent_pager_fixture.dart';

/// The pager puts the keyboard away for a swipe between agents — and for nothing else.
void main() {
  bool terminalHasFocus(WidgetTester tester) =>
      tester.binding.focusManager.primaryFocus?.context
          ?.findAncestorWidgetOfExactType<TerminalView>() !=
      null;

  Future<AppNotifier> pumpPager(WidgetTester tester) async {
    final app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    final session = await liveAgent(app, 'b');
    for (var line = 0; line < 400; line++) {
      session.terminal.write('output line $line\r\n');
    }
    await tester.pumpWidget(
      MaterialApp(
        home: AgentSwipeHost(
          notifier: app,
          machineId: 'm',
          agentId: 'b',
          neighbours: pagerList(app),
        ),
      ),
    );
    await tester.pump();
    return app;
  }

  /// The software keyboard sliding up, as the platform reports it.
  Future<void> raiseKeyboard(WidgetTester tester) async {
    tester.view.viewInsets = const FakeViewPadding(bottom: 900);
    addTearDown(tester.view.resetViewInsets);
    await tester.pump();
    await tester.pump();
  }

  testWidgets('reading back through the scrollback leaves the keyboard up', (
    tester,
  ) async {
    await pumpPager(tester);
    await raiseKeyboard(tester);
    expect(terminalHasFocus(tester), isTrue);

    await tester.drag(find.byType(TerminalView), const Offset(0, 300));
    await tester.pump(const Duration(milliseconds: 500));

    expect(
      terminalHasFocus(tester),
      isTrue,
      reason: 'the terminal\'s own scroll is not a swipe to another agent',
    );
  });

  testWidgets('a swipe with no keyboard up does not swallow the next one', (
    tester,
  ) async {
    final app = await pumpPager(tester);

    await tester.fling(find.byType(PageView), const Offset(-400, 0), 1000);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    // The page swiped to opens as it lands, and its machine answers — `pumpAndSettle` cannot be used
    // while it is still "Attaching…", whose skeleton breathes for ever (see [goLive]).
    await goLive(app.paneOfAgent('m', 'c')!.session!);
    // Twice: each of the keyframe's coalescing windows is armed by the frame before it, and the
    // binding fails a test that leaves one pending.
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    await raiseKeyboard(tester);

    expect(terminalHasFocus(tester), isTrue);
  });
}
