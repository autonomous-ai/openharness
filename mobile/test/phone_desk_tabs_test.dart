import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/phone/desk_groups.dart';
import 'package:harness_mobile/phone/terminal_header.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/desk_sync.dart';

import 'agent_pager_fixture.dart';
import 'desk_fixture.dart';

/// The home screen inside its tab: a swipe walks the tab the phone is in, and
/// the mark beside `⋯` is how it gets to another one.
///
/// ⚠️ **The pager's `neighbours` is the assertion throughout, because it IS the
/// swipe.** [AgentSwipeHost] pages through exactly that list and nothing else,
/// so a list holding one tab's agents is a swipe that stays inside that tab —
/// which is the whole change, and it can be read without flinging anything.
void main() {
  /// The home screen as the shell mounts it: an agent picked anywhere else —
  /// the tabs sheet included — arrives through [AgentHome.openAgent], and the
  /// shell is what carries it there.
  Future<AppNotifier> pumpHome(
    WidgetTester tester, {
    required List<DeskTab> tabs,
  }) async {
    final app = await deskApp(
      PagerConn(),
      // Nothing here is about the terminals themselves — see [deskApp].
      opensTerminals: false,
      tabs: tabs,
    );
    addTearDown(app.dispose);
    final request = ValueNotifier<({String machineId, String agentId})?>(null);
    addTearDown(request.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: PhoneShellScope(
          onMachineLinked: (_) {},
          onOpenAgent: (machineId, agentId) =>
              request.value = (machineId: machineId, agentId: agentId),
          child: AgentHome(notifier: app, openAgent: request),
        ),
      ),
    );
    await tester.pump();
    return app;
  }

  AgentSwipeHost pager(WidgetTester tester) =>
      tester.widget<AgentSwipeHost>(find.byType(AgentSwipeHost));

  /// Open the tabs sheet from the mark in the header, and pick [tab] in it.
  ///
  /// ⚠️ **Timed pumps, never `pumpAndSettle`.** These pages have no terminal
  /// behind them (see [deskApp]), so each one draws the "Attaching…" skeleton —
  /// which breathes for ever, and `pumpAndSettle` waits for a still frame that
  /// never comes. The waits below are the sheet's own open and dismiss
  /// animations; the row runs its action after the dismissal (see
  /// [showPhoneSheet]), so the second one is the switch as well.
  Future<void> switchTo(WidgetTester tester, String tab) async {
    await tester.tap(find.byTooltip('Tabs'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text(tab));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  List<String> swipesOver(WidgetTester tester) => [
    for (final entry in pager(tester).neighbours!.entries) entry.agent.id,
  ];

  testWidgets('a swipe walks the tab the agent on screen is in', (
    tester,
  ) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c']),
      ],
    );

    expect(pager(tester).agentId, 'a');
    expect(swipesOver(tester), ['a', 'b']);
  });

  testWidgets('tapping a tab opens its first agent, and swipes inside it', (
    tester,
  ) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c', 'd']),
      ],
    );

    await switchTo(tester, 'Docker');

    expect(pager(tester).agentId, 'c');
    expect(swipesOver(tester), ['c', 'd']);
  });

  testWidgets('the agents no tab holds are a tab of their own', (tester) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a']),
        deskTab('t2', 'Docker', ['b']),
      ],
    );

    await switchTo(tester, kUntabbedGroupName);

    expect(pager(tester).agentId, 'c');
    expect(swipesOver(tester), ['c', 'd']);
  });

  testWidgets('coming back to a tab returns to the agent it was left on', (
    tester,
  ) async {
    final app = await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c', 'd']),
      ],
    );

    await switchTo(tester, 'Docker');
    expect(pager(tester).agentId, 'c');
    // Desktop was left on `b` — what a swipe inside that tab records, and what
    // the home screen writes down on every build it draws (`noteDeskTab`).
    app.noteDeskTab('t1', showing: (machineId: 'm', agentId: 'b'));

    await switchTo(tester, 'Desktop');

    expect(pager(tester).agentId, 'b');
  });

  testWidgets('an account with no tabs is offered none', (tester) async {
    // Nothing on the desk: the sheet would hold one row naming every agent on
    // the account, which is what a swipe already walks. So no mark at all, and
    // the header is the row it has always been.
    await pumpHome(tester, tabs: []);

    expect(find.byTooltip('Tabs'), findsNothing);
    expect(swipesOver(tester), ['a', 'b', 'c', 'd']);
  });

  testWidgets('the tabs mark sits in the header, not over the terminal', (
    tester,
  ) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c']),
      ],
    );

    // One mark, inside the header's own row — nothing is stacked under it, so
    // the terminal keeps every line it had before the desk existed.
    final mark = find.byTooltip('Tabs');
    expect(mark, findsOneWidget);
    expect(
      tester.getCenter(mark).dy,
      lessThan(TerminalHeader.height),
      reason: 'the mark rides the header row',
    );
  });

  testWidgets('a tab changed on another computer moves the swipe with it', (
    tester,
  ) async {
    final app = await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a']),
        deskTab('t2', 'Docker', ['c']),
      ],
    );
    expect(swipesOver(tester), ['a']);

    // A window on some computer adds an agent to the tab this phone is in.
    deskApiOf(app).tabs = [
      deskTab('t1', 'Desktop', ['a', 'b']),
      deskTab('t2', 'Docker', ['c']),
    ];
    deskApiOf(app).revision++;
    await syncDesk(app);
    await tester.pump();

    expect(pager(tester).agentId, 'a');
    expect(swipesOver(tester), ['a', 'b']);
  });
}
