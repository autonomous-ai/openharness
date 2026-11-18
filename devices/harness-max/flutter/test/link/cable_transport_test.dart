// The far ends for real: the link over a TCP socket a fake daemon dials on loopback, the bounded write queue, and the
// USB transport's host gating and read loop on a file standing in for the gadget's port.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/link/cable/cable_frame.dart';
import 'package:harness_max_bar/link/cable/cable_link.dart';
import 'package:harness_max_bar/link/cable/cable_transport.dart';
import 'package:harness_max_bar/model/types.dart';

import 'support/cable_fakes.dart';

/// A daemon dialling the bar as cableTcp.ts does.
class _Daemon {
  _Daemon(this.socket) {
    socket.listen(
      (data) {
        decoder.feed(data, (_, type, payload) {
          if (type == kCableTypeJson) got.add(jsonDecode(utf8.decode(payload)) as Map<String, Object?>);
          _arrived.add(null);
        });
      },
      onDone: () {
        if (!closed.isCompleted) closed.complete();
      },
      onError: (Object _) {
        if (!closed.isCompleted) closed.complete();
      },
    );
  }

  static Future<_Daemon> dial(int port) async => _Daemon(await Socket.connect(InternetAddress.loopbackIPv4, port));

  final Socket socket;
  final decoder = CableDecoder();
  final List<Map<String, Object?>> got = [];
  final _arrived = StreamController<void>.broadcast(sync: true);
  final closed = Completer<void>();

  /// The first message of [kind] not yet taken, waiting for it if it has not come.
  Future<Map<String, Object?>> next(String kind) async {
    for (;;) {
      final i = got.indexWhere((m) => m['t'] == kind);
      if (i >= 0) return got.removeAt(i);
      await _arrived.stream.first.timeout(const Duration(seconds: 5));
    }
  }

  void say(Map<String, Object?> message) =>
      socket.add(encodeCableFrame(kCableTypeJson, utf8.encode(jsonEncode(message)))!);

  Future<void> hangUp() async {
    await socket.close();
    socket.destroy();
  }
}

/// Waits for [done] to hold, a bounded while.
Future<void> _until(bool Function() done, {String what = 'condition'}) async {
  final watch = Stopwatch()..start();
  while (!done()) {
    if (watch.elapsed > const Duration(seconds: 5)) fail('timed out waiting for $what');
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

void main() {
  group('TCP', () {
    test('a daemon on loopback: hello, welcome, the ring, an open, and the link down when it hangs up', () async {
      final model = RecordingModel();
      final transport = TcpTransport(port: 0, log: (_) {});
      final link = CableLink(model, transport: transport, hostName: 'orangepi4pro', log: (_) {});
      addTearDown(link.stop);
      await link.start();
      expect(transport.boundPort, isNot(0));
      expect(transport.connected, isFalse);

      final daemon = await _Daemon.dial(transport.boundPort);
      addTearDown(daemon.hangUp);
      final hello = await daemon.next('hello');
      expect(
        [hello['board'], hello['appFilter'], hello['product'], hello['mac']],
        ['max', 'v1', 'harness', 'AE:32:4E:AD:E7:88'],
      );
      expect(hello.containsKey('ota'), isFalse);

      daemon.say({
        't': 'welcome',
        'machine': {'id': 'm1', 'name': 'Mac'},
        'features': ['form'],
      });
      await _until(() => model.named('link').isNotEmpty, what: 'the link up');
      expect(model.named('link').single.args, {'up': true, 'computer': 'Mac', 'offersNew': true});
      await daemon.next('machines.list');
      await daemon.next('agents.list');

      daemon.say({'t': 'agents.begin', 'seq': 1});
      daemon.say({'t': 'agent', 'id': 'a1', 'name': 'auth', 'engine': 'claude', 'host': 'harness', 'caps': 'sv'});
      daemon.say({'t': 'agents.end'});
      final agents = await model.next('agents');
      expect((agents['rows'] as List<AgentRow>).single.name, 'auth');

      daemon.say({'t': 'ping'});
      await daemon.next('pong');
      link.openAgent('a1');
      expect(await daemon.next('agent.open'), {'t': 'agent.open', 'agentId': 'a1'});

      await daemon.hangUp();
      await _until(() => model.named('link').length == 2, what: 'the link down');
      expect(model.named('link').last.args['up'], false);
      expect(transport.connected, isFalse);
      expect(link.connected, isFalse);
    });

    test('a daemon that dials again replaces its old connection, and the link starts over on the new one', () async {
      final model = RecordingModel();
      final transport = TcpTransport(port: 0, log: (_) {});
      final link = CableLink(model, transport: transport, hostName: 'orangepi4pro', log: (_) {});
      addTearDown(link.stop);
      await link.start();

      final first = await _Daemon.dial(transport.boundPort);
      addTearDown(first.hangUp);
      await first.next('hello');
      first.say({
        't': 'welcome',
        'machine': {'id': 'm1', 'name': 'Mac'},
      });
      await _until(() => model.named('link').length == 1, what: 'the first session');

      final second = await _Daemon.dial(transport.boundPort);
      addTearDown(second.hangUp);
      await second.next('hello');
      await first.closed.future.timeout(const Duration(seconds: 5));
      expect(model.named('link').map((c) => c['up']), [true, false]);

      second.say({
        't': 'welcome',
        'machine': {'id': 'm1', 'name': 'Mac'},
      });
      await _until(() => model.named('link').length == 3, what: 'the second session');
      expect(model.named('link').last.args['up'], true);
      await second.next('agents.list');
    });

    test('nothing is written with no daemon; a re-plug hangs the daemon up', () async {
      final transport = TcpTransport(port: 0, log: (_) {});
      final closes = <String>[];
      var connects = 0;
      await transport.start(onConnected: () => connects++, onBytes: (_) {}, onClosed: closes.add);
      addTearDown(transport.stop);
      expect(transport.write(Uint8List.fromList([1, 2, 3])), isFalse);
      transport.replug();
      final daemon = await _Daemon.dial(transport.boundPort);
      addTearDown(daemon.hangUp);
      await _until(() => connects == 1, what: 'the connection');
      final frame = encodeCableFrame(kCableTypeJson, utf8.encode('{"t":"pong"}'))!;
      expect(transport.write(frame), isTrue);
      await daemon.next('pong');
      transport.replug();
      expect(closes, ['re-plug']);
      await daemon.closed.future.timeout(const Duration(seconds: 5));
      expect(transport.connected, isFalse);
      expect(transport.write(frame), isFalse);
    });
  });

  group('the write queue', () {
    test('writes in order, what queued during a write going as one batch', () async {
      final batches = <List<int>>[];
      var gate = Completer<void>();
      final q = FrameQueue((bytes) async {
        batches.add(bytes);
        await gate.future;
      });
      expect(q.add(Uint8List.fromList([1])), isTrue);
      expect(q.add(Uint8List.fromList([2, 3])), isTrue);
      expect(q.add(Uint8List.fromList([4])), isTrue);
      expect(q.bytes, 4);
      await pumpEventQueue();
      expect(batches, [
        [1],
      ]);
      final first = gate;
      gate = Completer<void>()..complete();
      first.complete();
      await q.idle;
      expect(batches, [
        [1],
        [2, 3, 4],
      ]);
      expect(q.bytes, 0);
    });

    test('a far end that stops reading costs the frames that do not fit, never more', () async {
      final stuck = Completer<void>();
      final q = FrameQueue((_) => stuck.future, capacity: 10);
      expect(q.add(Uint8List(6)), isTrue);
      expect(q.add(Uint8List(4)), isTrue);
      expect(q.add(Uint8List(1)), isFalse);
      expect(q.bytes, 10);
      q.clear();
      // The batch in flight is still counted until it is written.
      expect(q.bytes, 6);
      expect(q.add(Uint8List(5)), isFalse);
      expect(q.add(Uint8List(4)), isTrue);
      q.close();
      expect(q.add(Uint8List(1)), isFalse);
      stuck.complete();
      await q.idle;
      expect(q.bytes, 0);
    });

    test('a batch that fails is dropped and reported; the next one is written', () async {
      final batches = <List<int>>[];
      final errors = <Object>[];
      var fail = true;
      final q = FrameQueue((bytes) async {
        if (fail) {
          fail = false;
          throw const SocketException('Broken pipe');
        }
        batches.add(bytes);
      }, onError: errors.add);
      q.add(Uint8List.fromList([1]));
      await q.idle;
      q.add(Uint8List.fromList([2]));
      await q.idle;
      expect(errors.single, isA<SocketException>());
      expect(batches, [
        [2],
      ]);
      expect(q.bytes, 0);
    });
  });

  group('USB', () {
    late Directory dir;
    late File state, port;
    late List<String> events;
    late UsbTransport usb;

    setUp(() {
      dir = Directory.systemTemp.createTempSync('cable_usb');
      state = File('${dir.path}/state')..writeAsStringSync('not attached\n');
      port = File('${dir.path}/ttyGS0');
      events = [];
      usb = UsbTransport(port: port.path, udcState: state.path, log: (_) {});
    });

    tearDown(() async {
      await usb.stop();
      dir.deleteSync(recursive: true);
    });

    Future<void> start() => usb.start(
      onConnected: () => events.add('connected'),
      onBytes: (b) => events.add('bytes:${utf8.decode(b)}'),
      onClosed: (why) => events.add('closed:$why'),
    );

    test('no host while the controller is not configured, even with the port there', () async {
      port.writeAsStringSync('');
      await start();
      await Future<void>.delayed(UsbTransport.pollEvery * 3);
      expect(events, isEmpty);
      expect(usb.connected, isFalse);
      expect(usb.write(Uint8List.fromList([1])), isFalse);
    });

    test('a configured host with no port yet waits for the port', () async {
      state.writeAsStringSync('configured\n');
      await start();
      await Future<void>.delayed(UsbTransport.pollEvery * 3);
      expect(events, isEmpty);
      expect(usb.connected, isFalse);
    });

    test('a port that hangs up is the host gone, and is opened again a second later', () async {
      // A plain empty file reads as a port whose host hung up at once.
      port.writeAsStringSync('');
      state.writeAsStringSync('configured\n');
      await start();
      await _until(() => events.length >= 2, what: 'a connection and its end');
      expect(events.take(2), ['connected', 'closed:host gone']);
      final watch = Stopwatch()..start();
      await _until(() => events.length >= 3, what: 'the port again');
      expect(events[2], 'connected');
      expect(watch.elapsed, greaterThan(UsbTransport.reopenAfter - UsbTransport.pollEvery * 2));
    });

    test('on a port that stays open, the controller leaving the configured state is the host gone', () async {
      // A FIFO blocks its reader as a quiet host's port does.
      final made = await Process.run('mkfifo', [port.path]);
      expect(made.exitCode, 0, reason: '${made.stderr}');
      state.writeAsStringSync('configured\n');
      await start();
      final host = await File(port.path).open(mode: FileMode.writeOnly);
      await _until(() => events.isNotEmpty, what: 'the host');
      await host.writeString('from the host');
      await _until(() => events.length == 2, what: 'the host\'s bytes');
      expect(usb.connected, isTrue);

      state.writeAsStringSync('suspended\n');
      await _until(() => events.length == 3, what: 'the host gone');
      expect(usb.connected, isFalse);
      expect(usb.write(Uint8List.fromList([1])), isFalse);

      state.writeAsStringSync('configured\n');
      await _until(() => events.length == 4, what: 'the host back');
      expect(events, ['connected', 'bytes:from the host', 'closed:host gone', 'connected']);
      await host.close();
    });
  });
}
