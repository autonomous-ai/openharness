import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// `flutter_webrtc`'s native side, played by the test over its own platform channels: the
/// method calls the plugin makes are recorded and answered, and the events a real peer
/// connection and data channel would raise are pushed in by hand. No native code, and no
/// network — nothing here ever gathers a candidate or opens a socket.
class FakeWebRtc {
  FakeWebRtc() {
    _messenger.setMockMethodCallHandler(_method, _onCall);
    for (final name in _eventChannels) {
      _messenger.setMockMethodCallHandler(
        MethodChannel(name),
        (_) async => null,
      );
    }
  }

  static const _method = MethodChannel('FlutterWebRTC.Method');
  static const peerConnectionId = 'pc1';

  /// Channels get `dc1`, `dc2`, … in the order they are created: `terminal-v1` is `dc1`, and
  /// `viewer-v1`, when the link opens one, `dc2`.
  static const dataChannelId = 'dc1';
  static const viewerChannelId = 'dc2';
  static const _pcEvents = 'FlutterWebRTC/peerConnectionEvent$peerConnectionId';
  static String _dcEvents(String id) =>
      'FlutterWebRTC/dataChannelEvent$peerConnectionId$id';
  static final _eventChannels = [
    'FlutterWebRTC.Event',
    _pcEvents,
    _dcEvents(dataChannelId),
    _dcEvents(viewerChannelId),
  ];
  int _channels = 0;

  TestDefaultBinaryMessenger get _messenger =>
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  /// Every method call, in order.
  final calls = <MethodCall>[];

  /// The offer's SDP as libwebrtc "created" it, before the plugin munges it.
  String offerSdp =
      'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
      'a=sctp-port:5000\r\n'
      'a=candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host\r\n';

  /// What `getLocalDescription` answers; null answers what was set.
  String? localSdp;

  /// Methods that fail with a PlatformException, by name.
  final failing = <String>{};

  /// What `getStats` reports.
  List<Map<String, Object?>> stats = [];

  int bufferedAmount = 0;
  String? _setLocal;

  Iterable<MethodCall> named(String method) =>
      calls.where((c) => c.method == method);

  Future<Object?> _onCall(MethodCall call) async {
    calls.add(call);
    if (failing.contains(call.method)) {
      throw PlatformException(code: 'fake', message: '${call.method} failed');
    }
    final args = call.arguments is Map ? call.arguments as Map : const {};
    switch (call.method) {
      case 'createPeerConnection':
        return {'peerConnectionId': peerConnectionId};
      case 'createDataChannel':
        _channels++;
        return {'id': _channels, 'flutterId': 'dc$_channels'};
      case 'createOffer':
        return {'sdp': offerSdp, 'type': 'offer'};
      case 'setLocalDescription':
        _setLocal = (args['description'] as Map)['sdp'] as String;
        return null;
      case 'getLocalDescription':
        return {'sdp': localSdp ?? _setLocal ?? offerSdp, 'type': 'offer'};
      case 'getStats':
        return {'stats': stats};
      case 'dataChannelGetBufferedAmount':
        return {'bufferedAmount': bufferedAmount};
      default:
        return null;
    }
  }

  Future<void> _event(String channel, Map<String, Object?> event) =>
      _messenger.handlePlatformMessage(
        channel,
        const StandardMethodCodec().encodeSuccessEnvelope(event),
        (_) {},
      );

  Future<void> iceGathering(String state) =>
      _event(_pcEvents, {'event': 'iceGatheringState', 'state': state});

  Future<void> candidate(String line, {String mid = '0', int index = 0}) =>
      _event(_pcEvents, {
        'event': 'onCandidate',
        'candidate': {'candidate': line, 'sdpMid': mid, 'sdpMLineIndex': index},
      });

  Future<void> connection(String state) =>
      _event(_pcEvents, {'event': 'peerConnectionState', 'state': state});

  Future<void> channelState(String state, {String channel = dataChannelId}) =>
      _event(_dcEvents(channel), {
        'event': 'dataChannelStateChanged',
        'id': int.parse(channel.substring(2)),
        'state': state,
      });

  Future<void> message(Object data, {String channel = dataChannelId}) =>
      _event(_dcEvents(channel), {
        'event': 'dataChannelReceiveMessage',
        'id': int.parse(channel.substring(2)),
        'type': data is String ? 'text' : 'binary',
        'data': data is String ? data : Uint8List.fromList(data as List<int>),
      });

  Future<void> buffered(int amount, {String channel = dataChannelId}) =>
      _event(_dcEvents(channel), {
        'event': 'dataChannelBufferedAmountChange',
        'bufferedAmount': amount,
        'changedAmount': 0,
      });

  void dispose() {
    _messenger.setMockMethodCallHandler(_method, null);
    for (final name in _eventChannels) {
      _messenger.setMockMethodCallHandler(MethodChannel(name), null);
    }
  }
}

/// Stats in the shape libwebrtc reports: a transport naming its selected pair, the pair, and
/// the two candidates it joins.
List<Map<String, Object?>> statsFor({
  required String local,
  required String remote,
  bool viaTransport = true,
}) => [
  if (viaTransport)
    {
      'id': 'T01',
      'type': 'transport',
      'timestamp': 1.0,
      'values': {'selectedCandidatePairId': 'CP1'},
    },
  {
    'id': 'CP1',
    'type': 'candidate-pair',
    'timestamp': 1.0,
    'values': {
      'nominated': true,
      'state': 'succeeded',
      'localCandidateId': 'L1',
      'remoteCandidateId': 'R1',
    },
  },
  {
    'id': 'L1',
    'type': 'local-candidate',
    'timestamp': 1.0,
    'values': {'candidateType': local},
  },
  {
    'id': 'R1',
    'type': 'remote-candidate',
    'timestamp': 1.0,
    'values': {'candidateType': remote},
  },
];

/// Lets the platform-channel round trips and the timers they arm run.
Future<void> settle([Duration wait = Duration.zero]) async {
  for (var i = 0; i < 20; i++) {
    await Future<void>.delayed(Duration.zero);
  }
  if (wait > Duration.zero) await Future<void>.delayed(wait);
  for (var i = 0; i < 20; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

/// Completes when [check] holds, polling.
Future<bool> eventually(
  bool Function() check, {
  Duration within = const Duration(seconds: 3),
}) async {
  final deadline = DateTime.now().add(within);
  while (DateTime.now().isBefore(deadline)) {
    if (check()) return true;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  return check();
}

typedef Signal = (String type, Map<String, dynamic> payload);

/// Signals and state changes a link reports, collected.
class LinkLog {
  final signals = <Signal>[];
  final states = <String>[];
  final data = <Object>[];
  final viewerData = <Object>[];
  final viewerStates = <bool>[];
  final unavailable = <String>[];
  final steps = <String>[];
  final _opened = Completer<void>();

  Future<void> get opened => _opened.future;

  void signal(String type, Map<String, dynamic> payload) =>
      signals.add((type, payload));

  void state(Object state, Duration setup, String? reason) {
    final name = state.toString().split('.').last;
    states.add(reason == null ? name : '$name:$reason');
    if (name == 'open' && !_opened.isCompleted) _opened.complete();
  }

  Iterable<Map<String, dynamic>> of(String type) =>
      signals.where((s) => s.$1 == type).map((s) => s.$2);
}
