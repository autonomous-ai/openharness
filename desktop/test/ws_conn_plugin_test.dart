import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/ws/relay_codec.dart';
import 'package:harness/ws/terminal_transport_plugin.dart';
import 'package:harness/ws/ws_conn.dart';

/// A relay session that seals nothing — the handshake shape of the real one, with
/// the frames left readable so the test can see what crossed the socket.
class _PassThroughCodec implements RelayCodec {
  bool welcomed = false;

  @override
  Map<String, dynamic> helloFrame() => {'type': 'e2e_hello', 'payload': {}};

  @override
  Future<bool> handleWelcome(Map<String, dynamic> payload) async {
    welcomed = true;
    return true;
  }

  @override
  bool handleRekey(Map<String, dynamic> payload) => true;

  @override
  int get terminalP2pVersion => 1;

  @override
  Map<String, dynamic>? encodeFrame(Map<String, dynamic> frame) => frame;

  @override
  Map<String, dynamic>? decodeFrame(Map<String, dynamic> frame) => frame;

  @override
  Uint8List? encodeBinary(Uint8List localFrame) => localFrame;

  @override
  Uint8List? decodeBinary(Uint8List wireFrame) => wireFrame;
}

class _RecordingPlugin implements TerminalTransportPlugin {
  _RecordingPlugin(this.host);
  final TerminalTransportHost host;
  final calls = <String>[];
  final sentJson = <Map<String, dynamic>>[];
  bool takeJson = false;
  bool takeBinary = false;
  bool openReady = true;
  bool disposed = false;

  @override
  void onConnectedAck(Map<String, dynamic> payload) =>
      calls.add('ack:${(payload['p2p'] as Map?)?['enabled']}');

  @override
  void onSessionReady() => calls.add('ready');

  @override
  bool consumesInbound(String type) => type.startsWith('p2p_');

  @override
  Future<void> handleInbound(String type, Map<String, dynamic> payload) async =>
      calls.add('inbound:$type');

  @override
  Future<void> observeWsFrame(Map<String, dynamic> plain) async =>
      calls.add('observe:${plain['type']}');

  @override
  Future<void> observeWsBinary(Uint8List localFrame) async =>
      calls.add('observeBinary:${localFrame.length}');

  @override
  Future<bool> prepareOpen(String requestId) async {
    calls.add('prepareOpen:$requestId');
    return openReady;
  }

  @override
  bool sendJson(
    String type,
    Map<String, dynamic> payload,
    String sealedJson, {
    required bool openViaPlugin,
    TransportVia? force,
  }) {
    sentJson.add({
      'type': type,
      'openViaPlugin': openViaPlugin,
      'force': force?.name,
    });
    return takeJson;
  }

  @override
  Future<bool> sendBinary(Uint8List localFrame, Uint8List sealedFrame) async {
    calls.add('sendBinary:${localFrame.length}');
    return takeBinary;
  }

  @override
  void dispose({bool notifyPeer = false}) {
    disposed = true;
    calls.add('dispose');
  }
}

Future<void> _settle() =>
    Future<void>.delayed(const Duration(milliseconds: 40));

void main() {
  late HttpServer server;
  late Completer<WebSocket> socketReady;
  late List<Map<String, dynamic>> received;
  late List<List<int>> receivedBinary;

  setUp(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    socketReady = Completer<WebSocket>();
    received = [];
    receivedBinary = [];
    unawaited(
      server.forEach((request) async {
        final socket = await WebSocketTransformer.upgrade(request);
        if (!socketReady.isCompleted) socketReady.complete(socket);
        socket.listen((raw) {
          if (raw is List<int>) {
            receivedBinary.add(raw);
            return;
          }
          final frame = jsonDecode(raw as String) as Map<String, dynamic>;
          received.add(frame);
          if (frame['type'] == 'machine_select') {
            socket.add(
              jsonEncode({
                'type': 'connected',
                'payload': {
                  'machineId': 'machine-1',
                  'p2p': {'enabled': true, 'protocolVersion': 1},
                },
              }),
            );
          }
          if (frame['type'] == 'e2e_hello') {
            socket.add(jsonEncode({'type': 'e2e_welcome', 'payload': {}}));
          }
        });
      }),
    );
  });

  tearDown(() async {
    await server.close(force: true);
  });

  Future<(WsConn, _RecordingPlugin, List<Map<String, dynamic>>, List<int>)>
  connect() async {
    final connected = Completer<void>();
    final events = <Map<String, dynamic>>[];
    final binaries = <int>[];
    late _RecordingPlugin plugin;
    final conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${server.port}',
      autonomousEnv: 'prod',
      machineId: 'machine-1',
      accessTokenProvider: (_, _) async => 'test-token',
      onAuthFailure: (_) {},
      relayCodecs: (_) async => _PassThroughCodec(),
      transportPlugins: (host, machineId) {
        expect(machineId, 'machine-1');
        return plugin = _RecordingPlugin(host);
      },
      onStatus: (status) {
        if (status == ConnectionStatus.connected && !connected.isCompleted) {
          connected.complete();
        }
      },
      onEvent: (event) => events.add(event),
    );
    conn.onBinaryFrame = (frame) async => binaries.add(frame.length);
    await conn.connect();
    await connected.future.timeout(const Duration(seconds: 2));
    await _settle();
    return (conn, plugin, events, binaries);
  }

  test(
    'policy ack precedes the hello, readiness follows the welcome',
    () async {
      final (conn, plugin, _, _) = await connect();
      expect(plugin.calls, ['ack:true', 'ready']);
      final helloAt = received.indexWhere((f) => f['type'] == 'e2e_hello');
      expect(helloAt, greaterThan(0));
      await conn.close();
    },
  );

  test('signaling goes to the plugin and never to onEvent', () async {
    final (conn, plugin, events, _) = await connect();
    final socket = await socketReady.future;
    socket.add(
      jsonEncode({
        'type': 'p2p_answer',
        'payload': {'sessionId': 's'},
      }),
    );
    socket.add(
      jsonEncode({
        'type': 'terminal_ready',
        'payload': {'streamId': 'st', 'requestId': 'r'},
      }),
    );
    await _settle();
    expect(events.map((e) => e['type']), ['terminal_ready']);
    expect(plugin.calls.skip(2), [
      'inbound:p2p_answer',
      'observe:terminal_ready',
    ]);
    await conn.close();
  });

  test(
    'terminal_open asks the plugin first and the answer rides the FIFO',
    () async {
      final (conn, plugin, _, _) = await connect();
      plugin.takeJson = true;
      expect(
        await conn.sendTerminalFrame('terminal_open', {'requestId': 'dsk_1'}),
        isTrue,
      );
      plugin.openReady = false;
      expect(
        await conn.sendTerminalFrame('terminal_open', {'requestId': 'dsk_2'}),
        isTrue,
      );
      await _settle();
      expect(plugin.calls.where((c) => c.startsWith('prepareOpen')), [
        'prepareOpen:dsk_1',
        'prepareOpen:dsk_2',
      ]);
      expect(plugin.sentJson.map((s) => s['openViaPlugin']), [true, false]);
      // The plugin took both: the socket saw neither.
      expect(received.where((f) => f['type'] == 'terminal_open'), isEmpty);

      plugin.takeJson = false;
      await conn.sendTerminalFrame('terminal_alive', {'streamId': 'st'});
      await _settle();
      expect(
        received.where((f) => f['type'] == 'terminal_alive'),
        hasLength(1),
      );
      await conn.close();
    },
  );

  test('the host sends on a forced wire through the same FIFO', () async {
    final (conn, plugin, _, _) = await connect();
    expect(
      await plugin.host.send({
        'type': 'terminal_resync',
        'payload': {'streamId': 'st'},
      }, force: TransportVia.ws),
      isTrue,
    );
    await _settle();
    expect(plugin.sentJson.single['force'], 'ws');
    expect(received.where((f) => f['type'] == 'terminal_resync'), hasLength(1));
    await conn.close();
  });

  test(
    'binary is offered to the plugin outbound and observed inbound first',
    () async {
      final (conn, plugin, _, binaries) = await connect();
      plugin.takeBinary = true;
      expect(await conn.sendTerminalBinary(Uint8List(5)), isTrue);
      await _settle();
      expect(receivedBinary, isEmpty);
      plugin.takeBinary = false;
      expect(await conn.sendTerminalBinary(Uint8List(6)), isTrue);
      await _settle();
      expect(receivedBinary.single.length, 6);

      final socket = await socketReady.future;
      socket.add(Uint8List(7));
      await _settle();
      expect(binaries, [7]);
      expect(plugin.calls.last, 'observeBinary:7');
      await conn.close();
    },
  );

  test(
    'the host delivers plugin traffic as if it were the socket\'s',
    () async {
      final (conn, plugin, events, binaries) = await connect();
      await plugin.host.dispatch({
        'type': 'terminal_link_mode',
        'payload': {'streamId': 'st', 'mode': 'p2p'},
      });
      await plugin.host.deliverBinary(Uint8List(3));
      expect(events.single['type'], 'terminal_link_mode');
      expect(binaries, [3]);
      await conn.close();
    },
  );

  test('closing disposes the plugin', () async {
    final (conn, plugin, _, _) = await connect();
    await conn.close();
    expect(plugin.disposed, isTrue);
  });
}
