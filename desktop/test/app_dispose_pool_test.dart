import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

/// Disposing the app ends its sockets (#3661). A socket that cannot be reached redials on its own timer; one that outlived the
/// app reported its status to a notifier that was gone, and `remote_connect_measurement_test` failed after it had finished.
void main() {
  const machine = Machine(
    machineId: 'm1',
    name: 'Box',
    authMode: MachineAuthMode.remote,
  );

  /// An app holding a socket to [machine] that is refused at every dial: how many dials were made is [dials].
  ({AppNotifier app, WsConn conn, List<int> dials}) refused() {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    app.machines.add(machine);
    app.machineStates[machine.machineId] = MachineState(machine);
    final dials = <int>[];
    final conn = WsConn(
      wsBaseUrl: 'wss://backend.test',
      autonomousEnv: 'test',
      machineId: machine.machineId,
      accessTokenProvider: (_, _) async => 'token',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      // What the pool does with a status of its socket: the app takes it.
      onStatus: (status) =>
          app.connectionStatusForTest(machine.machineId, status),
      cloudSocket: (uri, protocols) {
        dials.add(dials.length);
        throw StateError('refused');
      },
    );
    app.adoptPoolConnectionForTest(machine.machineId, conn);
    return (app: app, conn: conn, dials: dials);
  }

  test(
    'disposing the app stops a socket redialling, and none reports to it after',
    () {
      fakeAsync((async) {
        final held = refused();
        unawaited(held.conn.connect());
        async.elapse(const Duration(seconds: 10));
        // Refused, it redials by itself.
        expect(held.dials.length, greaterThan(1));
        held.app.dispose();
        async.flushMicrotasks();
        final dialled = held.dials.length;
        // Whatever it had scheduled, minutes on, nothing is dialled and nothing reaches the app.
        expect(() => async.elapse(const Duration(minutes: 5)), returnsNormally);
        expect(held.dials.length, dialled);
        expect(held.conn.isClosed, isTrue);
      });
    },
  );

  test('a status that arrives after the app is disposed is dropped', () {
    final held = refused();
    held.app.dispose();
    expect(
      () => held.app.connectionStatusForTest(
        machine.machineId,
        ConnectionStatus.connected,
      ),
      returnsNormally,
    );
  });
}
