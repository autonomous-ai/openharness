import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/buddy_rows.dart' show SuperTabCountBadge;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/my_agents.dart';
import 'package:harness/super_tabs/project_sidebar.dart';

import 'super_tab_activity_lists_test.dart' show load, swarm;
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// Swarm v3's left pane (task #4118, anh Dee 2026-11-07): org switching, Decisions, My agents, then collapsible Projects,
/// closed unless the person has no agents. Mentions goes.
Map<String, dynamic> _agent(
  String id,
  String name, {
  String contributor = 'owner',
}) => {
  'id': id,
  'projectId': 'lead',
  'name': name,
  'displayName': name,
  'machineId': 'host',
  'harnessId': 'session',
  'contributorId': contributor,
  'configuration': {'engine': 'codex'},
};

void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<SuperTabController> show(
    WidgetTester tester, {
    List<Map<String, dynamic>>? agents,
    bool board = true,
    void Function(ConversationServer server)? setup,
    List<String>? selected,
    List<SuperTabAgentKind>? created,
  }) async {
    final server = swarm();
    if (agents != null) server.state['agents'] = agents;
    setup?.call(server);
    final activity = (await tester.runAsync(() => load(server)))!;
    final c = activity.controller;
    final AppNotifier app = createApp();
    addTearDown(app.dispose);
    await tester.binding.setSurfaceSize(const Size(300, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          // The view rebuilds the sidebar as the controller changes.
          body: ListenableBuilder(
            listenable: c,
            builder: (context, _) => ProjectSidebar(
              controller: c,
              app: app,
              onSelect: (id) {
                selected?.add(id);
                c.select(id);
              },
              onNewAgent: created?.add,
              onNewSwarm: () {},
              onNewProject: () {},
              onPage: (_) {},
              activity: activity,
              attention: activity.attention,
              onManage: () {},
              board: board,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    addTearDown(() => tester.pumpWidget(const SizedBox()));
    return c;
  }

  group('Mentions goes', () {
    testWidgets('the Desktop\'s left pane has Decisions and no Mentions', (
      tester,
    ) async {
      await show(tester);
      expect(key('super-decisions'), findsOneWidget);
      expect(key('super-mentions'), findsNothing);
    });

    testWidgets('a layout that is not the Desktop\'s keeps its rows', (
      tester,
    ) async {
      await show(tester, board: false);
      expect(key('super-mentions'), findsOneWidget);
    });
  });

  group('Projects folds', () {
    testWidgets('closed while the person has an agent', (tester) async {
      await show(tester);
      expect(key('project-sidebar-projects'), findsOneWidget);
      expect(key('super-project-lead'), findsNothing);
      expect(find.byTooltip('Expand Projects'), findsOneWidget);
    });

    testWidgets('open when the person has no agents, or only another\'s', (
      tester,
    ) async {
      await show(tester, agents: []);
      expect(key('super-project-lead'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await show(
        tester,
        agents: [_agent('tuan-agent', 'Tuan agent', contributor: 'tuan')],
      );
      expect(key('super-project-lead'), findsOneWidget);
    });

    testWidgets('its heading opens and closes it', (tester) async {
      final c = await show(tester);
      await tester.tap(find.byTooltip('Expand Projects'));
      await tester.pump();
      expect(key('super-project-lead'), findsOneWidget);
      await tester.tap(find.byTooltip('Collapse Projects'));
      await tester.pump();
      expect(key('super-project-lead'), findsNothing);
      // The choice is saved with the view.
      expect(c.projectsGroupOpen, isFalse);
      await tester.runAsync(c.flush);
    });

    testWidgets('a layout that is not the Desktop\'s keeps Projects open', (
      tester,
    ) async {
      await show(tester, board: false);
      expect(key('super-project-lead'), findsOneWidget);
      expect(find.byTooltip('Collapse Projects'), findsNothing);
    });
  });

  group('My agents', () {
    final buddy = {
      ..._agent('buddy', 'Buddy'),
      'buddyScope': 'swarm',
      'buddyOf': {'personId': 'owner'},
    };

    /// The person's Buddy, an agent of theirs at work on a task (Kestrel), a
    /// PM of theirs (Orion, the project's), and another person's agent.
    void agents(ConversationServer server) {
      server.state['swarmBuddy'] = true;
      final groups = (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>();
      groups.firstWhere((g) => g['id'] == 'lead')['leadId'] = 'orion';
      groups.firstWhere((g) => g['id'] == 'offline')['assignment'] = {
        'id': 'a1',
        'agentId': 'kestrel',
        'status': 'working',
      };
    }

    final mine = [
      buddy,
      _agent('kestrel', 'Kestrel'),
      _agent('orion', 'Orion'),
      _agent('tuan-agent', 'Tuan agent', contributor: 'tuan'),
    ];

    double top(WidgetTester tester, String k) => tester.getTopLeft(key(k)).dy;

    testWidgets('lists the Buddy first, then the person\'s own agents and '
        'no one else\'s', (tester) async {
      await show(tester, agents: mine, setup: agents);
      expect(key('project-sidebar-agents'), findsOneWidget);
      expect(
        find.descendant(
          of: key('project-sidebar-agents'),
          matching: find.text('My agents'),
        ),
        findsOneWidget,
      );
      expect(key('super-swarm-buddy'), findsOneWidget);
      expect(
        top(tester, 'super-swarm-buddy'),
        lessThan(top(tester, 'super-agent-kestrel')),
      );
      expect(
        top(tester, 'super-agent-kestrel'),
        lessThan(top(tester, 'super-agent-orion')),
      );
      expect(key('super-agent-tuan-agent'), findsNothing);
      // My agents comes before Projects.
      expect(
        top(tester, 'project-sidebar-agents'),
        lessThan(top(tester, 'project-sidebar-projects')),
      );
    });

    testWidgets('a PM has a crown right after its name, a Regular agent '
        'none', (tester) async {
      await show(tester, agents: mine, setup: agents);
      expect(key('super-agent-crown-orion'), findsOneWidget);
      expect(key('super-agent-crown-kestrel'), findsNothing);
      final name = find.descendant(
        of: key('super-agent-orion'),
        matching: find.text('Orion'),
      );
      final crown = tester.getRect(key('super-agent-crown-orion'));
      expect(crown.left - tester.getRect(name).right, inInclusiveRange(0, 12));
      expect(
        (crown.center.dy - tester.getRect(name).center.dy).abs(),
        lessThan(4),
      );
    });

    testWidgets('unread is a bold name, with no dot and no number', (
      tester,
    ) async {
      await show(
        tester,
        agents: mine,
        setup: (server) {
          agents(server);
          server.append('Done with the change.', conversationId: 'offline');
        },
      );
      FontWeight? weight(String agent, String name) => tester
          .widget<Text>(
            find.descendant(of: key(agent), matching: find.text(name)),
          )
          .style
          ?.fontWeight;
      expect(weight('super-agent-kestrel', 'Kestrel'), FontWeight.w600);
      expect(weight('super-agent-orion', 'Orion'), isNot(FontWeight.w600));
      expect(
        find.descendant(
          of: key('super-agent-kestrel'),
          matching: find.byType(SuperTabCountBadge),
        ),
        findsNothing,
      );
    });

    testWidgets('opening an agent opens its chat: a PM\'s project chat, a '
        'Regular agent\'s task', (tester) async {
      final selected = <String>[];
      await show(tester, agents: mine, setup: agents, selected: selected);
      await tester.tap(key('super-agent-orion'));
      await tester.pump();
      await tester.tap(key('super-agent-kestrel'));
      await tester.pump();
      expect(selected, ['lead', 'offline']);
    });

    testWidgets('an agent with no chat yet opens nothing and says why', (
      tester,
    ) async {
      final selected = <String>[];
      await show(
        tester,
        agents: mine,
        setup: (server) {
          agents(server);
          (server.state['conversations'] as List<Map<String, dynamic>>)
              .firstWhere((g) => g['id'] == 'offline')
              .remove('assignment');
        },
        selected: selected,
      );
      await tester.tap(key('super-agent-kestrel'));
      await tester.pump();
      expect(selected, isEmpty);
      expect(find.byTooltip('Kestrel · no chat yet'), findsOneWidget);
    });

    testWidgets('+ New agent offers Regular or PM and hands the choice on', (
      tester,
    ) async {
      final created = <SuperTabAgentKind>[];
      await show(tester, agents: mine, setup: agents, created: created);
      await tester.tap(find.byTooltip('New agent'));
      await tester.pumpAndSettle();
      expect(key('super-new-agent-regular'), findsOneWidget);
      expect(key('super-new-agent-pm'), findsOneWidget);
      await tester.tap(key('super-new-agent-pm'));
      await tester.pumpAndSettle();
      expect(created, [SuperTabAgentKind.pm]);
      await tester.tap(find.byTooltip('New agent'));
      await tester.pumpAndSettle();
      await tester.tap(key('super-new-agent-regular'));
      await tester.pumpAndSettle();
      expect(created, [SuperTabAgentKind.pm, SuperTabAgentKind.regular]);
    });

    testWidgets('a layout that is not the Desktop\'s has no My agents', (
      tester,
    ) async {
      await show(tester, agents: mine, setup: agents, board: false);
      expect(key('project-sidebar-agents'), findsNothing);
    });
  });
}
