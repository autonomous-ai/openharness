import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/phone/desk_groups.dart';
import 'package:harness_mobile/phone/desk_tab_strip.dart';
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
  /// the tab rail included — arrives through [AgentHome.openAgent], and the
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

  /// Open the rail from the mark in the header — see [DeskTabStrip].
  ///
  /// ⚠️ **Timed pumps, never `pumpAndSettle`.** These pages have no terminal
  /// behind them (see [deskApp]), so each one draws the "Attaching…" skeleton —
  /// which breathes for ever, and `pumpAndSettle` waits for a still frame that
  /// never comes. The wait is the rail's own unroll.
  Future<void> openRail(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Tabs'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  /// Pick [tab] in the rail already open, which switches and closes at once.
  Future<void> pick(WidgetTester tester, String tab) async {
    await tester.tap(find.text(tab));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  /// Open the rail and pick [tab] in it.
  Future<void> switchTo(WidgetTester tester, String tab) async {
    await openRail(tester);
    await pick(tester, tab);
  }

  DeskTabStrip rail(WidgetTester tester) =>
      tester.widget<DeskTabStrip>(find.byType(DeskTabStrip));

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
    // Nothing on the desk: the rail would carry one name over every agent on
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

  testWidgets('the rail is drawn only while the mark is on', (tester) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c']),
      ],
    );

    // The terminal keeps its rows until somebody asks for the tabs.
    expect(find.byType(DeskTabStrip), findsNothing);

    await openRail(tester);
    expect(rail(tester).groups.map((group) => group.name), [
      'Desktop',
      'Docker',
      kUntabbedGroupName,
    ]);

    // The same mark puts it away again.
    await openRail(tester);
    expect(find.byType(DeskTabStrip), findsNothing);
  });

  testWidgets('the rail bars the tab the agent on screen is in', (
    tester,
  ) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c']),
      ],
    );

    await openRail(tester);
    expect(rail(tester).activeId, 't1');

    // The rail is already open, so this is the pick alone — opening it again
    // here would put it away.
    await pick(tester, 'Docker');
    await openRail(tester);
    expect(rail(tester).activeId, 't2');
  });

  testWidgets('picking the tab you are in only closes the rail', (
    tester,
  ) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c']),
      ],
    );

    await switchTo(tester, 'Desktop');

    // Still on `a`, and the rail is away: re-opening the tab already on screen
    // would re-attach the terminal under it for nothing.
    expect(pager(tester).agentId, 'a');
    expect(swipesOver(tester), ['a', 'b']);
    expect(find.byType(DeskTabStrip), findsNothing);
  });
}
