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
import 'package:harness/super_tabs/leaderboard/reader.dart';
import 'package:harness/super_tabs/model.dart' show SuperTabAgent;
import 'package:harness/super_tabs/places.dart';
import 'package:harness/core/models.dart' show Agent;
import 'package:harness/state/harness_activity.dart'
    show HarnessActivity, harnessActivity;
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/harness_activity_mark.dart' show ActivityMark;

import 'package:flutter/gestures.dart' show PointerDeviceKind;

import 'harness_activity_test.dart' show activityQuestion;
import 'super_tab_activity_lists_test.dart' show load, swarm, wait;
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
  Finder ring(String agent) => find.descendant(
    of: key('super-agent-$agent'),
    matching: key('super-lead-ring'),
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
    List<String>? terminals,
    double width = 300,
    Brightness brightness = Brightness.light,
    List<SwarmPage>? pages,
    SwarmPage? page,
    String? boardProjectId,
    SuperTabLeaderboardReader? leaderboard,
    AppNotifier? withApp,
  }) async {
    final server = swarm();
    if (agents != null) server.state['agents'] = agents;
    setup?.call(server);
    final activity = (await tester.runAsync(() => load(server)))!;
    final c = activity.controller;
    final app = withApp ?? createApp();
    if (withApp == null) addTearDown(app.dispose);
    // The design tokens follow the app's brightness, which main.dart sets from the theme.
    final previous = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = previous);
    await tester.binding.setSurfaceSize(Size(width, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
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
              onOpenAgentTerminal: (agent) => terminals?.add(agent.id),
              places: SuperTabPlaces.of(c),
              onNewSwarm: () {},
              onNewProject: () {},
              onPage: (page) => pages?.add(page),
              page: page,
              boardProjectId: boardProjectId,
              leaderboard: leaderboard,
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

  // Swarm v4 (anh Dee 2026-11-08): the org name, Your agents, Projects, Humans; Manage at the foot. No Decisions, Mentions,
  // Threads, Projects grid or Buddy, and an agent's row is its face and name only.
  group('the v4 left pane', () {
    void lead(ConversationServer server) {
      (server.state['conversations'] as List)
              .cast<Map<String, dynamic>>()
              .firstWhere((g) => g['id'] == 'lead')['leadId'] =
          'orion';
    }

    final mine = [
      _agent('kestrel', 'Kestrel'),
      _agent('orion', 'Orion'),
      _agent('tuan-agent', 'Tuan agent', contributor: 'tuan'),
    ];
    double top(WidgetTester tester, String k) => tester.getTopLeft(key(k)).dy;

    testWidgets('org, Your agents, Projects, then Manage', (
      tester,
    ) async {
      await show(tester, agents: mine);
      final order = [
        'super-swarm-switcher',
        'project-sidebar-agents',
        'project-sidebar-projects',
        'super-manage',
      ];
      for (var i = 1; i < order.length; i++) {
        expect(
          top(tester, order[i - 1]),
          lessThan(top(tester, order[i])),
          reason: order[i],
        );
      }
      expect(
        find.descendant(
          of: key('project-sidebar-agents'),
          matching: find.text('Your agents'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('no Decisions, Mentions, Threads or Projects grid', (
      tester,
    ) async {
      await show(tester, agents: mine);
      for (final gone in [
        'super-decisions',
        'super-mentions',
        'super-threads',
        'super-projects',
      ]) {
        expect(key(gone), findsNothing, reason: gone);
      }
    });

    testWidgets('Projects lists each project as a row', (tester) async {
      final c = await show(tester, agents: mine);
      for (final project in c.snapshot!.projects) {
        expect(key('super-project-${project.id}'), findsOneWidget);
      }
    });

    testWidgets('Your agents lists only the reader\'s agents, face and name, '
        'with no detail', (tester) async {
      await show(tester, agents: mine, setup: lead);
      expect(key('super-agent-kestrel'), findsOneWidget);
      expect(key('super-agent-orion'), findsOneWidget);
      expect(key('super-agent-tuan-agent'), findsNothing);
      expect(key('super-swarm-buddy'), findsNothing);
      // The PM still wears the gold ring, and no row says more than its name.
      expect(ring('orion'), findsOneWidget);
      expect(ring('kestrel'), findsNothing);
      for (final agent in ['kestrel', 'orion']) {
        final texts = tester
            .widgetList<Text>(
              find.descendant(
                of: key('super-agent-$agent'),
                matching: find.byType(Text),
              ),
            )
            .map((t) => t.data)
            .whereType<String>()
            .where((t) => t.trim().isNotEmpty);
        expect(texts, [agent == 'orion' ? 'Orion' : 'Kestrel']);
      }
    });

    testWidgets('the + on Your agents opens New agent', (tester) async {
      final created = <String>[];
      await show(tester, agents: mine, created: created);
      await tester.tap(key('project-sidebar-agents-add'));
      await tester.pump();
      expect(created, ['new']);
    });
  });
  group('Humans is the Leaderboard', () {
    SuperTabLeaderboardReader board(List<(String, int)> people) {
      final reader = SuperTabLeaderboardReader(
        tabId: 'tab',
        request: (method, path, {body}) async => {
          'projectId': 'lead',
          'week': 0,
          'people': [
            for (final (i, (id, points)) in people.indexed)
              {'personId': id, 'points': points, 'rank': i + 1},
          ],
        },
      );
      addTearDown(reader.dispose);
      return reader;
    }

    void people(ConversationServer server) =>
        (server.state['people'] as List).addAll([
          for (final id in ['dee', 'ken', 'tuan'])
            {'id': id, 'email': '$id@example.com', 'role': 'collaborator'},
        ]);

    testWidgets('lists people most points first, their points on the right', (
      tester,
    ) async {
      final reader = board([('dee', 120), ('ken', 80), ('owner', 0)]);
      await tester.runAsync(() => reader.show('lead'));
      await show(tester, setup: people, leaderboard: reader);
      expect(
        find.descendant(
          of: key('project-sidebar-humans'),
          matching: find.text('Humans'),
        ),
        findsOneWidget,
      );
      double top(String k) => tester.getTopLeft(key(k)).dy;
      expect(top('super-human-dee'), lessThan(top('super-human-ken')));
      expect(top('super-human-ken'), lessThan(top('super-human-owner')));
      final points = find.descendant(
        of: key('super-human-dee'),
        matching: find.text('120'),
      );
      expect(points, findsOneWidget);
      // Zero still shows, so the column holds.
      expect(
        find.descendant(of: key('super-human-owner'), matching: find.text('0')),
        findsOneWidget,
      );
      expect(
        tester.getRect(points).right,
        greaterThan(tester.getRect(key('super-human-dee')).right - 16),
      );
      expect(top('super-human-owner'), lessThan(top('super-manage')));
    });

    testWidgets('at most 8 people; the heading and every person open the '
        'whole board', (tester) async {
      final reader = board([for (var i = 0; i < 12; i++) ('p$i', 12 - i)]);
      await tester.runAsync(() => reader.show('lead'));
      final pages = <SwarmPage>[];
      await show(tester, leaderboard: reader, pages: pages, setup: people);
      expect(key('super-human-p7'), findsOneWidget);
      expect(key('super-human-p8'), findsNothing);
      await tester.tap(key('project-sidebar-humans'));
      await tester.tap(key('super-human-p0'));
      expect(pages, [SwarmPage.leaderboard, SwarmPage.leaderboard]);
    });

    testWidgets('before the board is read, nothing: an empty list shows no '
        'heading', (tester) async {
      await show(tester, leaderboard: board([('dee', 1)]));
      expect(key('project-sidebar-humans'), findsNothing);
      expect(key('super-human-dee'), findsNothing);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });
  });

  group('the view offers + New agent only with Cmd-N to open', () {
    Future<SuperTabController> view(
      WidgetTester tester, {
      required bool withApp,
      VoidCallback? onNewAgent,
    }) async {
      final server = swarm()..state['agents'] = [_agent('kestrel', 'Kestrel')];
      final c = server.controller(
        account: 'owner',
        initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
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
              onNewAgent: onNewAgent,
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

    testWidgets('the + on My agents opens Cmd-N', (tester) async {
      var opened = 0;
      final c = await view(tester, withApp: true, onNewAgent: () => opened++);
      expect(key('project-sidebar-agents-add'), findsOneWidget);
      await tester.tap(key('project-sidebar-agents-add'));
      await tester.pump();
      expect(opened, 1);
      expect(find.text('Create agent'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });

    testWidgets('without Cmd-N to open it has none', (tester) async {
      final c = await view(tester, withApp: true);
      expect(key('project-sidebar-agents-add'), findsNothing);
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
        initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
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
      // A project's Board opens from the Projects grid (task #4466).
      await tester.tap(find.byKey(const ValueKey('super-projects')));
      await tester.pump();
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
      // A project's Board opens from the Projects grid (task #4466).
      await tester.tap(find.byKey(const ValueKey('super-projects')));
      await tester.pump();
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
      // A project's Board opens from the Projects grid (task #4466).
      await tester.tap(find.byKey(const ValueKey('super-projects')));
      await tester.pump();
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
      // A project's Board opens from the Projects grid (task #4466).
      await tester.tap(find.byKey(const ValueKey('super-projects')));
      await tester.pump();
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
      // A project's Board opens from the Projects grid (task #4466).
      await tester.tap(find.byKey(const ValueKey('super-projects')));
      await tester.pump();
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

      testWidgets(
        'a PM by kind has the Lead ring and opens the chat it names',
        (tester) async {
          final selected = <String>[];
          final c = await show(
            tester,
            agents: [
              {..._agent('zed', 'Zed'), 'kind': 'pm', 'chatId': 'offline'},
              {..._agent('amy', 'Amy'), 'kind': 'regular', 'chatId': null},
            ],
            selected: selected,
          );
          expect(ring('zed'), findsOneWidget);
          expect(ring('amy'), findsNothing);
          await tester.tap(key('super-agent-zed'));
          await tester.pump();
          expect(selected, ['offline']);
          await tester.runAsync(c.flush);
        },
      );

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
        expect(ring('orion'), findsNothing);
      });
    },
  );
}
