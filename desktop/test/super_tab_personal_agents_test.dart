import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/super_tabs/buddy_rows.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/model.dart' show stableId;
import 'package:harness/super_tabs/personal_agents.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/swarm_switcher.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/widgets/pane_grid.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the pictures of Your Team there, in both themes at three window sizes.
final _shots = Platform.environment['PERSONAL_AGENTS_SHOTS'];

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
  }) => Agent(
    id: id,
    name: name,
    title: title,
    nameChosen: chosen,
    engine: engine,
    status: status,
    terminalAvailable: status != 'stopped',
    project: project,
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
    Size size = const Size(1440, 900),
    Brightness brightness = Brightness.light,
  }) async {
    final f = SuperTabLaunchFixture();
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
          },
      ]
      ..['agents'] = [
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
    Size size = const Size(1440, 900),
  }) => testWidgets(description, (tester) async {
    final (:f, :c) = await open(
      tester,
      name: name,
      personal: personal,
      people: people,
      desk: desk,
      joined: joined,
      size: size,
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
    // The id of a message a person sends is the same function over its three parts.
    expect(
      superTabMessageId(
        tabId: '0123456789abcdef01234567',
        accountId: 'owner',
        operationId: 'receipt-1',
      ),
      'c48f7b12bbeacb4a0f75c722',
    );
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
      'sleeping computer show, and a click brings a pane forward', (
    tester,
    f,
    c,
  ) async {
    final laptop = f.app.swarms.firstWhere((t) => t.id == 'two').panes.first;
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
      inRow('super-pane-laptop-notes', find.text('Mac laptop · offline')),
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

    // A click on the laptop's session brings its tab forward with the pane focused.
    await tester.tap(key('super-pane-laptop-notes'));
    await tester.pump();
    expect(f.app.activeSwarmId, 'two');
    expect(f.app.focusedPaneId, laptop.id);
  });

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
      'forty panes: every row is there by name, the list scrolls to the last '
      'and a click on it still brings its tab forward',
      (tester, f, c) async {
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
        await tester.pump();
        expect(f.app.activeSwarmId, 'tab7');
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

    scene('a session two tabs show comes forward in the one it was last focused in, '
        'else the first', (tester, f, c) async {
      final swarmTab = f.app.swarms.firstWhere((s) => s.isSuperTab).id;
      final one = f.app.swarms.firstWhere((t) => t.id == 'one');
      final two = f.app.swarms.firstWhere((t) => t.id == 'two');
      final docsInTwo = two.panes.firstWhere((p) => p.agentId == 'docs');
      two.focusedPaneId = docsInTwo.id;
      await tester.tap(key('super-pane-m-docs'));
      await tester.pump();
      expect(f.app.activeSwarmId, 'two');
      expect(f.app.focusedPaneId, docsInTwo.id);

      // Focused in neither: the first tab that holds it.
      one.focusedPaneId = null;
      two.focusedPaneId = null;
      f.app.selectSwarm(swarmTab);
      await changed(tester, f);
      await tester.tap(key('super-pane-m-docs'));
      await tester.pump();
      expect(f.app.activeSwarmId, 'one');
      expect(
        f.app.focusedPaneId,
        one.panes.firstWhere((p) => p.agentId == 'docs').id,
      );
    });

    scene(
      'a click on a row whose pane closed since it was drawn does nothing',
      (tester, f, c) async {
        for (final tab in f.app.swarms.where((t) => !t.isSuperTab)) {
          tab.panes.removeWhere((p) => p.agentId == 'docs');
        }
        // The list is not drawn again yet: the row is still there to click.
        expect(key('super-pane-m-docs'), findsOneWidget);
        final before = f.app.activeSwarmId;
        await tester.tap(key('super-pane-m-docs'));
        await tester.pump();
        expect(tester.takeException(), isNull);
        expect(f.app.activeSwarmId, before);
        await changed(tester, f);
        expect(key('super-pane-m-docs'), findsNothing);
      },
    );

    scene(
      'one session name on three computers: three rows, told apart by their '
      'computers, each bringing its own tab forward',
      (tester, f, c) async {
        expect(paneRows(), findsNWidgets(3));
        final swarmTab = f.app.swarms.firstWhere((s) => s.isSuperTab).id;
        for (final (row, place, tab) in [
          ('super-pane-laptop-a1', 'Mac laptop', 'lap'),
          ('super-pane-studio-a1', 'Mac Studio', 'studio'),
        ]) {
          expect(inRow(row, find.text('Docs bot')), findsOneWidget);
          expect(inRow(row, find.text(place)), findsOneWidget);
          await tester.tap(key(row));
          await tester.pump();
          expect(f.app.activeSwarmId, tab);
          f.app.selectSwarm(swarmTab);
          await changed(tester, f);
        }
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
        // A session still under its automatic name is called what it is working on, else Untitled.
        expect(
          inRow('super-pane-m-t', find.text('Fix the login page')),
          findsOneWidget,
        );
        expect(
          inRow('super-pane-m-v', find.text('Untitled Pane')),
          findsOneWidget,
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
            'A session named with far too many words to fit in the left pane of any window at all',
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

  scene('a Swarm with other people in it lists no panes of theirs', (
    tester,
    f,
    c,
  ) async {
    expect(find.text('Your Team'), findsOneWidget);
    expect(paneRows(), findsNothing);
  }, people: const ['owner', 'kim']);

  scene(
    'a Swarm that is not their Personal one lists no panes either',
    (tester, f, c) async {
      expect(find.text('Your Team'), findsOneWidget);
      expect(paneRows(), findsNothing);
    },
    name: 'Acme',
    personal: false,
  );

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
          await close(tester, f, c);
        },
        variant: TargetPlatformVariant.only(TargetPlatform.macOS),
      );
    }
  }
}
