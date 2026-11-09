import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

/// An agent's instructions are asked of a computer only through daemons that seal the request (Swarm v4, privacy): the
/// target's and this computer's own must both report `agentInstructions`, and a computer another account shares is never
/// asked. Nothing is sent otherwise, and a computer that is not connected is refused at once.
void main() {
  late AppNotifier app;

  setUp(() {
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
  });
  tearDown(() => app.dispose());

  MachineState add(
    String id, {
    bool local = false,
    bool loaded = true,
    bool knows = true,
    bool shared = false,
    bool online = true,
  }) {
    final machine = Machine(
      machineId: id,
      authMode: MachineAuthMode.remote,
      name: id,
      isShared: shared,
    );
    app.machines = [...app.machines, machine];
    return app.machineStates[id] = MachineState(machine)
      ..localOnly = local
      ..nodeOnline = online
      ..connectionStatus = online
          ? ConnectionStatus.connected
          : ConnectionStatus.disconnected
      ..terminalCapabilityLoaded = loaded
      ..agentInstructionsAvailable = knows;
  }

  test('it may be asked only when both daemons report the feature', () {
    add('here', local: true);
    add('far');
    expect(app.instructionsGate('far'), isNull);
    expect(app.instructionsGate('here'), isNull);
  });

  test('a computer whose daemon does not know the requests says update', () {
    add('here', local: true);
    add('far', knows: false);
    expect(app.instructionsGate('far'), 'UNSUPPORTED');
  });

  test(
    'this computer\'s own daemon, which seals the request, must know them too',
    () {
      add('here', local: true, knows: false);
      add('far');
      expect(app.instructionsGate('far'), 'UPDATE_HERE');
    },
  );

  test(
    'a daemon not heard from yet is waited for, never taken for an old one',
    () {
      add('here', local: true, loaded: false);
      add('far');
      expect(app.instructionsGate('far'), 'NOT_READY');
      app.machineStates['here']!.terminalCapabilityLoaded = true;
      app.machineStates['far']!.terminalCapabilityLoaded = false;
      expect(app.instructionsGate('far'), 'NOT_READY');
      expect(app.instructionsGate('nowhere'), 'NOT_READY');
    },
  );

  test('a computer another account shares is never asked', () {
    add('here', local: true);
    add('theirs', shared: true);
    expect(app.instructionsGate('theirs'), 'OWNER_REQUIRED');
  });

  test('a computer that is not connected is refused at once, not queued', () {
    add('here', local: true);
    add('far', online: false);
    expect(
      () => app.askMachine('far', 'agent_instructions_read', {}),
      throwsA(isA<WsRequestFailure>().having((f) => f.code, 'code', 'OFFLINE')),
    );
  });
}
