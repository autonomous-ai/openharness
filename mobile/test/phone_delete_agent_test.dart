import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';
import 'package:harness_mobile/phone/agent_tile.dart';
import 'package:harness_mobile/phone/agents_page.dart';

/// Records what the page asks the machine for, and answers everything with a bare success.
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

  final calls = <(String, Map<String, dynamic>)>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    calls.add((type, payload));
    return {};
  }

  List<String> get deleted => [
    for (final (type, payload) in calls)
      if (type == 'agent_delete') payload['agentId'] as String,
  ];
}

/// A machine answering with two agents: one whose terminal is up, one whose is not.
///
/// The second is the case the row's hold exists for — it cannot be opened, so a menu hung off the
/// tap would never reach it.
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
  // ⚠️ `connected` is load-bearing, and not for realism. Anything less leaves the header at
  // "Connecting…", whose StatusPill draws a CircularProgressIndicator — an animation that never
  // ends, so `pumpAndSettle` never returns and every test here times out before its first assert.
  app.machineStates['m'] = MachineState(machine)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = const [
      Agent(
        id: 'a0',
        name: 'Live one',
        engine: 'codex',
        terminalAvailable: true,
      ),
      Agent(
        id: 'a1',
        name: 'Gone one',
        engine: 'codex',
        terminalAvailable: false,
      ),
    ];
  return app;
}

Future<void> _pump(WidgetTester tester, AppNotifier app) async {
  await tester.pumpWidget(
    MaterialApp(
      home: AgentsPage(notifier: app, machineId: 'm'),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('holding an agent offers Delete, and Cancel deletes nothing', (
    tester,
  ) async {
    final conn = _Conn();
    final app = _app(conn);
    addTearDown(app.dispose);
    await _pump(tester, app);

    await tester.longPress(find.byType(AgentTile).first);
    await tester.pumpAndSettle();
    expect(find.text('Delete agent…'), findsOneWidget);

    await tester.tap(find.text('Delete agent…'));
    await tester.pumpAndSettle();
    expect(find.text('Delete Live one?'), findsOneWidget);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(conn.deleted, isEmpty, reason: 'backing out must ask nothing');
    expect(app.machineStates['m']!.agents, hasLength(2));
  });

  testWidgets('confirming deletes that agent and no other', (tester) async {
    final conn = _Conn();
    final app = _app(conn);
    addTearDown(app.dispose);
    await _pump(tester, app);

    await tester.longPress(find.byType(AgentTile).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete agent…'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await tester.pumpAndSettle();

    expect(conn.deleted, ['a0']);
    expect(app.machineStates['m']!.agents.map((agent) => agent.id), [
      'a1',
    ], reason: 'the row goes because the notifier dropped it, not the page');
    expect(find.text('Live one'), findsNothing);
  });

  testWidgets('an agent with no terminal cannot be opened but can be held', (
    tester,
  ) async {
    final conn = _Conn();
    final app = _app(conn);
    addTearDown(app.dispose);
    await _pump(tester, app);

    final gone = find.byType(AgentTile).last;
    // A tap is the gesture this row refuses; nothing should open.
    await tester.tap(gone);
    await tester.pumpAndSettle();
    expect(find.text('Delete agent…'), findsNothing);

    await tester.longPress(gone);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete agent…'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await tester.pumpAndSettle();

    expect(conn.deleted, ['a1']);
  });
}
