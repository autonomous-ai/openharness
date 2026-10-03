import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/companions/coding_memory_connection.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/ws/local_cli_discovery.dart';

class _Log implements AppLog {
  final messages = <String>[];
  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {
    messages.add('$message $error');
  }
}

void main() {
  late HttpServer server;
  late LocalCodingMemoryConnection connection;
  late List<WebSocket> sockets;
  late List<Map<String, dynamic>> frames;
  late bool ownerCurrent;
  late _Log log;
  late AppLog previousLog;
  Completer<void>? delay;

  setUp(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    sockets = [];
    frames = [];
    ownerCurrent = true;
    delay = null;
    previousLog = appLog;
    log = _Log();
    appLog = log;
    server.listen((request) async {
      expect(request.headers.value('sec-websocket-protocol'), isNull);
      final socket = await WebSocketTransformer.upgrade(request);
      sockets.add(socket);
      socket.listen((data) async {
        final frame = jsonDecode(data as String) as Map<String, dynamic>;
        frames.add(frame);
        final payload = frame['payload'] as Map;
        if (frame['type'] == 'machine_select') {
          socket.add(
            jsonEncode({
              'type': 'connected',
              'payload': {
                'machineId': 'local-fixture',
                'localProtocolVersion': 1,
              },
            }),
          );
        } else if (frame['type'] == 'pair') {
          if (delay != null) await delay!.future;
          if (socket.readyState != WebSocket.open) return;
          socket.add(
            jsonEncode({
              'type': 'pair_result',
              'payload': {
                'requestId': payload['requestId'],
                'ok': true,
                'claim': 'private synthetic assertion',
                'capability': 'b' * 32,
              },
            }),
          );
          // Late uncorrelated frames must be excluded from logs as well.
          socket.add(
            jsonEncode({
              'type': 'pair_result',
              'payload': {
                'claim': 'private late assertion',
                'capability': 'c' * 32,
              },
            }),
          );
        }
      });
    });
    connection = LocalCodingMemoryConnection(
      endpoint: LocalCliEndpoint(
        computerId: 'local-fixture',
        wsUri: Uri.parse('ws://127.0.0.1:${server.port}/api/web-ws'),
        socketPath: '/never-open-this-test-socket',
        protocolVersion: 1,
        terminalProtocolVersion: 1,
      ),
      machineId: 'local-fixture',
      isCurrent: () => ownerCurrent,
      onClosed: () {},
    );
  });
  tearDown(() async {
    connection.dispose();
    if (delay != null && !delay!.isCompleted) delay!.complete();
    for (final socket in sockets) {
      await socket.close();
    }
    await server.close(force: true);
    appLog = previousLog;
  });

  test('auxiliary owner connection uses local TCP without credentials, presence or sensitive logs', () async {
    final result = await connection.request({
      'action': 'preview',
      'command': {'claim': 'private outgoing assertion'},
    });
    expect(result['claim'], 'private synthetic assertion');
    expect(frames.first, {
      'type': 'machine_select',
      'payload': {
        'machineId': 'local-fixture',
        'localProtocolVersion': 1,
        'tool': true,
      },
    });
    expect((frames.last['payload'] as Map)['verb'], 'memory');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(log.messages.join('\n'), isNot(contains('assertion')));
    expect(log.messages.join('\n'), isNot(contains('b' * 32)));
    expect(log.messages.join('\n'), isNot(contains('c' * 32)));
  });

  test('a reply cannot cross an owner change and no later request can use that connection', () async {
    delay = Completer<void>();
    final requesting = connection.request({'action': 'show', 'id': 'fixture'});
    final refused = expectLater(
      requesting,
      throwsA(
        isA<CodingMemoryFailure>().having(
          (e) => e.code,
          'code',
          'OWNER_CHANGED',
        ),
      ),
    );
    while (!frames.any((f) => f['type'] == 'pair')) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    ownerCurrent = false;
    delay!.complete();
    await refused;
    await expectLater(
      connection.request({'action': 'status'}),
      throwsA(isA<CodingMemoryFailure>()),
    );
    expect(frames.where((f) => f['type'] == 'pair'), hasLength(1));
  });
}
