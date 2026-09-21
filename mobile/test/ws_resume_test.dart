import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

/// Counts how many times anybody opened a socket, and can drop the ones it holds.
///
/// A phone loses this socket by being backgrounded, which no client-side event reports — so what
/// these tests reproduce is the shape of that loss, not its cause: the wire goes away, and the app
/// finds out by being unable to use it.
class _Hub {
  _Hub._(this.server);

  final HttpServer server;
  final List<WebSocket> live = [];
  int opened = 0;

  /// Answers every dial with a 404 rather than an upgrade — a dial that fails.
  bool refuse = false;

  /// Closes the next socket opened with this code the moment it opens.
  int? closeNextWith;

  int get port => server.port;

  static Future<_Hub> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final hub = _Hub._(server);
    server.listen((request) async {
      if (hub.refuse || !WebSocketTransformer.isUpgradeRequest(request)) {
        request.response.statusCode = 404;
        await request.response.close();
        return;
      }
      final ws = await WebSocketTransformer.upgrade(
        request,
        protocolSelector: (protocols) =>
            protocols.isNotEmpty ? protocols.first : null,
      );
      hub.opened++;
      final closeWith = hub.closeNextWith;
      if (closeWith != null) {
        hub.closeNextWith = null;
        await ws.close(closeWith);
        return;
      }
      hub.live.add(ws);
      // Whatever the client says, this hub only counts connections.
      ws.listen((_) {}, onDone: () => hub.live.remove(ws));
    });
    return hub;
  }

  Future<void> dropAll() async {
    final all = live.toList();
    live.clear();
    for (final ws in all) {
      await ws.close();
    }
  }

  Future<void> stop() async => server.close(force: true);
}

void main() {
  late _Hub hub;
  final statuses = <ConnectionStatus>[];
  final signOuts = <String>[];

  setUp(() async {
    hub = await _Hub.start();
    statuses.clear();
    signOuts.clear();
  });

  tearDown(() async => hub.stop());

  WsConn newConn({AccessTokenProvider? tokens}) => WsConn(
    wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
    autonomousEnv: 'test',
    machineId: 'm',
    accessTokenProvider: tokens ?? (_, _) async => 'token',
    onAuthFailure: signOuts.add,
    onEvent: (_) {},
    onStatus: statuses.add,
  );

  /// Polls rather than waiting a fixed time, and takes a DEADLINE rather than assuming one.
  ///
  /// ⚠️ The deadline is what makes the backoff test mean anything. The first retry is armed at one
  /// second, so a generous wait would go green whether the kick worked or the backoff simply fired
  /// on its own — a test that passes without the fix, which is worse than no test.
  Future<bool> opensReach(
    int count, {
    Duration within = const Duration(seconds: 2),
  }) async {
    final deadline = DateTime.now().add(within);
    while (DateTime.now().isBefore(deadline)) {
      if (hub.opened >= count) return true;
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    return hub.opened >= count;
  }

  test('a live connection is left alone', () async {
    final conn = newConn();
    addTearDown(conn.close);
    await conn.connect();
    expect(await opensReach(1), isTrue);

    conn.reconnectNow();
    conn.reconnectNow();
    await Future<void>.delayed(const Duration(milliseconds: 120));

    expect(
      hub.opened,
      1,
      reason:
          'a tab switch that cost nothing must cost nothing — tearing down '
          'a working socket to prove it is alive is a fresh handshake per switch',
    );
  });

  test(
    'a lost connection dials again without waiting out its backoff',
    () async {
      final conn = newConn();
      addTearDown(conn.close);
      await conn.connect();
      expect(await opensReach(1), isTrue);

      // The wire goes away the way a backgrounded phone's does: from the far end, with nothing said.
      await hub.dropAll();
      // Long enough for the client to notice and arm its backoff, short enough that the backoff
      // itself — a second on the first attempt, climbing to thirty — has not fired.
      await Future<void>.delayed(const Duration(milliseconds: 150));
      final beforeKick = hub.opened;

      conn.reconnectNow();

      // ⚠️ Well inside the ~850ms still left on that first backoff. Reaching the hub this early is
      // the whole assertion: the dial can only have come from the kick.
      expect(
        await opensReach(
          beforeKick + 1,
          within: const Duration(milliseconds: 350),
        ),
        isTrue,
      );
    },
  );

  test('a dial that failed does not hold up the next one', () async {
    hub.refuse = true;
    final conn = newConn();
    addTearDown(conn.close);
    await conn.connect();
    hub.refuse = false;

    // Back in front of somebody, on a network that works now.
    conn.reconnectNow();

    // Well inside the one-second backoff the failed dial armed.
    expect(
      await opensReach(1, within: const Duration(milliseconds: 350)),
      isTrue,
    );
  });

  test('a token refresh that cannot reach the server is retried', () async {
    hub.closeNextWith = 4401;
    final conn = newConn(
      tokens: (force, _) async =>
          force ? throw StateError('network unreachable') : 'token',
    );
    addTearDown(conn.close);
    await conn.connect();

    expect(await opensReach(2, within: const Duration(seconds: 3)), isTrue);
    expect(signOuts, isEmpty, reason: 'an outage is not a dead session');
  });

  test('a session that is gone for good signs out', () async {
    hub.closeNextWith = 4401;
    final conn = newConn(
      tokens: (force, _) async =>
          force ? throw const WsCredentialRevoked('revoked') : 'token',
    );
    addTearDown(conn.close);
    await conn.connect();
    await Future<void>.delayed(const Duration(milliseconds: 300));

    expect(signOuts, hasLength(1));
    expect(conn.isClosed, isTrue);
  });

  test('a connection somebody closed stays closed', () async {
    final conn = newConn();
    await conn.connect();
    expect(await opensReach(1), isTrue);
    await conn.close();
    final afterClose = hub.opened;

    // Signed out, machine unlinked, SSO refused: resuming the app is not a reason to revive it.
    conn.reconnectNow();
    await Future<void>.delayed(const Duration(milliseconds: 150));

    expect(hub.opened, afterClose);
  });
}
