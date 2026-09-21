import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_pane_prune.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_pager_fixture.dart';

/// The pager holds exactly the agent being READ: no other is opened, and the one swiped away from
/// is closed.
///
/// ⚠️ **Why this has a test of its own.** The daemon keeps a single controller per agent, so an open
/// stream is a claim on that agent's terminal. The pager used to open the agent one swipe either
/// side to have its output ready before the swipe landed, and to keep every agent it had visited —
/// so reading one agent on the phone took two more away from the desktop, and a lap of the list took
/// them all.
void main() {
  Future<(AppNotifier, PagerConn)> pumpPager(WidgetTester tester) async {
    final conn = PagerConn();
    final app = pagerApp(conn);
    addTearDown(app.dispose);
    final list = pagerList(app);
    await liveAgent(app, 'b');
    await tester.pumpWidget(
      MaterialApp(
        home: AgentSwipeHost(
          notifier: app,
          machineId: 'm',
          agentId: 'b',
          neighbours: list,
        ),
      ),
    );
    await tester.pump();
    return (app, conn);
  }

  /// The same pager PUSHED over a page, which is how search and the machines tab open it.
  ///
  /// The difference is what a page leaving can do: pushed, `_leave()` takes the route — and with it
  /// every page of the pager — down. As a root it can only no-op, so the regression this guards
  /// against is invisible there.
  Future<(AppNotifier, PagerConn)> pushPager(WidgetTester tester) async {
    final conn = PagerConn();
    final app = pagerApp(conn);
    addTearDown(app.dispose);
    final list = pagerList(app);
    await liveAgent(app, 'b');
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: navigator,
        home: const Scaffold(body: Text('the list')),
      ),
    );
    unawaited(
      navigator.currentState!.push(
        MaterialPageRoute(
          builder: (_) => AgentSwipeHost(
            notifier: app,
            machineId: 'm',
            agentId: 'b',
            neighbours: list,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (app, conn);
  }

  /// A settled swipe, with the page it lands on answering as a machine does — [towards] the next
  /// agent or back to the previous one.
  ///
  /// `pumpAndSettle` is deliberately not used: the page arrived at says "Attaching…" until its
  /// keyframe lands, and that skeleton breathes for ever — see [goLive].
  ///
  /// The pumps run well past [AgentPanePruner.delay], so the agent left behind is closed by the time
  /// this returns.
  Future<void> swipeTo(
    WidgetTester tester,
    AppNotifier app,
    String agentId, {
    double towards = -400,
  }) async {
    await tester.fling(find.byType(PageView), Offset(towards, 0), 1000);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    final session = app.paneOfAgent('m', agentId)?.session;
    if (session != null) await goLive(session);
    // Long enough for the keyframe's ack and the view's first resize, twice over: each coalescing
    // window is armed by the frame before it, and the binding fails a test that leaves one pending.
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    // And past the prune, armed by the frame the page landed on.
    await tester.pump(AgentPanePruner.delay);
    await tester.pump();
  }

  testWidgets('leaves the agents either side of the one on screen alone', (
    tester,
  ) async {
    final (app, conn) = await pumpPager(tester);

    // Well past the beat the neighbours were once opened after.
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();

    expect(conn.opens, isEmpty, reason: 'no stream but the agent being read');
    expect(app.paneOfAgent('m', 'a'), isNull);
    expect(app.paneOfAgent('m', 'c'), isNull);
  });

  testWidgets('opens the agent swiped to, and only when it is swiped to', (
    tester,
  ) async {
    final (app, conn) = await pumpPager(tester);

    await swipeTo(tester, app, 'c');

    expect({for (final open in conn.opens) open['agentId']}, {'c'});
    expect(app.paneOfAgent('m', 'c')?.session, isNotNull);
    expect(app.stateOf('m')?.activeAgentId, 'c', reason: 'the agent read');
    expect(app.paneOfAgent('m', 'd'), isNull, reason: 'one swipe ahead');
    expect(app.paneOfAgent('m', 'a'), isNull, reason: 'one swipe behind');
  });

  testWidgets('closes the agent swiped away from, once the swipe has settled', (
    tester,
  ) async {
    final (app, _) = await pumpPager(tester);
    expect(app.paneOfAgent('m', 'b'), isNotNull, reason: 'the agent read');

    await swipeTo(tester, app, 'c');

    expect(
      app.paneOfAgent('m', 'b'),
      isNull,
      reason: 'handed back to whoever wants it next',
    );
    expect(app.paneOfAgent('m', 'c')?.session, isNotNull);
  });

  testWidgets(
    'an agent swiped back onto is attached again, in a pushed pager',
    (tester) async {
      final (app, _) = await pushPager(tester);
      await swipeTo(tester, app, 'c');
      expect(app.paneOfAgent('m', 'b'), isNull);

      // The page for b is still mounted beside c, and its pane is the one just closed.
      await swipeTo(tester, app, 'b', towards: 400);

      expect(
        find.byType(AgentSwipeHost),
        findsOneWidget,
        reason: 'a pane closed behind the pager is not the agent going away',
      );
      expect(app.paneOfAgent('m', 'b')?.session, isNotNull);
      expect(app.paneOfAgent('m', 'c'), isNull, reason: 'closed in its turn');
    },
  );
}
