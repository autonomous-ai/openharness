import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
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

void main() {
  testWidgets('⌘B makes new work at once, set up as the router chose', (
    tester,
  ) async {
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
    app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
    app.adoptSessionForTest(terminal('a0', []));
    await app.addAgentToSwarm('m', 'a0');
    await mount(tester, app);

    await chord(tester, LogicalKeyboardKey.keyB);
    final field = find.byWidgetPredicate(
      (widget) =>
          widget is TextField &&
          widget.decoration?.hintText == 'Describe the work…',
    );
    await tester.enterText(field, 'plot signups by week');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }

    expect(connection.asked['route_decide']?['text'], 'plot signups by week');
    final create = connection.asked['agent_create'];
    expect(create, isNotNull);
    expect(create!['engine'], 'codex');
    expect(create['cwd'], '/work/analytics');
    expect(create['prompt'], 'plot signups by week');
    await tester.pump(const Duration(seconds: 1));
  });

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
}
