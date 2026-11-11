import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/ws/ws_conn.dart';

/// A daemon's local socket whose relay fails the first [failSelects] selects, as a dial that fails
/// does (close 1011), and then answers. A machine in [hanging] never answers: a slow handshake.
class _Daemon {
  _Daemon._(this.server);
  final HttpServer server;
  int failSelects = 0;
  int selects = 0;
  final hanging = <String>{};
  final sockets = <WebSocket>[];

  static Future<_Daemon> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final daemon = _Daemon._(server);
    server.listen((request) async {
      // Whatever else finds a loopback port on a shared machine is not a dial of this test's.
      if (!WebSocketTransformer.isUpgradeRequest(request)) {
        request.response.statusCode = HttpStatus.notFound;
        await request.response.close();
        return;
      }
      final ws = await WebSocketTransformer.upgrade(request);
      daemon.sockets.add(ws);
      ws.listen((raw) {
        final frame = jsonDecode(raw as String) as Map<String, dynamic>;
        if (frame['type'] != 'machine_select') return;
        daemon.selects++;
        final machineId = (frame['payload'] as Map)['machineId'] as String;
        if (daemon.hanging.contains(machineId)) return;
        if (daemon.failSelects > 0) {
          daemon.failSelects--;
          unawaited(ws.close(1011, 'relay failed'));
          return;
        }
        ws.add(
          jsonEncode({
            'type': 'connected',
            'payload': {'machineId': machineId},
          }),
        );
      });
    });
    return daemon;
  }

  Future<void> stop() async {
    for (final ws in sockets) {
      await ws.close();
    }
    await server.close(force: true);
  }
}

/// The longest wait the backoff's jitter can draw, so a test of how soon a retry goes cannot pass on
/// a lucky draw.
class _LongestWait implements Random {
  @override
  double nextDouble() => 1;
  @override
  bool nextBool() => true;
  @override
  int nextInt(int max) => max - 1;
}

void main() {
  late _Daemon daemon;
  final conns = <WsConn>[];

  setUp(() async => daemon = await _Daemon.start());
  tearDown(() async {
    for (final conn in conns) {
      await conn.close();
    }
    conns.clear();
    await daemon.stop();
  });

  WsConn local(
    List<ConnectionStatus> statuses, {
    String machineId = 'm1',
    Duration firstConnectFor = firstConnectWindow,
  }) {
    final conn = WsConn(
      wsBaseUrl: 'wss://unused.example',
      autonomousEnv: 'prod',
      machineId: machineId,
      accessTokenProvider: (_, _) async => '',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: statuses.add,
      random: _LongestWait(),
      firstConnectFor: firstConnectFor,
      transportKind: WsTransportKind.localPlaintext,
      allowLocalTcpFixture: true,
      localWsUri: Uri.parse(
        'ws://127.0.0.1:${daemon.server.port}/api/local-ws',
      ),
    );
    conns.add(conn);
    return conn;
  }

  Future<void> untilReady(WsConn conn, Duration within) async {
    final clock = Stopwatch()..start();
    while (!conn.isReady) {
      if (clock.elapsed > within) {
        fail('not ready after ${clock.elapsedMilliseconds} ms');
      }
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
  }

  test('a first connect that has not failed says connecting', () async {
    final statuses = <ConnectionStatus>[];
    final conn = local(statuses);
    await conn.connect();
    expect(statuses.first, ConnectionStatus.connecting);
    await untilReady(conn, const Duration(seconds: 2));
    expect(statuses, isNot(contains(ConnectionStatus.reconnecting)));
    expect(statuses.last, ConnectionStatus.connected);
  });

  test('three failed first tries say connecting and connect sooner than the backoff could', () async {
    // The backoff's shortest waits for these three are 0.5 + 1 + 2 = 3.5 s; these wait 2.5 s.
    daemon.failSelects = 3;
    final statuses = <ConnectionStatus>[];
    final conn = local(statuses);
    final clock = Stopwatch()..start();
    await conn.connect();
    await untilReady(conn, const Duration(seconds: 10));
    expect(clock.elapsed, lessThan(const Duration(milliseconds: 3400)));
    expect(daemon.selects, 4);
    expect(statuses, isNot(contains(ConnectionStatus.reconnecting)));
  });

  test('the first retry goes within about half a second', () async {
    daemon.failSelects = 1;
    final conn = local([]);
    final clock = Stopwatch()..start();
    await conn.connect();
    await untilReady(conn, const Duration(seconds: 5));
    expect(clock.elapsed, lessThan(const Duration(milliseconds: 900)));
  });

  test('past the quick tries it still says connecting within the window, and backs off from the start', () async {
    daemon.failSelects = firstConnectRetries + 1;
    final statuses = <ConnectionStatus>[];
    final conn = local(statuses);
    await conn.connect();
    await untilReady(conn, const Duration(seconds: 10));
    expect(statuses, isNot(contains(ConnectionStatus.reconnecting)));
    expect(daemon.selects, firstConnectRetries + 2);
  });

  test(
    'past the window it says reconnecting, which reads as offline',
    () async {
      daemon.failSelects = firstConnectRetries + 1;
      final statuses = <ConnectionStatus>[];
      final conn = local(statuses, firstConnectFor: Duration.zero);
      await conn.connect();
      await untilReady(conn, const Duration(seconds: 10));
      expect(statuses, contains(ConnectionStatus.reconnecting));
    },
  );

  test('a connection that was up and dropped says reconnecting', () async {
    final statuses = <ConnectionStatus>[];
    final conn = local(statuses);
    await conn.connect();
    await untilReady(conn, const Duration(seconds: 2));
    statuses.clear();
    await daemon.sockets.single.close(1011, 'dropped');
    while (statuses.isEmpty) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    await untilReady(conn, const Duration(seconds: 5));
    expect(statuses.first, ConnectionStatus.reconnecting);
    expect(statuses.last, ConnectionStatus.connected);
  });

  test('a browser socket keeps the plain backoff and words', () async {
    daemon.failSelects = 1;
    final statuses = <ConnectionStatus>[];
    final conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${daemon.server.port}',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'token',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: statuses.add,
    );
    conns.add(conn);
    await conn.connect();
    await untilReady(conn, const Duration(seconds: 5));
    expect(statuses, contains(ConnectionStatus.reconnecting));
  });

  test('closed while it waits to retry, it dials no more', () async {
    daemon.failSelects = 1;
    final statuses = <ConnectionStatus>[];
    final conn = local(statuses);
    await conn.connect();
    while (daemon.selects == 0) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    await Future<void>.delayed(const Duration(milliseconds: 100));
    await conn.close();
    final selects = daemon.selects;
    await Future<void>.delayed(const Duration(milliseconds: 800));
    expect(daemon.selects, selects);
    expect(conn.isReady, isFalse);
    expect(statuses.last, ConnectionStatus.disconnected);
  });

  test('one slow handshake holds up no other machine', () async {
    daemon.hanging.add('slow');
    final slowStatuses = <ConnectionStatus>[];
    final slow = local(slowStatuses, machineId: 'slow');
    final fast = local([], machineId: 'fast');
    await Future.wait([slow.connect(), fast.connect()]);
    await untilReady(fast, const Duration(milliseconds: 500));
    expect(slow.isReady, isFalse);
    expect(slowStatuses, isNot(contains(ConnectionStatus.reconnecting)));
  });

  test('a request asked during a failed first try is answered or fails, never stuck', () async {
    daemon.failSelects = 1;
    final conn = local([]);
    await conn.connect();
    final asked = conn.request(
      'agents_list',
      timeout: const Duration(milliseconds: 300),
    );
    await expectLater(asked, throwsA(anything));
  });
}
