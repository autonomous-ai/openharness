import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

void main() {
  test(
    'a real native link handshake survives the old five-second retry tick',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final clients = <WebSocket>[];
      final selections = <String>[];
      final refused = Completer<void>();
      final handshake = Completer<void>();
      final timers = <Timer>[];
      var stopped = false;
      server.listen((request) async {
        final ws = await WebSocketTransformer.upgrade(request);
        clients.add(ws);
        var refusedSocket = false;
        ws.listen((data) {
          if (stopped || refusedSocket) return;
          final frame = jsonDecode(data as String) as Map<String, dynamic>;
          final payload = frame['payload'] as Map? ?? {};
          if (frame['type'] == 'machine_select') {
            selections.add(payload['machineId'] as String);
            if (selections.length == 1) {
              refusedSocket = true;
              unawaited(ws.close(4404, 'NO_PEER_LINK'));
            } else {
              if (!handshake.isCompleted) handshake.complete();
              // The old retry closed this socket at five seconds, before the
              // remote computer could finish establishing its trusted link.
              timers.add(
                Timer(const Duration(seconds: 6), () {
                  if (!stopped && ws.readyState == WebSocket.open) {
                    ws.add(
                      jsonEncode({
                        'type': 'connected',
                        'payload': {'machineId': 'remote'},
                      }),
                    );
                  }
                }),
              );
            }
          } else if (payload['requestId'] != null &&
              ws.readyState == WebSocket.open) {
            ws.add(
              jsonEncode({
                'type': '${frame['type']}_result',
                'payload': {
                  'requestId': payload['requestId'],
                  'agents': [],
                  'engines': [],
                },
              }),
            );
          }
        });
      });

      late AppNotifier app;
      WsConn? current;
      WsConn connect(String machineId) {
        if (current case final existing? when !existing.isClosed)
          return existing;
        late final WsConn conn;
        conn = WsConn(
          wsBaseUrl: 'ws://127.0.0.1:${server.port}',
          autonomousEnv: 'test',
          machineId: machineId,
          accessTokenProvider: (_, _) async => '',
          transportKind: WsTransportKind.localPlaintext,
          allowLocalTcpFixture: true,
          localWsUri: Uri.parse('ws://127.0.0.1:${server.port}'),
          onAuthFailure: (_) {},
          onEvent: (_) {},
          onLocalFailure: (code, reason) =>
              app.localFailureForTest(machineId, code, reason),
          onStatus: (status) {
            if (!identical(current, conn)) return;
            app.connectionStatusForTest(machineId, status);
            if (status == ConnectionStatus.disconnected &&
                app.stateOf(machineId)?.needsLink == true &&
                !refused.isCompleted) {
              refused.complete();
            }
          },
        );
        current = conn;
        app.adoptPoolConnectionForTest(machineId, conn);
        unawaited(conn.connect());
        return conn;
      }

      app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        connectionForTest: connect,
      );
      const machine = Machine(
        machineId: 'remote',
        name: 'Synthetic box',
        authMode: MachineAuthMode.remote,
      );
      app.machines.add(machine);
      app.machineStates['remote'] = MachineState(machine)..nodeOnline = true;
      addTearDown(() async {
        stopped = true;
        for (final timer in timers) {
          timer.cancel();
        }
        final last = current;
        current = null;
        app.dispose();
        await last?.close();
        for (final client in clients) {
          await client.close();
        }
        await server.close(force: true);
      });
      connect('remote');
      await refused.future.timeout(const Duration(seconds: 3));
      final recovery = app.connectTrusted('remote');
      await handshake.future.timeout(const Duration(seconds: 3));
      expect(await recovery, isTrue);
      expect(selections, [
        'remote',
        'remote',
      ], reason: 'no background retry replaces the active handshake');
      expect(app.stateOf('remote')!.needsLink, isFalse);
      expect(
        app.stateOf('remote')!.connectionStatus,
        ConnectionStatus.connected,
      );
    },
  );
}
