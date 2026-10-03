import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

/// A machine that records what it is asked.
class _Conn extends WsConn {
  _Conn(this.requests)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final List<(String, Map<String, dynamic>)> requests;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add((type, payload));
    return {};
  }
}

/// Opening an agent here tells the machine that owns it, so its `lastOpenedAt`
/// — and the order every app sorts by — is the account's, not this phone's.
void main() {
  test('an agent opened here is reported to its machine, once', () async {
    final requests = <(String, Map<String, dynamic>)>[];
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (_) => _Conn(requests),
    );
    addTearDown(app.dispose);
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Studio',
    );
    app.machines = [machine];
    app.machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded;

    app.touchAgent('m', 'a');
    // Opened again straight away: nothing new to say.
    app.touchAgent('m', 'a');
    await Future<void>.delayed(Duration.zero);

    expect(requests, hasLength(1));
    expect(requests.single.$1, 'agent_update');
    expect(requests.single.$2, {'agentId': 'a', 'opened': true});
  });

  test('last use is the later of activity and the last open', () {
    final activity = DateTime.utc(2026, 9, 26, 10);
    final opened = DateTime.utc(2026, 9, 26, 11);
    Agent agent({DateTime? updatedAt, DateTime? lastOpenedAt}) => Agent(
      id: 'a',
      name: 'a',
      updatedAt: updatedAt,
      lastOpenedAt: lastOpenedAt,
    );
    expect(agent(updatedAt: activity, lastOpenedAt: opened).lastUsedAt, opened);
    expect(agent(updatedAt: opened, lastOpenedAt: activity).lastUsedAt, opened);
    expect(agent(updatedAt: activity).lastUsedAt, activity);
    expect(agent(lastOpenedAt: opened).lastUsedAt, opened);
    expect(
      Agent.fromJson({
        'id': 'a',
        'name': 'a',
        'lastOpenedAt': '2026-09-26T11:00:00.000Z',
      }).lastOpenedAt,
      opened,
    );
  });
}
