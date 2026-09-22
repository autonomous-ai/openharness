import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_pager_fixture.dart';

/// Arriving on an agent TAKES its terminal.
///
/// ⚠️ **Why this has a test of its own.** The phone asked politely for a while, and what that
/// looked like was opening the app onto a read-only stream with a band over it — "Take control" to
/// type — whenever a desktop had the agent open. A phone is picked up to type at an agent. So an
/// open a person causes is a claim, and the one open that still asks politely is the tile the pager
/// builds ahead of the thumb, which is a guess (see `AppNotifier.warmAgentPane`).
///
/// The wire says it by OMISSION: `takeover: false` is the polite key, and a claim leaves it out —
/// see `TerminalSession.openTerminal`.
void main() {
  /// The frames a terminal open sends, once the viewport it waits for has given up and fallen back
  /// (`waitForViewportSize`) — nothing here mounts a panel to measure.
  Future<Map<String, dynamic>> openedWith(
    WidgetTester tester,
    Future<void> Function(AppNotifier app) open,
    PagerConn conn,
    AppNotifier app,
  ) async {
    await tester.pumpWidget(const SizedBox.shrink());
    unawaited(open(app));
    await tester.pump(const Duration(seconds: 3));
    expect(conn.opens, hasLength(1), reason: 'one open, for one agent');
    // The keyframe the machine would answer with, which disarms the open's watchdog — a timer
    // still pending at teardown fails the test. See [goLive].
    final session = app.paneOfAgent('m', 'a')?.session;
    if (session != null) await goLive(session);
    // The keyframe's ack and the view's first resize each coalesce over a frame, and the binding
    // fails a test that leaves one pending — the same two pumps the pager's tests spend.
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    return conn.opens.single;
  }

  testWidgets('opening an agent claims its terminal', (tester) async {
    final conn = PagerConn();
    final app = pagerApp(conn);
    addTearDown(app.dispose);

    final open = await openedWith(
      tester,
      (app) => app.selectAgent('m', 'a'),
      conn,
      app,
    );

    expect(open['agentId'], 'a');
    expect(
      open.containsKey('takeover'),
      isFalse,
      reason: 'no `takeover: false` — the open takes the terminal',
    );
  });

  testWidgets('a tile opened ahead of the thumb asks politely', (tester) async {
    final conn = PagerConn();
    final app = pagerApp(conn);
    addTearDown(app.dispose);
    // A guess is only made where the daemon honours the key at all — see [warmAgentPane].
    app.stateOf('m')!.terminalNoTakeoverAvailable = true;

    final open = await openedWith(
      tester,
      (app) => app.warmAgentPane('m', 'a'),
      conn,
      app,
    );

    expect(open['agentId'], 'a');
    expect(open['takeover'], isFalse, reason: 'a guess never takes a terminal');
  });
}
