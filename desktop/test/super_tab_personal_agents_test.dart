import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/personal_agents.dart';
import 'package:harness/super_tabs/swarm_switcher.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/super_tab_fixture.dart';

/// Your Team in a person's Personal Swarm (Swarm v4, anh Dee 2026-11-09): every pane they run is an agent there, with its
/// face, its name and its computer, clicked through as a person does.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));
  Finder paneRows() => find.byWidgetPredicate(
    (w) =>
        w.key is ValueKey<String> &&
        (w.key! as ValueKey<String>).value.startsWith('super-pane-'),
  );

  Agent session(
    String id,
    String name, {
    String engine = 'claude',
    String status = 'active',
  }) => Agent(
    id: id,
    name: name,
    nameChosen: true,
    engine: engine,
    status: status,
    terminalAvailable: status != 'stopped',
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
    app.machineStates[id] = MachineState(machine)
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
  }

  var paneIds = 4000;
  TerminalPane pane(String machineId, String agentId) =>
      TerminalPane(id: paneIds++, machineId: machineId, agentId: agentId);

  void deskTab(AppNotifier app, String id, List<TerminalPane> panes) =>
      app.swarms.add(Swarm(id: id, name: id)..panes.addAll(panes));

  /// A Swarm tab showing [name], and the desk its person works from: this Mac with a Claude Code session, a plain shell, a
  /// stopped session and a Codex one that is in the Swarm already; their laptop with Codex; a computer shared with them.
  /// [personal]: it was picked as their Personal Swarm.
  Future<({SuperTabLaunchFixture f, SuperTabController c})> open(
    WidgetTester tester, {
    String name = 'Personal',
    bool personal = true,
    List<String> people = const ['owner'],
  }) async {
    final f = SuperTabLaunchFixture();
    f.app.machineStates['m']!
      ..localOnly = true
      ..agents = [
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
    final atlas = swarmAgentId('m', 'joined');
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
        {
          'id': atlas,
          'projectId': 'lead',
          'name': 'Atlas',
          'displayName': 'Atlas',
          'machineId': 'm',
          'harnessId': 'joined',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
          'kind': 'regular',
          'chatId': 'atlas-chat',
          'myAgent': true,
        },
      ];
    (f.connection.server.state['conversations'] as List).add({
      ...conversationFixture('atlas-chat', 'Atlas'),
      'kind': 'agent-chat',
      'agentIds': [atlas],
    });
    if (personal) {
      await f.app.superTabs.storage.write('super_tab.personal.owner', tabId);
    }
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, name);
    PersonalSwarm.of(f.app).id;
    for (var i = 0; i < 20; i++) {
      await Future<void>.microtask(() {});
    }
    final c = (await tester.runAsync(() async {
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      return c;
    }))!;
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            app: f.app,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (id) =>
                f.app.stateOf(id)?.machine.displayName ?? 'Offline machine',
            board: true,
          ),
        ),
      ),
    );
    await tester.pump();
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(c.flush);
      f.app.superTabs.dispose();
    });
    return (f: f, c: c);
  }

  test('the Swarm\'s id for an agent is the backend\'s, so a face is the same once it joins', () {
    // backend superTabs/model.ts stableId(machineId, harnessId), worked out with node's crypto.
    expect(swarmAgentId('m', 'h1'), 'c82f313e6c97bca6dfd30dcb');
    expect(swarmAgentId('laptop', 'n1'), '2c4729e0c7a5fb6fe9462e8e');
    expect(
      swarmAgentId('0c2d6c8a-3f7e-4d0e-9a52-6f1f6a2f0b11', 'session-ü'),
      '53fc1449b3b28a00489bbf59',
    );
  });

  testWidgets(
    'every Claude Code or Codex pane of the person is a row under Your Team: '
    'its face, its name and its computer',
    (tester) async {
      final (:f, :c) = await open(tester);
      // One of this Mac's and one of the laptop's, each once though a tab holds the same session twice over.
      expect(paneRows(), findsNWidgets(2));
      Finder inRow(String row, Finder finder) =>
          find.descendant(of: key(row), matching: finder);
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
      // Nothing was sent: the server learns of a pane only when its person opens it.
      expect(f.connection.server.posts, isEmpty);
    },
  );

  testWidgets(
    'a click on a pane\'s row brings its tab forward with the pane focused',
    (tester) async {
      final (:f, c: _) = await open(tester);
      final laptop = f.app.swarms.firstWhere((t) => t.id == 'two').panes.first;
      await tester.tap(key('super-pane-laptop-notes'));
      await tester.pump();
      expect(f.app.activeSwarmId, 'two');
      expect(f.app.focusedPaneId, laptop.id);
    },
  );

  testWidgets('a Swarm with other people in it lists no panes of theirs', (
    tester,
  ) async {
    await open(tester, people: const ['owner', 'kim']);
    expect(find.text('Your Team'), findsOneWidget);
    expect(paneRows(), findsNothing);
  });

  testWidgets('a Swarm that is not their Personal one lists no panes either', (
    tester,
  ) async {
    await open(tester, name: 'Acme', personal: false);
    expect(find.text('Your Team'), findsOneWidget);
    expect(paneRows(), findsNothing);
  });
}
