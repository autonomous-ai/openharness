// The machine list is pushed, not polled. The backend tells every daemon socket
// of the account when the list changed (a machine created / renamed / deleted,
// a shared harness invited or taken back); the daemon relays `machines_changed`
// to the window, which re-reads. What is left on a timer is a safety net for a
// push that was missed — minutes apart, because every re-read is two
// authenticated backend requests from every open app.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

const _computerId = 'aabbccddeeff0011';

/// Counts every read of the list, and lets a test hold one open.
class _Api extends ApiClient {
  _Api() : super(config: AppConfig.dev, session: AuthSession());
  int reads = 0;
  Completer<void>? hold;

  @override
  Future<Map<String, dynamic>?> me() async => null;

  // A daemon without the desk: a manual reload asks, and must not reach the network.
  @override
  Future<Map<String, dynamic>?> desk() async => null;

  @override
  Future<List<Machine>> machines() async {
    reads++;
    await hold?.future;
    return const [_localMachine];
  }
}

class _Cli extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: true);
  @override
  Future<void> login({void Function(String url)? onAuthorizeUrl}) async {}
  @override
  Future<void> logout() async {}
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => _computerId;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      LocalCliEndpoint(
        computerId: _computerId,
        wsUri: Uri.parse('ws://127.0.0.1:18473/ws'),
        protocolVersion: localWsProtocolVersion,
        terminalProtocolVersion: 1,
        machineId: 'local-machine',
        backendOnline: true,
      );
}

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'local-machine',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => const {'agents': []};
}

class _App extends AppNotifier {
  _App(_Api api)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        cliLogin: _Cli(),
        localCliDiscovery: _Discovery(),
        connectionForTest: (_) => _Connection(),
      ) {
    this.api = api;
  }
  @override
  Future<void> ensureCliDaemonReady() async {}
}

const _localMachine = Machine(
  machineId: 'local-machine',
  name: 'This computer',
  computerId: _computerId,
  authMode: MachineAuthMode.remote,
  status: 'online',
);

const _push = {
  'type': 'machines_changed',
  'payload': {'reason': 'updated'},
};

/// A successful read arms the safety-net timer, and `testWidgets` checks for
/// pending timers before tear-downs run — so every test disposes its own app.
_App _signedIn(_Api api) {
  final app = _App(api);
  app.status = AppStatus.authenticated;
  app.machines = [_localMachine];
  app.machineStates['local-machine'] = MachineState(_localMachine)
    ..localOnly = true;
  return app;
}

void main() {
  testWidgets('a machines_changed push re-reads the machine list', (
    tester,
  ) async {
    final api = _Api();
    final app = _signedIn(api);

    await app.handleEventForTest('local-machine', _push);
    await tester.pump();

    expect(api.reads, 1);
    app.dispose();
  });

  testWidgets('a push is ignored once the person has signed out', (
    tester,
  ) async {
    final api = _Api();
    final app = _signedIn(api)..status = AppStatus.unauthenticated;

    await app.handleEventForTest('local-machine', _push);
    await tester.pump();

    expect(api.reads, 0);
    app.dispose();
  });

  testWidgets(
    'a burst of pushes during a re-read costs one more read, not one each',
    (tester) async {
      final api = _Api()..hold = Completer<void>();
      final app = _signedIn(api);

      // A bulk rename: the first push starts a read, the rest land while it is open.
      for (var i = 0; i < 5; i++) {
        await app.handleEventForTest('local-machine', _push);
      }
      await tester.pump();
      expect(api.reads, 1);

      // The open read may predate the later changes, so exactly one more follows it.
      api.hold!.complete();
      api.hold = null;
      await tester.pump();
      await tester.pump();
      expect(api.reads, 2);
      app.dispose();
    },
  );

  testWidgets(
    'a push that lands during a read the person started is not lost',
    (tester) async {
      final api = _Api()..hold = Completer<void>();
      final app = _signedIn(api);

      // Reload pressed; the read is open when the list changes underneath it.
      final manual = app.retryMachines();
      await tester.pump();
      expect(api.reads, 1);
      await app.handleEventForTest('local-machine', _push);
      await tester.pump();

      api.hold!.complete();
      api.hold = null;
      await tester.pump();
      await manual;
      await tester.pump();

      // The open read may predate the change, so the push still gets its own.
      expect(api.reads, 2);
      app.dispose();
    },
  );

  testWidgets(
    'what is left on a timer is a safety net, minutes apart — not a poll',
    (tester) async {
      final api = _Api();
      final app = _signedIn(api);

      // A successful read arms the background timer.
      await app.refreshMachines();
      await tester.pump();
      final afterLoad = api.reads;

      // The old 15s discovery poll would have read four more times by now.
      await tester.pump(const Duration(seconds: 60));
      expect(api.reads, afterLoad);

      await tester.pump(AppNotifier.machineListSafetyNetInterval);
      await tester.pump();
      expect(api.reads, afterLoad + 1);
      app.dispose();
    },
  );

  test('the safety net is minutes, never seconds', () {
    expect(
      AppNotifier.machineListSafetyNetInterval,
      greaterThanOrEqualTo(const Duration(minutes: 5)),
    );
  });
}
