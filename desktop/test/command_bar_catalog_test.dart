import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/command_bar.dart';
import 'package:harness/state/command_bar_catalog.dart';
import 'package:harness/state/pending_question.dart';

import 'swarm_state_test.dart' show createApp;

void main() {
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
