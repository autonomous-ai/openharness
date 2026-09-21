import 'dart:async';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:harness_mobile/logging/app_log.dart';

import 'terminal_p2p_link.dart';
import 'terminal_p2p_policy.dart';

/// Diagnostic only, the phone's `TERMINAL_P2P_FORCE_RELAY`: drops host and srflx so
/// nothing but a TURN allocation can be nominated. `--dart-define=HARNESS_P2P_FORCE_RELAY=true`.
/// Unlike the CLI's flag it leaves an upgrade trial alone — a primary forced onto
/// TURN with a shadow free to go direct is how the cutover gets exercised at all.
const kForceP2pRelay = bool.fromEnvironment('HARNESS_P2P_FORCE_RELAY');

/// What this side advertises as `a=max-message-size`. libwebrtc's default is 256 KiB
/// and werift (the machine's WebRTC stack) enforces the PEER's advertised ceiling on
/// every send — a terminal keyframe runs to ~480 KiB, so the default would make the
/// responder's very first keyframe fail and demote the whole channel. The CLI sets
/// the same 512 KiB for werift↔werift.
const _maxMessageSize = 512 * 1024;

/// libwebrtc gathers in the background and only reports `complete` once every
/// server answered or timed out — with a dozen STUN/TURN urls that is routinely
/// the whole budget. The offer goes out early instead: once a server-reflexive
/// (or relay) candidate is in, plus a moment for the other interfaces to report,
/// and at the cap regardless. Whatever gathers after that trickles.
const _gatherCap = Duration(seconds: 3);
const _gatherSettleAfterReflexive = Duration(milliseconds: 500);

class WebRtcTerminalP2pLinkFactory implements TerminalP2pLinkFactory {
  const WebRtcTerminalP2pLinkFactory();

  @override
  TerminalP2pLink create({
    required TerminalP2pPolicy policy,
    required TerminalP2pSignalSink sendSignal,
    required TerminalP2pDataSink onData,
    TerminalP2pStateSink? onState,
    void Function(String reason)? onUnavailable,
    void Function(String step, Duration elapsed)? onStep,
    bool upgrade = false,
  }) => WebRtcTerminalP2pLink(
    policy: policy,
    sendSignal: sendSignal,
    onData: onData,
    onState: onState,
    onUnavailable: onUnavailable,
    onStep: onStep,
    upgrade: upgrade,
  );
}

/// The offerer side of one `terminal-v1` data channel, on `flutter_webrtc`. A port
/// of the harness CLI's `TerminalP2pInitiator` (terminalP2p.ts); the responder on
/// the machine is unchanged and this speaks exactly what it expects.
///
/// Where the CLI races its STUN servers and picks one TURN url, this hands
/// libwebrtc the whole list — the race exists for werift's serial gather, and the
/// single url for its "first `turn:` entry only" limit; neither applies here.
class WebRtcTerminalP2pLink implements TerminalP2pLink {
  WebRtcTerminalP2pLink({
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
  final String sessionId = _uuidV4();

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

  /// Candidates not carried by the offer. Held until the answer is in: the
  /// responder only adds a candidate to an entry that already has a remote
  /// description, and one arriving earlier is dropped or tears the session down.
  /// Before the offer goes out everything lands here too, and what its SDP turns
  /// out to carry is dropped again then — the alternative, ignoring candidates
  /// until the SDP is known, loses the ones reported while it is being read.
  final _lateCandidates = <RTCIceCandidate>[];
  String _offeredSdp = '';

  Duration get _elapsed => _clock.elapsed;

  void _step(String label) => onStep?.call(label, _elapsed);

  @override
  bool get isReady => _ready && _channelCanSend;

  bool get _channelCanSend {
    final channel = _channel;
    return channel != null &&
        channel.state == RTCDataChannelState.RTCDataChannelOpen &&
        (channel.bufferedAmount ?? 0) < terminalP2pMaxBufferedBytes;
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
      final turn = policy.turn;
      final config = <String, dynamic>{
        'iceServers': [
          if (policy.stunUrls.isNotEmpty) {'urls': policy.stunUrls},
          if (turn != null)
            {
              'urls': turn.urls,
              'username': turn.username,
              'credential': turn.credential,
            },
        ],
        'sdpSemantics': 'unified-plan',
        // Left at 'all' deliberately, as the CLI does: host and srflx pairs win by
        // priority, and a TURN pair is nominated only once every direct one failed.
        if (kForceP2pRelay && !upgrade) 'iceTransportPolicy': 'relay',
      };
      final pc = await createPeerConnection(config);
      if (_finished) {
        await pc.dispose();
        return;
      }
      _pc = pc;
      _gathered = Completer<void>();
      _reflexive = Completer<void>();
      _wirePeer(pc);
      final channel = await pc.createDataChannel(
        terminalP2pChannel,
        RTCDataChannelInit()..ordered = true,
      );
      _channel = channel;
      _wireChannel(channel);
      await _createOffer(pc);
    } catch (error) {
      appLog.warn('p2p', 'peer connection setup failed', error: error);
      _fail('offer_failed');
    }
  }

  Future<void> _createOffer(RTCPeerConnection pc) async {
    final offer = await pc.createOffer({});
    final munged = _raiseMaxMessageSize(offer.sdp ?? '');
    await pc.setLocalDescription(RTCSessionDescription(munged, 'offer'));
    if (_pc != pc || _finished) return;
    _step('offer-created');
    // Gather-then-signal, like the CLI, but not to completion: the responder's
    // answer needs nothing more than what is in the SDP, and anything slower
    // trickles after it.
    final how = await Future.any<String>([
      _gathered!.future.then((_) => 'gathered'),
      _reflexive!.future
          .then((_) => Future<void>.delayed(_gatherSettleAfterReflexive))
          .then((_) => 'gathered-enough'),
    ]).timeout(_gatherCap, onTimeout: () => 'gather-capped');
    if (_pc != pc || _finished) return;
    _step(how);
    final local = await pc.getLocalDescription();
    final sdp = local?.sdp;
    if (sdp == null || sdp.isEmpty) {
      throw StateError('local_description_missing');
    }
    _offeredSdp = sdp;
    _lateCandidates.removeWhere((c) => sdp.contains(c.candidate ?? ''));
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
          await pc.setRemoteDescription(RTCSessionDescription(sdp, 'answer'));
          _flushLateCandidates();
        case 'p2p_ice_candidate':
          final candidate = payload['candidate'];
          if (candidate is Map) {
            final line = candidate['candidate'];
            if (line is String) {
              await pc.addCandidate(
                RTCIceCandidate(
                  line,
                  candidate['sdpMid'] as String?,
                  (candidate['sdpMLineIndex'] as num?)?.toInt(),
                ),
              );
            }
          }
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

  void _flushLateCandidates() {
    final pending = List<RTCIceCandidate>.from(_lateCandidates);
    _lateCandidates.clear();
    for (final candidate in pending) {
      _trickle(candidate);
    }
  }

  void _trickle(RTCIceCandidate candidate) {
    final line = candidate.candidate;
    if (line == null || line.isEmpty) return;
    sendSignal('p2p_ice_candidate', {
      'sessionId': sessionId,
      'protocolVersion': terminalP2pProtocolVersion,
      'candidate': {
        'candidate': line,
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
      final message = data is String
          ? RTCDataChannelMessage(data)
          : RTCDataChannelMessage.fromBinary(asBytes(data));
      // The plugin's send is a Future, so a rejection lands after this has already
      // answered true and the frame is gone — unlike the CLI's synchronous werift
      // send, which hands a refused frame back for the relay. Rare (the channel
      // has to die between the state check and the native call); the demotion's
      // resync restores the screen, and a lost keystroke is retyped. Reported on a
      // later turn so nothing of the failure precedes the frames already queued.
      unawaited(
        channel.send(message).catchError((Object error) {
          appLog.warn('p2p', 'data channel send failed', error: error);
          _fail('send_failed');
        }),
      );
      return true;
    } catch (_) {
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
    if (channel == null ||
        channel.state != RTCDataChannelState.RTCDataChannelOpen) {
      return false;
    }
    if (!await _waitForBufferedAmountLow(channel, drain)) return false;
    return send(data);
  }

  Future<bool> _waitForBufferedAmountLow(
    RTCDataChannel channel,
    Duration timeout,
  ) async {
    // The cached figure only moves on a native event; ask for the real one first.
    try {
      if (await channel.getBufferedAmount() < terminalP2pMaxBufferedBytes) {
        return true;
      }
    } catch (_) {
      return false;
    }
    final drained = _drained ??= Completer<void>();
    try {
      await drained.future.timeout(timeout);
    } catch (_) {
      return false;
    }
    return channel.state == RTCDataChannelState.RTCDataChannelOpen &&
        (channel.bufferedAmount ?? 0) < terminalP2pMaxBufferedBytes;
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
    final waiters = List<Completer<bool>>.from(_waiters);
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
    _drained?.complete();
    _drained = null;
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
    try {
      await channel?.close();
    } catch (_) {
      /* already closed */
    }
    // dispose() alone: natively it IS close, and it cancels the Dart event
    // subscription first — a close() before it removes the native handler that
    // cancel then fails to reach, as an uncaught MissingPluginException.
    if (pc != null) {
      try {
        await pc.dispose();
      } catch (_) {
        /* best effort */
      }
    }
    onState?.call(TerminalP2pLinkState.closed, _elapsed, reason);
  }

  /// Why a negotiation went nowhere, in one line. `answer=no` is the case that
  /// matters: the peer never replied, so no candidate of ours was ever going to be
  /// tried — a peer problem, not a connectivity one.
  String get negotiationDetail =>
      'answer=${_sawAnswer ? 'yes' : 'no'} ice=${_pc?.connectionState?.name ?? '-'}';

  void _wirePeer(RTCPeerConnection pc) {
    pc.onIceGatheringState = (state) {
      if (_pc != pc) return;
      if (state == RTCIceGatheringState.RTCIceGatheringStateComplete) {
        final gathered = _gathered;
        if (gathered != null && !gathered.isCompleted) gathered.complete();
      }
    };
    pc.onIceCandidate = (candidate) {
      if (_pc != pc || _finished) return;
      final line = candidate.candidate;
      if (line == null || line.isEmpty) return;
      if (RegExp(r'\btyp (srflx|relay)\b').hasMatch(line)) {
        final reflexive = _reflexive;
        if (reflexive != null && !reflexive.isCompleted) reflexive.complete();
      }
      // Everything gathered before the offer left is already inside its SDP.
      if (_offeredSdp.isNotEmpty && _offeredSdp.contains(line)) return;
      if (_sawAnswer) {
        _trickle(candidate);
      } else {
        _lateCandidates.add(candidate);
      }
    };
    pc.onConnectionState = (state) {
      if (_pc != pc || _finished) return;
      _step('ice-${state.name}');
      switch (state) {
        case RTCPeerConnectionState.RTCPeerConnectionStateFailed:
          _clearDisconnectGrace();
          _fail('peer_failed');
        case RTCPeerConnectionState.RTCPeerConnectionStateDisconnected:
          if (_disconnectGrace != null) return;
          _disconnectGrace = Timer(terminalP2pDisconnectGrace, () {
            _disconnectGrace = null;
            if (_pc == pc && !_finished) _fail('peer_disconnected_timeout');
          });
        default:
          // Back to connected (or connecting through an ICE restart): it healed.
          _clearDisconnectGrace();
      }
    };
  }

  void _wireChannel(RTCDataChannel channel) {
    channel.bufferedAmountLowThreshold = terminalP2pBufferedLowThreshold;
    channel.onBufferedAmountLow = (_) {
      final drained = _drained;
      _drained = null;
      if (drained != null && !drained.isCompleted) drained.complete();
    };
    channel.onDataChannelState = (state) {
      if (_channel != channel || _finished) return;
      switch (state) {
        case RTCDataChannelState.RTCDataChannelOpen:
          unawaited(_opened());
        case RTCDataChannelState.RTCDataChannelClosing:
        case RTCDataChannelState.RTCDataChannelClosed:
          if (_ready) _fail('channel_closed');
        case RTCDataChannelState.RTCDataChannelConnecting:
          break;
      }
    };
    channel.onMessage = (message) {
      if (_channel != channel || _finished) return;
      onData(message.isBinary ? message.binary : message.text);
    };
  }

  Future<void> _opened() async {
    // Read the pair BEFORE reporting open, so `transport` answers synchronously to
    // whoever acts on the state change.
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
      final reports = await pc.getStats();
      final byId = {for (final report in reports) report.id: report};
      StatsReport? pair;
      for (final report in reports) {
        if (report.type == 'transport') {
          final selected = report.values['selectedCandidatePairId'];
          if (selected is String && byId[selected] != null) {
            pair = byId[selected];
            break;
          }
        }
      }
      pair ??= reports.cast<StatsReport?>().firstWhere((report) {
        if (report!.type != 'candidate-pair') return false;
        final values = report.values;
        return values['nominated'] == true &&
            (values['state'] == 'succeeded' ||
                values['state'] == 'in-progress');
      }, orElse: () => null);
      if (pair == null) return null;
      String? typeOf(Object? id) {
        final candidate = id is String ? byId[id] : null;
        final type = candidate?.values['candidateType'];
        return type is String ? type : null;
      }

      return isRelayedPair(
            typeOf(pair.values['localCandidateId']),
            typeOf(pair.values['remoteCandidateId']),
          )
          ? TerminalP2pTransport.relay
          : TerminalP2pTransport.direct;
    } catch (error) {
      appLog.warn('p2p', 'getStats failed', error: error);
      return null;
    }
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

/// `a=max-message-size` raised to what a keyframe needs — see [_maxMessageSize].
/// Added when libwebrtc left it out, since werift then assumes 64 KiB.
String _raiseMaxMessageSize(String sdp) {
  // Only the number is touched: libwebrtc's parser rejects a description whose
  // line endings do not all match, so the `\r\n` around it must stay put.
  final line = RegExp(r'^(a=max-message-size:)\d+', multiLine: true);
  if (line.hasMatch(sdp)) {
    return sdp.replaceAllMapped(line, (match) => '${match[1]}$_maxMessageSize');
  }
  final sctp = RegExp(r'^a=sctp-port:\d+(\r?\n)', multiLine: true);
  return sdp.replaceFirstMapped(
    sctp,
    (match) => '${match[0]}a=max-message-size:$_maxMessageSize${match[1]}',
  );
}

String _uuidV4() {
  final random = Random.secure();
  final bytes = Uint8List.fromList(
    List.generate(16, (_) => random.nextInt(256)),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-'
      '${hex.substring(16, 20)}-${hex.substring(20)}';
}

@visibleForTesting
String raiseMaxMessageSizeForTest(String sdp) => _raiseMaxMessageSize(sdp);
