import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:harness/ws/ws_pool.dart';

/// Disposing the app ends its sockets (#3661). A socket that cannot be reached redials on a timer of its own; one that outlived
/// the app went on redialling and reported its status to a notifier that was gone, and `remote_connect_measurement_test` failed
/// after it had finished.
void main() {
  const machine = Machine(
    machineId: 'm1',
    name: 'Box',
    authMode: MachineAuthMode.remote,
  );

  test('disposing the app stops a socket redialling', () {
    fakeAsync((async) {
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      var dials = 0;
      final conn = WsConn(
        wsBaseUrl: 'wss://backend.test',
        autonomousEnv: 'test',
        machineId: machine.machineId,
        accessTokenProvider: (_, _) async => 'token',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
        // Refused at every dial, as a computer that is off is.
        cloudSocket: (uri, protocols) {
          dials++;
          throw StateError('refused');
        },
      );
      app.adoptPoolConnectionForTest(machine.machineId, conn);
      unawaited(conn.connect());
      async.elapse(const Duration(seconds: 10));
      // Refused, it redials by itself.
      expect(dials, greaterThan(1));
      app.dispose();
      async.flushMicrotasks();
      final dialled = dials;
      // Whatever it had scheduled, minutes on, nothing is dialled.
      async.elapse(const Duration(minutes: 5));
      expect(dials, dialled);
      expect(conn.isClosed, isTrue);
    });
  });

  test('a pool that is closed dials no more', () async {
    final pool = WsPool(
      wsBaseUrl: 'wss://backend.test',
      autonomousEnv: 'test',
      accessTokenProvider: (_, _) async => 'token',
      onAuthFailure: (_) {},
      onEvent: (_, _) {},
      onStatus: (_, _) {},
    );
    await pool.closeAll();
    expect(
      () => pool.connFor(
        machine.machineId,
        transportKind: WsTransportKind.localPlaintext,
        localWsUri: Uri.parse('ws://127.0.0.1:1/ws'),
      ),
      throwsStateError,
    );
    expect(pool.has(machine.machineId), isFalse);
  });
}
