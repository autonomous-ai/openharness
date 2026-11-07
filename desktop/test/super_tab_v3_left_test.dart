import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/super_tabs/buddy_rows.dart' show SuperTabCountBadge;
import 'package:harness/super_tabs/identity.dart' show SuperTabAvatar;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart' show SuperTabAgent;
import 'package:harness/super_tabs/places.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show load, swarm;
import 'support/capture.dart';
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

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

void main() {
  Finder key(String k) => find.byKey(ValueKey(k));
  Finder crown(String agent) => find.descendant(
    of: key('super-agent-$agent'),
    matching: find.byIcon(AppIcons.crown),
  );
  Finder text(String agent, String text) =>
      find.descendant(of: key('super-agent-$agent'), matching: find.text(text));

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
    double width = 300,
    Brightness brightness = Brightness.light,
  }) async {
    final server = swarm();
    if (agents != null) server.state['agents'] = agents;
    setup?.call(server);
    final activity = (await tester.runAsync(() => load(server)))!;
    final c = activity.controller;
    final AppNotifier app = createApp();
    addTearDown(app.dispose);
    await tester.binding.setSurfaceSize(Size(width, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
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
              places: SuperTabPlaces.of(c),
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

  group('the org switcher is the first thing in the left pane', () {
    // Task #4192 (anh Dee 11-07): no back and forward arrows under it; ⌘[ and ⌘] still step back and forward.
    testWidgets('on the Desktop it sits above Decisions, with no back and '
        'forward arrows', (tester) async {
      await show(tester);
      double top(String k) => tester.getTopLeft(key(k)).dy;
      expect(top('super-swarm-switcher'), lessThan(top('super-decisions')));
      expect(key('super-back'), findsNothing);
      expect(key('super-forward'), findsNothing);
    });

    testWidgets('a layout that is not the Desktop\'s keeps its order', (
      tester,
    ) async {
      await show(tester, board: false);
      double top(String k) => tester.getTopLeft(key(k)).dy;
      expect(top('super-back'), lessThan(top('super-swarm-switcher')));
    });
  });

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

    // Task #4192 (anh Dee 11-07): his list showed about 30 rows, Team-account and finished agents he never started among
    // them. The server says which agents are the reader's; the list follows it.
    testWidgets('lists only the agents the server says are the reader\'s', (
      tester,
    ) async {
      await show(
        tester,
        agents: [
          {...buddy, 'myAgent': true},
          {..._agent('kestrel', 'Kestrel'), 'myAgent': true},
          {..._agent('avatarrow', 'Avatarrow'), 'myAgent': false},
          {..._agent('fir', 'Fir'), 'myAgent': false},
        ],
        setup: agents,
      );
      expect(key('super-swarm-buddy'), findsOneWidget);
      expect(key('super-agent-kestrel'), findsOneWidget);
      expect(key('super-agent-avatarrow'), findsNothing);
      expect(key('super-agent-fir'), findsNothing);
    });

    // Task #4421 (anh Dee 11-07): "let's just put a leader crown on the avatar. it's too much." and "let's put the project
    // name next to the one that it leads".
    testWidgets('a PM wears its crown on its avatar and names the project it '
        'leads after its name; a Regular agent neither', (tester) async {
      await show(tester, agents: mine, setup: agents);
      expect(crown('orion'), findsOneWidget);
      final avatar = tester.getRect(
        find.descendant(
          of: key('super-agent-orion'),
          matching: find.byType(SuperTabAvatar),
        ),
      );
      final badge = tester.getRect(crown('orion'));
      // On the avatar's top right corner, not after the name.
      expect(badge.center.dx, greaterThan(avatar.center.dx));
      expect(badge.center.dy, lessThan(avatar.center.dy));
      expect(badge.left, lessThan(avatar.right));
      final name = tester.getRect(text('orion', 'Orion'));
      expect(badge.right, lessThan(name.left));
      final project = tester.getRect(text('orion', 'web-project'));
      expect(project.left, greaterThan(name.right));
      expect((project.center.dy - name.center.dy).abs(), lessThan(4));
      expect(
        tester.widget<Text>(text('orion', 'web-project')).style?.color,
        grid.SidebarInk.muted(tester.element(key('super-agent-orion'))),
      );
      expect(crown('kestrel'), findsNothing);
      expect(text('kestrel', 'web-project'), findsNothing);
    });

    testWidgets('in a narrow pane the project name is cut before the agent\'s '
        'name', (tester) async {
      await show(
        tester,
        agents: [
          buddy,
          {..._agent('orion', 'Orion Lead'), 'kind': 'pm'},
        ],
        setup: agents,
        width: 280,
      );
      bool cut(String shown) => tester
          .renderObject<RenderParagraph>(text('orion', shown))
          .didExceedMaxLines;
      expect(cut('web-project'), isTrue);
      expect(cut('Orion Lead'), isFalse);
    });

    testWidgets('screenshots of My agents, light and dark', (tester) async {
      for (final (brightness, name) in [
        (Brightness.light, 'light'),
        (Brightness.dark, 'dark'),
      ]) {
        await show(tester, agents: mine, setup: agents, brightness: brightness);
        await captureWindow(tester, shots, 'my-agents-pm-crown-$name');
        await tester.pumpWidget(const SizedBox());
      }
    }, skip: shots == null);

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

    testWidgets('+ New agent is the last row, below the agents, and hands on '
        'to the creation dialog', (tester) async {
      final created = <String>[];
      await show(tester, agents: mine, setup: agents, created: created);
      expect(find.byTooltip('New agent'), findsNothing);
      expect(
        top(tester, 'super-new-agent-row'),
        greaterThan(top(tester, 'super-agent-orion')),
      );
      expect(
        top(tester, 'super-new-agent-row'),
        lessThan(top(tester, 'project-sidebar-projects')),
      );
      expect(
        find.descendant(
          of: key('super-new-agent-row'),
          matching: find.text('New agent'),
        ),
        findsOneWidget,
      );
      await tester.tap(key('super-new-agent-row'));
      await tester.pumpAndSettle();
      expect(created, ['new']);
    });

    // Task #4192: My agents folds with the same chevron as Projects, and the choice is remembered.
    testWidgets('its heading folds and unfolds it, and the choice is saved', (
      tester,
    ) async {
      late ConversationServer server;
      final c = await show(
        tester,
        agents: mine,
        setup: (s) {
          server = s;
          agents(s);
        },
      );
      expect(key('super-agent-kestrel'), findsOneWidget);
      await tester.tap(find.byTooltip('Collapse My agents'));
      await tester.pump();
      for (final row in [
        'super-swarm-buddy',
        'super-agent-kestrel',
        'super-new-agent-row',
      ]) {
        expect(key(row), findsNothing, reason: row);
      }
      expect(key('project-sidebar-agents'), findsOneWidget);
      expect(c.agentsGroupOpen, isFalse);
      await tester.runAsync(c.flush);
      final again = server.controller(initial: server.saved);
      addTearDown(again.dispose);
      expect(again.agentsGroupOpen, isFalse);
      await tester.tap(find.byTooltip('Expand My agents'));
      await tester.pump();
      expect(key('super-agent-kestrel'), findsOneWidget);
      expect(c.agentsGroupOpen, isTrue);
      await tester.runAsync(c.flush);
    });

    // Task #4192: the Buddy wears the face every agent has, not the robot icon, and is still first.
    testWidgets('the Buddy has the avatar every agent has, first', (
      tester,
    ) async {
      await show(
        tester,
        agents: mine,
        setup: (server) {
          agents(server);
          (server.state['conversations'] as List).add({
            ...conversationFixture('swarm-buddy-owner', 'Buddy'),
            'kind': 'swarm-buddy',
            'buddyOwnerId': 'owner',
            'agentIds': ['buddy'],
          });
        },
      );
      Finder inBuddy(Finder f) =>
          find.descendant(of: key('super-swarm-buddy'), matching: f);
      expect(inBuddy(find.byType(SuperTabAvatar)), findsOneWidget);
      expect(inBuddy(find.byIcon(AppIcons.bot)), findsNothing);
      expect(
        tester.getSize(inBuddy(find.byType(SuperTabAvatar))),
        tester.getSize(
          find.descendant(
            of: key('super-agent-kestrel'),
            matching: find.byType(SuperTabAvatar),
          ),
        ),
      );
      expect(
        top(tester, 'super-swarm-buddy'),
        lessThan(top(tester, 'super-agent-kestrel')),
      );
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

    testWidgets('with an app the last row of My agents is + New agent', (
      tester,
    ) async {
      final c = await view(tester, withApp: true);
      expect(key('super-new-agent-row'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });

    testWidgets('without one it has none', (tester) async {
      final c = await view(tester, withApp: false);
      expect(key('super-new-agent-row'), findsNothing);
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

    testWidgets('the right pane is a fixed 340 and the middle has the rest', (
      tester,
    ) async {
      final c = await view(tester, rightPane: (_) => const SizedBox.expand());
      await tester.tap(key('super-group-lead'));
      await settle(tester);
      double w(String k) => tester.getSize(key(k)).width;
      expect(w('super-right-pane'), 340);
      expect(
        w('super-center-pane'),
        closeTo(1600 - w('super-left-pane') - 340, 1),
      );
      // Fixed: no divider to drag.
      expect(key('super-resize-right'), findsNothing);
      await end(tester, c);
    });

    testWidgets('Board and Chat are the one view switch: Board is not '
        'repeated, and the selected tab reads as selected', (tester) async {
      final c = await view(tester, rightPane: (_) => const SizedBox.expand());
      await tester.tap(key('super-group-lead'));
      await settle(tester);
      expect(key('super-tasks-layout-board'), findsNothing);
      expect(find.text('Board'), findsOneWidget);
      final style = tester
          .widget<TextButton>(key('super-board-tab-board'))
          .style!;
      expect(
        style.foregroundColor!.resolve({WidgetState.disabled}),
        DesktopChrome.foreground,
        reason: 'the tab shown is not greyed as a disabled button',
      );
      await end(tester, c);
    });

    testWidgets('List and Members are toggles back to the Board', (
      tester,
    ) async {
      final c = await view(tester, rightPane: (_) => const SizedBox.expand());
      await tester.tap(key('super-group-lead'));
      await settle(tester);
      for (final layout in ['list', 'members']) {
        expect(key('super-tasks-board'), findsOneWidget);
        await tester.tap(key('super-tasks-layout-$layout'));
        await settle(tester);
        expect(key('super-tasks-board'), findsNothing, reason: layout);
        await tester.tap(key('super-tasks-layout-$layout'));
        await settle(tester);
        expect(key('super-tasks-board'), findsOneWidget, reason: layout);
      }
      await end(tester, c);
    });

    testWidgets('a person\'s own agent chat sends without a Lead', (
      tester,
    ) async {
      final c = await view(
        tester,
        setup: (server) {
          (server.state['agents'] as List<Map<String, dynamic>>)
              .firstWhere((a) => a['id'] == 'kestrel')
              .addAll({'kind': 'regular', 'chatId': 'agent-chat-kestrel'});
          (server.state['conversations'] as List).add({
            ...conversationFixture('agent-chat-kestrel', 'Kestrel'),
            'kind': 'agent-chat',
            'agentIds': ['kestrel'],
          });
          server.append(
            'Please look at the build.',
            conversationId: 'agent-chat-kestrel',
          );
          server.messages.last['author'] = {
            'kind': 'person',
            'id': 'owner',
            'name': 'owner@example.com',
          };
        },
      );
      await tester.tap(key('super-agent-kestrel'));
      await settle(tester);
      expect(c.selectedId, 'agent-chat-kestrel');
      expect(find.text('Please look at the build.'), findsOneWidget);
      expect(find.text('Not sent · this chat has no Lead'), findsNothing);
      expect(find.text('Add a Lead'), findsNothing);
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
        expect(crown('zed'), findsOneWidget);
        expect(crown('amy'), findsNothing);
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
        expect(crown('orion'), findsNothing);
      });
    },
  );
}
