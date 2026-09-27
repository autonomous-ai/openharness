@TestOn('vm')
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/e2ee/bytes.dart';
import 'package:harness/e2ee/envelope.dart';
import 'package:harness/e2ee/keys.dart';
import 'package:harness/viewer/observer_relay_codec.dart';
import 'package:harness/ws/ws_conn.dart';

void main() {
  test('a direct observer without a codec fails before dialing', () async {
    String? refusal;
    final conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:1',
      autonomousEnv: 'prod',
      machineId: 'machine',
      observerShareId: 'grant',
      accessTokenProvider: (_, _) async => 'fixture-token',
      onAuthFailure: (reason) => fail(reason),
      onLocalFailure: (_, reason) => refusal = reason,
      onEvent: (_) {},
      onStatus: (_) {},
    );
    addTearDown(conn.close);
    await conn.connect();
    expect(conn.isClosed, isTrue);
    expect(conn.isReady, isFalse);
    expect(refusal, contains('verified owner identity'));
  });

  test(
    'direct observer uses the grant socket and only forwards verified output',
    () async {
      const context = 'harness-observer-v1:machine:grant';
      final owner = await E2eeIdentity.generate();
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final sockets = <WebSocket>[];
      addTearDown(() async {
        for (final socket in sockets) {
          await socket.close();
        }
        await server.close(force: true);
      });
      final frames = <Map<String, dynamic>>[];
      server.listen((request) async {
        expect(request.uri.path, '/api/observer-ws');
        expect(request.uri.queryParameters['share'], 'grant');
        expect(
          request.headers.value('sec-websocket-protocol'),
          'fixture-token',
        );
        final socket = await WebSocketTransformer.upgrade(
          request,
          protocolSelector: (p) => p.first,
        );
        sockets.add(socket);
        SessionKeys? keys;
        socket.listen((raw) async {
          expect(
            raw,
            isA<String>(),
            reason: 'observers never send binary input',
          );
          final frame = jsonDecode(raw as String) as Map<String, dynamic>;
          if (frame['type'] == 'observer_hello') {
            final peer = b64d(frame['payload']['ephemeral'] as String);
            final eph = await Ephemeral.generate();
            keys = sessionKeys(eph, peer, context, peer, eph.pub);
            socket.add(
              jsonEncode({
                'type': 'observer_welcome',
                'payload': {
                  'ephemeral': b64e(eph.pub),
                  'signature': b64e(
                    await owner.sign(
                      lvCat(['e2e-welcome-v1', context, peer, eph.pub]),
                    ),
                  ),
                },
              }),
            );
          } else {
            expect(frame['type'], 'observer_frame');
            final clear = unwrapPayload(
              keys!.c2s,
              Map<String, dynamic>.from(frame['payload']['__e2e'] as Map),
              'observer_frame',
              context,
            )!;
            frames.add(clear);
            socket.add(
              jsonEncode({
                'type': 'observer_frame',
                'payload': wrapPayload(
                  keys!.s2c,
                  'p',
                  0,
                  'observer_frame',
                  context,
                  {
                    'type': 'observer_binary',
                    'payload': {
                      'bytes': base64Encode([1, 2, 3]),
                    },
                  },
                ),
              }),
            );
          }
        });
        socket.add(jsonEncode({'type': 'observer_connected'}));
      });
      final connected = Completer<void>();
      final received = Completer<Uint8List>();
      final conn =
          WsConn(
              wsBaseUrl: 'ws://127.0.0.1:${server.port}',
              autonomousEnv: 'prod',
              machineId: 'machine',
              observerShareId: 'grant',
              relayCodecs: (_) => ObserverRelayCodec.create(
                machineId: 'machine',
                shareId: 'grant',
                ownerPublicKey: b64e(owner.pub),
              ),
              accessTokenProvider: (_, _) async => 'fixture-token',
              onAuthFailure: (reason) => fail(reason),
              onEvent: (_) {},
              onStatus: (status) {
                if (status == ConnectionStatus.connected &&
                    !connected.isCompleted) {
                  connected.complete();
                }
              },
            )
            ..onBinaryFrame = (bytes) async {
              if (!received.isCompleted) received.complete(bytes);
            };
      addTearDown(conn.close);
      await conn.connect();
      await connected.future.timeout(const Duration(seconds: 5));
      expect(
        await conn.sendTerminalFrame('terminal_input', {'data': 'forbidden'}),
        isFalse,
      );
      expect(await conn.sendTerminalBinary(Uint8List(1)), isFalse);
      expect(
        await conn.sendTerminalFrame('terminal_open', {'agentId': 'a'}),
        isTrue,
      );
      expect(await received.future.timeout(const Duration(seconds: 5)), [
        1,
        2,
        3,
      ]);
      expect(frames.single['type'], 'terminal_open');
    },
  );
}
