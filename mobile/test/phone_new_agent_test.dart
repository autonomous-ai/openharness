import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

/// A machine that answers every question with nothing.
class _Conn extends WsConn {
  _Conn()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'ready',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => {};
}

/// A machine that is answering, and one that is not.
///
/// The second is the whole point of the picker's filter: an agent cannot be created on a machine
/// that has not listed its folders or named its engines, so it must not be offered as a host.
AppNotifier _app() {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    // The form asks the machine for its engines and Codex profiles as it opens.
    connectionForTest: (_) => _Conn(),
  );
  const ready = Machine(
    machineId: 'ready',
    authMode: MachineAuthMode.remote,
    name: 'Studio',
  );
  const sleeping = Machine(
    machineId: 'sleeping',
    authMode: MachineAuthMode.remote,
    name: 'Laptop',
  );
  app.machines = [ready, sleeping];
  app.machineStates['ready'] = MachineState(ready)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded;
  // Harness is not running there: offline, whatever the socket says.
  app.machineStates['sleeping'] = MachineState(sleeping)
    ..nodeOnline = false
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded;
  return app;
}

void main() {
  testWidgets('the form offers only machines that can host an agent', (
    tester,
  ) async {
    final app = _app();
    addTearDown(app.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: NewAgentPage(notifier: app, machineId: 'ready'),
      ),
    );
    await tester.pumpAndSettle();
    // The machine row unfolds into the others there are to choose from.
    await tester.tap(find.text('Studio'));
    await tester.pumpAndSettle();

    expect(find.text('Studio'), findsOneWidget);
    expect(
      find.text('Laptop'),
      findsNothing,
      reason: 'an offline machine cannot host a new agent',
    );
  });
}
