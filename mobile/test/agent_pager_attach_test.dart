import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_pane_prune.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_pager_fixture.dart';

/// The pager holds the agent being READ and the agent ONE swipe either side of it — no further out,
/// and nothing it has swiped away from once that agent is no longer a swipe away.
///
/// ⚠️ **Why this has a test of its own.** The daemon keeps a single controller per agent, so an open
/// stream is a claim on that agent's terminal. The pager once kept every agent it had visited, so a
/// lap of the list took them all from the desktop; later it attached two pages either side and kept
/// the last two it left, up to eight at once. One either side is what an instant swipe needs — a
/// swipe goes one page, in either direction — and at most three agents are ever claimed.
void main() {
  Future<(AppNotifier, PagerConn)> pumpPager(WidgetTester tester) async {
    final conn = PagerConn();
    final app = pagerApp(conn);
    addTearDown(app.dispose);
    // The pager attaches ahead of the thumb only where the machine honours the polite open — see
    // `AppNotifier.warmAgentPane`.
    app.stateOf('m')!.terminalNoTakeoverAvailable = true;
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
    // The pager attaches ahead of the thumb only where the machine honours the polite open — see
    // `AppNotifier.warmAgentPane`.
    app.stateOf('m')!.terminalNoTakeoverAvailable = true;
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

  /// The agents the phone has a pane for right now, by id.
  Set<String> openAgents(AppNotifier app) => {
    for (final id in pagerAgentIds)
      if (app.paneOfAgent('m', id) != null) id,
  };

  testWidgets('attaches the agent one swipe either side, and none further', (
    tester,
  ) async {
    final (app, conn) = await pumpPager(tester);

    // Inside the debounce: a page being flung past attaches nothing.
    expect(conn.opens, isEmpty, reason: 'nothing before the page has settled');

    await tester.pump(const Duration(seconds: 2));
    await tester.pump();

    expect(
      {for (final open in conn.opens) open['agentId']},
      {'a', 'c'},
      reason: 'b is on screen; a and c are one swipe either side',
    );
    expect(conn.opens, hasLength(2), reason: 'each opened once');
    expect(app.paneOfAgent('m', 'd'), isNull, reason: 'two swipes away');
    expect(openAgents(app), {'a', 'b', 'c'});
  });

  testWidgets('the ring moves with the swipe, and what fell out of it closes', (
    tester,
  ) async {
    final (app, conn) = await pumpPager(tester);

    await swipeTo(tester, app, 'c');

    expect(app.stateOf('m')?.activeAgentId, 'c', reason: 'the agent read');
    expect(app.paneOfAgent('m', 'c')?.session, isNotNull);
    expect(
      app.paneOfAgent('m', 'b'),
      isNotNull,
      reason: 'b is one swipe back from c, so it stays',
    );
    expect(
      app.paneOfAgent('m', 'a'),
      isNull,
      reason: 'a is two swipes from c now: handed back once the swipe settled',
    );
    expect(openAgents(app), {'b', 'c', 'd'});
    expect(
      conn.opens.where((open) => open['agentId'] == 'c'),
      hasLength(1),
      reason: 'c was already open ahead of the swipe, and is not opened again',
    );
  });

  testWidgets('keeps nothing it has left once it is two swipes behind', (
    tester,
  ) async {
    final (app, _) = await pumpPager(tester);

    await swipeTo(tester, app, 'c');
    await swipeTo(tester, app, 'd');

    // Four agents wrap: d's neighbours are c and a. b was visited, and is not kept for it.
    expect(
      app.paneOfAgent('m', 'b'),
      isNull,
      reason: 'visited, then two swipes behind: handed back',
    );
    expect(openAgents(app), {'a', 'c', 'd'});
  });

  testWidgets('never holds more than three agents open', (tester) async {
    final (app, _) = await pumpPager(tester);

    for (final id in ['c', 'd', 'a', 'b', 'c']) {
      await swipeTo(tester, app, id);
      expect(
        openAgents(app).length,
        lessThanOrEqualTo(3),
        reason: 'on $id: the page and one either side, at most',
      );
    }
  });

  testWidgets(
    'an agent swiped back onto is still attached, in a pushed pager',
    (tester) async {
      final (app, _) = await pushPager(tester);
      await swipeTo(tester, app, 'c');
      expect(openAgents(app), {'b', 'c', 'd'});

      // b's page is still mounted beside c, and its pane is still open — it is one swipe away.
      await swipeTo(tester, app, 'b', towards: 400);

      expect(
        find.byType(AgentSwipeHost),
        findsOneWidget,
        reason: 'swiping back is not the agent going away',
      );
      expect(app.paneOfAgent('m', 'b')?.session, isNotNull);
      expect(
        app.paneOfAgent('m', 'd'),
        isNull,
        reason: 'two swipes from b now: closed in its turn',
      );
      expect(openAgents(app), {'a', 'b', 'c'});
    },
  );
}
