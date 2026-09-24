import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_pane_prune.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_pager_fixture.dart';

/// The pager holds a HANDFUL of agents open — the one being read, the ones a swipe or two away, and
/// the two just left — and hands the rest back a beat after each swipe. See `AgentSwipeHost._keepSet`.
///
/// ⚠️ **Why this has a test of its own.** The daemon keeps a single controller per agent, so an open
/// stream is a claim on that agent's terminal. The pager once kept every agent it had visited, so a
/// lap of the list took them all away from the desktop.
///
/// The fixture's machine predates `terminalNoTakeoverAvailable`, so nothing here is attached AHEAD of
/// a swipe (`AppNotifier.warmAgentPane`): every open below is a page landed on.
void main() {
  /// Longer than the pager's keep-set can cover — its reach either side, and the agents just left —
  /// so swiping through it leaves agents behind to close. [pagerAgentIds] is four agents that wrap,
  /// every one of them always within reach.
  const longList = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

  void lengthen(AppNotifier app) => app.stateOf('m')!.agents = [
    for (final id in longList)
      Agent(
        id: id,
        name: id,
        engine: 'claude',
        project: const AgentProject(name: 'work', cwd: '/work'),
        terminalAvailable: true,
      ),
  ];

  Future<(AppNotifier, PagerConn)> pumpPager(
    WidgetTester tester, {
    bool long = false,
  }) async {
    final conn = PagerConn();
    final app = pagerApp(conn);
    addTearDown(app.dispose);
    if (long) lengthen(app);
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

  testWidgets(
    'keeps the agent just left, and closes it once the swipes leave it behind',
    (tester) async {
      final (app, _) = await pumpPager(tester, long: true);
      expect(app.paneOfAgent('m', 'b'), isNotNull, reason: 'the agent read');

      await swipeTo(tester, app, 'c');
      expect(
        app.paneOfAgent('m', 'b'),
        isNotNull,
        reason: 'just left, so going back is instant',
      );
      expect(app.paneOfAgent('m', 'c')?.session, isNotNull);

      for (final agent in ['d', 'e', 'f']) {
        await swipeTo(tester, app, agent);
      }

      expect(
        app.paneOfAgent('m', 'b'),
        isNull,
        reason: 'out of reach and no longer recent: handed back',
      );
      expect(app.paneOfAgent('m', 'f')?.session, isNotNull);
    },
  );

  testWidgets(
    'an agent swiped back onto is attached again, in a pushed pager',
    (tester) async {
      final (app, _) = await pushPager(tester);
      await swipeTo(tester, app, 'c');
      // Closed the way the prune closes it, while the page for b is still mounted beside c.
      releaseAgentPanes(app, [
        (machineId: 'm', agentId: 'b'),
      ], heldElsewhere: (_) => false);
      await tester.pump();
      expect(app.paneOfAgent('m', 'b'), isNull);

      await swipeTo(tester, app, 'b', towards: 400);

      expect(
        find.byType(AgentSwipeHost),
        findsOneWidget,
        reason: 'a pane closed behind the pager is not the agent going away',
      );
      expect(app.paneOfAgent('m', 'b')?.session, isNotNull);
      expect(app.paneOfAgent('m', 'c'), isNotNull, reason: 'just left, kept');
    },
  );
}
