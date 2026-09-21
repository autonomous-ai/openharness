import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/phone/desk_groups.dart';
import 'package:harness_mobile/phone/desk_tab_strip.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/desk_sync.dart';

import 'agent_pager_fixture.dart';
import 'desk_fixture.dart';

/// The home screen inside its tab: a swipe walks the tab the phone is in, and
/// the strip is how it gets to another one.
///
/// ⚠️ **The pager's `neighbours` is the assertion throughout, because it IS the
/// swipe.** [AgentSwipeHost] pages through exactly that list and nothing else,
/// so a list holding one tab's agents is a swipe that stays inside that tab —
/// which is the whole change, and it can be read without flinging anything.
void main() {
  /// The home screen as the shell mounts it: an agent picked anywhere else —
  /// the strip included — arrives through [AgentHome.openAgent], and the shell
  /// is what carries it there.
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

    await tester.tap(find.text('Docker'));
    await tester.pump();
    await tester.pump();

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

    await tester.tap(find.text(kUntabbedGroupName));
    await tester.pump();
    await tester.pump();

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

    // Swiped to `b` and then away to the other tab.
    app.noteDeskTab('t1', showing: (machineId: 'm', agentId: 'b'));
    await tester.tap(find.text('Docker'));
    await tester.pump();
    await tester.pump();
    expect(pager(tester).agentId, 'c');

    await tester.tap(find.text('Desktop'));
    await tester.pump();
    await tester.pump();

    expect(pager(tester).agentId, 'b');
  });

  testWidgets('one tab is no choice, so no strip is drawn', (tester) async {
    // Every agent on the one tab: nothing to switch to, and the header is the
    // row it has always been.
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b', 'c', 'd']),
      ],
    );

    expect(find.byType(DeskTabStrip), findsNothing);
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
    await app.deskSyncForTest();
    await tester.pump();

    expect(pager(tester).agentId, 'a');
    expect(swipesOver(tester), ['a', 'b']);
  });
}
