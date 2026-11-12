import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/super_tabs/quiet_rows.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/agent_names.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/model.dart' show stableId;
import 'package:harness/super_tabs/new_agent.dart';
import 'package:harness/super_tabs/personal_agents.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/swarm_switcher.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/widgets/pane_grid.dart';

import 'super_tab_launch_test.dart'
    show SuperTabFixtureConnection, SuperTabLaunchFixture, tabId;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

/// Set to a folder to write the pictures of Your Team there, in both themes at three window sizes.
final _shots = Platform.environment['PERSONAL_AGENTS_SHOTS'];

/// Another Swarm the person is in, beside their Personal one.
const _acme = 'fedcba9876543210fedcba98';

/// The backend with Acme beside the Personal Swarm: Acme's reads and commands go to [acme], everything else as before.
class _WithAcme extends SuperTabFixtureConnection {
  _WithAcme(super.store);
  final acme = ConversationServer();

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final path = payload['path'];
    if (type == 'super_tabs' && path == '/api/super-tabs/list') {
      return {
        'ok': true,
        'value': {
          'tabs': [
            {'id': tabId, 'name': 'Personal', 'ownerId': 'owner'},
            {'id': _acme, 'name': 'Acme', 'ownerId': 'owner'},
          ],
          'next': null,
        },
      };
    }
    if (type == 'super_tabs' &&
        path is String &&
        path.startsWith('/api/super-tabs/$_acme/')) {
      final value = await acme.request(
        payload['method'] as String,
        path,
        body: payload['body'] as Map<String, dynamic>?,
      );
      return {'ok': true, 'value': value};
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

/// Your Team in a person's Personal Swarm (Swarm v4, anh Dee 2026-11-09): every pane they run is an agent there, with its
/// face, its name and its computer, clicked through as a person does.
void main() {
  setUpAll(() => loadCaptureFonts(_shots));

  Finder key(String k) => find.byKey(ValueKey(k));
  Finder paneRows() => find.byWidgetPredicate(
    (w) =>
        w.key is ValueKey<String> &&
        (w.key! as ValueKey<String>).value.startsWith('super-pane-'),
  );
  Finder inRow(String row, Finder finder) =>
      find.descendant(of: key(row), matching: finder);

  Agent session(
    String id,
    String name, {
    String engine = 'claude',
    String status = 'active',
    String? title,
    bool chosen = true,
    AgentProject? project,
    String? startedBy,
  }) => Agent(
    id: id,
    name: name,
    title: title,
    nameChosen: chosen,
    engine: engine,
    status: status,
    terminalAvailable: status != 'stopped',
    project: project,
    startedBy: startedBy,
  );

  void computer(
    AppNotifier app,
    String id,
    String name, {
    bool shared = false,
  }) {
    final machine = Machine(
      machineId: id,
      authMode: MachineAuthMode.remote,
      name: name,
      isShared: shared,
      ownerName: shared ? 'Kim' : null,
    );
    app.machines = [...app.machines, machine];
    // Their own computers' panes have no part in Personal's sync of other machines here (as this Mac's).
    app.machineStates[id] = MachineState(machine)
      ..localOnly = !shared
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
  }

  var paneIds = 4000;
  TerminalPane pane(String machineId, String agentId) =>
      TerminalPane(id: paneIds++, machineId: machineId, agentId: agentId);

  Swarm deskTab(AppNotifier app, String id, List<TerminalPane> panes) {
    final tab = Swarm(id: id, name: id)..panes.addAll(panes);
    app.swarms.add(tab);
    return tab;
  }

  /// This Mac with a Claude Code session, a plain shell, a stopped session and a Codex one that is in the Swarm already;
  /// their laptop with Codex; a computer shared with them. The same session is in two tabs.
  void usualDesk(SuperTabLaunchFixture f) {
    f.app.machineStates['m']!.agents = [
      session('docs', 'Docs bot'),
      session('shell', 'Plain shell', engine: 'terminal'),
      session('old', 'Old builder', status: 'stopped'),
      session('joined', 'Atlas', engine: 'codex'),
    ];
    computer(f.app, 'laptop', 'Mac laptop');
    f.app.machineStates['laptop']!.agents = [
      session('notes', 'Release notes', engine: 'codex'),
    ];
    computer(f.app, 'guest', 'Kim’s Mac', shared: true);
    f.app.machineStates['guest']!.agents = [session('theirs', 'Kim’s bot')];
    deskTab(f.app, 'one', [
      pane('m', 'docs'),
      pane('m', 'shell'),
      pane('m', 'old'),
    ]);
    deskTab(f.app, 'two', [
      pane('laptop', 'notes'),
      pane('guest', 'theirs'),
      pane('m', 'docs'),
      pane('m', 'joined'),
    ]);
  }

  /// A Swarm tab showing [name] in the real workspace, redrawn as the app is, over the desk [desk] sets up. [personal]: it
  /// was picked as their Personal Swarm. [joined] are the sessions already in the Swarm, each as (computer, session, name).
  Future<({SuperTabLaunchFixture f, SuperTabController c})> open(
    WidgetTester tester, {
    String name = 'Personal',
    bool personal = true,
    List<String> people = const ['owner'],
    void Function(SuperTabLaunchFixture f)? desk,
    List<(String, String, String)> joined = const [('m', 'joined', 'Atlas')],
    List<Map<String, Object>> removed = const [],
    Size size = const Size(1440, 900),
    Brightness brightness = Brightness.light,
    SuperTabFixtureConnection Function(MemoryStore)? connection,
  }) async {
    final f = SuperTabLaunchFixture(connectionFactory: connection);
    f.app.machineStates['m']!.localOnly = true;
    (desk ?? usualDesk)(f);
    f.connection.server.state
      ..['name'] = name
      ..['ownerId'] = 'owner'
      ..['people'] = [
        for (final person in people)
          {
            'id': person,
            'email': '$person@example.com',
            'role': person == 'owner' ? 'owner' : 'collaborator',
            // The sessions the reader took out, on their own entry alone.
            if (person == 'owner' && removed.isNotEmpty)
              'removedPanes': removed,
          },
      ]
      ..['agents'] = <Map<String, dynamic>>[
        for (final (machine, harness, agentName) in joined)
          {
            'id': swarmAgentId(machine, harness),
            'projectId': 'lead',
            'name': agentName,
            'displayName': agentName,
            'machineId': machine,
            'harnessId': harness,
            'contributorId': 'owner',
            'configuration': {'engine': 'codex'},
            'kind': 'regular',
            'chatId': 'chat-$harness',
            'myAgent': true,
          },
      ];
    for (final (machine, harness, agentName) in joined) {
      (f.connection.server.state['conversations'] as List).add({
        ...conversationFixture('chat-$harness', agentName),
        'kind': 'agent-chat',
        'agentIds': [swarmAgentId(machine, harness)],
      });
    }
    if (personal) {
      await f.app.superTabs.storage.write('super_tab.personal.owner', tabId);
    }
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, name);
    PersonalSwarm.of(f.app).id;
    for (var i = 0; i < 20; i++) {
      await Future<void>.microtask(() {});
    }
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    final previous = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = previous);
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          // The real workspace, redrawn whenever the app changes, as the Swarm screen does.
          body: ListenableBuilder(
            listenable: f.app,
            builder: (_, _) => SuperTabWorkspace(
              app: f.app,
              canvas: PaneGrid(notifier: f.app, swarmMode: true),
              onAddAgent: (_) {},
              onNewProject: () {},
              onNewSwarm: () {},
            ),
          ),
        ),
      ),
    );
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
    return (f: f, c: c);
  }

  /// The end of a test: the tree goes, the controller's saves and its poll timer with it, before the test is checked for
  /// timers left running.
  Future<void> close(
    WidgetTester tester,
    SuperTabLaunchFixture f,
    SuperTabController c,
  ) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  }

  /// The app changed: redrawn as the Swarm screen would be.
  Future<void> changed(WidgetTester tester, SuperTabLaunchFixture f) async {
    f.app.notifyListeners();
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
  }

  /// A click's join goes to the Swarm and comes back, its chat opens: [wait] of time passes, a lost reply is tried again in it.
  Future<void> joined(
    WidgetTester tester, {
    Duration wait = const Duration(seconds: 1),
  }) async {
    for (var i = 0; i < wait.inMilliseconds ~/ 50; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  /// The commands the person's Desktop has sent the Swarm so far, by type.
  List<String> sent(SuperTabLaunchFixture f) => [
    for (final post in f.connection.server.posts)
      if (post['command'] case {'type': final String type}) type,
  ];

  List<String> names() => [
    for (final row in paneRows().evaluate())
      (row.widget as SuperTabQuietRow).name,
  ];

  /// A test over [open]'s Swarm view that ends by closing it, as each must.
  void scene(
    String description,
    Future<void> Function(
      WidgetTester tester,
      SuperTabLaunchFixture f,
      SuperTabController c,
    )
    body, {
    String name = 'Personal',
    bool personal = true,
    List<String> people = const ['owner'],
    void Function(SuperTabLaunchFixture f)? desk,
    List<(String, String, String)> joined = const [('m', 'joined', 'Atlas')],
    List<Map<String, Object>> removed = const [],
    Size size = const Size(1440, 900),
    SuperTabFixtureConnection Function(MemoryStore)? connection,
  }) => testWidgets(description, (tester) async {
    final (:f, :c) = await open(
      tester,
      name: name,
      personal: personal,
      people: people,
      desk: desk,
      joined: joined,
      removed: removed,
      size: size,
      connection: connection,
    );
    await body(tester, f, c);
    await close(tester, f, c);
  });

  test('the Swarm\'s id for an agent is the backend\'s, so a face is the same once it joins', () {
    // backend superTabs/model.ts stableId(machineId, harnessId), worked out with node's crypto.
    expect(swarmAgentId('m', 'h1'), 'c82f313e6c97bca6dfd30dcb');
    expect(swarmAgentId('laptop', 'n1'), '2c4729e0c7a5fb6fe9462e8e');
    expect(
      swarmAgentId('0c2d6c8a-3f7e-4d0e-9a52-6f1f6a2f0b11', 'session-ü'),
      '53fc1449b3b28a00489bbf59',
    );
    expect(swarmAgentId('m', 'h1'), stableId(['m', 'h1']));
  });

  scene(
    'every Claude Code or Codex pane of the person is a row under Your Team: '
    'its face, its name and its computer',
    (tester, f, c) async {
      // One of this Mac's and one of the laptop's, each once though a tab holds the same session twice over.
      expect(paneRows(), findsNWidgets(2));
      expect(inRow('super-pane-m-docs', find.text('Docs bot')), findsOneWidget);
      expect(
        inRow('super-pane-laptop-notes', find.text('Release notes')),
        findsOneWidget,
      );
      // Its computer is the row's detail.
      expect(
        inRow('super-pane-laptop-notes', find.text('Mac laptop')),
        findsOneWidget,
      );
      // Its face is the one it wears once it joins.
      final face = tester.widget<SuperTabAvatar>(
        inRow('super-pane-m-docs', find.byType(SuperTabAvatar)),
      );
      expect(face.identity, 'agent:${swarmAgentId('m', 'docs')}');
      // A plain shell, a stopped session and a computer shared with them are no agents of theirs.
      for (final gone in ['m-shell', 'm-old', 'guest-theirs']) {
        expect(key('super-pane-$gone'), findsNothing, reason: gone);
      }
      // One that already joined is its own row, never a second one.
      expect(key('super-agent-${swarmAgentId('m', 'joined')}'), findsOneWidget);
      expect(key('super-pane-m-joined'), findsNothing);
      expect(c.snapshot!.agents, hasLength(1));
      // The server is told of no agent: it learns of a pane only when its person opens it.
      expect(sent(f).where((type) => type.startsWith('agent.')), isEmpty);
    },
  );

  scene('a person works through their desk: panes come and go, a rename and a '
      'sleeping computer show, and a click makes a pane an agent', (
    tester,
    f,
    c,
  ) async {
    expect(paneRows(), findsNWidgets(2));

    // They start another Claude Code session in their first tab: its row appears, by name.
    f.app.machineStates['m']!.agents = [
      ...f.app.machineStates['m']!.agents,
      session('fresh', 'Billing fix'),
    ];
    f.app.swarms.firstWhere((t) => t.id == 'one').panes.add(pane('m', 'fresh'));
    await changed(tester, f);
    expect(names(), ['Billing fix', 'Docs bot', 'Release notes']);

    // They rename one in its tab: its row says so.
    f.app.machineStates['m']!.agents = [
      for (final agent in f.app.machineStates['m']!.agents)
        if (agent.id == 'docs') session('docs', 'Docs writer') else agent,
    ];
    await changed(tester, f);
    expect(
      inRow('super-pane-m-docs', find.text('Docs writer')),
      findsOneWidget,
    );
    expect(find.text('Docs bot'), findsNothing);

    // The laptop goes to sleep: its row says so, and says nothing once it is back.
    f.app.machineStates['laptop']!.nodeOnline = false;
    await changed(tester, f);
    expect(
      inRow('super-pane-laptop-notes', find.text('offline')),
      findsOneWidget,
    );
    f.app.machineStates['laptop']!.nodeOnline = true;
    await changed(tester, f);
    expect(
      inRow('super-pane-laptop-notes', find.text('Mac laptop')),
      findsOneWidget,
    );

    // They close a session: its row goes with it.
    f.app.swarms
        .firstWhere((t) => t.id == 'one')
        .panes
        .removeWhere((p) => p.agentId == 'fresh');
    await changed(tester, f);
    expect(key('super-pane-m-fresh'), findsNothing);
    expect(paneRows(), findsNWidgets(2));

    // They fold Your Team: its rows go, and come back as they unfold it.
    await tester.tap(key('project-sidebar-agents'));
    await tester.pump();
    expect(paneRows(), findsNothing);
    await tester.tap(key('project-sidebar-agents'));
    await tester.pump();
    expect(paneRows(), findsNWidgets(2));

    // A click on the laptop's session makes it an agent of the Swarm: its chat opens, and the row is the agent's now.
    await tester.tap(key('super-pane-laptop-notes'));
    await joined(tester);
    expect(sent(f).where((type) => type == 'agent.new'), hasLength(1));
    final join = f.connection.joins.single['command'] as Map;
    expect(join, containsPair('machineId', 'laptop'));
    expect(join, containsPair('harnessId', 'notes'));
    expect(c.selectedId, join['conversationId']);
  });

  scene(
    'the name a row shows is the name it joins under: its folder, or one of the '
    "Swarm's when it has none or the Swarm has it already",
    (tester, f, c) async {
      String shown(String row) =>
          tester.widget<SuperTabQuietRow>(key(row)).name;
      expect(shown('super-pane-m-u'), 'api');
      // Untitled, and named as an agent already in the Swarm: neither keeps that name, each shows the one it gets.
      for (final row in ['super-pane-m-v', 'super-pane-m-x']) {
        expect(shown(row), isNot(anyOf('Untitled Pane', 'Atlas')));
      }
      for (final row in ['super-pane-m-y', 'super-pane-m-z']) {
        expect(agentNames, contains(shown(row)), reason: row);
      }
      expect({for (final r in names()) r.toLowerCase()}, hasLength(5));
      // The same on every draw, and an untitled row's stays as others join.
      final before = names();
      final untitled = shown('super-pane-m-v');
      await changed(tester, f);
      expect(names(), before);
      for (final (row, harness) in [
        ('super-pane-m-u', 'u'),
        ('super-pane-m-v', 'v'),
        ('super-pane-m-x', 'x'),
        ('super-pane-m-y', 'y'),
      ]) {
        final name = shown(row);
        await tester.tap(key(row));
        await joined(tester);
        final join = f.connection.joins.last['command'] as Map;
        expect(join, containsPair('harnessId', harness));
        expect(join, containsPair('name', name), reason: row);
        // Its chat was asked for under that name, for that very session.
        final chat =
            f.connection.server.posts.lastWhere(
                  (p) => (p['command'] as Map?)?['type'] == 'agent.new',
                )['command']
                as Map;
        expect(chat, containsPair('name', name));
        expect(chat, containsPair('harnessId', harness));
        // The fake Swarm keeps one fixed agent id: it forgets this one before the next join.
        (f.connection.server.state['agents'] as List).removeWhere(
          (a) => a['id'] == 'lead-agent',
        );
        await c.refresh();
        await changed(tester, f);
        if (harness == 'u') expect(shown('super-pane-m-v'), untitled);
      }
    },
    desk: (f) {
      f.app.machineStates['m']!.agents = [
        session(
          'u',
          'harness-8',
          chosen: false,
          project: const AgentProject(name: 'api', cwd: '/w/api'),
        ),
        session('v', 'harness-9', chosen: false),
        session('x', 'Atlas'),
        // Names the Swarm refuses for an agent: one over 60 characters, an engine's.
        session(
          'y',
          'A name far longer than the sixty characters a Swarm keeps for one',
        ),
        session('z', 'Claude Code'),
      ];
      deskTab(f.app, 'one', [
        for (final id in ['u', 'v', 'x', 'y', 'z']) pane('m', id),
      ]);
    },
  );

  scene(
    'Your Team is one list from A to Z, folded by the rule every Swarm has: a pane '
    'is ranked as its agents are, never put last',
    (tester, f, c) async {
      // Ten agents and a pane: eight show, and "Able" is first, by its name.
      expect(find.text('3 more'), findsOneWidget);
      expect(key('super-pane-m-able'), findsOneWidget);
      final rows = find.byWidgetPredicate(
        (w) =>
            w is SuperTabQuietRow &&
            w.key is ValueKey<String> &&
            ((w.key! as ValueKey<String>).value.startsWith('super-pane-') ||
                (w.key! as ValueKey<String>).value.startsWith('super-agent-')),
      );
      final order = [
        for (final row in rows.evaluate())
          (row.widget as SuperTabQuietRow).name,
      ];
      expect(order.first, 'Able');
      expect(order, [...order]..sort());
    },
    joined: [
      for (final name in [
        'Bea',
        'Cal',
        'Dov',
        'Eli',
        'Fox',
        'Gus',
        'Hal',
        'Ida',
        'Jon',
        'Kit',
      ])
        ('m', 'h$name', name),
    ],
    desk: (f) {
      f.app.machineStates['m']!.agents = [session('able', 'Able')];
      deskTab(f.app, 'one', [pane('m', 'able')]);
    },
  );

  scene(
    'a pane the person took out of the Swarm has no row, on any of their computers',
    (tester, f, c) async {
      expect(key('super-pane-m-docs'), findsNothing);
      expect(key('super-pane-laptop-notes'), findsOneWidget);
    },
    removed: const [
      {'machineId': 'm', 'harnessId': 'docs', 'removedAt': 1},
    ],
  );

  group('trying to break it', () {
    scene(
      'a desk with no panes lists no rows, and nothing else moves',
      (tester, f, c) async {
        expect(find.text('Your Team'), findsOneWidget);
        expect(paneRows(), findsNothing);
        expect(find.text('Projects'), findsOneWidget);
        expect(c.snapshot!.agents, isEmpty);
        expect(sent(f), isEmpty);
      },
      joined: const [],
      desk: (f) => f.app.machineStates['m']!.agents = [],
    );

    scene(
      'forty panes: eight show, "N more" opens every row, the list scrolls to the last '
      'and a click on it still makes that one an agent',
      (tester, f, c) async {
        expect(key('super-pane-m-p39'), findsNothing);
        // Atlas, already in the Swarm, and forty panes: eight of 41 show.
        expect(find.text('33 more'), findsOneWidget);
        await tester.tap(key('super-team-more'));
        await tester.pump();
        final scroll = find
            .descendant(
              of: find.byType(ProjectSidebar),
              matching: find.byType(Scrollable),
            )
            .first;
        expect(key('super-pane-m-p0'), findsOneWidget);
        await tester.scrollUntilVisible(
          key('super-pane-m-p39'),
          200,
          scrollable: scroll,
        );
        expect(tester.takeException(), isNull);
        await tester.tap(key('super-pane-m-p39'));
        await joined(tester);
        expect(f.connection.joins, hasLength(1));
        expect(
          f.connection.joins.single['command'],
          containsPair('harnessId', 'p39'),
        );
      },
      desk: (f) {
        f.app.machineStates['m']!.agents = [
          for (var i = 0; i < 40; i++)
            session('p$i', 'Session ${'$i'.padLeft(2, '0')}'),
        ];
        for (var t = 0; t < 8; t++) {
          deskTab(f.app, 'tab$t', [
            for (var i = 0; i < 5; i++) pane('m', 'p${t * 5 + i}'),
          ]);
        }
      },
    );

    scene(
      'one session name on three computers: three rows, one keeps the name and '
      "the others show the Swarm's names they join under, each from its own computer",
      (tester, f, c) async {
        expect(paneRows(), findsNWidgets(3));
        expect(names().where((n) => n == 'Docs bot'), hasLength(1));
        expect(names().toSet(), hasLength(3));
        for (final (row, place, machine) in [
          ('super-pane-laptop-a1', 'Mac laptop', 'laptop'),
          ('super-pane-studio-a1', 'Mac Studio', 'studio'),
        ]) {
          final name = tester.widget<SuperTabQuietRow>(key(row)).name;
          expect(inRow(row, find.text(place)), findsOneWidget);
          await tester.tap(key(row));
          await joined(tester);
          expect(
            f.connection.joins.last['command'],
            allOf(
              containsPair('machineId', machine),
              containsPair('name', name),
            ),
          );
          // The fake Swarm keeps one fixed agent id: it forgets this one before the next join.
          (f.connection.server.state['agents'] as List).removeWhere(
            (a) => a['id'] == 'lead-agent',
          );
          await c.refresh();
        }
        expect(f.connection.joins, hasLength(2));
      },
      desk: (f) {
        f.app.machineStates['m']!.agents = [session('a1', 'Docs bot')];
        for (final (id, name) in [
          ('laptop', 'Mac laptop'),
          ('studio', 'Mac Studio'),
        ]) {
          computer(f.app, id, name);
          f.app.machineStates[id]!.agents = [session('a1', 'Docs bot')];
        }
        deskTab(f.app, 'here', [pane('m', 'a1')]);
        deskTab(f.app, 'lap', [pane('laptop', 'a1')]);
        deskTab(f.app, 'studio', [pane('studio', 'a1')]);
      },
    );

    scene(
      'an emoji name and a very long one are cut at the row\'s edge: the '
      'computer stays, nothing overflows',
      (tester, f, c) async {
        expect(tester.takeException(), isNull);
        expect(
          inRow('super-pane-m-e', find.text('🚀 Ship the release 🎉')),
          findsOneWidget,
        );
        expect(
          inRow('super-pane-m-l', find.textContaining('A session named')),
          findsOneWidget,
        );
        // The computer is still there at the row's right edge.
        expect(inRow('super-pane-m-l', find.text('Test host')), findsOneWidget);
        // A session still under its automatic name is called what it is working on, else the Swarm's name it joins under.
        expect(
          inRow('super-pane-m-t', find.text('Fix the login page')),
          findsOneWidget,
        );
        expect(
          agentNames,
          contains(tester.widget<SuperTabQuietRow>(key('super-pane-m-v')).name),
        );
        // One that is still untitled and works in a folder reads as that folder.
        expect(inRow('super-pane-m-u', find.text('api')), findsOneWidget);
      },
      size: const Size(1024, 700),
      desk: (f) {
        f.app.machineStates['m']!.agents = [
          session('e', '🚀 Ship the release 🎉'),
          session(
            'l',
            'A session named with far too many words to fit a left pane',
          ),
          session('t', 'harness-7', title: 'Fix the login page', chosen: false),
          session(
            'u',
            'harness-8',
            chosen: false,
            project: const AgentProject(name: 'api', cwd: '/w/api'),
          ),
          session('v', 'harness-9', chosen: false),
        ];
        deskTab(f.app, 'one', [
          pane('m', 'e'),
          pane('m', 'l'),
          pane('m', 't'),
          pane('m', 'u'),
          pane('m', 'v'),
        ]);
      },
    );

    scene('a machine that has not listed its agents yet shows no rows', (
      tester,
      f,
      c,
    ) async {
      f.app.machineStates['laptop']!
        ..agents = []
        ..agentLoadStatus = AgentLoadStatus.loading;
      await changed(tester, f);
      expect(key('super-pane-laptop-notes'), findsNothing);
      expect(key('super-pane-m-docs'), findsOneWidget);
    });

    // The backend keeps a computer's id without its dashes, the daemon's own record with them (core/models.dart sameMachineId).
    const dashed = 'd11a1f3b-ca2a-44e9-8a8d-1f2e3d4c5b6a';
    scene(
      'a session the Swarm lists under the computer\'s other spelling is not listed twice',
      (tester, f, c) async {
        // The one the Swarm has is its own agent row, Atlas; only the other is a pane's row.
        expect(paneRows(), findsOneWidget);
        expect(key('super-pane-$dashed-s2'), findsOneWidget);
        expect(key('super-pane-$dashed-s1'), findsNothing);
      },
      joined: const [('d11a1f3bca2a44e98a8d1f2e3d4c5b6a', 's1', 'Atlas')],
      desk: (f) {
        computer(f.app, dashed, 'Mac Studio');
        f.app.machineStates[dashed]!.agents = [
          session('s1', 'Docs bot', engine: 'codex'),
          session('s2', 'Billing fix'),
        ];
        deskTab(f.app, 'one', [pane(dashed, 's1'), pane(dashed, 's2')]);
      },
    );
  });

  // anh Dee, 2026-11-11: "the agents started in other swarms leave them in other swarms, they are not part of this swarm".
  scene(
    'a session that is an agent of another Swarm stays there: Your Team offers it only once it leaves that Swarm',
    (tester, f, c) async {
      // The person has Acme open too, and Docs bot is one of its agents.
      final acme = (f.connection as _WithAcme).acme;
      acme.state
        ..['id'] = _acme
        ..['name'] = 'Acme'
        ..['ownerId'] = 'owner'
        ..['people'] = [
          {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
        ]
        ..['agents'] = [
          {
            'id': swarmAgentId('m', 'docs'),
            'projectId': 'lead',
            'name': 'Docs bot',
            'machineId': 'm',
            'harnessId': 'docs',
            'contributorId': 'owner',
            'configuration': {'engine': 'claude'},
            'kind': 'regular',
          },
        ];
      final acmeTab = await f.app.superTabs.open(_acme);
      await acmeTab.refresh();
      await changed(tester, f);
      // Neither Acme's agent nor a session a Swarm started is offered: only the laptop's own session is.
      expect(names(), ['Release notes']);
      expect(key('super-pane-m-docs'), findsNothing);
      expect(key('super-pane-m-built'), findsNothing);

      // They close Acme's tab here: what was last read of it still keeps Docs bot Acme's.
      await f.app.superTabs.refreshTabs();
      f.app.superTabs.release(_acme);
      await changed(tester, f);
      expect(names(), ['Release notes']);

      // They open Acme again, and Acme lets Docs bot go: it is theirs to bring in, and a click makes it an agent here.
      (acme.state['agents'] as List).clear();
      await (await f.app.superTabs.open(_acme)).refresh();
      await changed(tester, f);
      expect(names(), ['Docs bot', 'Release notes']);
      await tester.tap(key('super-pane-m-docs'));
      await joined(tester);
      expect(
        f.connection.joins.single['command'],
        containsPair('harnessId', 'docs'),
      );
    },
    connection: _WithAcme.new,
    desk: (f) {
      usualDesk(f);
      // A session a Swarm's agent started, shown in one of their own tabs.
      f.app.machineStates['m']!.agents = [
        ...f.app.machineStates['m']!.agents,
        session('built', 'Billing builder', startedBy: 'agent'),
      ];
      f.app.swarms
          .firstWhere((t) => t.id == 'one')
          .panes
          .add(pane('m', 'built'));
    },
  );

  // anh Dee, 2026-11-11: the person invites people to their Personal Swarm, and it stays theirs.
  scene(
    'their Personal Swarm with someone they invited still lists their own panes, and never the guest\'s',
    (tester, f, c) async {
      expect(find.text('Your Team'), findsOneWidget);
      expect(paneRows(), findsNWidgets(2));
      expect(key('super-pane-guest-theirs'), findsNothing);
    },
    people: const ['owner', 'kim'],
  );

  scene(
    'a Swarm that is not their Personal one lists no panes either',
    (tester, f, c) async {
      expect(find.text('Your Team'), findsOneWidget);
      expect(paneRows(), findsNothing);
    },
    name: 'Acme',
    personal: false,
  );

  // A click on a pane's row makes it an agent of the Swarm as Attach does (new_agent.dart swarmAttachAgent): its 1:1 chat opens
  // and its terminal shows beside it.
  group('a click opens the agent', () {
    int chatsMade(SuperTabLaunchFixture f) =>
        (f.connection.server.state['conversations'] as List)
            .where((g) => (g['id'] as String).startsWith('agent-chat-'))
            .length;

    scene(
      'its chat opens with its terminal beside it, and the row is the agent\'s '
      'now, with the face it had',
      (tester, f, c) async {
        await tester.tap(key('super-pane-m-docs'));
        await joined(tester);
        // As Attach joins one: a chat of its own, then the session in it, under the name it has.
        final commands = [
          for (final post in f.connection.server.posts)
            post['command'] as Map<String, dynamic>,
        ];
        final made = commands.singleWhere((cmd) => cmd['type'] == 'agent.new');
        expect(made['name'], 'Docs bot');
        expect(made['engine'], 'claude');
        expect(made['machineId'], 'm');
        expect(made['local'], isTrue);
        final join = f.connection.joins.single['command'] as Map;
        expect(join['harnessId'], 'docs');
        expect(join['machineId'], 'm');
        expect(join['name'], 'Docs bot');
        expect((join['configuration'] as Map)['engine'], 'claude');
        // Its chat is open, and nothing else was sent.
        expect(c.selectedId, join['conversationId']);
        expect(sent(f).where((type) => type.startsWith('agent.')).toList(), [
          'agent.new',
          'agent.add',
        ]);
        // The id the Swarm gives it is the one its row's face was drawn from.
        expect(
          stableId(['${join['machineId']}', '${join['harnessId']}']),
          swarmAgentId('m', 'docs'),
        );
        // The pane row is gone and the agent has its row.
        expect(key('super-pane-m-docs'), findsNothing);
        expect(key('super-agent-lead-agent'), findsOneWidget);
        // Its terminal is beside the chat: the Swarm's own tab holds that session.
        final swarmTab = f.app.swarms.firstWhere((tab) => tab.isSuperTab);
        expect(swarmTab.panes.map((p) => p.agentId), contains('docs'));
      },
    );

    scene(
      'the row says joining while it does, and clicks meanwhile make nothing more; a '
      'lost reply is asked again as the same operation',
      (tester, f, c) async {
        f.connection.loseJoin = true;
        await tester.tap(key('super-pane-m-docs'));
        await tester.pump(const Duration(milliseconds: 300));
        expect(
          inRow('super-pane-m-docs', find.text('joining')),
          findsOneWidget,
        );
        expect(
          inRow('super-pane-m-docs', find.text('Test host')),
          findsNothing,
        );
        // Two clicks in one frame, and another after it: still one chat.
        await tester.tap(key('super-pane-m-docs'));
        await tester.tap(key('super-pane-m-docs'));
        await tester.pump(const Duration(milliseconds: 100));
        await tester.tap(key('super-pane-m-docs'));
        await tester.pump(const Duration(milliseconds: 100));
        expect(sent(f).where((type) => type == 'agent.new'), hasLength(1));
        await joined(tester, wait: const Duration(seconds: 3));
        // The reply was lost after the join committed: it was asked again, the same operation, and the Swarm has one agent.
        expect(f.connection.joins, hasLength(2));
        expect(
          f.connection.joins[0]['operationId'],
          f.connection.joins[1]['operationId'],
        );
        expect(
          (f.connection.server.state['agents'] as List).where(
            (agent) => agent['id'] == 'lead-agent',
          ),
          hasLength(1),
        );
        expect(chatsMade(f), 1);
        expect(
          c.selectedId,
          f.connection.joins.last['command']['conversationId'],
        );
        expect(key('super-pane-m-docs'), findsNothing);
      },
    );

    scene(
      'a refusal is said, the row stays, and the next click finishes it without a second chat',
      (tester, f, c) async {
        f.connection.failJoin = const SuperTabFailure(
          'ALREADY_SHARED',
          'This native harness is already in the tab.',
          statusCode: 400,
        );
        final before = c.selectedId;
        await tester.tap(key('super-pane-m-docs'));
        await joined(tester);
        expect(
          find.text('This native harness is already in the tab.'),
          findsOneWidget,
        );
        // The row is as it was, and the chat shown is the one that was.
        expect(
          inRow('super-pane-m-docs', find.text('Test host')),
          findsOneWidget,
        );
        expect(inRow('super-pane-m-docs', find.text('joining')), findsNothing);
        expect(c.selectedId, before);
        expect(chatsMade(f), 1);
        // Again: the same operations, the chat made the first time.
        await tester.tap(key('super-pane-m-docs'));
        await joined(tester);
        expect(f.connection.joins, hasLength(2));
        expect(
          f.connection.joins[0]['operationId'],
          f.connection.joins[1]['operationId'],
        );
        expect(chatsMade(f), 1);
        expect(
          c.selectedId,
          f.connection.joins.last['command']['conversationId'],
        );
        expect(key('super-agent-lead-agent'), findsOneWidget);
      },
    );

    scene(
      'a computer that goes off while it joins: the refusal is said, the row says offline '
      'and does nothing until it is back, then the click finishes the join',
      (tester, f, c) async {
        f.connection.failJoin = const SuperTabFailure(
          'HOST_REQUIRED',
          'Choose your own computer.',
          statusCode: 403,
        );
        await tester.tap(key('super-pane-laptop-notes'));
        f.app.machineStates['laptop']!.nodeOnline = false;
        await joined(tester);
        expect(find.text('Choose your own computer.'), findsOneWidget);
        await changed(tester, f);
        expect(
          inRow('super-pane-laptop-notes', find.text('offline')),
          findsOneWidget,
        );
        final sentBefore = sent(f).length;
        await tester.tap(key('super-pane-laptop-notes'));
        await joined(tester);
        expect(
          sent(f),
          hasLength(sentBefore),
          reason: 'an offline row does nothing',
        );
        // Back: the click makes the agent, in the chat the first click made.
        f.app.machineStates['laptop']!.nodeOnline = true;
        await changed(tester, f);
        await tester.tap(key('super-pane-laptop-notes'));
        await joined(tester);
        expect(f.connection.joins, hasLength(2));
        expect(chatsMade(f), 1);
        expect(
          c.selectedId,
          f.connection.joins.last['command']['conversationId'],
        );
      },
    );

    scene('a row of a computer that is off does nothing', (tester, f, c) async {
      f.app.machineStates['laptop']!.nodeOnline = false;
      await changed(tester, f);
      final before = (c.selectedId, sent(f).length);
      await tester.tap(key('super-pane-laptop-notes'));
      await joined(tester);
      expect((c.selectedId, sent(f).length), before);
      expect(find.byType(SnackBar), findsNothing);
    });

    // PSQA, 2026-11-12: a computer's long name cut "offline" off its rows, the one word saying why a click did nothing.
    scene(
      'a row of a computer that is off says offline, as an agent\'s row does, its face grey, however long the computer\'s name',
      (tester, f, c) async {
        f.app.machineStates['laptop']!.nodeOnline = false;
        await changed(tester, f);
        expect(
          inRow('super-pane-laptop-notes', find.text('offline')),
          findsOneWidget,
        );
        expect(
          inRow(
            'super-pane-laptop-notes',
            find.byKey(const ValueKey('super-face-offline')),
          ),
          findsOneWidget,
        );
        expect(
          inRow(
            'super-pane-m-docs',
            find.byKey(const ValueKey('super-face-offline')),
          ),
          findsNothing,
        );
      },
      desk: (f) {
        f.app.machineStates['m']!.agents = [session('docs', 'Docs bot')];
        computer(f.app, 'laptop', 'Dee’s MacBook Pro (16-inch, 2024)');
        f.app.machineStates['laptop']!.agents = [
          session('notes', 'Release notes', engine: 'codex'),
        ];
        deskTab(f.app, 'one', [pane('m', 'docs'), pane('laptop', 'notes')]);
      },
      joined: const [],
    );

    scene(
      'a session two tabs show joins once, and a name of emoji and one the person never '
      'chose are told as the Swarm will know them',
      (tester, f, c) async {
        // docs is in both tabs: one row, one join.
        await tester.tap(key('super-pane-m-docs'));
        await joined(tester);
        expect(f.connection.joins, hasLength(1));
        expect(
          f.connection.joins.single['command']['name'],
          '🚀 Ship the release 🎉',
        );
        // A session still under its automatic name is named by the Swarm, not by the pane's placeholder.
        (f.connection.server.state['agents'] as List).clear();
        await c.refresh();
        await tester.tap(key('super-pane-m-auto'));
        await joined(tester);
        final named = f.connection.joins.last['command']['name'] as String;
        expect(named, isNot('harness-7'));
        expect(named, isNotEmpty);
        expect(tester.takeException(), isNull);
      },
      size: const Size(1024, 700),
      desk: (f) {
        f.app.machineStates['m']!.agents = [
          session('docs', '🚀 Ship the release 🎉'),
          session('auto', 'harness-7', chosen: false),
        ];
        deskTab(f.app, 'one', [pane('m', 'docs'), pane('m', 'auto')]);
        deskTab(f.app, 'two', [pane('m', 'docs')]);
      },
      joined: const [],
    );

    scene(
      'a session its person never named keeps the name it was given when its '
      'join is tried again: one chat, the same request',
      (tester, f, c) async {
        // As the backend: an operation sent again with another request is refused.
        f.connection.server.refuseReusedOperations = true;
        f.connection.failJoin = const SuperTabFailure(
          'HOST_REQUIRED',
          'Choose your own computer.',
          statusCode: 403,
        );
        await tester.tap(key('super-pane-m-auto'));
        await joined(tester);
        expect(find.text('Choose your own computer.'), findsOneWidget);
        await tester.tap(key('super-pane-m-auto'));
        await joined(tester);
        expect(f.connection.joins, hasLength(2));
        final names = {
          for (final join in f.connection.joins) join['command']['name'],
        };
        expect(names, hasLength(1));
        expect(names.single, isNot('harness-7'));
        expect(chatsMade(f), 1);
        expect(
          c.selectedId,
          f.connection.joins.last['command']['conversationId'],
        );
        expect(find.textContaining('operation'), findsNothing);
      },
      desk: (f) {
        f.app.machineStates['m']!.agents = [
          session('auto', 'harness-7', chosen: false),
        ];
        deskTab(f.app, 'one', [pane('m', 'auto')]);
      },
      joined: const [],
    );

    scene('a join refused, then tried from elsewhere after the view went (Attach\'s '
        'picker), finishes the same one: one chat', (tester, f, c) async {
      f.connection.failJoin = const SuperTabFailure(
        'HOST_REQUIRED',
        'Choose your own computer.',
        statusCode: 403,
      );
      await tester.tap(key('super-pane-m-docs'));
      await joined(tester);
      // The person leaves this Swarm: the view goes.
      await tester.pumpWidget(const SizedBox());
      final docs = f.app.machineStates['m']!.agents.firstWhere(
        (a) => a.id == 'docs',
      );
      final done = swarmAttachAgent(f.app, tabId, 'm', docs);
      await joined(tester);
      await done;
      expect(f.connection.joins, hasLength(2));
      expect(
        f.connection.joins[0]['operationId'],
        f.connection.joins[1]['operationId'],
      );
      expect(chatsMade(f), 1);
    });

    scene(
      'two sessions never named, clicked one after the other, join under two names',
      (tester, f, c) async {
        await tester.tap(key('super-pane-m-a'));
        await tester.tap(key('super-pane-m-b'));
        await joined(tester);
        final names = [
          for (final join in f.connection.joins) join['command']['name'],
        ];
        expect(names, hasLength(2));
        expect(names.toSet(), hasLength(2));
      },
      desk: (f) {
        f.app.machineStates['m']!.agents = [
          session('a', 'harness-1', chosen: false),
          session('b', 'harness-2', chosen: false),
        ];
        deskTab(f.app, 'one', [pane('m', 'a'), pane('m', 'b')]);
      },
      joined: const [],
    );

    scene('in a narrow window the drawer closes and the chat shows', (
      tester,
      f,
      c,
    ) async {
      await tester.tap(find.byTooltip('Conversations'));
      await joined(tester, wait: const Duration(milliseconds: 300));
      expect(find.byType(ProjectSidebar), findsOneWidget);
      await tester.tap(key('super-pane-m-docs'));
      await joined(tester);
      expect(find.byType(ProjectSidebar), findsNothing);
      expect(
        c.selectedId,
        f.connection.joins.single['command']['conversationId'],
      );
    }, size: const Size(700, 800));
  });

  // Pictures for the pull request: Your Team at the three window sizes the Desktop is used at, in both themes. A narrow
  // window keeps the left pane in a drawer, so it is opened there.
  for (final (width, height) in [(1440, 900), (1024, 700), (700, 800)]) {
    for (final brightness in Brightness.values) {
      testWidgets(
        'pictures of Your Team at ${width}x$height in ${brightness.name}',
        (tester) async {
          if (_shots == null) return;
          final (:f, :c) = await open(
            tester,
            size: Size(width.toDouble(), height.toDouble()),
            brightness: brightness,
            desk: (f) {
              usualDesk(f);
              f.app.machineStates['m']!.agents = [
                ...f.app.machineStates['m']!.agents,
                session('billing', 'Billing fix'),
                session('ship', '🚀 Ship the release', engine: 'codex'),
              ];
              deskTab(f.app, 'three', [
                pane('m', 'billing'),
                pane('m', 'ship'),
              ]);
            },
          );
          f.app.machineStates['laptop']!.nodeOnline = false;
          await changed(tester, f);
          if (width < 720) {
            await tester.tap(find.byTooltip('Conversations'));
            for (var i = 0; i < 6; i++) {
              await tester.pump(const Duration(milliseconds: 20));
            }
          }
          await captureWindow(
            tester,
            _shots,
            'your-team-${width}x$height-${brightness.name}',
          );
          // A click: the row waits while the pane joins, then its chat is open with its terminal beside it.
          final hold = f.connection.server.holdCommands = Completer<void>();
          await tester.tap(key('super-pane-m-billing'));
          await tester.pump(const Duration(milliseconds: 100));
          await captureWindow(
            tester,
            _shots,
            'your-team-joining-${width}x$height-${brightness.name}',
          );
          f.connection.server.holdCommands = null;
          hold.complete();
          await joined(tester, wait: const Duration(seconds: 2));
          await captureWindow(
            tester,
            _shots,
            'your-team-joined-${width}x$height-${brightness.name}',
          );
          await close(tester, f, c);
        },
        variant: TargetPlatformVariant.only(TargetPlatform.macOS),
      );
    }
  }
}
