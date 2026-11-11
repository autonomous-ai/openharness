import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/browser/browser_stream.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/ws/ws_conn.dart';

import '../swarm_state_test.dart' show createApp;

const _id = '0f8fad5b-d9cb-469f-a165-70867728950e';
const _other = '1f8fad5b-d9cb-469f-a165-70867728950e';

/// A machine's daemon as a browser stream sees it: every frame and binary message is recorded.
class _Daemon extends WsConn {
  _Daemon(String machineId)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final frames = <(String, Map<String, dynamic>)>[];
  final binary = <TerminalBinaryFrame>[];

  @override
  bool get isReady => true;

  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    frames.add((type, Map.of(payload)));
    return true;
  }

  @override
  Future<bool> sendTerminalBinary(Uint8List bytes) async {
    binary.add(decodeTerminalLocal(bytes)!);
    return true;
  }
}

void main() {
  late Map<String, _Daemon> daemons;
  late AppNotifier app;
  setUp(() {
    daemons = {'m': _Daemon('m'), 'm2': _Daemon('m2')};
    app = createApp(connectionForTest: (id) => daemons[id]!, connected: true);
    const second = Machine(
      machineId: 'm2',
      authMode: MachineAuthMode.remote,
      name: 'Second host',
    );
    app.machines = [...app.machines, second];
    app.machineStates['m2'] = MachineState(second)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
  });
  tearDown(() => app.dispose());

  /// A stream on [machine], opened as its daemon answers.
  Future<dynamic> open(String machine, String streamId) async {
    final stream = app.browserStream(machine, 'a1');
    final opened = stream.open();
    await Future<void>.delayed(Duration.zero);
    final request = daemons[machine]!.frames.last.$2['requestId'];
    await app.handleMachineEventForTest(machine, {
      'type': 'agent_browser_open_result',
      'payload': {'requestId': request, 'streamId': streamId},
    });
    await opened;
    return stream;
  }

  test('frames and kind-8 bytes reach the stream they name, and its bytes '
      'leave as kind 8', () async {
    final stream = await open('m', _id);
    final got = <int>[];
    stream.bytes.listen(got.addAll);
    for (final (streamId, bytes) in [
      (_id, [1, 2]),
      (_other, [9]),
      (_id, [3]),
    ]) {
      await app.handleTerminalBinaryForTest(
        'm',
        encodeTerminalLocal(
          TerminalBinaryFrame(
            kind: TerminalBinaryKind.browser,
            streamId: streamId,
            seq: 0,
            bytes: Uint8List.fromList(bytes),
            compressed: false,
          ),
        )!,
      );
    }
    await Future<void>.delayed(Duration.zero);
    expect(got, [1, 2, 3]);
    stream.write(Uint8List.fromList([7]));
    await Future<void>.delayed(Duration.zero);
    expect(daemons['m']!.binary.single.kind, TerminalBinaryKind.browser);
    expect(daemons['m']!.binary.single.bytes, [7]);
    await app.handleMachineEventForTest('m', {
      'type': 'agent_browser_close',
      'payload': {'streamId': _id, 'reason': 'agent'},
    });
    expect(await stream.closed, 'agent');
  });

  test('a transport error for one machine closes only that machine\'s '
      'streams', () async {
    final here = await open('m', _id);
    final there = await open('m2', _other);
    await app.handleMachineEventForTest('m', {
      'type': 'agent_browser_transport_error',
      'payload': {'code': 'RATE'},
    });
    expect(await here.closed, 'rate');
    expect(daemons['m']!.frames.last.$1, 'agent_browser_close');
    expect(there.isClosed, isFalse);
  });

  test('a machine connection that drops ends its streams with route', () async {
    final here = await open('m', _id);
    final there = await open('m2', _other);
    app.connectionStatusForTest('m', ConnectionStatus.reconnecting);
    expect(await here.closed, 'route');
    expect(there.isClosed, isFalse);
  });

  test('a stream closed before its open is answered still closes what the '
      'machine opens, also after the open timed out', () async {
    final stream = app.browserStream('m', 'a1');
    final opened = expectLater(
      stream.open(),
      throwsA(isA<BrowserStreamError>()),
    );
    await Future<void>.delayed(Duration.zero);
    final request = daemons['m']!.frames.last.$2['requestId'];
    await stream.close();
    await app.handleMachineEventForTest('m', {
      'type': 'agent_browser_open_result',
      'payload': {'requestId': request, 'streamId': _id},
    });
    await opened;
    expect(daemons['m']!.frames.last.$1, 'agent_browser_close');
    expect(daemons['m']!.frames.last.$2, {'streamId': _id});

    fakeAsync((async) {
      final late = app.browserStream('m', 'a1');
      Object? failure;
      late.open().catchError((Object e) => failure = e);
      async.flushMicrotasks();
      final request = daemons['m']!.frames.last.$2['requestId'];
      async.elapse(BrowserStream.openTimeout);
      expect((failure as BrowserStreamError).code, BrowserStreamError.route);
      late.close();
      app.handleMachineEventForTest('m', {
        'type': 'agent_browser_open_result',
        'payload': {'requestId': request, 'streamId': _other},
      });
      async.flushMicrotasks();
      expect(daemons['m']!.frames.last.$1, 'agent_browser_close');
      expect(daemons['m']!.frames.last.$2, {'streamId': _other});
    });
  });

  test('terminal binary frames pass the browser check without being parsed '
      '(prints the time for 100k frames)', () async {
    final frame = encodeTerminalLocal(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.output,
        streamId: _id,
        seq: 0,
        bytes: Uint8List(64),
        compressed: false,
      ),
    )!;
    for (var i = 0; i < 10000; i++) {
      await app.handleTerminalBinaryForTest('m', frame);
    }
    final clock = Stopwatch()..start();
    for (var i = 0; i < 100000; i++) {
      await app.handleTerminalBinaryForTest('m', frame);
    }
    // ignore: avoid_print
    print('100k terminal frames: ${clock.elapsedMilliseconds} ms');
  });
}
