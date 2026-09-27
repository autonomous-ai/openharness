import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

/// A machine that starts the agent it is asked for, and answers everything else with nothing.
///
/// The reply shape is the one the notifier's receipt path requires: the creation id it was handed
/// back, `created`, and the agent itself — anything less reads as unconfirmed.
class _Conn extends WsConn {
  _Conn()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  /// Every `agent_create` payload asked for, in order.
  final created = <Map<String, dynamic>>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'agent_create') return {};
    created.add(payload);
    return {
      'creationId': payload['creationId'],
      'state': 'created',
      'agent': {
        'id': 'new-agent',
        'name': 'new-agent',
        'engine': 'claude',
        'terminal': {'available': true},
      },
    };
  }
}

/// A machine answering, with one agent already in a folder.
///
/// ⚠️ The agent is no longer what puts a tappable folder on the form — RECENT does, and RECENT is
/// the stored history rather than a reading of the machine's agents. The caller seeds that history;
/// this agent is here so the machine is not empty. Browsing for a folder instead would open the
/// remote picker, a screen of its own.
AppNotifier _app(_Conn conn) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    connectionForTest: (_) => conn,
  );
  const machine = Machine(
    machineId: 'm',
    authMode: MachineAuthMode.remote,
    name: 'Test host',
  );
  app.machines = [machine];
  app.machineStates['m'] = MachineState(machine)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = [
      const Agent(
        id: 'old',
        name: 'old',
        engine: 'claude',
        project: AgentProject(name: 'grid', cwd: '/src/grid'),
        terminalAvailable: true,
      ),
    ];
  return app;
}

void main() {
  testWidgets(
    'creating an agent opens it, and leaves no form to come back to',
    (tester) async {
      final app = _app(_Conn());
      addTearDown(app.dispose);
      // A folder this machine has been used with before — the Project row's
      // default, titled by the path's last segment.
      await app.projectHistory.select('m', '/src/grid');
      await tester.pumpWidget(
        MaterialApp(
          home: NewAgentPage(notifier: app, machineId: 'm'),
        ),
      );
      await tester.pump();

      // The desktop's ⌘N defaults: the project last started here and the engine
      // the form starts on are already chosen, so the button is the whole flow.
      expect(find.text('Test host:grid', findRichText: true), findsOneWidget);
      // Start is the button.
      await tester.tap(find.text('Start'));
      // The create resolves on a microtask, then the route it pushes has to slide in — and only once
      // that transition ends does the form's own route come off the stack.
      await tester.pump();
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 400));
      }

      expect(
        find.byType(AgentSwipeHost),
        findsOneWidget,
        reason: 'the agent just asked for is what the form opens',
      );
      expect(
        find.byType(NewAgentPage),
        findsNothing,
        reason: 'the form is replaced, so back from the agent is the list behind it',
      );
    },
  );

  testWidgets(
    'the task goes with Start as the first prompt, and only if there is one',
    (tester) async {
      final conn = _Conn();
      final app = _app(conn);
      addTearDown(app.dispose);
      await app.projectHistory.select('m', '/src/grid');
      await tester.pumpWidget(
        MaterialApp(
          home: NewAgentPage(notifier: app, machineId: 'm'),
        ),
      );
      await tester.pump();
      expect(find.text('task (optional)'), findsOneWidget);
      await tester.enterText(
        find.byType(TextField),
        '  fix the login test, then run the suite  ',
      );
      await tester.pump();
      await tester.tap(find.text('Start'));
      await tester.pump();
      // Not pumpAndSettle: the task field's cursor blinks for as long as it has the keyboard.
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 400));
      }
      expect(conn.created, hasLength(1));
      final choices = conn.created.single;
      // Wherever the transport nests them, the trimmed task rides as `prompt`.
      expect(
        choices.toString(),
        contains('prompt: fix the login test, then run the suite'),
      );
    },
  );
}
