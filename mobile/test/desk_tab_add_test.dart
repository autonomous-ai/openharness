import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/agent_tile.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/desk_sync.dart';

import 'agent_pager_fixture.dart';
import 'desk_fixture.dart';

/// The two `+`s on the tabs panel: one opens a tab, one fills the tab being
/// read.
///
/// ⚠️ **They are the same glyph, so every test here asserts on what was WRITTEN
/// to the desk rather than on what was tapped.** A `+` that made a tab where it
/// should have added an agent would look identical on screen and be wrong on
/// every computer the person owns.
void main() {
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
    // ⚠️ A phone's shape, not the 800x600 a widget test defaults to. Both
    // sheets here keep half the screen for their list, and on a landscape
    // window the rows to tap sit below the bottom edge.
    tester.view.physicalSize = const Size(400, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
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

  /// ⚠️ Timed pumps, never `pumpAndSettle`: these pages draw the "Attaching…"
  /// skeleton, which breathes for ever. The waits are the sheets' own
  /// animations.
  Future<void> openPanel(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Tabs'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  Future<void> showTab(WidgetTester tester, String tab) async {
    await tester.tap(find.text(tab));
    await tester.pump();
  }

  Future<void> settleSheet(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  /// An agent's row, wherever it is drawn.
  Finder row(String agent) => find.byWidgetPredicate(
    (widget) => widget is AgentTile && widget.agent.id == agent,
  );

  testWidgets('the + on the tab row opens a tab holding the agent picked', (
    tester,
  ) async {
    final app = await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a']),
      ],
    );

    await openPanel(tester);
    await tester.tap(find.bySemanticsLabel('New tab'));
    await settleSheet(tester);
    // `c` is in no tab, so its row exists only in the sheet.
    await tester.tap(row('c'));
    await settleSheet(tester);

    final written = deskApiOf(app).written;
    expect(written, hasLength(2));
    expect(written.first['op'], 'tab.create');
    expect(
      written.first['name'],
      'c',
      reason: 'a tab made for one agent is named after it',
    );
    expect(
      written.first['nameIsCustom'],
      false,
      reason: 'the name is the agent\'s, not one a person typed',
    );
    expect(written[1], {
      'op': 'pane.add',
      'tabId': written.first['id'],
      'machineId': 'm',
      'agentId': 'c',
    });
    expect(app.deskTabs.map((tab) => tab.name), [
      'Desktop',
      'c',
    ], reason: 'the new tab is last on the row');
    expect(
      app.activeDeskTabId,
      written.first['id'],
      reason: 'the person made it to be in it',
    );
  });

  testWidgets('the + under a tab adds the agent to THAT tab', (tester) async {
    final app = await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a']),
        deskTab('t2', 'Docker', ['b']),
      ],
    );

    await openPanel(tester);
    await showTab(tester, 'Docker');
    await tester.tap(find.bySemanticsLabel('Add agent to Docker'));
    await settleSheet(tester);
    await tester.tap(row('d'));
    await settleSheet(tester);

    expect(deskApiOf(app).written, [
      {'op': 'pane.add', 'tabId': 't2', 'machineId': 'm', 'agentId': 'd'},
    ]);
    expect(
      app.deskTabs
          .firstWhere((tab) => tab.id == 't2')
          .panes
          .map((pane) => pane.agentId),
      ['b', 'd'],
    );
    expect(
      row('d'),
      findsOneWidget,
      reason: 'the panel stays open, and the agent is in the list it filled',
    );
  });

  testWidgets('a tab is not offered the agents it already holds', (
    tester,
  ) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
      ],
    );

    await openPanel(tester);
    await tester.tap(find.bySemanticsLabel('Add agent to Desktop'));
    await settleSheet(tester);

    // `a` and `b` are in the tab, and the panel under the sheet still draws
    // their rows — one each, from the list behind, and none from the sheet.
    expect(row('a'), findsOneWidget);
    expect(row('b'), findsOneWidget);
    expect(row('c'), findsOneWidget);
    expect(row('d'), findsOneWidget);
  });

  testWidgets('a tab emptied of agents says so, and can still be filled', (
    tester,
  ) async {
    await pumpHome(tester, tabs: [deskTab('t1', 'Empty', [])]);

    await openPanel(tester);
    // The panel opens on the group holding the agent on screen, which is the
    // leftover one — every agent is outside this tab.
    await showTab(tester, 'Empty');

    expect(find.text('This tab has no agents yet.'), findsOneWidget);
    expect(
      find.textContaining('asleep'),
      findsNothing,
      reason: 'a tab holding nothing is not a tab whose machine is away',
    );
    expect(find.bySemanticsLabel('Add agent to Empty'), findsOneWidget);
  });

  testWidgets('the agents no tab holds are offered no + of their own', (
    tester,
  ) async {
    await pumpHome(
      tester,
      tabs: [
        deskTab('t1', 'Desktop', ['a']),
      ],
    );

    await openPanel(tester);
    await showTab(tester, 'Other');

    // "Other" is not a tab — there is nothing on the desk to add an agent to.
    expect(find.textContaining('Add agent to'), findsNothing);
    expect(
      find.bySemanticsLabel('New tab'),
      findsOneWidget,
      reason: 'the tab row keeps its own +, whichever group is being read',
    );
  });
}
