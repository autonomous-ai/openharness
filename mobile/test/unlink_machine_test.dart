import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/auth/cli_link.dart';
import 'package:harness_mobile/auth/peer_link_client.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';

/// Unlinks whatever it is asked to, so these tests are about what the APP does with that answer.
class _Links implements PeerLinkClient {
  final unlinked = <String>[];

  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) async => const CliLinkConnectResult(error: 'not used');

  @override
  Future<CliLinkListResult> list() async =>
      const CliLinkListResult(machines: []);

  @override
  Future<String?> unlink(String machineId) async {
    unlinked.add(machineId);
    return null;
  }
}

/// A machine as it looks while everything is working: linked, answering, agents listed.
AppNotifier _app(_Links links) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    peerLinks: links,
  );
  const machine = Machine(
    machineId: 'm',
    authMode: MachineAuthMode.remote,
    name: 'Studio',
  );
  app.machines = [machine];
  app.machineStates['m'] = MachineState(machine)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = const [
      Agent(id: 'a0', name: 'One', engine: 'codex', terminalAvailable: true),
    ];
  return app;
}

void main() {
  test('unlinking leaves the machine wanting its password again', () async {
    final links = _Links();
    final app = _app(links);
    addTearDown(app.dispose);

    expect(app.machineStates['m']!.needsLink, isFalse);

    final error = await app.unlinkMachine('m');

    expect(error, isNull);
    expect(links.unlinked, ['m']);
    // ⚠️ The pin is local to this device and the machine is never told, so no close arrives to flip
    // this on its own. Without the app doing it by hand the row stayed under "Linked", still
    // connected, and unlinking read as having done nothing at all.
    expect(app.machineStates['m']!.needsLink, isTrue);
    expect(
      app.machineStates['m']!.agentLoadStatus,
      AgentLoadStatus.needsLink,
      reason: 'the list has to stop offering agents it can no longer reach',
    );
  });

  test('a refused unlink changes nothing', () async {
    final links = _Refusing();
    final app = _app(links);
    addTearDown(app.dispose);

    final error = await app.unlinkMachine('m');

    expect(error, isNotNull);
    expect(
      app.machineStates['m']!.needsLink,
      isFalse,
      reason: 'a machine that is still linked must not be shown as needing a password',
    );
  });
}

class _Refusing extends _Links {
  @override
  Future<String?> unlink(String machineId) async => 'm is not linked.';
}
