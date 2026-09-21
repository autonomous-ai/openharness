import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';

import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/ws/relay_codec.dart';
import 'package:harness_mobile/ws/terminal_transport_plugin.dart';
import 'package:harness_mobile/p2p/terminal_p2p_link.dart';
import 'package:harness_mobile/p2p/terminal_p2p_plugin.dart';
import 'package:harness_mobile/p2p/terminal_p2p_policy.dart';

const streamA = '11111111-1111-4111-8111-111111111111';
const streamB = '22222222-2222-4222-8222-222222222222';

const enabledPolicy = {
  'enabled': true,
  'protocolVersion': 1,
  'stunUrls': ['stun:stun.example:3478'],
  'openWaitMs': 1500,
};

/// A scripted data channel: the test opens, fails or drops it, and sees every
/// frame the plugin put on it.
class FakeTerminalP2pLink implements TerminalP2pLink {
  FakeTerminalP2pLink({
    required this.policy,
    required this.sendSignal,
    required this.onData,
    this.onState,
    this.onUnavailable,
    this.upgrade = false,
    required this.sessionId,
  });

  final TerminalP2pPolicy policy;
  final TerminalP2pSignalSink sendSignal;
  final TerminalP2pDataSink onData;
  final TerminalP2pStateSink? onState;
  final void Function(String reason)? onUnavailable;
  final bool upgrade;

  @override
  final String sessionId;

  bool started = false;
  bool ready = false;
  bool acceptSends = true;
  bool stopped = false;
  String? stopReason;
  bool? stopNotifiedPeer;
  TerminalP2pTransport? _transport;
  final sent = <Object>[];
  final signals = <(String, Map<String, dynamic>)>[];
  final _waiters = <Completer<bool>>[];

  @override
  bool get isReady => ready && acceptSends;

  @override
  TerminalP2pTransport? get transport => ready ? _transport : null;

  @override
  void start() {
    started = true;
    onState?.call(TerminalP2pLinkState.connecting, Duration.zero, null);
  }

  void open({TerminalP2pTransport transport = TerminalP2pTransport.direct}) {
    ready = true;
    _transport = transport;
    for (final waiter in _waiters.toList()) {
      if (!waiter.isCompleted) waiter.complete(true);
    }
    _waiters.clear();
    onState?.call(
      TerminalP2pLinkState.open,
      const Duration(milliseconds: 420),
      null,
    );
  }

  /// Never reached open.
  void failNegotiation(String reason) {
    onState?.call(
      TerminalP2pLinkState.failed,
      const Duration(seconds: 25),
      reason,
    );
    unawaited(stop(reason: reason));
  }

  /// Was open, and then the wire went away.
  void drop(String reason) {
    final wasReady = ready;
    ready = false;
    onState?.call(
      TerminalP2pLinkState.failed,
      const Duration(seconds: 90),
      reason,
    );
    if (wasReady) onUnavailable?.call(reason);
    unawaited(stop(reason: reason));
  }

  /// Something arrived over the channel.
  void receive(Object data) => onData(data);

  @override
  Future<bool> handleSignal(String type, Map<String, dynamic> payload) async {
    if (!terminalP2pSignalTypes.contains(type)) return false;
    signals.add((type, payload));
    return true;
  }

  @override
  bool send(Object data) {
    if (!isReady) return false;
    sent.add(data);
    return true;
  }

  @override
  Future<bool> sendWithBackpressureRetry(
    Object data, {
    Duration drain = const Duration(seconds: 5),
  }) async => send(data);

  @override
  Future<bool> waitUntilReady(Duration timeout) {
    if (isReady) return Future.value(true);
    if (stopped || timeout <= Duration.zero) return Future.value(false);
    final waiter = Completer<bool>();
    _waiters.add(waiter);
    Timer(timeout, () {
      _waiters.remove(waiter);
      if (!waiter.isCompleted) waiter.complete(false);
    });
    return waiter.future;
  }

  @override
  Future<void> stop({String reason = 'closed', bool notifyPeer = true}) async {
    if (stopped) return;
    stopped = true;
    ready = false;
    stopReason = reason;
    stopNotifiedPeer = notifyPeer;
    for (final waiter in _waiters.toList()) {
      if (!waiter.isCompleted) waiter.complete(false);
    }
    _waiters.clear();
    if (notifyPeer) {
      sendSignal('p2p_abort', {
        'sessionId': sessionId,
        'protocolVersion': 1,
        'reason': reason,
      });
    }
    onState?.call(TerminalP2pLinkState.closed, Duration.zero, reason);
  }
}

class FakeLinkFactory implements TerminalP2pLinkFactory {
  final created = <FakeTerminalP2pLink>[];

  FakeTerminalP2pLink get last => created.last;
  FakeTerminalP2pLink get first => created.first;

  @override
  TerminalP2pLink create({
    required TerminalP2pPolicy policy,
    required TerminalP2pSignalSink sendSignal,
    required TerminalP2pDataSink onData,
    TerminalP2pStateSink? onState,
    void Function(String reason)? onUnavailable,
    void Function(String step, Duration elapsed)? onStep,
    bool upgrade = false,
  }) {
    final link = FakeTerminalP2pLink(
      policy: policy,
      sendSignal: sendSignal,
      onData: onData,
      onState: onState,
      onUnavailable: onUnavailable,
      upgrade: upgrade,
      sessionId: 'session-${created.length + 1}',
    );
    created.add(link);
    return link;
  }
}

class FakeCodec implements RelayCodec {
  FakeCodec({this.terminalP2pVersion = 1});

  @override
  final int terminalP2pVersion;

  @override
  Map<String, dynamic> helloFrame() => {'type': 'e2e_hello', 'payload': {}};

  @override
  Future<bool> handleWelcome(Map<String, dynamic> payload) async => true;

  @override
  bool handleRekey(Map<String, dynamic> payload) => true;

  @override
  Map<String, dynamic>? encodeFrame(Map<String, dynamic> frame) => frame;

  @override
  Map<String, dynamic>? decodeFrame(Map<String, dynamic> frame) => frame;

  @override
  Uint8List? encodeBinary(Uint8List localFrame) => localFrame;

  @override
  Uint8List? decodeBinary(Uint8List wireFrame) => wireFrame;
}

/// The connection as the plugin sees it, with the same routing rule `WsConn`
/// applies: a frame the plugin does not take goes to the socket.
class FakeHost implements TerminalTransportHost {
  FakeHost({FakeCodec? codec}) : codec = codec ?? FakeCodec();

  @override
  final FakeCodec codec;
  late TerminalP2pPlugin plugin;

  /// Frames that reached the socket.
  final wsFrames = <Map<String, dynamic>>[];

  /// Every frame the plugin asked the host to send, with its forced wire.
  final sends = <(Map<String, dynamic>, TransportVia?)>[];
  final dispatched = <Map<String, dynamic>>[];
  final delivered = <Uint8List>[];
  Future<void> _inbound = Future.value();

  @override
  Future<bool> send(Map<String, dynamic> frame, {TransportVia? force}) async {
    sends.add((frame, force));
    // `WsConn` queues this behind whatever the outbound FIFO is sending right now.
    await Future<void>.microtask(() {});
    final type = frame['type'] as String;
    final payload = (frame['payload'] as Map<String, dynamic>?) ?? {};
    final taken = plugin.sendJson(
      type,
      payload,
      jsonEncode(frame),
      openViaPlugin: false,
      force: force,
    );
    // Diagnostics ride the socket too, but no test is about where they went.
    if (!taken && type != 'p2p_result') wsFrames.add(frame);
    return true;
  }

  /// What `WsConn` does for a terminal frame from the app: ask before an open,
  /// then offer the sealed frame inside the FIFO.
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    var openViaPlugin = false;
    if (type == 'terminal_open' && payload['requestId'] is String) {
      openViaPlugin = await plugin.prepareOpen(payload['requestId'] as String);
    }
    final frame = {'type': type, 'payload': payload};
    final taken = plugin.sendJson(
      type,
      payload,
      jsonEncode(frame),
      openViaPlugin: openViaPlugin,
    );
    if (!taken) wsFrames.add(frame);
    return true;
  }

  Future<bool> sendTerminalBinary(Uint8List local) async {
    final taken = await plugin.sendBinary(local, local);
    if (!taken) wsBinary.add(local);
    return true;
  }

  final wsBinary = <Uint8List>[];

  @override
  void enqueueInbound(Future<void> Function() task) {
    _inbound = _inbound.then((_) => task());
  }

  Future<void> get inboundIdle => _inbound;

  @override
  Future<void> dispatch(Map<String, dynamic> plain) async =>
      dispatched.add(plain);

  @override
  Future<void> deliverBinary(Uint8List localFrame) async =>
      delivered.add(localFrame);

  /// A frame arrived over the socket: dispatched to the app, then observed.
  Future<void> receiveWs(Map<String, dynamic> plain) async {
    dispatched.add(plain);
    await plugin.observeWsFrame(plain);
  }

  Future<void> receiveWsBinary(Uint8List local) async {
    await plugin.observeWsBinary(local);
    delivered.add(local);
  }

  Iterable<String> get dispatchedTypes =>
      dispatched.map((f) => f['type'] as String);
  Iterable<String> get wsTypes => wsFrames.map((f) => f['type'] as String);
}

Uint8List htrl(TerminalBinaryKind kind, String streamId, {int seq = 1}) =>
    encodeTerminalLocal(
      TerminalBinaryFrame(
        kind: kind,
        streamId: streamId,
        seq: seq,
        bytes: kind == TerminalBinaryKind.sync
            ? Uint8List(0)
            : Uint8List.fromList([1, 2, 3]),
        compressed: false,
        cols: kind == TerminalBinaryKind.keyframe ? 80 : null,
        rows: kind == TerminalBinaryKind.keyframe ? 24 : null,
      ),
    )!;

Map<String, dynamic> linkMode(String streamId, String mode) => {
  'type': 'terminal_link_mode',
  'payload': {'streamId': streamId, 'mode': mode},
};

/// A plugin with its host and link factory, session already up on the given policy.
///
/// Under [async], the plugin's clock is the fake one — `DateTime.now()` is not
/// faked on its own, and the retry budget and migration sweep read the clock.
({TerminalP2pPlugin plugin, FakeHost host, FakeLinkFactory links}) bootPlugin({
  Map<String, dynamic>? policy = enabledPolicy,
  int peerVersion = 1,
  FakeAsync? async,
}) {
  final host = FakeHost(codec: FakeCodec(terminalP2pVersion: peerVersion));
  final links = FakeLinkFactory();
  final epoch = DateTime(2026, 9, 14);
  final plugin = TerminalP2pPlugin(
    host: host,
    machineId: 'machine-1234567890',
    links: links,
    now: async == null ? null : () => async.getClock(epoch).now(),
  );
  host.plugin = plugin;
  plugin.onConnectedAck({'machineId': 'machine-1234567890', 'p2p': policy});
  plugin.onSessionReady();
  return (plugin: plugin, host: host, links: links);
}
