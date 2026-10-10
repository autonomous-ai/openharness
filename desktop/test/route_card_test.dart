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
import 'package:harness/ws/ws_conn.dart';

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

  /// Held until the test lets it go, when set: the pane coming forward before the words are typed.
  Completer<void>? paneReady;

  @override
  Future<String?> sendTaskToSession(
    String machineId,
    String agentId,
    String task, {
    bool Function()? stillWanted,
  }) async {
    await paneReady?.future;
    if (stillWanted != null && !stillWanted()) return 'Nothing was sent.';
    sent.add((machineId, agentId, task));
    return null;
  }
}

/// This computer's daemon, answering `route_decide` with [answer]: a reply, or a refusal to throw.
class _Daemon extends WsConn {
  _Daemon(this.answer)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final Object Function() answer;
  var asked = 0;

  @override
  bool get isReady => true;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'route_decide') return const {};
    asked++;
    final reply = answer();
    if (reply is Map<String, dynamic>) return reply;
    throw reply;
  }
}

/// The app's own reading of the router's answers, against a daemon that gives [answer].
Future<(TaskRouteDecision?, _Daemon)> _decided(Object Function() answer) async {
  final daemon = _Daemon(answer);
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    connectionForTest: (_) => daemon,
  );
  addTearDown(app.dispose);
  const machine = Machine(
    machineId: 'm',
    authMode: MachineAuthMode.remote,
    name: 'Office',
  );
  app.machines = [machine];
  app.machineStates['m'] = MachineState(machine)
    ..localOnly = true
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = const [
      Agent(
        id: 'a0',
        name: 'Analyze',
        engine: 'codex',
        terminalAvailable: true,
      ),
    ];
  final decision = await app.routeDecide('go', taskRouteChoices(app));
  return (decision, daemon);
}

WsRequestFailure _refused(String code, [String? detail]) => WsRequestFailure(
  responseType: 'route_decide_result',
  code: code,
  detail: detail,
);

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

final _now = DateTime(2026, 10, 10, 12);

Agent _agent(
  String id, {
  String status = 'idle',
  int minutesAgo = 0,
  String engine = 'claude',
  String? sessionId,
}) => Agent(
  id: id,
  name: 'Session $id',
  engine: engine,
  status: status,
  sessionId: sessionId,
  terminalAvailable: status != 'stopped',
  lastActivityAt: _now.subtract(Duration(minutes: minutesAgo)),
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
    final ids = taskRouteChoices(
      app,
      now: _now,
    ).sessions.values.map((s) => s.agentId).toList();
    expect(ids, [for (var i = 0; i < 40; i++) 'a$i']);
  });

  test('a stopped session is offered for a week, when it can resume its own conversation', () {
    final app = _App();
    addTearDown(app.dispose);
    const day = 24 * 60;
    app.machineStates['m']!.agents = [
      _agent('live', minutesAgo: 30 * day),
      _agent(
        'tuesday',
        status: 'stopped',
        sessionId: 'c-1',
        minutesAgo: 4 * day,
      ),
      _agent(
        'lastweek',
        status: 'stopped',
        sessionId: 'c-2',
        minutesAgo: 8 * day,
      ),
      // Nothing of its conversation to go back to: a follow-up would land in a new one.
      _agent('unsaved', status: 'stopped', minutesAgo: 60),
      _agent(
        'other',
        status: 'stopped',
        sessionId: 'c-3',
        engine: 'gemini',
        minutesAgo: 60,
      ),
      const Agent(
        id: 'undated',
        name: 'Undated',
        engine: 'claude',
        status: 'stopped',
        sessionId: 'c-4',
      ),
    ];
    final ids = taskRouteChoices(
      app,
      now: _now,
    ).sessions.values.map((s) => s.agentId).toList();
    expect(ids, ['tuesday', 'live']);
    // Jev is told it is stopped, and since when; a live one says nothing of the kind.
    final sent = {
      for (final row
          in taskRouteChoices(app, now: _now).toPayload()['sessions'] as List)
        (row as Map)['id']: row['stoppedAgoMs'],
    };
    expect(sent, {
      'm\ntuesday': const Duration(days: 4).inMilliseconds,
      'm\nlive': null,
    });
    // A machine whose clock runs ahead still reads as stopped, never as live.
    final ahead = taskRouteChoices(
      app,
      now: _now.subtract(const Duration(days: 5)),
    );
    expect(ahead.sessions['m\ntuesday']?.stoppedFor, Duration.zero);
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
      expect(start?.folder, '/repos/harness');
      expect(start?.request?.payload['projectSource'], 'worktree');
    },
  );

  test('new work outside Git starts in the folder itself', () async {
    final app = _App();
    addTearDown(app.dispose);
    app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
    final start = await newWorkFolder(app, 'm', '/notes');
    expect(start?.folder, '/notes');
    expect(start?.request, isNull);
  });

  test(
    'a folder that could not be read is nowhere to start, not a plain folder',
    () async {
      final app = _App();
      addTearDown(app.dispose);
      app.gitProjectReaderForTest = (_, _) async => {'error': 'UNAVAILABLE'};
      expect(await newWorkFolder(app, 'm', '/repos/harness'), isNull);
    },
  );

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

  group('the router\'s answer, as the app reads it', () {
    test('a session it was offered', () async {
      final (decision, _) = await _decided(
        () => {'decided': 'session', 'id': 'm\na0', 'via': 'jev'},
      );
      expect(decision?.sessionId, 'm\na0');
    });

    test('a session it was never offered is nothing decided', () async {
      final (decision, _) = await _decided(
        () => {'decided': 'session', 'id': 'm\nelsewhere', 'via': 'jev'},
      );
      expect(decision?.session, isNull);
      expect(
        decision?.unavailableBecause,
        'the router named a session it was not offered',
      );
    });

    test('Jev unreachable is nothing decided, and says why', () async {
      final (decision, _) = await _decided(
        () => _refused('JEV_UNAVAILABLE', 'no OpenRouter key on this computer'),
      );
      expect(
        decision?.unavailableBecause,
        'no OpenRouter key on this computer',
      );
    });

    test(
      'a router busy, down or silent is nothing decided — never the old router',
      () async {
        for (final code in ['BUSY', 'SERVICE_UNAVAILABLE', 'SERVICE_FAILED']) {
          final (decision, _) = await _decided(() => _refused(code));
          expect(
            decision?.unavailableBecause,
            'the router answered $code',
            reason: code,
          );
        }
        final (silent, _) = await _decided(
          () => WsRequestTimeout('route_decide'),
        );
        expect(silent?.unavailableBecause, 'the router did not answer');
      },
    );

    test(
      'a daemon without the router hands the card back to the old one',
      () async {
        final (decision, daemon) = await _decided(
          () => _refused('UNSUPPORTED'),
        );
        expect(decision, isNull);
        expect(daemon.asked, 1);
      },
    );
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

  testWidgets('Return during the receipt does not send the task again', (
    tester,
  ) async {
    final (app, _) = await _open(tester);
    app.reply = (_) => {'decided': 'session', 'id': _session, 'via': 'jev'};
    await _say(tester, "what's the D3 retention rate");
    expect(app.sent, hasLength(1));
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.pumpAndSettle(const Duration(seconds: 1));
    expect(app.sent, hasLength(1));
  });

  testWidgets('Esc while the pane comes forward stops the send', (
    tester,
  ) async {
    final (app, result) = await _open(tester);
    app.paneReady = Completer<void>();
    app.reply = (_) => {'decided': 'session', 'id': _session, 'via': 'jev'};
    await _say(tester, "what's the D3 retention rate");
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    app.paneReady!.complete();
    await tester.pump();
    expect(app.sent, isEmpty);
    expect(app.lastRoutedTask, isNull);
    expect(await result(), isNull);
  });

  testWidgets('new work is not followed up in the session before it', (
    tester,
  ) async {
    final (app, _) = await _open(tester);
    app.lastRoutedTask = (id: _session, at: DateTime.now());
    app.reply = (_) => {'decided': 'new', 'via': 'jev'};
    await _say(tester, 'write a script that plots signups by week');
    await tester.pumpAndSettle();
    expect(app.lastRoutedTask, isNull);
  });

  testWidgets('a spoken task keeps the dial button it was said with', (
    tester,
  ) async {
    final app = _App();
    addTearDown(app.dispose);
    app.reply = (_) => {'decided': 'session', 'id': _session, 'via': 'jev'};
    final reports = <(String, String)>[];
    final spoken = SpokenTask(
      voiceId: 'v1',
      text: 'ship the retention chart',
      cmd: 'goal',
      report: (_, state, agentId) => reports.add((state, agentId)),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showTaskPalette(context, app, spoken: spoken),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle(const Duration(seconds: 1));
    expect(app.sent, [('m', 'a0', '/goal ship the retention chart')]);
    expect(reports, [('taken', ''), ('sent', 'a0')]);
  });

  testWidgets('spoken new work is answered by whoever makes the harness', (
    tester,
  ) async {
    final app = _App();
    addTearDown(app.dispose);
    app.reply = (_) => {'decided': 'new', 'via': 'jev'};
    final reports = <String>[];
    final spoken = SpokenTask(
      voiceId: 'v1',
      text: 'plot signups by week',
      cmd: 'loop',
      report: (_, state, _) => reports.add(state),
    );
    Future<NewHarnessFromTask?>? result;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () =>
                  result = showTaskPalette(context, app, spoken: spoken),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    final plan = await result!;
    expect(plan?.prompt, '/loop plot signups by week');
    expect(reports, ['taken']);
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
