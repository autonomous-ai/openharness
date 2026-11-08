import 'dart:async';
import 'dart:js_interop';

import 'package:harness/logging/app_log.dart';
import 'package:web/web.dart';

import 'browser_rtc_stats.dart';
import 'p2p_sdp.dart';
import 'terminal_p2p_link.dart';
import 'terminal_p2p_policy.dart';

/// Diagnostic only, as on the phone: `--dart-define=HARNESS_P2P_FORCE_RELAY=true`
/// drops host and srflx so nothing but a TURN allocation can be nominated. An
/// upgrade trial is left alone, which is how the cutover gets exercised at all.
const kForceP2pRelay = bool.fromEnvironment('HARNESS_P2P_FORCE_RELAY');

/// The browser reports `complete` only once every server answered or timed out
/// — with a dozen STUN/TURN urls, routinely the whole budget. The offer goes
/// out once a server-reflexive (or relay) candidate is in plus a moment for the
/// other interfaces, and at the cap regardless; the rest trickles.
const _gatherCap = Duration(seconds: 3);
const _gatherSettleAfterReflexive = Duration(milliseconds: 500);

class BrowserTerminalP2pLinkFactory implements TerminalP2pLinkFactory {
  const BrowserTerminalP2pLinkFactory();

  @override
  TerminalP2pLink create({
    required TerminalP2pPolicy policy,
    required TerminalP2pSignalSink sendSignal,
    required TerminalP2pDataSink onData,
    TerminalP2pStateSink? onState,
    void Function(String reason)? onUnavailable,
    void Function(String step, Duration elapsed)? onStep,
    bool upgrade = false,
  }) => BrowserTerminalP2pLink(
    policy: policy,
    sendSignal: sendSignal,
    onData: onData,
    onState: onState,
    onUnavailable: onUnavailable,
    onStep: onStep,
    upgrade: upgrade,
  );
}

/// The offerer side of one `terminal-v1` data channel, on the browser's own
/// `RTCPeerConnection`. The phone's `WebRtcTerminalP2pLink` with the platform
/// swapped: the same signals, timings and fallbacks, so the responder on the
/// machine (the CLI's `terminalP2p.ts`) cannot tell the two apart. Without it a
/// browser's every keystroke and every byte of output rode the relay twice —
/// out to the backend and back — even with the machine on the same network.
class BrowserTerminalP2pLink implements TerminalP2pLink {
  BrowserTerminalP2pLink({
    required this.policy,
    required this.sendSignal,
    required this.onData,
    this.onState,
    this.onUnavailable,
    this.onStep,
    this.upgrade = false,
  });

  final TerminalP2pPolicy policy;
  final bool upgrade;
  final TerminalP2pSignalSink sendSignal;
  final TerminalP2pDataSink onData;
  final TerminalP2pStateSink? onState;
  final void Function(String reason)? onUnavailable;
  final void Function(String step, Duration elapsed)? onStep;

  @override
  final String sessionId = p2pSessionId();

  final Stopwatch _clock = Stopwatch()..start();
  RTCPeerConnection? _pc;
  RTCDataChannel? _channel;
  bool _ready = false;
  bool _starting = false;
  bool _finished = false;
  bool _sawAnswer = false;
  Timer? _timeout;
  Timer? _disconnectGrace;
  TerminalP2pTransport? _transport;
  final _waiters = <Completer<bool>>[];
  Completer<void>? _gathered;
  Completer<void>? _reflexive;
  Completer<void>? _drained;

  /// Candidates not carried by the offer, held until the answer is in: the
  /// responder only adds a candidate to an entry that already has a remote
  /// description. What the offer's SDP turns out to carry is dropped again.
  final _lateCandidates = <RTCIceCandidate>[];
  String _offeredSdp = '';

  Duration get _elapsed => _clock.elapsed;

  void _step(String label) => onStep?.call(label, _elapsed);

  @override
  bool get isReady => _ready && _channelCanSend;

  bool get _channelCanSend {
    final channel = _channel;
    return channel != null &&
        channel.readyState == 'open' &&
        channel.bufferedAmount < terminalP2pMaxBufferedBytes;
  }

  @override
  TerminalP2pTransport? get transport => _ready ? _transport : null;

  @override
  void start() {
    if (_starting || _pc != null || _finished) return;
    _starting = true;
    _timeout = Timer(
      terminalP2pNegotiationTimeout,
      () => _fail('negotiation_timeout'),
    );
    onState?.call(TerminalP2pLinkState.connecting, Duration.zero, null);
    unawaited(_begin());
  }

  Future<void> _begin() async {
    try {
      final pc = RTCPeerConnection(_configuration());
      if (_finished) {
        pc.close();
        return;
      }
      _pc = pc;
      _gathered = Completer<void>();
      _reflexive = Completer<void>();
      _wirePeer(pc);
      final channel = pc.createDataChannel(
        terminalP2pChannel,
        RTCDataChannelInit(ordered: true),
      )..binaryType = 'arraybuffer';
      _channel = channel;
      _wireChannel(channel);
      await _createOffer(pc);
    } catch (error) {
      appLog.warn('p2p', 'peer connection setup failed', error: error);
      _fail('offer_failed');
    }
  }

  RTCConfiguration _configuration() {
    final turn = policy.turn;
    final servers = <RTCIceServer>[
      if (policy.stunUrls.isNotEmpty) RTCIceServer(urls: _urls(policy.stunUrls)),
      if (turn != null)
        RTCIceServer(
          urls: _urls(turn.urls),
          username: turn.username,
          credential: turn.credential,
        ),
    ].toJS;
    // 'all' unless forced, as the CLI does: host and srflx pairs win by
    // priority, and a TURN pair is nominated only once every direct one failed.
    return kForceP2pRelay && !upgrade
        ? RTCConfiguration(iceServers: servers, iceTransportPolicy: 'relay')
        : RTCConfiguration(iceServers: servers);
  }

  static JSArray<JSString> _urls(List<String> urls) =>
      [for (final url in urls) url.toJS].toJS;

  Future<void> _createOffer(RTCPeerConnection pc) async {
    final offer = await pc.createOffer().toDart;
    await pc
        .setLocalDescription(
          RTCLocalSessionDescriptionInit(
            type: 'offer',
            sdp: raiseMaxMessageSize(offer?.sdp ?? ''),
          ),
        )
        .toDart;
    if (_pc != pc || _finished) return;
    _step('offer-created');
    // Gather-then-signal, like the CLI, but not to completion: the answer
    // needs nothing more than what is in the SDP.
    final how = await Future.any<String>([
      _gathered!.future.then((_) => 'gathered'),
      _reflexive!.future
          .then((_) => Future<void>.delayed(_gatherSettleAfterReflexive))
          .then((_) => 'gathered-enough'),
    ]).timeout(_gatherCap, onTimeout: () => 'gather-capped');
    if (_pc != pc || _finished) return;
    _step(how);
    final sdp = pc.localDescription?.sdp;
    if (sdp == null || sdp.isEmpty) {
      throw StateError('local_description_missing');
    }
    _offeredSdp = sdp;
    _lateCandidates.removeWhere((c) => sdp.contains(c.candidate));
    sendSignal('p2p_offer', {
      'sessionId': sessionId,
      'protocolVersion': terminalP2pProtocolVersion,
      'sdp': sdp,
      // The RAW policy list: the responder runs its own gather against it.
      'stunUrls': policy.stunUrls,
      if (policy.turn != null) 'turn': policy.turn!.toJson(),
      if (upgrade) 'upgrade': true,
    });
    _step('offer-sent');
  }

  @override
  Future<bool> handleSignal(String type, Map<String, dynamic> payload) async {
    if (!terminalP2pSignalTypes.contains(type)) return false;
    if (payload['sessionId'] != sessionId ||
        payload['protocolVersion'] != terminalP2pProtocolVersion ||
        _finished) {
      return true;
    }
    final pc = _pc;
    if (pc == null) return true;
    try {
      switch (type) {
        case 'p2p_answer':
          final sdp = payload['sdp'];
          if (sdp is! String) return true;
          _sawAnswer = true;
          _step('answer-in');
          await pc
              .setRemoteDescription(
                RTCSessionDescriptionInit(type: 'answer', sdp: sdp),
              )
              .toDart;
          _flushLateCandidates();
        case 'p2p_ice_candidate':
          await _addCandidate(pc, payload['candidate']);
        case 'p2p_abort':
          final reason = payload['reason'];
          // The peer's word for it, bounded before it reaches a log line.
          _fail(
            reason is String && reason.isNotEmpty
                ? (reason.length > 64 ? reason.substring(0, 64) : reason)
                : 'peer_aborted',
          );
      }
    } catch (error) {
      appLog.warn('p2p', 'signal $type failed', error: error);
      _fail('signal_invalid');
    }
    return true;
  }

  Future<void> _addCandidate(RTCPeerConnection pc, Object? candidate) async {
    if (candidate is! Map) return;
    final line = candidate['candidate'];
    if (line is! String) return;
    await pc
        .addIceCandidate(
          RTCIceCandidateInit(
            candidate: line,
            sdpMid: candidate['sdpMid'] as String?,
            sdpMLineIndex: (candidate['sdpMLineIndex'] as num?)?.toInt(),
          ),
        )
        .toDart;
  }

  void _flushLateCandidates() {
    final pending = List<RTCIceCandidate>.of(_lateCandidates);
    _lateCandidates.clear();
    pending.forEach(_trickle);
  }

  void _trickle(RTCIceCandidate candidate) {
    if (candidate.candidate.isEmpty) return;
    sendSignal('p2p_ice_candidate', {
      'sessionId': sessionId,
      'protocolVersion': terminalP2pProtocolVersion,
      'candidate': {
        'candidate': candidate.candidate,
        'sdpMid': candidate.sdpMid,
        'sdpMLineIndex': candidate.sdpMLineIndex,
      },
    });
  }

  @override
  bool send(Object data) {
    final channel = _channel;
    if (!isReady || channel == null) return false;
    try {
      // Synchronous here, unlike the phone's plugin: a frame the browser
      // refuses goes back to the caller, and so onto the relay.
      channel.send(data is String ? data.toJS : asBytes(data).toJS);
      return true;
    } catch (error) {
      appLog.warn('p2p', 'data channel send failed', error: error);
      scheduleMicrotask(() => _fail('send_failed'));
      return false;
    }
  }

  @override
  Future<bool> sendWithBackpressureRetry(
    Object data, {
    Duration drain = const Duration(seconds: 5),
  }) async {
    if (send(data)) return true;
    final channel = _channel;
    if (channel == null || channel.readyState != 'open') return false;
    if (!await _waitForBufferedAmountLow(channel, drain)) return false;
    return send(data);
  }

  Future<bool> _waitForBufferedAmountLow(
    RTCDataChannel channel,
    Duration timeout,
  ) async {
    if (channel.bufferedAmount < terminalP2pMaxBufferedBytes) return true;
    final drained = _drained ??= Completer<void>();
    try {
      await drained.future.timeout(timeout);
    } on TimeoutException {
      return false;
    }
    return _channelCanSend;
  }

  @override
  Future<bool> waitUntilReady(Duration timeout) {
    if (isReady) return Future.value(true);
    if (_finished || timeout <= Duration.zero) return Future.value(false);
    final waiter = Completer<bool>();
    _waiters.add(waiter);
    final timer = Timer(timeout, () {
      _waiters.remove(waiter);
      if (!waiter.isCompleted) waiter.complete(false);
    });
    return waiter.future.whenComplete(timer.cancel);
  }

  void _settleWaiters(bool ready) {
    final waiters = List<Completer<bool>>.of(_waiters);
    _waiters.clear();
    for (final waiter in waiters) {
      if (!waiter.isCompleted) waiter.complete(ready);
    }
  }

  @override
  Future<void> stop({String reason = 'closed', bool notifyPeer = true}) async {
    if (_finished) return;
    _finished = true;
    _ready = false;
    _timeout?.cancel();
    _timeout = null;
    _clearDisconnectGrace();
    _settleWaiters(false);
    _lateCandidates.clear();
    final drained = _drained;
    _drained = null;
    if (drained != null && !drained.isCompleted) drained.complete();
    if (notifyPeer) {
      sendSignal('p2p_abort', {
        'sessionId': sessionId,
        'protocolVersion': terminalP2pProtocolVersion,
        'reason': reason,
      });
    }
    final channel = _channel;
    final pc = _pc;
    _channel = null;
    _pc = null;
    channel?.close();
    pc?.close();
    onState?.call(TerminalP2pLinkState.closed, _elapsed, reason);
  }

  void _wirePeer(RTCPeerConnection pc) {
    pc.onicegatheringstatechange = ((Event _) {
      if (_pc == pc && pc.iceGatheringState == 'complete') {
        _complete(_gathered);
      }
    }).toJS;
    pc.onicecandidate = ((RTCPeerConnectionIceEvent event) {
      if (_pc != pc || _finished) return;
      final candidate = event.candidate;
      // A null candidate is the end of gathering.
      if (candidate == null) return _complete(_gathered);
      final line = candidate.candidate;
      if (line.isEmpty) return;
      if (reflexiveCandidate.hasMatch(line)) _complete(_reflexive);
      // Everything gathered before the offer left is already inside its SDP.
      if (_offeredSdp.isNotEmpty && _offeredSdp.contains(line)) return;
      if (_sawAnswer) {
        _trickle(candidate);
      } else {
        _lateCandidates.add(candidate);
      }
    }).toJS;
    pc.onconnectionstatechange = ((Event _) {
      if (_pc != pc || _finished) return;
      final state = pc.connectionState;
      _step('ice-$state');
      switch (state) {
        case 'failed':
          _clearDisconnectGrace();
          _fail('peer_failed');
        case 'disconnected':
          // "Checks failing but still trying": it heals after a wifi blip.
          _disconnectGrace ??= Timer(terminalP2pDisconnectGrace, () {
            _disconnectGrace = null;
            if (_pc == pc && !_finished) _fail('peer_disconnected_timeout');
          });
        default:
          _clearDisconnectGrace();
      }
    }).toJS;
  }

  void _wireChannel(RTCDataChannel channel) {
    channel.bufferedAmountLowThreshold = terminalP2pBufferedLowThreshold;
    channel.onbufferedamountlow = ((Event _) {
      final drained = _drained;
      _drained = null;
      _complete(drained);
    }).toJS;
    channel.onopen = ((Event _) {
      if (_channel == channel && !_finished) unawaited(_opened());
    }).toJS;
    channel.onclose = ((Event _) {
      if (_channel == channel && !_finished && _ready) {
        _fail('channel_closed');
      }
    }).toJS;
    channel.onmessage = ((MessageEvent event) {
      if (_channel != channel || _finished) return;
      final data = event.data;
      if (data.isA<JSString>()) {
        onData((data as JSString).toDart);
      } else if (data.isA<JSArrayBuffer>()) {
        onData((data as JSArrayBuffer).toDart.asUint8List());
      }
    }).toJS;
  }

  Future<void> _opened() async {
    // Read the pair BEFORE reporting open, so `transport` answers synchronously
    // to whoever acts on the state change.
    _transport = await _readTransport();
    if (_finished) return;
    _ready = true;
    _timeout?.cancel();
    _timeout = null;
    _settleWaiters(true);
    onState?.call(TerminalP2pLinkState.open, _elapsed, null);
  }

  Future<TerminalP2pTransport?> _readTransport() async {
    final pc = _pc;
    if (pc == null) return null;
    try {
      return await nominatedTransport(pc);
    } catch (error) {
      appLog.warn('p2p', 'getStats failed', error: error);
      return null;
    }
  }

  static void _complete(Completer<void>? completer) {
    if (completer != null && !completer.isCompleted) completer.complete();
  }

  void _clearDisconnectGrace() {
    _disconnectGrace?.cancel();
    _disconnectGrace = null;
  }

  void _fail(String reason) {
    if (_finished) return;
    final wasReady = _ready;
    _ready = false;
    onState?.call(TerminalP2pLinkState.failed, _elapsed, reason);
    if (wasReady) onUnavailable?.call(reason);
    unawaited(stop(reason: reason));
  }
}
