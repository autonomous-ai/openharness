import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/ws/ws_pool.dart';

import 'memory_web_socket.dart';

/// One connection per machine, and who may speak for that machine.
void main() {
  late List<String> events;
  late WsPool pool;

  setUp(() {
    events = [];
    pool = WsPool(
      wsBaseUrl: 'ws://fixture.invalid',
      connectChannel: (_, {protocols}) {
        final (client, server) = MemoryWebSocket.pair();
        server.stream.listen((_) {});
        client.accept();
        return client;
      },
      autonomousEnv: 'test',
      // Never resolves: nothing is ever dialled.
      accessTokenProvider: (_, _) => Completer<String>().future,
      onAuthFailure: (message) => events.add('auth:$message'),
      onLocalFailure: (machineId, code, _) =>
          events.add('local:$machineId:$code'),
      onStatus: (machineId, status) =>
          events.add('status:$machineId:${status.name}'),
      onEvent: (machineId, event) =>
          events.add('event:$machineId:${event['type']}'),
    );
    addTearDown(pool.closeAll);
  });

  test('a machine keeps its one connection while it is open', () {
    final conn = pool.connFor('m');
    expect(pool.connFor('m'), same(conn));
    expect(pool['m'], same(conn));
    expect(pool.has('m'), isTrue);
    expect(pool.has('other'), isFalse);
    expect(conn.machineId, 'm');
    expect(conn.endpointKey, 'cloud:ws://fixture.invalid:test');
  });

  test('its callbacks carry the machine they are for', () async {
    final conn = pool.connFor('m');
    events.clear();
    conn.onStatus(ConnectionStatus.connected);
    conn.onLocalFailure!(4404, 'NO_PEER_LINK');
    await conn.onEvent({'type': 'node_status'});
    conn.onAuthFailure('gone');
    expect(events, [
      'status:m:connected',
      'local:m:4404',
      'event:m:node_status',
      'auth:gone',
    ]);
  });

  test('a closed connection is replaced, not handed back', () async {
    final first = pool.connFor('m');
    await first.close();
    final second = pool.connFor('m');
    expect(second, isNot(same(first)));
  });

  // Carried over from the desktop's pool: once another connection holds the machine, the one it
  // replaced speaks for nothing. Its final `disconnected` landing late used to mark the new,
  // working connection's machine as lost ("Connection lost. Reconnecting…").
  test('a replaced connection cannot publish late callbacks', () async {
    final old = pool.connFor('m');
    await pool.closeMachine('m');
    final current = pool.connFor('m');
    events.clear();

    old.onAuthFailure('old');
    old.onLocalFailure!(4404, 'old');
    await old.onEvent({'type': 'old'});
    old.onStatus(ConnectionStatus.disconnected);
    expect(events, isEmpty);

    current.onStatus(ConnectionStatus.connected);
    await current.onEvent({'type': 'current'});
    expect(events, ['status:m:connected', 'event:m:current']);
  });

  test('closing a machine reports its end, then forgets it', () async {
    pool.connFor('m');
    events.clear();
    await pool.closeMachine('m');
    expect(events, ['status:m:disconnected']);
    expect(pool.has('m'), isFalse);
    // Closing what is not there is nothing.
    await pool.closeMachine('m');
  });

  test('closing everything leaves nothing to reconnect', () async {
    final a = pool.connFor('a');
    final b = pool.connFor('b');
    await pool.closeAll();
    expect(a.isClosed, isTrue);
    expect(b.isClosed, isTrue);
    expect(pool.has('a') || pool.has('b'), isFalse);
    pool.reconnectAll();
  });

  test('coming back to the foreground asks every connection to redial', () {
    final a = pool.connFor('a');
    final b = pool.connFor('b');
    // Both are mid-dial (the credential never arrives), so there is nothing to redo.
    pool.reconnectAll();
    expect(a.isClosed || b.isClosed, isFalse);
  });
}
