import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/core/models.dart' show ConnectionStatus;
import 'package:harness_mobile/ws/ws_conn.dart';

import 'memory_web_socket.dart';

/// A machine the relay refuses — removed from the account (prod, 2026-10-28: a laptop deleted in
/// September, still selected every ~7 s), no longer shared, another environment, unpaid — is not
/// dialled again. The select watchdog read the silence after the refusal as a relay gone quiet and
/// redialled it after six seconds, for as long as the app was open.
void main() {
  void refused(
    String error,
    void Function(
      FakeAsync clock,
      WsConn conn,
      List<MemoryWebSocket> relay,
      List<ConnectionStatus> statuses,
    )
    body,
  ) {
    fakeAsync((clock) {
      final relay = <MemoryWebSocket>[];
      final statuses = <ConnectionStatus>[];
      final conn = WsConn(
        wsBaseUrl: 'ws://fixture.invalid',
        connectChannel: (_, {protocols}) {
          final (client, server) = MemoryWebSocket.pair();
          server.stream.listen((raw) {
            final frame = jsonDecode(raw as String) as Map<String, dynamic>;
            if (frame['type'] != 'machine_select') return;
            server.sink.add(
              jsonEncode({
                'type': 'machine_select_error',
                'payload': {'machineId': 'm', 'error': error},
              }),
            );
          });
          relay.add(server);
          client.accept();
          return client;
        },
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => 'token',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: statuses.add,
      );
      unawaited(conn.connect());
      clock.flushMicrotasks();
      body(clock, conn, relay, statuses);
      unawaited(conn.close());
      clock.flushMicrotasks();
    });
  }

  for (final error in [
    'NOT_YOUR_MACHINE',
    'MACHINE_ENV_MISMATCH',
    'MACHINE_PAYMENT_PENDING',
    'MACHINE_SUBSCRIPTION_REQUIRED',
  ]) {
    test('$error is not redialled', () {
      refused(error, (clock, conn, relay, statuses) {
        clock.elapse(const Duration(minutes: 10));
        expect(relay, hasLength(1));
        expect(conn.isClosed, isTrue);
        expect(statuses.last, ConnectionStatus.disconnected);
      });
    });
  }

  test('a refusal it may outlive (a machine that failed to start) waits out the backoff', () {
    refused('MACHINE_START_FAILED', (clock, conn, relay, statuses) {
      // Not the six-second watchdog: the ordinary 1, 2, 4 … 30 s backoff, from the refusal on.
      clock.elapse(const Duration(milliseconds: 999));
      expect(relay, hasLength(1));
      clock.elapse(const Duration(milliseconds: 1));
      expect(relay, hasLength(2));
      clock.elapse(const Duration(seconds: 2));
      expect(relay, hasLength(3));
      expect(conn.isClosed, isFalse);
    });
  });
}
