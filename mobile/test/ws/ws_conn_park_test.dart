import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/ws/ws_conn.dart';

import 'memory_web_socket.dart';

/// A connection whose machine the relay calls offline waits for it ([WsConn.parkUntilOnline]) and
/// dials again on its own only now and then: after a minute, then twice as long each time, to
/// fifteen minutes. Anything that says the machine is back, and anybody asking for it, dials at
/// once and starts the waits over. At a flat minute, an app left open beside a machine that was
/// off dialled it sixty times an hour, for as long as it stayed open.
void main() {
  test('the waits double from a minute to fifteen at most', () {
    expect(
      [for (var n = 0; n < 7; n++) WsConn.parkedRecheckAfter(n).inSeconds],
      [60, 120, 240, 480, 900, 900, 900],
    );
  });

  /// One connection on a fake clock, dialled through an in-memory relay ([relay] holds the relay's
  /// end of every dial, so its length is the number of dials). The first dial is parked, as the
  /// app parks it when the relay answers the select with "offline".
  void parked(
    void Function(FakeAsync clock, WsConn conn, List<MemoryWebSocket> relay)
    body,
  ) {
    fakeAsync((clock) {
      final relay = <MemoryWebSocket>[];
      final conn = WsConn(
        wsBaseUrl: 'ws://fixture.invalid',
        connectChannel: (_, {protocols}) {
          final (client, server) = MemoryWebSocket.pair();
          server.stream.listen((_) {});
          relay.add(server);
          client.accept();
          return client;
        },
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => 'token',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
      unawaited(conn.connect());
      clock.flushMicrotasks();
      conn.parkUntilOnline();
      expect(relay, hasLength(1));
      expect(conn.isParked, isTrue);
      body(clock, conn, relay);
      unawaited(conn.close());
      clock.flushMicrotasks();
    });
  }

  /// The dial just made hears "offline" again, and the app parks it once more.
  void stillOff(FakeAsync clock, WsConn conn) {
    clock.flushMicrotasks();
    conn.parkUntilOnline();
    expect(conn.isParked, isTrue);
  }

  test('dials again after 1, 2, 4, 8 and then every 15 minutes', () {
    parked((clock, conn, relay) {
      for (final (minutes, dials) in [
        (1, 2),
        (2, 3),
        (4, 4),
        (8, 5),
        (15, 6),
        (15, 7),
      ]) {
        clock.elapse(Duration(minutes: minutes) - const Duration(seconds: 1));
        expect(relay, hasLength(dials - 1), reason: 'before $minutes min');
        clock.elapse(const Duration(seconds: 1));
        expect(relay, hasLength(dials), reason: 'at $minutes min');
        stillOff(clock, conn);
      }
    });
  });

  test('word that the machine is back dials at once and starts the waits over', () {
    parked((clock, conn, relay) {
      // Three rechecks of its own: the next one is eight minutes away.
      for (final minutes in [1, 2, 4]) {
        clock.elapse(Duration(minutes: minutes));
        stillOff(clock, conn);
      }
      expect(relay, hasLength(4));

      // The relay's push says it is back, and the dial finds it off after all.
      conn.wake('the relay says it is online');
      stillOff(clock, conn);
      expect(relay, hasLength(5));

      // A minute again, not eight.
      clock.elapse(const Duration(minutes: 1));
      expect(relay, hasLength(6));
    });
  });

  test('somebody asking for it (the app back in front, a tap) dials at once and starts over', () {
    parked((clock, conn, relay) {
      for (final minutes in [1, 2]) {
        clock.elapse(Duration(minutes: minutes));
        stillOff(clock, conn);
      }
      conn.reconnectNow();
      stillOff(clock, conn);
      expect(relay, hasLength(4));

      clock.elapse(const Duration(minutes: 1));
      expect(relay, hasLength(5));
    });
  });

  test('a connection that came up, then lost its machine, starts from a minute again', () {
    parked((clock, conn, relay) {
      for (final minutes in [1, 2, 4]) {
        clock.elapse(Duration(minutes: minutes));
        stillOff(clock, conn);
      }

      // The eight-minute recheck finds the machine up: the select is answered.
      clock.elapse(const Duration(minutes: 8));
      clock.flushMicrotasks();
      relay.last.sink.add(
        jsonEncode({
          'type': 'connected',
          'payload': {'machineId': 'm'},
        }),
      );
      clock.flushMicrotasks();
      expect(conn.isReady, isTrue);
      expect(conn.isParked, isFalse);

      // Later the socket drops and the machine is off: the ordinary backoff dials, and the park
      // after it waits a minute, not fifteen.
      unawaited(relay.last.sink.close());
      clock.elapse(const Duration(seconds: 1));
      expect(relay, hasLength(6));
      stillOff(clock, conn);

      clock.elapse(const Duration(minutes: 1));
      expect(relay, hasLength(7));
    });
  });

  test(
    'in the background it stops dialling on its own; coming back asks at once',
    () {
      parked((clock, conn, relay) {
        conn.pauseParkedRecheck();
        clock.elapse(const Duration(hours: 2));
        expect(relay, hasLength(1));
        // Still waiting for the machine: a push would still wake it.
        expect(conn.isParked, isTrue);

        conn.reconnectNow();
        stillOff(clock, conn);
        expect(relay, hasLength(2));

        clock.elapse(const Duration(minutes: 1));
        expect(relay, hasLength(3));
      });
    },
  );

  test('a push still wakes a connection paused in the background', () {
    parked((clock, conn, relay) {
      conn.pauseParkedRecheck();
      conn.wake('the relay says it is online');
      clock.flushMicrotasks();
      expect(relay, hasLength(2));
    });
  });

  test('pausing leaves a connection that is not parked to its own backoff', () {
    parked((clock, conn, relay) {
      // The machine answers, then the socket drops: an ordinary reconnect, not a park.
      relay.last.sink.add(
        jsonEncode({
          'type': 'connected',
          'payload': {'machineId': 'm'},
        }),
      );
      clock.flushMicrotasks();
      expect(conn.isReady, isTrue);
      unawaited(relay.last.sink.close());
      clock.flushMicrotasks();

      conn.pauseParkedRecheck();
      clock.elapse(const Duration(seconds: 1));
      expect(relay, hasLength(2));
    });
  });
}
