import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/leaderboard/shipping.dart';
import 'package:harness/super_tabs/model.dart' show SuperTabAgent;
import 'package:harness/super_tabs/places.dart';
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

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

void main() {
  Finder key(String k) => find.byKey(ValueKey(k));
  Finder ring(String agent) => find.descendant(
    of: key('super-agent-$agent'),
    matching: key('super-lead-ring'),
  );

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
    SuperTabShippingReader? leaderboard,
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

  // Swarm v4 (anh Dee 2026-11-08): the org name, Your Team, Projects, Top Teams; Manage at the foot. No Decisions, Mentions,
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

    testWidgets('org, Your Team, Projects, then Manage', (tester) async {
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
          matching: find.text('Your Team'),
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

    testWidgets('Your Team lists only the reader\'s agents, face and name, '
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

    testWidgets('the + on Your Team opens New agent', (tester) async {
      final created = <String>[];
      await show(tester, agents: mine, created: created);
      await tester.tap(key('project-sidebar-agents-add'));
      await tester.pump();
      expect(created, ['new']);
    });
  });
  group('the left pane\'s sections fold', () {
    SuperTabShippingReader board() {
      final reader = SuperTabShippingReader(
        tabId: 'tab',
        request: (method, path, {body}) async => {
          'week': 1793577600000,
          'people': [
            {
              'personId': 'dee',
              'displayName': 'dee',
              'agentsShipping': 3,
              'level': 3,
              'points': 12.5,
              'rank': 1,
            },
          ],
          'failures': <dynamic>[],
        },
      );
      addTearDown(reader.dispose);
      return reader;
    }

    // Two computers of this account, one a team's, one another's: only the account's own are its machines. Old Rig is off,
    // unless [rigUp].
    AppNotifier appWithMachines({bool rigUp = false}) {
      final app = createApp();
      addTearDown(app.dispose);
      app.machines = [
        const Machine(
          machineId: 'm3',
          authMode: MachineAuthMode.remote,
          name: 'Mac 3',
          status: 'running',
        ),
        Machine(
          machineId: 'rig',
          authMode: MachineAuthMode.remote,
          name: 'Old Rig',
          status: rigUp ? 'running' : 'offline',
        ),
        const Machine(
          machineId: 'team',
          authMode: MachineAuthMode.remote,
          name: 'Studio · Team',
          status: 'running',
          sessionKind: 'team',
        ),
        const Machine(
          machineId: 'theirs',
          authMode: MachineAuthMode.remote,
          name: 'Teammate Mac',
          isShared: true,
        ),
      ];
      return app;
    }

    void people(ConversationServer server) => (server.state['people'] as List)
        .add({'id': 'dee', 'email': 'dee@example.com', 'role': 'collaborator'});

    testWidgets('Your Team and Projects are open, Your Machines and Top '
        'Teams folded, each with its chevron', (tester) async {
      final c = await show(
        tester,
        agents: [_agent('kestrel', 'Kestrel')],
        setup: people,
        leaderboard: await tester.runAsync(() async {
          final reader = board();
          await reader.show();
          return reader;
        }),
        withApp: appWithMachines(rigUp: true),
      );
      expect(key('super-agent-kestrel'), findsOneWidget);
      for (final project in c.snapshot!.projects) {
        expect(key('super-project-${project.id}'), findsOneWidget);
      }
      expect(key('project-sidebar-machines'), findsOneWidget);
      expect(key('super-machine-m3'), findsNothing);
      expect(key('super-human-dee'), findsNothing);
      for (final heading in [
        'project-sidebar-agents',
        'project-sidebar-projects',
        'project-sidebar-machines',
        'project-sidebar-humans',
      ]) {
        expect(
          find.descendant(
            of: key(heading),
            matching: find.byWidgetPredicate(
              (w) =>
                  w is Icon &&
                  (w.icon == AppIcons.chevronDown ||
                      w.icon == AppIcons.chevronRight),
            ),
          ),
          findsOneWidget,
          reason: heading,
        );
      }
      // Open: down; folded: right.
      expect(
        find.descendant(
          of: key('project-sidebar-agents'),
          matching: find.byIcon(AppIcons.chevronDown),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: key('project-sidebar-machines'),
          matching: find.byIcon(AppIcons.chevronRight),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a click on a heading folds or opens its list, and the '
        'reader\'s choice is kept', (tester) async {
      final c = await show(
        tester,
        agents: [_agent('kestrel', 'Kestrel')],
        withApp: appWithMachines(),
      );
      await tester.tap(key('project-sidebar-agents'));
      await settle(tester);
      expect(key('super-agent-kestrel'), findsNothing);
      expect(c.agentsGroupOpen, isFalse);
      await tester.tap(key('project-sidebar-agents'));
      await settle(tester);
      expect(key('super-agent-kestrel'), findsOneWidget);
      await tester.tap(key('project-sidebar-projects'));
      await settle(tester);
      for (final project in c.snapshot!.projects) {
        expect(key('super-project-${project.id}'), findsNothing);
      }
      expect(c.projectsGroupOpen, isFalse);
      // What the reader chose survives a restart of the view.
      final saved = c.savedForTest;
      expect(saved['agentsGroupOpen'], isTrue);
      expect(saved['projectsGroupOpen'], isFalse);
      expect(saved['yourMachinesGroupOpen'], isFalse);
      expect(saved['yourMachinesGroupChosen'], isFalse);
      expect(saved['topTeamsGroupOpen'], isFalse);
      await tester.runAsync(c.flush);
    });

    testWidgets('Your Machines lists this account\'s own computers, opens '
        'Manage, and says offline for one that is', (tester) async {
      final c = await show(
        tester,
        agents: [_agent('kestrel', 'Kestrel')],
        withApp: appWithMachines(),
      );
      // Old Rig is off: the list is open without a click.
      // Alphabetical; a team's pool and a teammate's computer are not its own.
      expect(key('super-machine-m3'), findsOneWidget);
      expect(key('super-machine-rig'), findsOneWidget);
      expect(key('super-machine-team'), findsNothing);
      expect(key('super-machine-theirs'), findsNothing);
      expect(
        tester.getTopLeft(key('super-machine-m3')).dy,
        lessThan(tester.getTopLeft(key('super-machine-rig')).dy),
      );
      expect(
        find.descendant(
          of: key('super-machine-rig'),
          matching: find.text('offline'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: key('super-machine-m3'),
          matching: find.text('offline'),
        ),
        findsNothing,
      );
      // It sits between Projects and Top Teams, above Manage.
      expect(
        tester.getTopLeft(key('project-sidebar-projects')).dy,
        lessThan(tester.getTopLeft(key('project-sidebar-machines')).dy),
      );
      expect(
        tester.getTopLeft(key('super-machine-rig')).dy,
        lessThan(tester.getTopLeft(key('super-manage')).dy),
      );
      await tester.runAsync(c.flush);
    });

    testWidgets('Your Machines opens by itself while a computer is off, and '
        'what its person chose stands', (tester) async {
      // A computer is off: open, so why an agent is silent is in sight.
      final app = appWithMachines();
      final c = await show(
        tester,
        agents: [_agent('kestrel', 'Kestrel')],
        withApp: app,
      );
      expect(key('super-machine-rig'), findsOneWidget);
      expect(c.yourMachinesGroupChosen, isFalse);
      // Their click folds it, and it stays folded while the computer is still off.
      await tester.tap(key('project-sidebar-machines'));
      await settle(tester);
      expect(key('super-machine-rig'), findsNothing);
      expect(c.yourMachinesGroupChosen, isTrue);
      expect(c.yourMachinesGroupOpen, isFalse);
      // The sidebar redraws as the Swarm reads again.
      await tester.runAsync(c.refresh);
      await settle(tester);
      expect(key('super-machine-rig'), findsNothing);
      // Opened again, it is theirs to keep open.
      await tester.tap(key('project-sidebar-machines'));
      await settle(tester);
      expect(key('super-machine-rig'), findsOneWidget);
      expect(c.savedForTest['yourMachinesGroupOpen'], isTrue);
      expect(c.savedForTest['yourMachinesGroupChosen'], isTrue);
      await tester.runAsync(c.flush);
    });

    testWidgets('Your Machines stays folded while every computer is up, and '
        'opens when one goes off', (tester) async {
      final app = appWithMachines(rigUp: true);
      final c = await show(
        tester,
        agents: [_agent('kestrel', 'Kestrel')],
        withApp: app,
      );
      expect(key('super-machine-m3'), findsNothing);
      app.machines = [
        for (final m in app.machines)
          if (m.machineId == 'm3')
            Machine(
              machineId: 'm3',
              authMode: MachineAuthMode.remote,
              name: 'Mac 3',
              status: 'offline',
            )
          else
            m,
      ];
      await tester.runAsync(c.refresh);
      await settle(tester);
      expect(key('super-machine-m3'), findsOneWidget);
      expect(
        find.descendant(
          of: key('super-machine-m3'),
          matching: find.text('offline'),
        ),
        findsOneWidget,
      );
      await tester.runAsync(c.flush);
    });

    test('a view saved with Your Machines open keeps it open; one saved '
        'folded follows the computers', () {
      SuperTabController saved(Map<String, dynamic> flags) =>
          swarm().controller(
            initial: {'tabId': 'tab', 'accountId': 'owner', ...flags},
          );
      expect(
        saved({'yourMachinesGroupOpen': true}).yourMachinesGroupChosen,
        isTrue,
      );
      expect(
        saved({'yourMachinesGroupOpen': false}).yourMachinesGroupChosen,
        isFalse,
      );
      expect(saved(const {}).yourMachinesGroupChosen, isFalse);
      final chose = saved({
        'yourMachinesGroupOpen': false,
        'yourMachinesGroupChosen': true,
      });
      expect(chose.yourMachinesGroupChosen, isTrue);
      expect(chose.yourMachinesGroupOpen, isFalse);
    });

    testWidgets('a person with no computer of their own sees no Your '
        'Machines', (tester) async {
      final app = createApp()..machines = const [];
      addTearDown(app.dispose);
      await show(tester, agents: [_agent('kestrel', 'Kestrel')], withApp: app);
      expect(key('project-sidebar-machines'), findsNothing);
    });
  });
  group('Humans is the Leaderboard', () {
    SuperTabShippingReader board(
      List<(String, double)> people, {
      List<String> failures = const [],
    }) {
      final reader = SuperTabShippingReader(
        tabId: 'tab',
        request: (method, path, {body}) async => {
          'week': 1793577600000,
          'people': [
            for (final (i, (id, points)) in people.indexed)
              {
                'personId': id,
                'displayName': id,
                'agentsShipping': 1,
                'level': 1,
                'points': points,
                'rank': i + 1,
              },
          ],
          'failures': [
            for (final code in failures) {'machineId': 'mac-1', 'code': code},
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
      final reader = board([('dee', 12.5), ('ken', 8), ('owner', 0)]);
      await tester.runAsync(reader.show);
      final c = await show(tester, setup: people, leaderboard: reader);
      expect(
        find.descendant(
          of: key('project-sidebar-humans'),
          matching: find.text('Top Teams'),
        ),
        findsOneWidget,
      );
      // Folded until the reader opens it (anh Dee, 2026-11-09).
      expect(key('super-human-dee'), findsNothing);
      await tester.tap(key('project-sidebar-humans'));
      await settle(tester);
      double top(String k) => tester.getTopLeft(key(k)).dy;
      expect(top('super-human-dee'), lessThan(top('super-human-ken')));
      expect(top('super-human-ken'), lessThan(top('super-human-owner')));
      final points = find.descendant(
        of: key('super-human-dee'),
        matching: find.text('12.5'),
      );
      expect(points, findsOneWidget);
      // Zero still shows, so the column holds.
      expect(
        find.descendant(
          of: key('super-human-owner'),
          matching: find.text('0.0'),
        ),
        findsOneWidget,
      );
      expect(
        tester.getRect(points).right,
        greaterThan(tester.getRect(key('super-human-dee')).right - 16),
      );
      expect(top('super-human-owner'), lessThan(top('super-manage')));
      // The fold is saved, so no timer is left running.
      await tester.runAsync(c.flush);
    });

    testWidgets('at most 8 people; the heading folds them and every person '
        'opens the whole board', (tester) async {
      final reader = board([for (var i = 0; i < 12; i++) ('p$i', 12.0 - i)]);
      await tester.runAsync(reader.show);
      final pages = <SwarmPage>[];
      final c = await show(
        tester,
        leaderboard: reader,
        pages: pages,
        setup: people,
      );
      await tester.tap(key('project-sidebar-humans'));
      await settle(tester);
      expect(key('super-human-p7'), findsOneWidget);
      expect(key('super-human-p8'), findsNothing);
      await tester.tap(key('super-human-p0'));
      expect(pages, [SwarmPage.leaderboard]);
      await tester.runAsync(c.flush);
    });

    testWidgets('a Swarm of one person with no points yet shows nothing; a '
        'team with none keeps the heading, its way to the Leaderboard', (
      tester,
    ) async {
      final reader = board([('owner', 0)]);
      await tester.runAsync(reader.show);
      final c = await show(tester, leaderboard: reader);
      expect(key('project-sidebar-humans'), findsNothing);
      expect(find.text('Top Teams'), findsNothing);
      await tester.runAsync(c.flush);

      final team = board([('dee', 0), ('owner', 0)]);
      await tester.runAsync(team.show);
      final c2 = await show(tester, setup: people, leaderboard: team);
      expect(key('project-sidebar-humans'), findsOneWidget);
      await tester.runAsync(c2.flush);
    });

    testWidgets('a Swarm of one person with no points because GitHub could '
        'not be read says why', (tester) async {
      final reader = board([('owner', 0)], failures: ['GH_SIGNED_OUT']);
      await tester.runAsync(reader.show);
      final c = await show(tester, leaderboard: reader);
      expect(key('project-sidebar-humans'), findsOneWidget);
      // Top Teams starts folded: its person opens it.
      await tester.tap(key('project-sidebar-humans'));
      await settle(tester);
      expect(key('super-human-reading'), findsOneWidget);
      await tester.runAsync(c.flush);
    });

    testWidgets('before the board is read, nothing: an empty list shows no '
        'heading', (tester) async {
      await show(tester, leaderboard: board([('dee', 1.0)]));
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
      VoidCallback? onAttachAgent,
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
              onAttachAgent: onAttachAgent,
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
      expect(key('project-sidebar-agents-attach'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });

    testWidgets('Attach, before the +, opens the picker of running agents', (
      tester,
    ) async {
      var attached = 0, opened = 0;
      final c = await view(
        tester,
        withApp: true,
        onNewAgent: () => opened++,
        onAttachAgent: () => attached++,
      );
      final attach = key('project-sidebar-agents-attach');
      expect(attach, findsOneWidget);
      // Attach sits just before the +, at the heading's right edge.
      expect(
        tester.getTopRight(attach).dx,
        lessThanOrEqualTo(
          tester.getTopLeft(key('project-sidebar-agents-add')).dx,
        ),
      );
      expect(
        find.descendant(of: attach, matching: find.byIcon(AppIcons.link2)),
        findsOneWidget,
      );
      await tester.tap(attach);
      await tester.pump();
      expect((attached, opened), (1, 0));
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });
  });

  group('an agent row opens its own chat', () {
    Future<SuperTabController> view(
      WidgetTester tester, {
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
