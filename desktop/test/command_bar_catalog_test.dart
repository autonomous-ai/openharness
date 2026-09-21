import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/command_bar.dart';
import 'package:harness/state/command_bar_catalog.dart';
import 'package:harness/state/pending_question.dart';
import 'package:harness/state/swarm_navigation.dart';

import 'swarm_state_test.dart' show createApp;

void main() {
  test(
    'exact Store and layout requests invoke their own existing controls',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      String? command;
      var calls = 0;
      final bar = CommandBarController(
        catalog: () => buildCommandBarCatalog(
          app,
          commands: [
            SwarmDestination(
              id: 'command:pane.layout',
              title: 'Choose layout',
              detail: '',
              swarmId: null,
              current: false,
              commandId: 'pane.layout',
            ),
          ],
          runCommand: (id) => command = id,
          create: (_, _, _) async {},
        ),
        resolve: (_, _) async {
          calls++;
          return {};
        },
      );
      addTearDown(bar.dispose);
      await bar.submit('Show me the layout options');
      expect(command, 'pane.layout');
      await bar.submit('Show me the Harness Store');
      expect(app.activeSwarm.isStore, isTrue);
      expect(calls, 0);
    },
  );

  test(
    'Go back restores the exact previous pane without closing the opened view',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      await app.addAgentToSwarm('m', 'a0');
      final before = app.focusedPaneId;
      final bar = CommandBarController(
        catalog: () => buildCommandBarCatalog(
          app,
          commands: [],
          runCommand: (_) {},
          create: (_, _, _) async {},
        ),
        resolve: (_, _) async =>
            throw Exception('exact navigation should stay local'),
      );
      addTearDown(bar.dispose);
      await bar.submit('Open Agent 1');
      expect(app.focusedPane!.agentId, 'a1');
      expect(bar.goBack, isNotNull);
      expect(await bar.goBack!(), isNull);
      expect(app.focusedPaneId, before);
      expect(app.panes.map((p) => p.agentId), contains('a1'));
    },
  );

  test(
    'Go back cannot recreate a closed pane or follow a replaced session',
    () async {
      for (final close in [true, false]) {
        final app = createApp();
        addTearDown(app.dispose);
        await app.addAgentToSwarm('m', 'a0');
        final before = app.focusedPaneId!;
        final bar = CommandBarController(
          catalog: () => buildCommandBarCatalog(
            app,
            commands: [],
            runCommand: (_) {},
            create: (_, _, _) async {},
          ),
          resolve: (_, _) async => {},
        );
        addTearDown(bar.dispose);
        await bar.submit('Open Agent 1');
        if (close) {
          await app.closePane(before);
        } else {
          app.machineStates['m']!.agents = [
            for (final a in app.machineStates['m']!.agents)
              if (a.id == 'a0')
                const Agent(
                  id: 'a0',
                  name: 'Replacement',
                  sessionId: 'new',
                  terminalAvailable: true,
                )
              else
                a,
          ];
        }
        expect(await bar.goBack!(), contains('changed or was closed'));
        expect(app.focusedPane!.agentId, 'a1');
      }
    },
  );

  test(
    'plain terminals and shared sessions can open but cannot receive tasks',
    () {
      for (final (engine, shared) in [('terminal', false), ('codex', true)]) {
        final app = createApp();
        addTearDown(app.dispose);
        final machine = app.machineStates['m']!;
        machine.machine = Machine(
          machineId: 'm',
          authMode: MachineAuthMode.remote,
          isShared: shared,
        );
        app.machines = [machine.machine];
        machine
          ..nodeOnline = true
          ..agents = [
            Agent(
              id: 'a0',
              name: 'Test session',
              engine: engine,
              terminalAvailable: true,
            ),
          ];
        final catalog = buildCommandBarCatalog(
          app,
          commands: [],
          runCommand: (_) {},
          create: (_, _, _) async {},
        );
        expect(catalog.where((a) => a.isSession), hasLength(1));
        expect(catalog.where((a) => a.kind == CommandKind.send), isEmpty);
      }
    },
  );

  test(
    'offline agents and live permission questions are never send targets',
    () {
      final app = createApp();
      addTearDown(app.dispose);
      List<CommandBarAction> catalog() => buildCommandBarCatalog(
        app,
        commands: [],
        runCommand: (_) {},
        create: (_, _, _) async {},
      );
      expect(catalog().where((a) => a.kind == CommandKind.send), isEmpty);
      app.machineStates['m']!.nodeOnline = true;
      expect(catalog().where((a) => a.kind == CommandKind.send), isNotEmpty);
      app.machineStates['m']!.blockedAgents['a0'] = PendingQuestion(
        machineId: 'm',
        agentId: 'a0',
        requestId: 'q',
        answerKey: 'q',
        prompt: 'Allow this command?',
        options: ['Yes', 'No'],
        multi: false,
        since: DateTime(2026, 9, 19),
      );
      expect(catalog().where((a) => a.id == 'send:agent:m\u0000a0'), isEmpty);
      expect(
        catalog().firstWhere((a) => a.id == 'open:agent:m\u0000a0').context,
        contains('Needs input'),
      );
    },
  );

  test('harness creation uses a real catalog identity and the unchanged original prompt', () async {
    final app = createApp();
    addTearDown(app.dispose);
    app.machineStates['m']!
      ..localOnly = true
      ..dsh.replace([
        const DshEntry(
          id: 'autonomous/slides',
          name: 'Slides',
          engine: 'claude',
          description: 'Create slide decks',
        ),
        const DshEntry(
          id: 'autonomous/viewer',
          name: 'Slide viewer',
          engine: '',
          kind: 'viewer',
        ),
      ]);
    List<String?>? creation;
    final catalog = buildCommandBarCatalog(
      app,
      commands: [],
      runCommand: (_) {},
      create: (machine, engine, prompt) async {
        creation = [machine, engine, prompt];
      },
    );
    final slides = catalog.singleWhere(
      (a) => a.id == 'create:m:autonomous/slides',
    );
    await slides.perform!('Build a launch presentation');
    expect(creation, ['m', 'autonomous/slides', 'Build a launch presentation']);
    expect(catalog.where((a) => a.id.contains('autonomous/viewer')), isEmpty);
    expect(slides.automatic, isFalse);
  });

  test('a replaced session with a reused agent id invalidates its previous candidate', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [
      const Agent(
        id: 'auth',
        sessionId: 'old',
        name: 'Auth',
        terminalAvailable: true,
      ),
    ];
    List<CommandBarAction> catalog() => buildCommandBarCatalog(
      app,
      commands: [],
      runCommand: (_) {},
      create: (_, _, _) async {},
    );
    final before = catalog().firstWhere((a) => a.isSession);
    app.machineStates['m']!.agents = [
      const Agent(
        id: 'auth',
        sessionId: 'new',
        name: 'Auth',
        terminalAvailable: true,
      ),
    ];
    final after = catalog().firstWhere((a) => a.isSession);
    expect(before.id, after.id);
    expect(before.version, isNot(after.version));
  });
}
