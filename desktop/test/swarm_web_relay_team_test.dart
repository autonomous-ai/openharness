import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart' show SuperTabFailure;
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:harness/viewer/viewer_services.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show MemoryStore;

/// One machine's daemon, recording the Swarm requests the app relays through
/// it. Nothing leaves the test.
class _Daemon extends WsConn {
  _Daemon(String machineId, this.relayed)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final List<String> relayed;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'super_tabs') relayed.add(machineId);
    return {'value': <String, dynamic>{}};
  }
}

/// The machine list as the server sends it (MachineService toOwner): a Harness
/// Team account's machine carries `sessionKind: team` and the Mac it lives on.
Machine _row(String id, {String? sessionKind, String? hostMachineId}) =>
    Machine.fromJson({
      'machineId': id,
      'authMode': 'remote',
      'name': id,
      'sessionKind': ?sessionKind,
      'hostMachineId': ?hostMachineId,
    });

void main() {
  late List<String> relayed;
  late AppNotifier app;

  /// A browser signed in to the person's account (the web app on a phone).
  void web() {
    relayed = [];
    final storage = MemoryStore();
    final session = AuthSession(storage: storage);
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: session,
      connectionForTest: (id) => _Daemon(id, relayed),
      viewer: ViewerServices(
        config: AppConfig.dev,
        session: session,
        keys: ViewerKeyStore(storage: storage),
      ),
    );
    addTearDown(app.dispose);
  }

  void online(Machine machine) {
    app.machines = [...app.machines, machine];
    app.machineStates[machine.machineId] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
  }

  // The Buddy-chat post the web app sends (a person's message in their chat).
  Future<Object?> post() => app.superTabs.transport(
    'POST',
    '/api/super-tabs/tab/commands',
    body: {
      'operationId': 'op-1',
      'command': {
        'type': 'message.send',
        'conversationId': 'buddy-chat',
        'text': 'hi',
      },
    },
  );

  test('the machine list marks a Harness Team account machine', () {
    expect(
      _row('t', sessionKind: 'team', hostMachineId: 'mac').isTeamAccount,
      isTrue,
    );
    expect(_row('c', sessionKind: 'computer').isTeamAccount, isFalse);
    expect(_row('old').isTeamAccount, isFalse);
  });

  test('on the web a Swarm post goes through the person\'s own machine, never '
      'a Team account machine that sorts first or is selected', () async {
    web();
    // The Team account on the person's Mac: its daemon signs in with a team
    // session, which the server refuses to act as the person.
    online(_row('a-team', sessionKind: 'team', hostMachineId: 'own-mac'));
    online(_row('own-mac', sessionKind: 'computer'));
    app.selectedMachineId = 'a-team';

    expect(app.sharedTabsTarget?.machine.machineId, 'own-mac');
    await post();
    expect(relayed, ['own-mac']);
  });

  /// The desktop app on a computer: its own machine is the one it asks.
  void native(Machine local) {
    relayed = [];
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (id) => _Daemon(id, relayed),
    );
    addTearDown(app.dispose);
    online(local);
    app.machineStates[local.machineId]!.localOnly = true;
  }

  test('natively a Swarm post goes through this computer\'s own machine', () async {
    native(_row('here', sessionKind: 'computer'));
    expect(app.sharedTabsTarget?.machine.machineId, 'here');
    await post();
    expect(relayed, ['here']);
  });

  test('natively on a computer switched to a Harness Team account nothing is '
      'sent, and the app says this computer cannot send it', () async {
    // `harness team on`: this computer's daemon now signs in as the team.
    native(_row('here', sessionKind: 'team'));
    online(_row('elsewhere', sessionKind: 'computer'));

    expect(app.sharedTabsTarget, isNull);
    await expectLater(
      post(),
      throwsA(
        isA<SuperTabFailure>()
            .having((f) => f.code, 'code', 'MACHINE_UNAVAILABLE')
            .having((f) => f.message, 'message', contains('This computer runs Swarm agents')),
      ),
    );
    expect(relayed, isEmpty);
  });

  test('on the web with only a Team account machine online nothing is sent, '
      'and the app says no machine of the person\'s is online', () async {
    web();
    online(_row('a-team', sessionKind: 'team', hostMachineId: 'own-mac'));
    app.selectedMachineId = 'a-team';

    expect(app.sharedTabsTarget, isNull);
    await expectLater(
      post(),
      throwsA(
        isA<SuperTabFailure>().having(
          (f) => f.code,
          'code',
          'MACHINE_UNAVAILABLE',
        ),
      ),
    );
    expect(relayed, isEmpty);
  });
}
