import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/launch_setup.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

/// ⌘B on the workspace: new work is made at once, with the agent and folder
/// the router chose and the words as its task (docs/design/2026-10-09-auto-router.md).
class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final asked = <String, Map<String, dynamic>>{};

  @override
  bool get isReady => true;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    asked[type] = payload;
    return switch (type) {
      'route_decide' => {
        'decided': 'new',
        'project': 'm\n/work/analytics',
        'agent': 'codex',
        'via': 'jev',
      },
      // Far enough: what was asked for is the test.
      'agent_create' => throw const WsRequestTimeout('agent_create'),
      _ => {},
    };
  }
}

/// ⌘B, the task typed and Return pressed, on a desk with one session in /work/analytics.
Future<_Connection> _routeNewWork(
  WidgetTester tester, {
  Future<Map<String, dynamic>> Function(String, String)? git,
  void Function(AppNotifier app)? before,
}) async {
  final connection = _Connection();
  final app = createApp(connectionForTest: (_) => connection);
  app.machineStates['m']!
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..localOnly = true
    ..localProjects = const {
      'a0': AgentProject(name: 'analytics', cwd: '/work/analytics'),
    };
  // Not a Git project; a real disk read would never finish under the test's clock.
  app.gitProjectReaderForTest = git ?? (_, _) async => {'isGit': false};
  before?.call(app);
  app.adoptSessionForTest(terminal('a0', []));
  await app.addAgentToSwarm('m', 'a0');
  await mount(tester, app);

  await chord(tester, LogicalKeyboardKey.keyB);
  await tester.enterText(_taskField, 'plot signups by week');
  await tester.sendKeyEvent(LogicalKeyboardKey.enter);
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
  expect(connection.asked['route_decide']?['text'], 'plot signups by week');
  return connection;
}

final _taskField = find.byWidgetPredicate(
  (widget) =>
      widget is TextField &&
      widget.decoration?.hintText == 'Describe the work…',
);

void main() {
  testWidgets('⌘B makes new work at once, set up as the router chose', (
    tester,
  ) async {
    final connection = await _routeNewWork(tester);
    final create = connection.asked['agent_create'];
    expect(create, isNotNull);
    expect(create!['engine'], 'codex');
    expect(create['cwd'], '/work/analytics');
    expect(create['prompt'], 'plot signups by week');
    // Nobody chose otherwise: New Harness's own default.
    expect(create['permissionMode'], 'auto');
    expect(create['bypassPermission'], isTrue);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('new work starts in the permission mode the person last chose', (
    tester,
  ) async {
    final connection = await _routeNewWork(
      tester,
      before: (app) => app.agentPreference.successfulLaunch = const LaunchSetup(
        engine: 'codex',
        permissionMode: 'ask',
      ),
    );
    final create = connection.asked['agent_create']!;
    expect(create['permissionMode'], 'ask');
    expect(create['bypassPermission'], isFalse);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets(
    'a project that could not be read opens New Harness on the task, never its checkout',
    (tester) async {
      final connection = await _routeNewWork(
        tester,
        git: (_, _) async => {'error': 'UNAVAILABLE'},
      );
      expect(connection.asked['agent_create'], isNull);
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('plot signups by week'), findsWidgets);
    },
  );

  testWidgets(
    'a session with a pane in another tab is brought forward there, never opened twice',
    (tester) async {
      final app = createApp(connectionForTest: (_) => _Connection());
      app.machineStates['m']!
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected;
      app.adoptSessionForTest(terminal('a0', []));
      await app.addAgentToSwarm('m', 'a0');
      final backlog = app.activeSwarmId;
      app.newSwarm(name: 'Work', newTabPage: true);
      expect(app.activeSwarmId, isNot(backlog));
      final panes = app.allPanes.length;

      app.bringSessionForward('m', 'a0');

      expect(app.activeSwarmId, backlog);
      expect(app.focusedPane?.agentId, 'a0');
      expect(app.allPanes.length, panes);
    },
  );

  testWidgets(
    'a pane brought forward from a tab behind with no terminal yet is attached',
    (tester) async {
      final app = createApp(connectionForTest: (_) => _Connection());
      app.machineStates['m']!
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected;
      await app.addAgentToSwarm('m', 'a0');
      final pane = app.allPanes.firstWhere((p) => p.agentId == 'a0');
      // Restored after a restart, or its session just resumed: nothing has attached it.
      pane.session = null;
      app.newSwarm(name: 'Work', newTabPage: true);
      app.machineStates['m']!.terminalCapabilityAvailable = true;

      app.bringSessionForward('m', 'a0');
      await tester.pump();

      expect(app.focusedPane?.agentId, 'a0');
      expect(pane.session, isNotNull);
      // The terminal it opened keeps an open deadline: let it lapse with the app.
      app.dispose();
      await tester.pump(const Duration(minutes: 1));
    },
  );
}
