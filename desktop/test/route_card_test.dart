import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/task_route.dart';
import 'package:harness/widgets/task_palette.dart';

/// ⌘B, say it and it is done (docs/design/2026-10-09-auto-router.md): Return
/// asks the router to decide, and the card acts on the answer without asking.
class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Office',
    );
    machines = [machine];
    machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = const [
        Agent(
          id: 'a0',
          name: 'Analyze Harness usage data',
          engine: 'codex',
          terminalAvailable: true,
        ),
        Agent(
          id: 'a1',
          name: 'zsh',
          engine: 'terminal',
          terminalAvailable: true,
        ),
      ]
      ..localProjects = const {
        'a0': AgentProject(name: 'analytics', cwd: '/work/analytics'),
      };
  }

  Map<String, dynamic>? Function(String text) reply = (_) => null;
  final payloads = <Map<String, dynamic>>[];
  final routed = <String>[];
  final sent = <(String, String, String)>[];

  TaskRouteDecision? Function(String text)? decision;

  @override
  Future<TaskRouteDecision?> routeDecide(
    String text,
    TaskRouteChoices choices,
  ) async {
    payloads.add(choices.toPayload());
    if (decision case final decide?) return decide(text);
    final answer = reply(text);
    return answer == null ? null : TaskRouteDecision.fromJson(answer, choices);
  }

  Map<String, dynamic> recent = const {};

  @override
  Future<Map<String, dynamic>> readRecentTurns(
    String machineId,
    String agentId,
  ) async => recent;

  @override
  Future<RouteAnswer?> routeTask(String text) {
    routed.add(text);
    return Completer<RouteAnswer?>().future;
  }

  @override
  Future<String?> sendTaskToSession(
    String machineId,
    String agentId,
    String task,
  ) async {
    sent.add((machineId, agentId, task));
    return null;
  }
}

Future<(_App, Future<NewHarnessFromTask?> Function())> _open(
  WidgetTester tester,
) async {
  final app = _App();
  addTearDown(app.dispose);
  Future<NewHarnessFromTask?>? result;
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => result = showTaskPalette(context, app),
            child: const Text('Open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
  return (app, () => result!);
}

Future<void> _say(WidgetTester tester, String text) async {
  await tester.enterText(find.byType(TextField), text);
  await tester.pump();
  await tester.sendKeyEvent(LogicalKeyboardKey.enter);
  await tester.pump();
  await tester.pump();
}

const _session = 'm\na0';

Agent _agent(String id, {String status = 'idle', int minutesAgo = 0}) => Agent(
  id: id,
  name: 'Session $id',
  engine: 'claude',
  status: status,
  terminalAvailable: true,
  lastActivityAt: DateTime(
    2026,
    10,
    10,
    12,
  ).subtract(Duration(minutes: minutesAgo)),
);

void main() {
  test('the router is offered live sessions on reachable machines, newest first, forty at most', () {
    final app = _App();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [
      for (var i = 0; i < 50; i++) _agent('a$i', minutesAgo: i),
      _agent('stopped', status: 'stopped'),
      const Agent(
        id: 'sh',
        name: 'zsh',
        engine: 'terminal',
        terminalAvailable: true,
      ),
    ];
    const away = Machine(
      machineId: 'off',
      authMode: MachineAuthMode.remote,
      name: 'Rig',
    );
    app.machines = [...app.machines, away];
    app.machineStates['off'] = MachineState(away)
      ..nodeOnline = false
      ..agents = [_agent('far')];
    final ids = taskRouteChoices(app).sessions.values
        .map((s) => s.agentId)
        .toList();
    expect(ids, [for (var i = 0; i < 40; i++) 'a$i']);
  });

  test(
    'new work in a Git project starts in a fresh worktree of its repository',
    () async {
      final app = _App();
      addTearDown(app.dispose);
      final asked = <String>[];
      app.gitProjectReaderForTest = (machineId, path) async {
        asked.add(path);
        return path == '/repos/harness/.wt/feature'
            ? {
                'isGit': true,
                'mainFolder': '/repos/harness',
                'branches': const [],
              }
            : {
                'isGit': true,
                'branch': 'main',
                'branches': [
                  {'ref': 'refs/heads/main', 'name': 'main'},
                ],
              };
      };
      final start = await newWorkFolder(app, 'm', '/repos/harness/.wt/feature');
      expect(asked, ['/repos/harness/.wt/feature', '/repos/harness']);
      expect(start.folder, '/repos/harness');
      expect(start.request?.payload['projectSource'], 'worktree');
    },
  );

  test('new work outside Git starts in the folder itself', () async {
    final app = _App();
    addTearDown(app.dispose);
    app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
    final start = await newWorkFolder(app, 'm', '/notes');
    expect(start.folder, '/notes');
    expect(start.request, isNull);
  });

  testWidgets('each session goes with what it was last asked and last did', (
    tester,
  ) async {
    final app = _App()
      ..recent = {
        'asks': ["ok we'll check again in 24 hours", 'did onboarding help'],
        'events': [
          {
            'kind': 'summary',
            'recap': 'Compared 24-hour activation and cohort sizes.',
          },
        ],
      };
    addTearDown(app.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showTaskPalette(context, app),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await _say(tester, "what's d30 retention on harness");
    final session = (app.payloads.single['sessions'] as List).single as Map;
    expect(session['asks'], [
      "ok we'll check again in 24 hours",
      'did onboarding help',
    ]);
    expect(session['about'], 'Compared 24-hour activation and cohort sizes.');
  });

  testWidgets('it offers the router every session it can see, never a shell', (
    tester,
  ) async {
    final (app, _) = await _open(tester);
    await _say(tester, "what's the D3 retention rate");
    final payload = app.payloads.single;
    expect(
      [for (final s in payload['sessions'] as List) (s as Map)['id']],
      [_session],
    );
    expect(
      (payload['sessions'] as List).single['name'],
      'Analyze Harness usage data',
    );
    expect(
      [for (final p in payload['projects'] as List) (p as Map)['name']],
      ['analytics'],
    );
    expect([
      for (final a in payload['agents'] as List) (a as Map)['id'],
    ], containsAll(['claude', 'codex']));
  });

  testWidgets('a task for a session is sent there at once, nothing asked', (
    tester,
  ) async {
    final (app, result) = await _open(tester);
    app.reply = (_) => {'decided': 'session', 'id': _session, 'via': 'jev'};
    await _say(tester, "what's the D3 retention rate");
    expect(app.sent, [('m', 'a0', "what's the D3 retention rate")]);
    expect(app.routed, isEmpty);
    expect(app.lastRoutedTask?.id, _session);
    // The receipt names who took it, then the card goes.
    expect(find.text('Analyze Harness usage data'), findsOneWidget);
    await tester.pumpAndSettle(const Duration(seconds: 1));
    expect(find.byType(TextField), findsNothing);
    expect(await result(), isNull);
  });

  testWidgets('new work closes the card with the setup the models chose', (
    tester,
  ) async {
    final (app, result) = await _open(tester);
    app.reply = (_) => {
      'decided': 'new',
      'project': 'm\n/work/analytics',
      'agent': 'codex',
      'via': 'jev',
    };
    await _say(tester, 'write a script that plots signups by week');
    await tester.pumpAndSettle();
    final plan = await result();
    expect(plan?.task, 'write a script that plots signups by week');
    expect(plan?.machineId, 'm');
    expect(plan?.folder, '/work/analytics');
    expect(plan?.engine, 'codex');
    expect(app.sent, isEmpty);
  });

  testWidgets(
    'new work the models were unsure of leaves the setup to the pane',
    (tester) async {
      final (app, result) = await _open(tester);
      app.reply = (_) => {'decided': 'new', 'via': 'unsure'};
      await _say(tester, 'write a haiku about autumn leaves');
      await tester.pumpAndSettle();
      final plan = await result();
      expect(plan?.machineId, isNull);
      expect(plan?.engine, isNull);
    },
  );

  testWidgets('a session the card never offered is never sent to', (
    tester,
  ) async {
    final (app, _) = await _open(tester);
    app.reply = (_) => {'decided': 'session', 'id': 'm\na1', 'via': 'jev'};
    await _say(tester, 'list the files');
    expect(app.sent, isEmpty);
    expect(app.routed, ['list the files']);
  });

  testWidgets('when Jev cannot be asked, the box says so and sends nothing', (
    tester,
  ) async {
    final (app, _) = await _open(tester);
    app.decision = (_) => const TaskRouteDecision.unavailable('out of credit');
    await _say(tester, "what's d30 retention on harness");
    expect(
      find.textContaining('Jev could not decide (out of credit)'),
      findsOneWidget,
    );
    expect(app.sent, isEmpty);
    expect(app.routed, isEmpty);
  });

  testWidgets('a daemon without the router leaves the card as it was', (
    tester,
  ) async {
    final (app, _) = await _open(tester);
    await _say(tester, "what's the D3 retention rate");
    expect(app.routed, ["what's the D3 retention rate"]);
    expect(app.sent, isEmpty);
  });
}
