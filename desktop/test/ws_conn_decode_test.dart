import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/ws/relay_codec.dart';
import 'package:harness/ws/ws_conn.dart';

// Task #2195: a big answer decodes off the UI thread, and frames stay in the order they came.

String _frame(int seq, {int pad = 0}) => jsonEncode({
  'type': 'terminal_output',
  'payload': {'streamId': 's', 'seq': seq, 'pad': 'x' * pad},
});

/// A seal nothing opens: whatever reaches the app from a sealed connection got past it.
class _ClosedSeal implements RelayCodec {
  int opened = 0;

  @override
  Map<String, dynamic> helloFrame() => {'type': 'e2e_hello', 'payload': {}};

  @override
  Future<bool> handleWelcome(Map<String, dynamic> payload) async => true;

  @override
  bool handleRekey(Map<String, dynamic> payload) => true;

  @override
  int get terminalP2pVersion => 1;

  @override
  Map<String, dynamic>? encodeFrame(Map<String, dynamic> frame) => frame;

  @override
  Map<String, dynamic>? decodeFrame(Map<String, dynamic> frame) {
    opened++;
    return null;
  }

  @override
  Uint8List? encodeBinary(Uint8List localFrame) => localFrame;

  @override
  Uint8List? decodeBinary(Uint8List wireFrame) {
    opened++;
    return null;
  }
}

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
            s.add(
              jsonEncode({
                'type': 'connected',
                'payload': {'machineId': 'm'},
              }),
            );
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
        if (status == ConnectionStatus.connected && !connected.isCompleted)
          connected.complete();
      },
      onEvent: (event) {
        if (event['type'] == 'terminal_output')
          arrived.add((event['payload'] as Map)['seq'] as int);
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

  test(
    'a large frame goes to the isolate decoder, a small one does not',
    () async {
      socket
        ..add(_frame(1))
        ..add(_frame(2, pad: WsConn.largeFrameChars));
      await until(() => arrived.length == 2);
      expect(arrived, [1, 2]);
      expect(decoded, hasLength(1));
    },
  );

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

  test(
    'a large frame that does not parse is dropped, and the next arrives',
    () async {
      socket
        ..add('{${'x' * WsConn.largeFrameChars}')
        ..add(_frame(2));
      await until(() => arrived.isNotEmpty);
      expect(arrived, [2]);
    },
  );

  test('a frame still arrives when the isolate cannot start', () async {
    WsConn.decodeLargeFrame = (_) => throw StateError('no isolate');
    socket.add(_frame(1, pad: WsConn.largeFrameChars));
    await until(() => arrived.isNotEmpty);
    expect(arrived, [1]);
  });

  // Security review 2 of #2627: a frame keeps the connection it came on. Finished after that connection went, it reaches nothing.
  test('a large frame whose connection drops while it decodes reaches nothing, nor does what waited behind it', () async {
    hold = Completer<void>();
    socket
      ..add(_frame(1, pad: WsConn.largeFrameChars))
      ..add(_frame(2));
    await until(() => decoded.isNotEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await conn.debugDropTransport();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    hold!.complete();
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(arrived, isEmpty);
  });

  test('a large frame still decoding at close reaches nothing', () async {
    hold = Completer<void>();
    socket
      ..add(_frame(1, pad: WsConn.largeFrameChars))
      ..add(_frame(2));
    await until(() => decoded.isNotEmpty);
    await conn.close();
    hold!.complete();
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(arrived, isEmpty);
  });

  test(
    'the real isolate decoder decodes, and says null for what will not parse',
    () async {
      expect(
        await WsConn.decodeInIsolate(_frame(1)),
        isA<Map<String, dynamic>>(),
      );
      expect(await WsConn.decodeInIsolate('{nope'), isNull);
    },
  );

  group('on a sealed connection', () {
    late HttpServer relay;
    late WebSocket wire;
    late WsConn sealed;
    late _ClosedSeal seal;
    late List<int> dispatched;
    late List<int> binaries;

    setUp(() async {
      seal = _ClosedSeal();
      dispatched = [];
      binaries = [];
      relay = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final ready = Completer<WebSocket>();
      unawaited(
        relay.forEach((request) async {
          final s = await WebSocketTransformer.upgrade(request);
          s.listen((_) {});
          if (!ready.isCompleted) ready.complete(s);
        }),
      );
      sealed = WsConn(
        wsBaseUrl: 'ws://127.0.0.1:${relay.port}',
        autonomousEnv: 'prod',
        machineId: 'm',
        accessTokenProvider: (_, _) async => 'test-token',
        onAuthFailure: (_) {},
        relayCodecs: (_) async => seal,
        onStatus: (_) {},
        onEvent: (event) {
          final seq = (event['payload'] as Map?)?['seq'];
          if (seq is int) dispatched.add(seq);
        },
      );
      sealed.onBinaryFrame = (frame) async => binaries.add(frame.length);
      unawaited(sealed.connect());
      wire = await ready.future;
      await Future<void>.delayed(const Duration(milliseconds: 20));
    });

    tearDown(() async {
      await sealed.close();
      await relay.close(force: true);
    });

    // Security review 2 of #2627: the relay isn't trusted here. A large frame to hold the queue,
    // a forged one behind it, then a dropped socket must not make the forged one the machine's.
    test('a forged frame behind a large one, the socket then dropped, reaches nothing', () async {
      hold = Completer<void>();
      wire
        ..add(_frame(1, pad: WsConn.largeFrameChars))
        ..add(_frame(2))
        ..add(Uint8List.fromList([1, 2, 3]));
      await until(() => decoded.isNotEmpty);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      await wire.close();
      await Future<void>.delayed(const Duration(milliseconds: 40));
      hold!.complete();
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(dispatched, isEmpty);
      expect(binaries, isEmpty);
    });

    test(
      'a forged frame behind a large one reaches nothing after close',
      () async {
        hold = Completer<void>();
        wire
          ..add(_frame(1, pad: WsConn.largeFrameChars))
          ..add(_frame(2));
        await until(() => decoded.isNotEmpty);
        await Future<void>.delayed(const Duration(milliseconds: 20));
        await sealed.close();
        hold!.complete();
        await Future<void>.delayed(const Duration(milliseconds: 40));
        expect(dispatched, isEmpty);
      },
    );

    test(
      'with the socket up, a large frame goes through the seal like any other',
      () async {
        wire
          ..add(_frame(1, pad: WsConn.largeFrameChars))
          ..add(_frame(2));
        await until(() => seal.opened >= 2);
        expect(dispatched, isEmpty);
      },
    );
  });
}
