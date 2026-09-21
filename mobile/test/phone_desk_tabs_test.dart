import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/phone/desk_groups.dart';
import 'package:harness_mobile/phone/desk_tab_strip.dart';
import 'package:harness_mobile/phone/phone_card.dart';
import 'package:harness_mobile/phone/terminal_header.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/desk_sync.dart';

import 'agent_pager_fixture.dart';
import 'desk_fixture.dart';

/// The home screen inside its tab: a swipe walks the tab the phone is in, and
/// the mark beside `⋯` opens the panel that reaches the others.
///
/// ⚠️ **The pager's `neighbours` is the assertion throughout, because it IS the
/// swipe.** [AgentSwipeHost] pages through exactly that list and nothing else,
/// so a list holding one tab's agents is a swipe that stays inside that tab —
/// which is the whole change, and it can be read without flinging anything.
void main() {
  /// The home screen as the shell mounts it: an agent picked anywhere else —
  /// the tabs panel included — arrives through [AgentHome.openAgent], and the
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

  /// Open the tabs panel from the mark in the header — see [showDeskTabsPopup].
  ///
  /// ⚠️ **Timed pumps, never `pumpAndSettle`.** These pages have no terminal
  /// behind them (see [deskApp]), so each one draws the "Attaching…" skeleton —
  /// which breathes for ever, and `pumpAndSettle` waits for a still frame that
  /// never comes. The waits below are the panel's own open and dismiss
  /// animations.
  Future<void> openPanel(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Tabs'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  /// Tap a tab's name in the open panel, which changes the cards under it and
  /// nothing else.
  Future<void> showTab(WidgetTester tester, String tab) async {
    await tester.tap(find.text(tab));
    await tester.pump();
  }

  /// Tap an agent's card, which opens it and takes the panel away.
  Future<void> openCard(WidgetTester tester, String agent) async {
    await tester.tap(
      find.ancestor(of: find.text(agent), matching: find.byType(PhoneCard)),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  DeskTabStrip strip(WidgetTester tester) =>
      tester.widget<DeskTabStrip>(find.byType(DeskTabStrip));

  /// The agents the panel is offering: one name per card.
  ///
  /// The name is the card's only plain [Text] — `AgentContextLine` draws the
  /// line under it as a `Text.rich`, whose `data` is null.
  List<String> cardsShown(WidgetTester tester) => [
    for (final text in tester.widgetList<Text>(
      find.descendant(of: find.byType(PhoneCard), matching: find.byType(Text)),
    ))
      if (text.data != null) text.data!,
  ];

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

  testWidgets('the panel opens on the tab the agent on screen is in', (
    tester,
  ) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c']),
      ],
    );

    await openPanel(tester);

    expect(strip(tester).selectedId, 't1');
    expect(cardsShown(tester), ['a', 'b']);
    expect(strip(tester).groups.map((group) => group.name), [
      'Desktop',
      'Docker',
      kUntabbedGroupName,
    ]);
  });

  testWidgets('a tab name changes the cards and leaves the terminal alone', (
    tester,
  ) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c', 'd']),
      ],
    );

    await openPanel(tester);
    await showTab(tester, 'Docker');

    // The other tab's agents are on offer...
    expect(strip(tester).selectedId, 't2');
    expect(cardsShown(tester), ['c', 'd']);
    // ...and the phone is still in the tab it was in, on the agent it was on.
    // Looking into another tab is not leaving this one.
    expect(pager(tester).agentId, 'a');
    expect(swipesOver(tester), ['a', 'b']);
  });

  testWidgets('a card opens its agent, and the swipe walks that tab', (
    tester,
  ) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c', 'd']),
      ],
    );

    await openPanel(tester);
    await showTab(tester, 'Docker');
    await openCard(tester, 'd');

    expect(pager(tester).agentId, 'd');
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

    await openPanel(tester);
    await showTab(tester, kUntabbedGroupName);

    expect(cardsShown(tester), ['c', 'd']);

    await openCard(tester, 'c');

    expect(pager(tester).agentId, 'c');
    expect(swipesOver(tester), ['c', 'd']);
  });

  testWidgets('the agent on screen keeps its card, and wears the rim', (
    tester,
  ) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c']),
      ],
    );

    await openPanel(tester);

    PhoneCard cardOf(String agent) => tester.widget<PhoneCard>(
      find.ancestor(of: find.text(agent), matching: find.byType(PhoneCard)),
    );
    expect(cardOf('a').border, isNotNull, reason: 'the agent on screen');
    expect(cardOf('b').border, isNull);
  });

  testWidgets('a tab this phone cannot reach is listed, and says why', (
    tester,
  ) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        // A tab of agents no machine here is listing — one asleep, in life.
        deskTab('t2', 'Away', ['gone']),
      ],
    );

    await openPanel(tester);
    await showTab(tester, 'Away');

    expect(cardsShown(tester), isEmpty);
    expect(find.textContaining('asleep'), findsOneWidget);
  });

  testWidgets('an account with no tabs is offered none', (tester) async {
    // Nothing on the desk: the panel would hold one tab over every agent on
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
