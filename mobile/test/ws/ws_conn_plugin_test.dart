import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/e2ee/keys.dart';
import 'package:harness_mobile/e2ee/relay_session_crypto.dart';
import 'package:harness_mobile/e2ee/terminal_cipher.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/viewer/e2ee_relay_codec.dart';
import 'package:harness_mobile/ws/relay_codec.dart';
import 'package:harness_mobile/ws/terminal_transport_plugin.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import '../e2ee/machine_session.dart';
import 'fake_relay.dart';

/// A second wire that takes whatever it is told to, and writes down every time the connection
/// gave it a say — the seam `TerminalP2pPlugin` rides on.
class _Wire implements TerminalTransportPlugin {
  _Wire(this.host);

  final TerminalTransportHost host;
  final calls = <String>[];
  Map<String, dynamic>? ack;
  bool takeJson = false;
  bool takeBinary = false;
  bool openHere = false;
  bool disposed = false;
  final sealedJson = <String>[];

  @override
  void onConnectedAck(Map<String, dynamic> payload) {
    calls.add('ack');
    ack = payload;
  }

  @override
  void onSessionReady() => calls.add('ready:${host.codec.terminalP2pVersion}');

  @override
  bool consumesInbound(String type) => type.startsWith('p2p_');

  @override
  Future<void> handleInbound(String type, Map<String, dynamic> payload) async =>
      calls.add('inbound:$type:${payload['sessionId']}');

  @override
  Future<void> observeWsFrame(Map<String, dynamic> plain) async =>
      calls.add('saw:${plain['type']}');

  @override
  Future<void> observeWsBinary(Uint8List localFrame) async =>
      calls.add('saw-binary:${peekTerminalLocal(localFrame)?.kind.name}');

  @override
  Future<bool> prepareOpen(String requestId) async {
    calls.add('prepare:$requestId');
    return openHere;
  }

  @override
  bool sendJson(
    String type,
    Map<String, dynamic> payload,
    String sealedJson, {
    required bool openViaPlugin,
    TransportVia? force,
  }) {
    calls.add('json:$type:$openViaPlugin:${force?.name}');
    this.sealedJson.add(sealedJson);
    return takeJson || force == TransportVia.plugin;
  }

  @override
  Future<bool> sendBinary(Uint8List localFrame, Uint8List sealedFrame) async {
    calls.add('binary');
    return takeBinary;
  }

  @override
  void dispose({bool notifyPeer = false}) {
    disposed = true;
    calls.add('dispose');
  }
}

void main() {
  late E2eeIdentity phone;
  late E2eeIdentity machineIdentity;
  late FakeRelay relay;
  late List<_Wire> wires;
  late List<Map<String, dynamic>> events;
  late List<Uint8List> binaries;
  late List<ConnectionStatus> statuses;

  setUpAll(() async {
    phone = await E2eeIdentity.generate();
    machineIdentity = await E2eeIdentity.generate();
  });

  setUp(() async {
    relay = await FakeRelay.start(machineIdentity);
    wires = [];
    events = [];
    binaries = [];
    statuses = [];
  });
  tearDown(() async => relay.stop());

  RelayCodecFactory codecs() =>
      (machineId) async => E2eeRelayCodec(
        await RelaySessionCrypto.start(
          machineId: machineId,
          identity: phone,
          peerPub: machineIdentity.pub,
        ),
      );

  WsConn newConn({RelayCodecFactory? relayCodecs}) {
    final conn = WsConn(
      wsBaseUrl: relay.url,
      connectChannel: relay.connect,
      autonomousEnv: 'test',
      machineId: machineId,
      accessTokenProvider: (_, _) async => 'token',
      onAuthFailure: (_) {},
      onLocalFailure: (_, _) {},
      onEvent: events.add,
      onStatus: statuses.add,
      relayCodecs: relayCodecs ?? codecs(),
      transportPlugins: (host, id) {
        expect(id, machineId);
        final wire = _Wire(host);
        wires.add(wire);
        return wire;
      },
    );
    conn.onBinaryFrame = (frame) async => binaries.add(frame);
    addTearDown(conn.close);
    return conn;
  }

  Future<bool> eventually(bool Function() check) async {
    final deadline = DateTime.now().add(const Duration(seconds: 3));
    while (DateTime.now().isBefore(deadline)) {
      if (check()) return true;
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    return check();
  }

  Future<(WsConn, RelayLink, _Wire)> connected() async {
    final conn = newConn();
    final session = relay.nextSession();
    unawaited(conn.connect());
    final link = await session.timeout(const Duration(seconds: 5));
    await conn.waitUntilReady(timeout: const Duration(seconds: 5));
    await eventually(
      () => wires.single.calls.any((c) => c.startsWith('ready')),
    );
    return (conn, link, wires.single);
  }

  TerminalBinaryFrame input(String text) => TerminalBinaryFrame(
    kind: TerminalBinaryKind.input,
    streamId: streamId,
    seq: 1,
    bytes: utf8Bytes(text),
    compressed: false,
  );

  test(
    'the wire hears the ack before the hello, and the session once it is up',
    () async {
      final (_, _, wire) = await connected();
      expect(wire.calls.take(2), ['ack', 'ready:1']);
      expect(wire.ack!['p2p'], {'enabled': true});
    },
  );

  test('its own signaling goes to it, sealed on the way, and never reaches the app', () async {
    final (_, link, wire) = await connected();
    link.send(
      link.machine!.target('p2p_answer', {'sessionId': 's1', 'sdp': 'v=0'}),
    );
    link.send({
      'type': 'node_status',
      'payload': {'online': true},
    });
    expect(await eventually(() => events.isNotEmpty), isTrue);
    expect(wire.calls, contains('inbound:p2p_answer:s1'));
    expect(events.map((e) => e['type']), ['node_status']);
    // And it sees every other frame, after the app has.
    expect(wire.calls.last, 'saw:node_status');
  });

  test('it sees terminal bytes before the app does', () async {
    final (_, link, wire) = await connected();
    link.sendBytes(link.machine!.terminal('out'));
    expect(await eventually(() => binaries.isNotEmpty), isTrue);
    expect(wire.calls, contains('saw-binary:output'));
  });

  test(
    'an open it is ready for rides it; one it is not rides the socket',
    () async {
      final (conn, link, wire) = await connected();
      wire.openHere = true;
      wire.takeJson = true;
      expect(
        await conn.sendTerminalFrame('terminal_open', {
          'requestId': 'r1',
          'cols': 80,
        }),
        isTrue,
      );
      expect(
        wire.calls,
        containsAllInOrder(['prepare:r1', 'json:terminal_open:true:null']),
      );
      // Sealed before it was offered: the counter was taken in send order either way.
      final offered = jsonDecode(wire.sealedJson.last) as Map<String, dynamic>;
      expect(link.machine!.openDown(offered)!['cols'], 80);

      wire.openHere = false;
      wire.takeJson = false;
      expect(
        await conn.sendTerminalFrame('terminal_open', {'requestId': 'r2'}),
        isTrue,
      );
      expect(
        await eventually(
          () => link.frames.any((f) => f['type'] == 'terminal_open'),
        ),
        isTrue,
      );
      expect(link.opened('terminal_open').single['requestId'], 'r2');
    },
  );

  test(
    'binary it takes stays off the socket; binary it declines goes on it',
    () async {
      final (conn, link, wire) = await connected();
      wire.takeBinary = true;
      expect(
        await conn.sendTerminalBinary(encodeTerminalLocal(input('a'))!),
        isTrue,
      );
      wire.takeBinary = false;
      expect(
        await conn.sendTerminalBinary(encodeTerminalLocal(input('b'))!),
        isTrue,
      );
      expect(await eventually(() => link.binary.isNotEmpty), isTrue);
      expect(link.binary, hasLength(1));
      final opened = openTerminalBinary(
        link.machine!.terminalC2s,
        link.binary.single,
      )!;
      expect(utf8.decode(opened.frame.bytes), 'b');
      expect(
        opened.counter,
        1,
        reason: 'the frame the wire took spent counter 0',
      );
    },
  );

  group('what the wire can ask of the connection', () {
    test('send, routed or forced', () async {
      final (_, link, wire) = await connected();
      expect(
        await wire.host.send({
          'type': 'p2p_offer',
          'payload': {'sdp': 'x'},
        }),
        isTrue,
      );
      expect(
        await wire.host.send({
          'type': 'terminal_resync',
          'payload': {'streamId': streamId},
        }, force: TransportVia.plugin),
        isTrue,
      );
      expect(
        await wire.host.send({
          'type': 'p2p_result',
          'payload': <String, dynamic>{},
        }, force: TransportVia.ws),
        isTrue,
      );
      expect(
        await eventually(
          () => link.frames.any((f) => f['type'] == 'p2p_result'),
        ),
        isTrue,
      );
      expect(link.opened('p2p_offer').single['sdp'], 'x');
      expect(wire.calls, contains('json:terminal_resync:false:plugin'));
      expect(link.frames.any((f) => f['type'] == 'terminal_resync'), isFalse);
    });

    test(
      'dispatch and deliver land as if they came over the socket, in order',
      () async {
        final (_, _, wire) = await connected();
        final order = <String>[];
        wire.host.enqueueInbound(() async {
          await Future<void>.delayed(const Duration(milliseconds: 20));
          order.add('first');
        });
        wire.host.enqueueInbound(() async => order.add('second'));
        wire.host.enqueueInbound(() async => throw StateError('a bad frame'));
        wire.host.enqueueInbound(() async => order.add('after a failure'));
        await wire.host.dispatch({'type': 'terminal_ready', 'payload': null});
        await wire.host.deliverBinary(encodeTerminalLocal(input('x'))!);
        expect(await eventually(() => order.length == 3), isTrue);
        expect(order, ['first', 'second', 'after a failure']);
        expect(events.single['type'], 'terminal_ready');
        expect(events.single['payload'], isEmpty);
        expect(binaries, hasLength(1));
      },
    );

    test('the session it rides on, until the connection closes', () async {
      final (conn, _, wire) = await connected();
      expect(wire.host.codec.terminalP2pVersion, 1);
      await conn.close();
      expect(wire.disposed, isTrue);
      expect(() => wire.host.codec, throwsStateError);
      expect(
        await wire.host.send({
          'type': 'p2p_abort',
          'payload': <String, dynamic>{},
        }),
        isFalse,
      );
    });
  });

  test('every dial gets a wire of its own; the old one is torn down', () async {
    final (conn, link, first) = await connected();
    final next = relay.nextSession();
    await link.close();
    expect(await eventually(() => first.disposed), isTrue);
    conn.reconnectNow();
    await next.timeout(const Duration(seconds: 3));
    await conn.waitUntilReady(timeout: const Duration(seconds: 3));
    expect(wires, hasLength(2));
    expect(wires.last.disposed, isFalse);
  });

  test(
    'a machine that refuses the phone takes its wire down with it',
    () async {
      relay.deny = true;
      final conn = newConn();
      await conn.connect();
      expect(await eventually(() => conn.isClosed), isTrue);
      expect(wires.single.disposed, isTrue);
    },
  );

  group('edges of the dial', () {
    test(
      'a dial closed while its handshake was in the air leaves nothing behind',
      () async {
        relay.holdUpgrade = Completer<void>();
        final conn = newConn();
        final reached = relay.dialled.stream.first;
        final dialling = conn.connect();
        await reached;
        // Closed mid-handshake; the close itself finishes once the socket has an answer.
        final closing = conn.close();
        relay.holdUpgrade!.complete();
        await closing;
        await dialling;
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(conn.isReady, isFalse);
        expect(conn.isClosed, isTrue);
      },
    );

    test(
      'a readiness wait fails when the socket drops before the session',
      () async {
        relay.silentOnSelect = true;
        final conn = newConn();
        final link = relay.nextLink();
        unawaited(conn.connect());
        final waiting = conn.waitUntilReady(
          timeout: const Duration(seconds: 5),
        );
        await (await link).close();
        await expectLater(waiting, throwsStateError);
      },
    );

    test('a request that timed out before the session never goes', () async {
      final conn = newConn();
      await expectLater(
        conn.request('agents_list', timeout: const Duration(milliseconds: 20)),
        throwsA(isA<WsRequestTimeout>()),
      );
      final session = relay.nextSession();
      unawaited(conn.connect());
      final link = await session;
      await conn.waitUntilReady(timeout: const Duration(seconds: 3));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(link.frames.any((f) => f['type'] == 'agents_list'), isFalse);
    });

    test('a request that cannot be sent fails with why', () async {
      final (conn, _, _) = await connected();
      conn.onOutgoing = (type, payload) async =>
          throw StateError('refused locally');
      await expectLater(
        conn.request('agents_list'),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            'refused locally',
          ),
        ),
      );
    });

    // Before the welcome nothing sealed may leave: in the clear it leaks, and the machine would
    // refuse it anyway. It is dropped, not sent.
    test('a sealed frame asked for before the session is dropped', () async {
      final hello = Completer<Map<String, dynamic>?>();
      relay.onHello = (_, _) => hello.future;
      final conn = newConn();
      final link = relay.nextLink();
      unawaited(conn.connect());
      final socket = await link;
      await eventually(
        () => socket.frames.any((f) => f['type'] == 'e2e_hello'),
      );
      conn.sendRaw('agents_list', {'requestId': 'x'});
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(socket.frames.any((f) => f['type'] == 'agents_list'), isFalse);
      hello.complete(null);
    });
  });
}
