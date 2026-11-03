import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart' show ConnectionStatus;
import 'package:harness/ws/ws_conn.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// How long the fake backend takes to answer or drop a socket.
const _latency = Duration(milliseconds: 50);

/// A backend socket that answers after [_latency]: either the machine's
/// `connected` and then a drop ([readyFirst]), or a close straight away.
class _Socket implements WebSocketChannel {
  _Socket({
    required this.closeWith,
    required this.readyFirst,
    this.upFor = _latency,
  });

  final int closeWith;
  final bool readyFirst;

  /// How long a socket that came up stays up before the drop.
  final Duration upFor;
  final _down = StreamController<dynamic>();
  late final _sink = _Sink(this);
  int? _closeCode;

  @override
  Future<void> get ready => Future<void>.delayed(_latency);
  @override
  Stream<dynamic> get stream => _down.stream;
  @override
  WebSocketSink get sink => _sink;
  @override
  int? get closeCode => _closeCode;
  @override
  String? get closeReason => null;

  void _selected(String machineId) {
    Timer(_latency, () {
      if (readyFirst) {
        _down.add(
          jsonEncode({
            'type': 'connected',
            'payload': {'machineId': machineId},
          }),
        );
      }
      Timer(readyFirst ? upFor : _latency, () => _drop(closeWith));
    });
  }

  void _drop(int code) {
    if (_down.isClosed) return;
    _closeCode = code;
    unawaited(_down.close());
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Sink implements WebSocketSink {
  _Sink(this._socket);
  final _Socket _socket;

  @override
  void add(dynamic data) {
    final frame = jsonDecode(data as String) as Map<String, dynamic>;
    if (frame['type'] == 'machine_select') {
      _socket._selected((frame['payload'] as Map)['machineId'] as String);
    }
  }

  @override
  Future<void> close([int? closeCode, String? closeReason]) async =>
      _socket._drop(closeCode ?? 1000);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// A [WsConn] to the backend whose every socket is a [_Socket].
class _Rig {
  _Rig({
    required int closeWith,
    bool readyFirst = false,
    Random? random,
    bool refreshFails = false,
    Duration Function()? now,
  }) {
    conn = WsConn(
      wsBaseUrl: 'wss://backend.test',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (force, _) async {
        if (force) {
          refreshes++;
          if (refreshFails) throw StateError('refresh failed');
          token = 'tok-$refreshes';
        }
        return token;
      },
      onAuthFailure: authFailures.add,
      onEvent: (_) {},
      onStatus: statuses.add,
      random: random,
      cloudSocket: (uri, protocols) {
        dials.add(protocols?.single);
        dialedAt.add(now?.call() ?? Duration.zero);
        final hold = holdNextFor;
        holdNextFor = null;
        return _Socket(
          closeWith: closeWith,
          readyFirst: readyFirst,
          upFor: hold ?? _latency,
        );
      },
    );
  }

  late final WsConn conn;
  final dials = <String?>[];
  final dialedAt = <Duration>[];

  /// Keeps the next socket up this long before it is dropped.
  Duration? holdNextFor;
  final authFailures = <String>[];
  final statuses = <ConnectionStatus>[];
  var token = 'tok-0';
  var refreshes = 0;
}

void main() {
  for (final (name, random) in [
    ('any', null),
    ('the shortest', _Fixed(0)),
    ('the longest', _Fixed(1)),
  ]) {
    test('a socket that comes up and is dropped again redials only a handful of times a minute '
        '($name jitter)', () {
      fakeAsync((async) {
        final rig = _Rig(closeWith: 1006, readyFirst: true, random: random);
        unawaited(rig.conn.connect());
        async.elapse(const Duration(minutes: 1));
        expect(rig.dials.length, lessThanOrEqualTo(8));

        // Steady state: after the first minute the pace is the 30 s ceiling, give or take jitter.
        final before = rig.dials.length;
        async.elapse(const Duration(minutes: 5));
        expect(rig.dials.length - before, inInclusiveRange(9, 20));
        unawaited(rig.conn.close());
      });
    });
  }

  test('a socket that closes before it is up redials only a handful of times a minute', () {
    fakeAsync((async) {
      final rig = _Rig(closeWith: 1013);
      unawaited(rig.conn.connect());
      async.elapse(const Duration(minutes: 1));
      expect(rig.dials.length, lessThanOrEqualTo(8));
      unawaited(rig.conn.close());
    });
  });

  test('a connection that stayed up for a minute retries its next drop promptly again', () {
    fakeAsync((async) {
      final rig = _Rig(
        closeWith: 1006,
        readyFirst: true,
        now: () => async.elapsed,
      );
      unawaited(rig.conn.connect());
      // Back off to the 30 s ceiling first, then let the next socket stay up for two minutes.
      async.elapse(const Duration(minutes: 3));
      rig.holdNextFor = const Duration(minutes: 2);
      final healthy = rig.dials.length;
      async.elapse(const Duration(minutes: 3));
      expect(rig.dials.length, greaterThan(healthy + 1));
      final gap = rig.dialedAt[healthy + 1] - rig.dialedAt[healthy];
      // Up two minutes, then at most the first step's second, not the 15-30 s ceiling.
      expect(gap, lessThan(const Duration(minutes: 2, seconds: 2)));
      unawaited(rig.conn.close());
    });
  });

  test('a short-lived connection keeps backing off', () {
    fakeAsync((async) {
      final rig = _Rig(
        closeWith: 1006,
        readyFirst: true,
        now: () => async.elapsed,
      );
      unawaited(rig.conn.connect());
      async.elapse(const Duration(minutes: 3));
      rig.holdNextFor = const Duration(seconds: 20);
      final brief = rig.dials.length;
      async.elapse(const Duration(minutes: 2));
      final gap = rig.dialedAt[brief + 1] - rig.dialedAt[brief];
      expect(gap, greaterThan(const Duration(seconds: 20 + 15)));
      unawaited(rig.conn.close());
    });
  });

  test('reconnect delays are jittered, so many tabs dropped at once do not return together', () {
    final delays = {
      for (var seed = 0; seed < 20; seed++)
        reconnectDelay(4, Random(seed)).inMilliseconds,
    };
    expect(delays.length, greaterThan(10));
    for (final delay in delays) {
      // The fourth attempt waits between half of 8 s and 8 s.
      expect(delay, inInclusiveRange(4000, 8000));
    }
  });

  test('reconnect delays double and stop at 30 s', () {
    Duration low(int attempt) => reconnectDelay(attempt, _Fixed(0));
    Duration high(int attempt) => reconnectDelay(attempt, _Fixed(1));
    expect(low(1), const Duration(milliseconds: 500));
    expect(high(1), const Duration(seconds: 1));
    expect(low(2), const Duration(seconds: 1));
    expect(high(3), const Duration(seconds: 4));
    expect(low(6), const Duration(seconds: 15));
    expect(high(6), const Duration(seconds: 30));
    expect(high(40), const Duration(seconds: 30));
    expect(low(40), const Duration(seconds: 15));
  });

  test(
    '4401 refreshes once; a refused fresh token stops and asks for sign-in',
    () {
      fakeAsync((async) {
        final rig = _Rig(closeWith: 4401);
        unawaited(rig.conn.connect());
        async.elapse(const Duration(minutes: 1));
        expect(rig.refreshes, 1);
        expect(rig.dials, ['tok-0', 'tok-1']);
        expect(rig.authFailures, hasLength(1));
        expect(rig.conn.isClosed, isTrue);
        expect(rig.statuses.last, ConnectionStatus.disconnected);
      });
    },
  );

  test(
    '4401 after a refreshed token served a working connection refreshes again',
    () {
      fakeAsync((async) {
        final rig = _Rig(closeWith: 4401, readyFirst: true);
        unawaited(rig.conn.connect());
        async.elapse(const Duration(minutes: 1));
        // Each socket was up before the backend said the token expired: never a sign-out, and
        // never a refresh loop either.
        expect(rig.authFailures, isEmpty);
        expect(rig.refreshes, greaterThanOrEqualTo(2));
        expect(rig.dials.length, lessThanOrEqualTo(8));
        unawaited(rig.conn.close());
      });
    },
  );
}

class _Fixed implements Random {
  _Fixed(this.value);
  final double value;
  @override
  double nextDouble() => value;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
