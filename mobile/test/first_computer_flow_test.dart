import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

class _Conn extends WsConn {
  _Conn()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'studio',
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

/// A new account's first minutes on the phone, signed in: no computer yet → how to set one up;
/// the computer appears, locked → its unlock, right there; unlocked with nothing running → New.
void main() {
  testWidgets('no computer, then a locked one, then an empty one', (
    tester,
  ) async {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (_) => _Conn(),
    );
    addTearDown(app.dispose);
    final request = ValueNotifier<({String machineId, String agentId})?>(null);
    addTearDown(request.dispose);
    final linked = ValueNotifier<String?>(null);
    addTearDown(linked.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: PhoneShellScope(
          // What the shell does on a link: tell home which machine was just unlocked.
          onMachineLinked: (machineId) => linked.value = machineId,
          onOpenAgent: (_, _) {},
          child: AgentHome(
            notifier: app,
            openAgent: request,
            openMachineId: linked,
          ),
        ),
      ),
    );
    Future<void> settle() async {
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    await settle();
    expect(find.text('Get Harness for\nyour computer'), findsOneWidget);

    // It appears — awake, and waiting for its phone password.
    const studio = Machine(
      machineId: 'studio',
      authMode: MachineAuthMode.remote,
      name: 'studio',
    );
    app.machines = [studio];
    app.machineStates['studio'] = MachineState(studio)
      ..nodeOnline = true
      ..needsLink = true
      ..agentLoadStatus = AgentLoadStatus.needsLink;
    app.notifyListeners();
    await settle();
    expect(find.text('Unlock studio'), findsOneWidget);

    // Unlocked (what a right password does), with nothing running: New, to start the first one.
    linked.value = 'studio';
    app.machineStates['studio']!
      ..needsLink = false
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [];
    app.notifyListeners();
    await settle();
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('New Harness'), findsWidgets);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });
}
