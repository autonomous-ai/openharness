// An agent's named state (OpenClaw engine spec, decision 5) on its phone row: the daemon's sentence
// in place of what the agent is doing while it holds, gone once the daemon pushes the agent without it.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agents_page.dart';
import 'package:harness_mobile/state/app_state.dart';

const _noGateway =
    'OpenClaw Gateway is not running. Start it with openclaw gateway.';

Map<String, Object?> _frame({String? namedState}) => {
  'id': 'a0',
  'name': 'Gateway check',
  'engine': 'openclaw',
  'terminal': {'available': true},
  'namedState': ?namedState,
};

void main() {
  testWidgets('a named state shows on the agent row and clears with the hold', (
    tester,
  ) async {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    addTearDown(app.dispose);
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Test host',
    );
    app.machines = [machine];
    // Connected, or the header's spinner keeps pumpAndSettle from returning.
    app.machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [Agent.fromJson(_frame(namedState: _noGateway))];
    await tester.pumpWidget(
      MaterialApp(
        home: AgentsPage(notifier: app, machineId: 'm'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text(_noGateway), findsOneWidget);

    await app.handleEventForTest('m', {
      'type': 'agent_synced',
      'payload': {'agent': _frame()},
    });
    await tester.pumpAndSettle();
    expect(find.text(_noGateway), findsNothing);
    expect(find.text('Gateway check'), findsOneWidget);
  });
}
