import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/ws/ws_conn.dart';

// Task #2195: a big answer decodes off the UI thread, and frames stay in the order they came.

String _frame(int seq, {int pad = 0}) => jsonEncode({
  'type': 'terminal_output',
  'payload': {'streamId': 's', 'seq': seq, 'pad': 'x' * pad},
});

void main() {
  late HttpServer server;
  late WebSocket socket;
  late WsConn conn;
  late List<int> arrived;
  final decoded = <int>[];
  Completer<void>? hold;

  setUp(() async {
    arrived = [];
    decoded.clear();
    hold = null;
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final ready = Completer<WebSocket>(), connected = Completer<void>();
    unawaited(
      server.forEach((request) async {
        final s = await WebSocketTransformer.upgrade(request);
        s.listen((raw) {
          final frame = jsonDecode(raw as String) as Map<String, dynamic>;
          if (frame['type'] == 'machine_select') {
            s.add(jsonEncode({'type': 'connected', 'payload': {'machineId': 'm'}}));
          }
        });
        if (!ready.isCompleted) ready.complete(s);
      }),
    );
    WsConn.decodeLargeFrame = (raw) async {
      decoded.add(raw.length);
      await hold?.future;
      return jsonDecode(raw);
    };
    addTearDown(() => WsConn.decodeLargeFrame = WsConn.decodeInIsolate);
    conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${server.port}',
      autonomousEnv: 'prod',
      machineId: 'm',
      accessTokenProvider: (_, _) async => 'test-token',
      onAuthFailure: (_) {},
      onStatus: (status) {
        if (status == ConnectionStatus.connected && !connected.isCompleted) connected.complete();
      },
      onEvent: (event) {
        if (event['type'] == 'terminal_output') arrived.add((event['payload'] as Map)['seq'] as int);
      },
    );
    unawaited(conn.connect());
    socket = await ready.future;
    await connected.future;
  });

  tearDown(() async {
    await conn.close();
    await server.close(force: true);
  });

  Future<void> until(bool Function() done) async {
    for (var i = 0; i < 200 && !done(); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  test('a large frame goes to the isolate decoder, a small one does not', () async {
    socket
      ..add(_frame(1))
      ..add(_frame(2, pad: WsConn.largeFrameChars));
    await until(() => arrived.length == 2);
    expect(arrived, [1, 2]);
    expect(decoded, hasLength(1));
  });

  test('a small frame after a large one still arrives second', () async {
    hold = Completer<void>();
    socket
      ..add(_frame(1, pad: WsConn.largeFrameChars))
      ..add(_frame(2))
      ..add(_frame(3));
    await until(() => decoded.isNotEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(arrived, isEmpty);
    hold!.complete();
    await until(() => arrived.length == 3);
    expect(arrived, [1, 2, 3]);
  });

  test('a large frame that does not parse is dropped, and the next arrives', () async {
    socket
      ..add('{${'x' * WsConn.largeFrameChars}')
      ..add(_frame(2));
    await until(() => arrived.isNotEmpty);
    expect(arrived, [2]);
  });

  test('a frame still arrives when the isolate cannot start', () async {
    WsConn.decodeLargeFrame = (_) => throw StateError('no isolate');
    socket.add(_frame(1, pad: WsConn.largeFrameChars));
    await until(() => arrived.isNotEmpty);
    expect(arrived, [1]);
  });

  test('the real isolate decoder decodes, and says null for what will not parse', () async {
    expect(await WsConn.decodeInIsolate(_frame(1)), isA<Map<String, dynamic>>());
    expect(await WsConn.decodeInIsolate('{nope'), isNull);
  });
}
