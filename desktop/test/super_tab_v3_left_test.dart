import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/buddy_rows.dart' show SuperTabCountBadge;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart' show SuperTabAgent;
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/view.dart';

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

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 3; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)),
      );
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  Future<SuperTabController> show(
    WidgetTester tester, {
    List<Map<String, dynamic>>? agents,
    bool board = true,
    void Function(ConversationServer server)? setup,
    List<String>? selected,
    List<String>? created,
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
              onNewAgent: () => created?.add('new'),
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
      final c = await show(
        tester,
        agents: mine,
        setup: agents,
        selected: selected,
      );
      await tester.tap(key('super-agent-orion'));
      await tester.pump();
      await tester.tap(key('super-agent-kestrel'));
      await tester.pump();
      expect(selected, ['lead', 'offline']);
      await tester.runAsync(c.flush);
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

    testWidgets('+ New agent hands on to the creation dialog', (tester) async {
      final created = <String>[];
      await show(tester, agents: mine, setup: agents, created: created);
      await tester.tap(find.byTooltip('New agent'));
      await tester.pumpAndSettle();
      expect(created, ['new']);
    });

    testWidgets('a layout that is not the Desktop\'s has no My agents', (
      tester,
    ) async {
      await show(tester, agents: mine, setup: agents, board: false);
      expect(key('project-sidebar-agents'), findsNothing);
    });
  });

  group('the view offers + New agent only with an app', () {
    Future<SuperTabController> view(
      WidgetTester tester, {
      required bool withApp,
    }) async {
      final server = swarm()..state['agents'] = [_agent('kestrel', 'Kestrel')];
      final c = server.controller(
        account: 'owner',
        initial: {
          'tabId': 'tab',
          'accountId': 'owner',
          'selectedId': 'lead',
          'projectsGroupOpen': true,
        },
      );
      await tester.runAsync(c.refresh);
      final AppNotifier? app = withApp ? createApp() : null;
      if (app != null) addTearDown(app.dispose);
      await tester.binding.setSurfaceSize(const Size(1500, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              app: app,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
              board: true,
            ),
          ),
        ),
      );
      await settle(tester);
      return c;
    }

    testWidgets('with an app the heading has + New agent', (tester) async {
      final c = await view(tester, withApp: true);
      expect(find.byTooltip('New agent'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });

    testWidgets('without one it has none', (tester) async {
      final c = await view(tester, withApp: false);
      expect(find.byTooltip('New agent'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });
  });

  group('the middle follows the selected agent', () {
    Future<SuperTabController> view(
      WidgetTester tester, {
      Widget Function(BuildContext)? rightPane,
      void Function(ConversationServer server)? setup,
    }) async {
      final server = swarm()
        ..state['agents'] = [
          _agent('kestrel', 'Kestrel'),
          _agent('orion', 'Orion'),
        ];
      final groups = (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>();
      groups.firstWhere((g) => g['id'] == 'lead')['leadId'] = 'orion';
      groups.firstWhere((g) => g['id'] == 'offline')['assignment'] = {
        'id': 'a1',
        'agentId': 'kestrel',
        'status': 'working',
      };
      server.append('Working on the fix.', conversationId: 'offline');
      server.append('The project chat line.');
      setup?.call(server);
      final c = server.controller(
        account: 'owner',
        initial: {
          'tabId': 'tab',
          'accountId': 'owner',
          'selectedId': 'lead',
          'projectsGroupOpen': true,
        },
      );
      await tester.runAsync(c.refresh);
      await tester.binding.setSurfaceSize(const Size(1600, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
              board: true,
              rightPane: rightPane,
            ),
          ),
        ),
      );
      await settle(tester);
      return c;
    }

    Future<void> end(WidgetTester tester, SuperTabController c) async {
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await tester.pump(const Duration(seconds: 5));
    }

    testWidgets('a Regular agent opens its task\'s chat in the middle', (
      tester,
    ) async {
      final c = await view(tester);
      await tester.tap(key('super-agent-kestrel'));
      await settle(tester);
      expect(c.selectedId, 'offline');
      expect(
        find.descendant(
          of: key('super-center-pane'),
          matching: find.text('Working on the fix.'),
        ),
        findsOneWidget,
      );
      expect(key('super-middle-chat'), findsOneWidget);
      // No Board, and the chat is not in the right pane any more.
      expect(key('super-tasks-lead'), findsNothing);
      expect(key('super-board-chat'), findsNothing);
      expect(key('super-right-pane'), findsOneWidget);
      await end(tester, c);
    });

    testWidgets('the Buddy opens its chat in the middle', (tester) async {
      final c = await view(
        tester,
        setup: (server) {
          server.state['swarmBuddy'] = true;
          (server.state['agents'] as List).add({
            ..._agent('buddy', 'Buddy'),
            'buddyScope': 'swarm',
            'buddyOf': {'personId': 'owner'},
          });
          (server.state['conversations'] as List).add({
            ...conversationFixture('swarm-buddy-owner', 'Buddy'),
            'kind': 'swarm-buddy',
            'buddyOwnerId': 'owner',
            'agentIds': ['buddy'],
          });
          server.append(
            'What shall we work on?',
            conversationId: 'swarm-buddy-owner',
          );
        },
      );
      await tester.tap(key('super-swarm-buddy'));
      await settle(tester);
      expect(c.selectedId, 'swarm-buddy-owner');
      expect(
        find.descendant(
          of: key('super-center-pane'),
          matching: find.text('What shall we work on?'),
        ),
        findsOneWidget,
      );
      expect(key('super-board-chat'), findsNothing);
      await end(tester, c);
    });

    testWidgets('a PM opens its project\'s chat in the middle', (tester) async {
      final c = await view(tester);
      await tester.tap(key('super-agent-orion'));
      await settle(tester);
      expect(c.selectedId, 'lead');
      expect(
        find.descendant(
          of: key('super-center-pane'),
          matching: find.text('The project chat line.'),
        ),
        findsOneWidget,
      );
      expect(key('super-tasks-lead'), findsNothing);
      await end(tester, c);
    });

    testWidgets('a project still opens its Board, Board first', (tester) async {
      final c = await view(tester);
      await tester.tap(key('super-agent-kestrel'));
      await settle(tester);
      await tester.tap(key('super-group-lead'));
      await settle(tester);
      expect(key('super-tasks-lead'), findsOneWidget);
      expect(key('super-middle-chat'), findsNothing);
      expect(
        tester.widget<TextButton>(key('super-board-tab-board')).onPressed,
        isNull,
        reason: 'Board is the tab shown',
      );
      await end(tester, c);
    });

    testWidgets('a project that is selected shows its Board first, and its '
        'Chat tab shows the chat', (tester) async {
      final c = await view(tester, rightPane: (_) => const SizedBox.expand());
      // The project's chat is the selected one at start: the Board is shown.
      expect(c.selectedId, 'lead');
      expect(key('super-tasks-lead'), findsOneWidget);
      await tester.tap(key('super-board-tab-chat'));
      await settle(tester);
      expect(key('super-tasks-lead'), findsNothing);
      expect(
        find.descendant(
          of: key('super-center-pane'),
          matching: find.text('The project chat line.'),
        ),
        findsOneWidget,
      );
      await tester.tap(key('super-board-tab-board'));
      await settle(tester);
      expect(key('super-tasks-lead'), findsOneWidget);
      await end(tester, c);
    });

    testWidgets('the right pane is the Tasks slot: always there, with the '
        'chat in the middle', (tester) async {
      final c = await view(
        tester,
        rightPane: (_) => const Text('Tasks pane', key: ValueKey('tasks-pane')),
      );
      // Even on a project's Board the right pane is the slot, not a chat.
      await tester.tap(key('super-group-lead'));
      await settle(tester);
      expect(
        find.descendant(
          of: key('super-right-pane'),
          matching: key('tasks-pane'),
        ),
        findsOneWidget,
      );
      expect(key('super-board-chat'), findsNothing);
      await tester.tap(key('super-agent-kestrel'));
      await settle(tester);
      expect(
        find.descendant(
          of: key('super-right-pane'),
          matching: key('tasks-pane'),
        ),
        findsOneWidget,
      );
      expect(key('super-middle-chat'), findsOneWidget);
      await end(tester, c);
    });
  });

  group(
    'an agent says what it is and where its person talks to it (#4116)',
    () {
      Map<String, dynamic> row(Map<String, dynamic> extra) => {
        'id': 'a',
        'name': 'A',
        'machineId': 'host',
        'harnessId': 'session',
        'contributorId': 'owner',
        'configuration': <String, dynamic>{},
        ...extra,
      };

      test('the model reads its kind and its chat; an older backend sends '
          'neither', () {
        final pm = SuperTabAgent.fromJson(
          row({'kind': 'pm', 'chatId': 'lead'}),
        );
        expect((pm.kind, pm.chatId), ('pm', 'lead'));
        final older = SuperTabAgent.fromJson(row({}));
        expect((older.kind, older.chatId), (null, null));
      });

      testWidgets('a PM by kind has the crown and opens the chat it names', (
        tester,
      ) async {
        final selected = <String>[];
        final c = await show(
          tester,
          agents: [
            {..._agent('zed', 'Zed'), 'kind': 'pm', 'chatId': 'offline'},
            {..._agent('amy', 'Amy'), 'kind': 'regular', 'chatId': null},
          ],
          selected: selected,
        );
        expect(key('super-agent-crown-zed'), findsOneWidget);
        expect(key('super-agent-crown-amy'), findsNothing);
        await tester.tap(key('super-agent-zed'));
        await tester.pump();
        expect(selected, ['offline']);
        await tester.runAsync(c.flush);
      });

      testWidgets('its kind wins over the project it once led', (tester) async {
        await show(
          tester,
          agents: [
            {..._agent('orion', 'Orion'), 'kind': 'regular', 'chatId': null},
          ],
          setup: (server) =>
              (server.state['conversations'] as List<Map<String, dynamic>>)
                      .firstWhere((g) => g['id'] == 'lead')['leadId'] =
                  'orion',
        );
        expect(key('super-agent-crown-orion'), findsNothing);
      });
    },
  );
}
