import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/ws/terminal_transport_plugin.dart';

import 'terminal_p2p_link.dart';
import 'terminal_p2p_policy.dart';

/// The phone's port of the harness CLI's `RemoteRelayPool` P2P orchestration
/// (`remoteRelay.ts`): where the desktop lets its local daemon decide which wire
/// each terminal stream rides, a viewer build decides here, per relay connection.
///
/// Three paths a stream can be on, reported to the app as `terminal_link_mode`:
///   'p2p'   — a data channel, ICE nominated a direct pair.
///   'turn'  — a data channel, but only a Cloudflare TURN pair would connect. Still
///             end-to-end encrypted, but billed per GB — hence the upgrade attempts.
///   'relay' — no data channel; the bytes ride the backend WebSocket.
///
/// Every constant and every rule here is the CLI's, and the comments there say why.

// Retry every 60s, capped at 10 attempts within any trailing hour — a ROLLING window,
// deliberately: the reason p2p cannot be reached right now is usually transient at the
// scale of hours (a changed IP, a router reboot, a NAT binding that thawed).
const _retryDelay = Duration(seconds: 60);
const _retryWindow = Duration(hours: 1);
const _retryHourlyCap = 10;

// How long a stream may sit mid-migration before the sweep gives up on it and the
// ordinary demote-on-mismatch rule applies to it again.
const _migrationTtl = Duration(seconds: 30);
const _migrationSweepEvery = Duration(seconds: 20);

// A connection that reached 'direct' only through a TURN pair still costs per GB —
// and, what a person actually notices, a relay round trip on every keystroke. Worth
// periodically trying for a truly direct one; the trial never touches the live
// connection until a replacement has already proven itself. The CLI gives up for
// good after three tries; a phone's relay socket can live in the foreground for
// hours, so after those three it keeps trying at a slow pace instead — and again
// at once when the app comes back, since that usually means the network changed.
const _upgradeQuickAttempts = 3;
const _upgradeRetryDelay = Duration(seconds: 60);
const _upgradeSlowRetryDelay = Duration(minutes: 15);
const _upgradeAttemptTimeout = Duration(seconds: 15);
const _upgradeDrainTimeout = Duration(seconds: 5);
const _promoteAckTimeout = Duration(seconds: 5);

enum _Wire { relay, p2p }

/// The plugins alive right now, so the phone's lifecycle can reach them: a retry
/// still waiting out its 60s when the app comes back to the foreground is fired
/// at once instead (its budget still applies).
class TerminalP2pPlugins {
  TerminalP2pPlugins({required this.links, DateTime Function()? now})
    : _now = now ?? DateTime.now;

  final TerminalP2pLinkFactory links;
  final DateTime Function() _now;
  final _live = <TerminalP2pPlugin>{};

  TerminalTransportPlugin create(TerminalTransportHost host, String machineId) {
    final plugin = TerminalP2pPlugin(
      host: host,
      machineId: machineId,
      links: links,
      now: _now,
      onDisposed: _live.remove,
    );
    _live.add(plugin);
    return plugin;
  }

  void kickRetry() {
    for (final plugin in List.of(_live)) {
      plugin.kickRetry();
    }
  }

  int get liveCount => _live.length;
}

class TerminalP2pPlugin implements TerminalTransportPlugin {
  TerminalP2pPlugin({
    required this.host,
    required this.machineId,
    required this.links,
    DateTime Function()? now,
    this.onDisposed,
  }) : _now = now ?? DateTime.now {
    _sweep = Timer.periodic(_migrationSweepEvery, (_) => _sweepMigrations());
  }

  final TerminalTransportHost host;
  final String machineId;
  final TerminalP2pLinkFactory links;
  final DateTime Function() _now;
  final void Function(TerminalP2pPlugin plugin)? onDisposed;

  TerminalP2pPolicy? _policy;
  TerminalP2pLink? _link;
  bool _disposed = false;

  /// Streams whose frames ride the data channel.
  final _p2pStreams = <String>{};

  /// Every stream open on this connection, whatever the wire — what
  /// [_promoteOpenStreams] walks for migration candidates.
  final _streams = <String>{};

  /// `terminal_open` requestIds that went out over the data channel; their
  /// `terminal_ready` decides whether the stream lands in [_p2pStreams].
  final _pendingOpens = <String>{};

  /// Streams that came up on the relay and have not yet had their first keyframe — each moved to
  /// the channel as that keyframe arrives, if the channel is up by then ([observeWsBinary]).
  ///
  /// ⚠️ **The gap this closes.** [_promoteOpenStreams] runs once, as the channel opens, over the
  /// streams already READY. One whose open went out on the relay but whose `terminal_ready` had not
  /// come back yet at that moment was never walked, and stayed on the relay for as long as it
  /// lived. Rare while an open waited for the channel; routine once it stopped waiting
  /// ([prepareOpen]), because the launch's first open and the channel now come up side by side.
  ///
  /// After the first keyframe and not at `terminal_ready`: the migration's first phase is a resync
  /// whose ANSWERING keyframe is what [observeWsBinary] takes as "drained, flip now" — started
  /// before the open's own keyframe, that keyframe would be taken for the answer.
  final _promoteAfterFirstFrame = <String>{};

  /// streamId → when its migration to p2p started.
  final _migrating = <String, DateTime>{};

  /// streamId → the sequence number of the first frame it delivered over the channel. A relay
  /// frame numbered below it was already on its way when the responder moved the stream onto
  /// the channel — see [_lateOnRelay].
  final _p2pFloor = <String, int>{};

  /// streamId → when its migration was confirmed by a frame that carries no sequence number, until
  /// a numbered one pins [_p2pFloor] — see [_lateOnRelay].
  final _confirmedAt = <String, DateTime>{};

  /// Streams whose late relay frames have been logged once already.
  final _lateNoted = <String>{};

  /// How long after a migration was confirmed with no numbered frame to go by a relay frame is still
  /// taken for a late one — the relay's own lag behind the channel, with room to spare.
  static const _lateRelayGrace = Duration(seconds: 2);

  final _retryTimestamps = <DateTime>[];
  Timer? _retryTimer;
  late final Timer _sweep;

  int _upgradeAttempts = 0;
  Timer? _upgradeTimer;
  TerminalP2pLink? _upgradeShadow;

  /// streamId → when its drain-barrier resync went out, right before a cutover.
  /// Distinct from [_migrating]: that one is WS→p2p, this is turn→direct, and the
  /// confirmation for each arrives over a different wire.
  final _upgradeDraining = <String, DateTime>{};
  void Function()? _upgradeWaitResolve;
  TerminalP2pLink? _upgradeOrphan;
  DateTime? _lastUpgradeAttemptAt;

  /// Set only once a cutover succeeded — there is nothing left to upgrade to. A
  /// demotion resets it along with the attempt count: the next link is its own.
  bool _upgradeDone = false;

  String get _sid =>
      machineId.length > 8 ? machineId.substring(0, 8) : machineId;

  void _log(String message) => appLog.info('p2p', '$message · machine=$_sid');

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  @override
  void onConnectedAck(Map<String, dynamic> payload) {
    _policy = TerminalP2pPolicy.parse(payload['p2p']);
    final policy = _policy;
    if (policy != null) {
      // Names only, never the credential itself.
      _log(
        'policy stun=${policy.stunUrls.length}'
        ' turn=${policy.turn == null ? 'NONE' : '${policy.turn!.urls.length} urls'}'
        ' openWait=${policy.openWaitMs}ms',
      );
    }
  }

  /// Whether this connection may run P2P — the backend sent a policy and the peer speaks this
  /// build's version — settled as its session comes up ([onSessionReady]).
  bool _p2pEligible = false;

  /// Whether the first negotiation has been started — by the first terminal to open
  /// ([prepareOpen]). Every later one is [_scheduleRetry]'s, budget and all.
  bool _p2pStarted = false;

  @override
  void onSessionReady() {
    if (_disposed) return;
    // Three ways p2p never even starts, all of which used to look identical from
    // outside. The peer-version case is the important one: a machine whose CLI
    // predates p2p answers no offer, so no amount of STUN or TURN can help it.
    final policy = _policy;
    if (policy == null) {
      _log('off · backend sent no policy (rollout or kill switch)');
    } else if (host.codec.terminalP2pVersion != terminalP2pProtocolVersion) {
      _log(
        'off · peer speaks p2p v${host.codec.terminalP2pVersion}, we speak'
        ' v$terminalP2pProtocolVersion — no data channel is possible, ws relay only',
      );
    } else {
      // ⚠️ **Not started here any more — on the first terminal instead (owner, 2026-10-01).**
      // Every machine the phone reached used to negotiate the moment its session came up: ICE
      // gathering, STUN and TURN, and the offer and answer over the relay, for each of seven or
      // eight machines at once at launch, when one terminal on one of them is all anybody is
      // waiting for. A data channel only carries terminals, so a machine with none open has no
      // use for one; the first open on it starts it ([prepareOpen]), rides the relay meanwhile as
      // every open made before the channel is up does, and moves over once it is.
      _p2pEligible = true;
    }
  }

  @override
  void dispose({bool notifyPeer = false}) {
    if (_disposed) return;
    _disposed = true;
    _retryTimer?.cancel();
    _retryTimer = null;
    _upgradeTimer?.cancel();
    _upgradeTimer = null;
    _sweep.cancel();
    final shadow = _upgradeShadow;
    final orphan = _upgradeOrphan;
    final link = _link;
    _upgradeShadow = null;
    _upgradeOrphan = null;
    _link = null;
    _upgradeDraining.clear();
    _upgradeWaitResolve = null;
    _p2pStreams.clear();
    _pendingOpens.clear();
    _promoteAfterFirstFrame.clear();
    _streams.clear();
    _migrating.clear();
    _forgetFloors();
    unawaited(shadow?.stop(reason: 'relay_closed', notifyPeer: notifyPeer));
    unawaited(orphan?.stop(reason: 'relay_closed', notifyPeer: notifyPeer));
    unawaited(link?.stop(reason: 'relay_closed', notifyPeer: notifyPeer));
    onDisposed?.call(this);
  }

  /// The app came back to the foreground: a retry waiting out its delay fires now,
  /// and a link sitting on TURN gets an upgrade trial at once — coming back usually
  /// means the network changed, which is exactly when a direct pair may have
  /// become possible.
  void kickRetry() {
    if (_disposed) return;
    final timer = _retryTimer;
    if (timer != null) {
      timer.cancel();
      _retryTimer = null;
      _log('retry kicked · app resumed');
      if (_link == null) _startP2p();
      return;
    }
    if (_link?.transport == TerminalP2pTransport.relay &&
        _upgradeShadow == null &&
        !_upgradeDone) {
      _upgradeTimer?.cancel();
      _upgradeTimer = null;
      _log('upgrade kicked · app resumed');
      _attemptUpgrade();
    }
  }

  // ── Negotiation ───────────────────────────────────────────────────────────

  void _startP2p() {
    final policy = _policy;
    if (policy == null || _link != null || _disposed) return;
    var wasDirect = false;
    late final TerminalP2pLink link;
    link = links.create(
      policy: policy,
      sendSignal: _sendSignal,
      onData: _handleP2pData,
      onStep: (step, elapsed) =>
          _log('step · $step +${elapsed.inMilliseconds}ms'),
      onState: (state, setup, reason) {
        if (_disposed) return;
        switch (state) {
          case TerminalP2pLinkState.open:
            wasDirect = true;
            final relayed = link.transport == TerminalP2pTransport.relay;
            _log(
              'connected · via=${relayed ? 'turn' : 'direct'}'
              ' setup=${setup.inMilliseconds}ms',
            );
            _reportP2pResult(
              'direct',
              setup: setup,
              reason: relayed ? 'relayed' : null,
            );
            _promoteOpenStreams();
            if (relayed && !_upgradeDone) _scheduleUpgradeAttempt();
          case TerminalP2pLinkState.failed:
            if (wasDirect || _link != link) return;
            _log(
              'gave up · reason=${reason ?? 'unknown'} after=${setup.inMilliseconds}ms'
              ' — terminals stay on the ws relay',
            );
            _reportP2pResult(
              reason == 'negotiation_timeout' ? 'timeout' : 'failed',
              setup: setup,
              reason: reason,
            );
            // Without this the plugin is stuck: `_link` still points at a finished
            // instance and `_startP2p`'s own guard blocks every future attempt.
            _link = null;
            _scheduleRetry();
          case TerminalP2pLinkState.connecting:
          case TerminalP2pLinkState.closed:
            break;
        }
      },
      onUnavailable: (reason) {
        if (_link == link) _demote(reason);
      },
    );
    _link = link;
    link.start();
  }

  void _sendSignal(String type, Map<String, dynamic> payload) {
    // Sealed by the codec on the way out: every p2p_* type is in encryptedDownTypes.
    unawaited(
      host.send({'type': type, 'payload': payload}, force: TransportVia.ws),
    );
  }

  void _scheduleRetry() {
    if (_disposed) return;
    if (_retryTimer != null) {
      _log('retry already pending');
      return;
    }
    final now = _now();
    final windowStart = now.subtract(_retryWindow);
    _retryTimestamps.removeWhere((at) => !at.isAfter(windowStart));
    var delay = _retryDelay;
    if (_retryTimestamps.length >= _retryHourlyCap) {
      // The CLI stops here and leaves the streams on the relay until the socket
      // itself redials. The window is rolling, though, and nothing else on a phone
      // would ever ask again — so wait for the oldest attempt to age out instead.
      delay =
          _retryTimestamps.first.add(_retryWindow).difference(now) +
          _retryDelay;
      _log(
        'retry budget exhausted · (${_retryTimestamps.length}/$_retryHourlyCap in the'
        ' last hour) — deferred ${delay.inSeconds}s until it frees',
      );
    } else {
      _retryTimestamps.add(now);
      _log(
        'retry scheduled · in ${delay.inSeconds}s'
        ' (${_retryTimestamps.length}/$_retryHourlyCap this hour)',
      );
    }
    _retryTimer = Timer(delay, () {
      _retryTimer = null;
      if (!_disposed && _link == null) _startP2p();
    });
  }

  // ── Inbound ───────────────────────────────────────────────────────────────

  @override
  bool consumesInbound(String type) => terminalP2pSignalTypes.contains(type);

  @override
  Future<void> handleInbound(String type, Map<String, dynamic> payload) async {
    if (_disposed) return;
    final sessionId = payload['sessionId'];
    // p2p_promote_ack belongs to the upgrade orchestration, not to a link's protocol.
    if (type == 'p2p_promote_ack') {
      if (sessionId is String && sessionId == _link?.sessionId) {
        _upgradeWaitResolve?.call();
      }
      return;
    }
    // A shadow trial negotiates its OWN session beside the live primary — route by
    // sessionId so its answer reaches it instead of being dropped by the primary.
    final shadow = _upgradeShadow;
    if (shadow != null &&
        sessionId is String &&
        sessionId == shadow.sessionId) {
      await shadow.handleSignal(type, payload);
    } else {
      await _link?.handleSignal(type, payload);
    }
  }

  @override
  Future<void> observeWsFrame(Map<String, dynamic> plain) =>
      _noteTerminalResponse(plain, _Wire.relay);

  @override
  Future<void> observeWsBinary(Uint8List localFrame) async {
    if (_disposed) return;
    final header = peekTerminalLocal(localFrame);
    if (header == null) return;
    final streamId = header.streamId;
    // Taken off on the stream's first keyframe whichever branch below runs: it is owed one
    // promotion attempt, at that frame, and never another from here — see [_promoteAfterFirstFrame].
    final firstKeyframe =
        header.kind == TerminalBinaryKind.keyframe &&
        _promoteAfterFirstFrame.remove(streamId);
    if (header.kind == TerminalBinaryKind.keyframe &&
        _migrating.containsKey(streamId) &&
        !_p2pStreams.contains(streamId)) {
      // Phase 1 of a live migration completing: the responder's reply to our WS-side
      // resync proves it has drained this stream as of now — safe to trigger phase 2.
      await _commitMigration(streamId);
    } else if (_p2pStreams.contains(streamId) &&
        !_migrating.containsKey(streamId)) {
      // Suppressed while migrating: during phase 2 the responder may still emit
      // relay-routed output until ITS flip lands, and that is not p2p breaking.
      // Nor after it, for what the relay was already carrying — see [_lateOnRelay].
      if (_lateOnRelay(streamId, localFrame)) return;
      await _demote('relay_binary_received');
    } else if (firstKeyframe && _link?.isReady == true) {
      // Came up on the relay after the channel was already up — nothing else would move it.
      _promote(streamId);
    }
  }

  void _handleP2pData(Object data) {
    host.enqueueInbound(() async {
      if (_disposed) return;
      if (data is String) {
        if (data.length > 512 * 1024) return;
        final Map<String, dynamic> wrapped;
        try {
          wrapped = jsonDecode(data) as Map<String, dynamic>;
        } catch (_) {
          return;
        }
        final type = wrapped['type'];
        if (type is! String || !terminalP2pUpTypes.contains(type)) return;
        final clear = host.codec.decodeFrame(wrapped);
        if (clear == null) return;
        final plain = <String, dynamic>{
          ...clear,
          'payload': (clear['payload'] as Map<String, dynamic>?) ?? {},
        };
        // The real frame first — `terminal_ready` is where the session learns its
        // streamId, and the derived link-mode frame must land after it.
        await host.dispatch(plain);
        await _noteTerminalResponse(plain, _Wire.p2p);
        return;
      }
      final bytes = asBytes(data);
      if (bytes.length > 512 * 1024) return;
      final local = host.codec.decodeBinary(bytes);
      if (local == null) return;
      final header = peekTerminalLocal(local);
      if (header == null) return;
      switch (header.kind) {
        case TerminalBinaryKind.output:
        case TerminalBinaryKind.keyframe:
        case TerminalBinaryKind.sync:
          break;
        default:
          return;
      }
      final streamId = header.streamId;
      // The first numbered frame the channel brings for this stream: the line below which a relay
      // frame is a late one — see [_lateOnRelay].
      if (!_p2pFloor.containsKey(streamId)) {
        if (peekTerminalLocalSeq(local) case final seq?) {
          _p2pFloor[streamId] = seq;
          _confirmedAt.remove(streamId);
        }
      }
      // Phase 2 of a live migration confirmed: this stream's bytes are genuinely
      // arriving over p2p — re-arm the ordinary demote-on-mismatch rule for it.
      await _confirmMigration(streamId);
      // Drain-barrier confirmation for an upgrade in flight: the OLD connection's
      // answer to the resync it sent itself, proving everything before is accounted for.
      if (_upgradeDraining.remove(streamId) != null &&
          _upgradeDraining.isEmpty) {
        _upgradeWaitResolve?.call();
      }
      await host.deliverBinary(local);
    });
  }

  Future<void> _noteTerminalResponse(
    Map<String, dynamic> plain,
    _Wire wire,
  ) async {
    if (_disposed) return;
    final type = plain['type'];
    final payload = (plain['payload'] as Map<String, dynamic>?) ?? const {};
    final streamId = payload['streamId'] is String
        ? payload['streamId'] as String
        : '';
    final requestId = payload['requestId'] is String
        ? payload['requestId'] as String
        : '';
    // Any p2p-delivered frame for a stream still migrating is itself proof the
    // responder committed its flip.
    if (wire == _Wire.p2p && streamId.isNotEmpty) {
      await _confirmMigration(streamId);
    }
    if (type == 'terminal_ready' &&
        requestId.isNotEmpty &&
        streamId.isNotEmpty) {
      _streams.add(streamId);
      final openedOnChannel = _pendingOpens.remove(requestId);
      if (openedOnChannel && wire == _Wire.p2p) {
        _p2pStreams.add(streamId);
      }
      // Only a stream that went to the relay because the channel was not up when it opened
      // ([prepareOpen]). One that asked for the channel and was answered on the relay anyway is
      // the responder's choice, and left where the responder put it, as before.
      if (!openedOnChannel && wire == _Wire.relay) {
        _promoteAfterFirstFrame.add(streamId);
      }
      // Derived from the routing table's own membership, not an echo of `wire`, so
      // a stale terminal_ready can never report a mode that is not actually routing.
      await _dispatchLinkMode(streamId, linkModeFor(streamId));
    } else if (type == 'terminal_error' && requestId.isNotEmpty) {
      _pendingOpens.remove(requestId);
    } else if (type == 'terminal_closed' && streamId.isNotEmpty) {
      _p2pStreams.remove(streamId);
      _streams.remove(streamId);
      _migrating.remove(streamId);
      _promoteAfterFirstFrame.remove(streamId);
      _forgetFloor(streamId);
    }
    // A frame for a stream still marked p2p but physically delivered over the relay:
    // a quieter, single-stream demotion than [_demote] — still worth telling the app.
    if (wire == _Wire.relay &&
        streamId.isNotEmpty &&
        !_migrating.containsKey(streamId) &&
        _p2pStreams.remove(streamId)) {
      _forgetFloor(streamId);
      await _dispatchLinkMode(streamId, 'relay');
    }
  }

  Future<void> _dispatchLinkMode(String streamId, String mode) =>
      host.dispatch({
        'type': 'terminal_link_mode',
        'payload': {'streamId': streamId, 'mode': mode},
      });

  /// Which of the three paths this stream's bytes are on.
  String linkModeFor(String streamId) {
    if (!_p2pStreams.contains(streamId)) return 'relay';
    return _link?.transport == TerminalP2pTransport.relay ? 'turn' : 'p2p';
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  /// Whether this open rides the channel: yes if it is up right now, and otherwise the relay, AT
  /// ONCE — the stream then moves to the channel on its own once it opens ([_promoteOpenStreams],
  /// or [_promoteAfterFirstFrame] for one that comes up after the channel did).
  ///
  /// ⚠️ **Deliberately not the CLI's rule, which waits up to the policy's `openWait` for the
  /// channel (owner, 2026-09-30).** On a phone that wait landed on the one open somebody is staring
  /// at: the channel only starts negotiating once the socket is up, which is also the moment the
  /// launch opens its first terminal — so every launch waited for it. Measured on the simulator: a
  /// launch took 6.1s to its first live screen, 2.0s of it this wait (the backend's `openWait` at
  /// 2500ms, the channel taking 1.7–2.8s to connect); without the wait, 3.5s.
  ///
  /// What it costs instead: the first seconds of a stream ride the relay — a relay round trip per
  /// keystroke and relay bandwidth — and each such stream is moved over with two resyncs, which
  /// the terminal takes as two keyframes. Both are cheaper than a blank screen.
  ///
  /// Nothing is reported to the backend for it (it used to send `open_wait_elapsed`): no wait ran
  /// out, and the channel's own outcome is still reported when it lands or gives up.
  @override
  Future<bool> prepareOpen(String requestId) async {
    if (_disposed) return false;
    // The connection's first terminal is what starts its channel — see [onSessionReady]. Once
    // only: a channel that failed or was demoted since is [_scheduleRetry]'s to bring back.
    if (_p2pEligible && !_p2pStarted) {
      _p2pStarted = true;
      _log('starting · first terminal on this machine');
      _startP2p();
    }
    final link = _link;
    if (link == null || _policy == null || !link.isReady) return false;
    _pendingOpens.add(requestId);
    return true;
  }

  @override
  bool sendJson(
    String type,
    Map<String, dynamic> payload,
    String sealedJson, {
    required bool openViaPlugin,
    TransportVia? force,
  }) {
    if (_disposed) return false;
    final streamId = payload['streamId'] is String
        ? payload['streamId'] as String
        : '';
    final closing = type == 'terminal_close' && streamId.isNotEmpty
        ? streamId
        : null;
    if (force == TransportVia.plugin) {
      // Phase 2 of a migration: a failure here abandons THIS stream's migration only,
      // never the whole connection — and the frame must not fall back to the relay.
      final link = _link;
      if (link != null && link.isReady && link.send(sealedJson)) {
        if (streamId.isNotEmpty && _migrating.containsKey(streamId)) {
          _p2pStreams.add(streamId);
        }
      } else if (streamId.isNotEmpty) {
        _migrating.remove(streamId);
      }
      return true;
    }
    var useP2p =
        force != TransportVia.ws &&
        (_p2pStreams.contains(streamId) ||
            (type == 'terminal_open' && openViaPlugin));
    if (useP2p && _link?.send(sealedJson) == true) {
      if (closing != null) {
        _p2pStreams.remove(closing);
        _streams.remove(closing);
        _migrating.remove(closing);
        _forgetFloor(closing);
      }
      return true;
    }
    if (useP2p) {
      // The relay carries this frame; the demotion's resyncs follow it in the FIFO.
      unawaited(_demote('send_failed'));
    }
    if (closing != null) {
      _streams.remove(closing);
      _migrating.remove(closing);
      _promoteAfterFirstFrame.remove(closing);
      _forgetFloor(closing);
    }
    return false;
  }

  @override
  Future<bool> sendBinary(Uint8List localFrame, Uint8List sealedFrame) async {
    if (_disposed) return false;
    final header = peekTerminalLocal(localFrame);
    if (header == null || !_p2pStreams.contains(header.streamId)) return false;
    final link = _link;
    if (link == null) return false;
    // A burst of large frames (a chunked upload) can push the send buffer over the
    // ceiling well before the network drained it — one bounded chance to clear
    // before this reads a busy channel as a dead one.
    final startedAt = _now();
    final sent = await link.sendWithBackpressureRetry(sealedFrame);
    final waited = _now().difference(startedAt);
    if (waited.inMilliseconds >= 50) {
      _log(
        'backpressure · drained=${sent ? 'yes' : 'no'} after=${waited.inMilliseconds}ms',
      );
    }
    if (sent) return true;
    unawaited(_demote('send_failed'));
    return false;
  }

  // ── Demotion, migration ───────────────────────────────────────────────────

  Future<void> _demote(String reason) async {
    // Two causes can race (a refused send and relay-delivered output, say); the
    // second finds nothing left to demote.
    if (_disposed || (_link == null && _p2pStreams.isEmpty)) return;
    // The ONE place every demotion converges, so none can fall through silently.
    _log('demoted · reason=$reason streams=${_p2pStreams.length}');
    _upgradeTimer?.cancel();
    _upgradeTimer = null;
    _upgradeAttempts = 0;
    _upgradeDone = false;
    final shadow = _upgradeShadow;
    _upgradeShadow = null;
    if (shadow != null) unawaited(shadow.stop(reason: 'primary_demoted'));
    // An orphan from an unanswered promote was only worth keeping beside the
    // primary it was cut over from; with that gone it is just a TURN allocation.
    final orphan = _upgradeOrphan;
    _upgradeOrphan = null;
    if (orphan != null) unawaited(orphan.stop(reason: 'primary_demoted'));
    _upgradeDraining.clear();
    _upgradeWaitResolve = null;
    final link = _link;
    _link = null;
    final streamIds = List.of(_p2pStreams);
    _p2pStreams.clear();
    _forgetFloors();
    _pendingOpens.clear();
    for (final streamId in streamIds) {
      _migrating.remove(streamId);
      unawaited(
        host.send({
          'type': 'terminal_resync',
          'payload': {'streamId': streamId},
        }, force: TransportVia.ws),
      );
      await _dispatchLinkMode(streamId, 'relay');
    }
    if (streamIds.isNotEmpty) _reportP2pResult('dropped', reason: reason);
    unawaited(link?.stop(reason: reason));
    _scheduleRetry();
  }

  /// Migrate every stream already open on this connection onto p2p, in two phases
  /// that both reuse `terminal_resync`: (1) here, over the wire the stream is on now
  /// (the relay) — a drain barrier the responder answers with a fresh keyframe over
  /// that same path; (2) [_commitMigration], once that keyframe arrives, a second
  /// resync over p2p, which is what makes the responder flip its routing too.
  void _promoteOpenStreams() {
    for (final streamId in _streams) {
      _promote(streamId);
    }
  }

  /// Phase 1 of moving one relay stream onto the channel: a resync over the socket, whose answering
  /// keyframe [observeWsBinary] then commits. A stream already on the channel, or already on its
  /// way, is left alone.
  ///
  /// Either way it no longer waits in [_promoteAfterFirstFrame]: that is a stream's one attempt,
  /// and a stream walked here has had it — a migration that then goes unanswered is swept
  /// ([_sweepMigrations]) and not started over by the keyframe that follows.
  void _promote(String streamId) {
    _promoteAfterFirstFrame.remove(streamId);
    if (_p2pStreams.contains(streamId) || _migrating.containsKey(streamId)) {
      return;
    }
    _migrating[streamId] = _now();
    _log('migrate · start stream=${_short(streamId)}');
    unawaited(
      host.send({
        'type': 'terminal_resync',
        'payload': {'streamId': streamId},
      }),
    );
  }

  /// A frame for [streamId] arrived over the channel. If the stream was migrating, that is the
  /// proof the responder flipped: the migration is over, and the app is told the stream's wire.
  ///
  /// ⚠️ **The telling is new (owner, 2026-09-30).** A migrated stream used to keep the `relay` badge
  /// its `terminal_ready` gave it, whatever wire its bytes actually took after — harmless while a
  /// migration was the rare case, misleading once every stream opened during a launch goes
  /// through one ([prepareOpen]). The upgrade path already re-tells its streams for the same
  /// reason (see [_attemptUpgrade]'s cutover).
  Future<void> _confirmMigration(String streamId) async {
    final startedAt = _migrating.remove(streamId);
    if (startedAt == null) return;
    if (!_p2pFloor.containsKey(streamId)) _confirmedAt[streamId] = _now();
    _log(
      'migrate · done stream=${_short(streamId)} via=${linkModeFor(streamId)}'
      ' took=${_now().difference(startedAt).inMilliseconds}ms',
    );
    await _dispatchLinkMode(streamId, linkModeFor(streamId));
  }

  /// Whether [localFrame], delivered over the relay for [streamId] — a stream on the channel — is a
  /// late one: sent before the responder moved the stream, and only now arriving.
  ///
  /// ⚠️ **One of these used to take the channel down for a minute.** Phase 2 of a migration flips
  /// the responder's routing, but what it had already put on the relay is still on its way — and
  /// the relay is the slower wire, so that output routinely lands AFTER the channel's first frame.
  /// Taken for p2p breaking, it demoted the whole channel and scheduled the retry a minute out; the
  /// session read the same frame as a sequence gap and asked for a resync. Measured on a phone
  /// (2026-10-02): migrated in 546 ms, demoted at once, every stream on the relay for 60 s.
  ///
  /// Late is told by number: everything the responder sent before its flip is numbered below the
  /// channel's first frame for the stream ([_p2pFloor]). A relay frame numbered at or above it
  /// means the responder really is back on the relay, and demotes as before. Until a numbered frame
  /// has come — a migration confirmed by a frame that carries none — a short grace after the
  /// confirmation stands in ([_lateRelayGrace]).
  bool _lateOnRelay(String streamId, Uint8List localFrame) {
    final floor = _p2pFloor[streamId];
    final seq = peekTerminalLocalSeq(localFrame);
    final late = floor != null
        ? seq != null && seq < floor
        : switch (_confirmedAt[streamId]) {
            final confirmedAt? =>
              _now().difference(confirmedAt) < _lateRelayGrace,
            null => false,
          };
    if (late && _lateNoted.add(streamId)) {
      _log(
        'late relay frame · stream=${_short(streamId)} seq=$seq'
        '${floor == null ? '' : ' < $floor'} · kept on p2p',
      );
    }
    return late;
  }

  void _forgetFloor(String streamId) {
    _p2pFloor.remove(streamId);
    _confirmedAt.remove(streamId);
    _lateNoted.remove(streamId);
  }

  void _forgetFloors() {
    _p2pFloor.clear();
    _confirmedAt.clear();
    _lateNoted.clear();
  }

  /// Enough of a stream id to tell a launch's few streams apart in the log.
  static String _short(String streamId) =>
      streamId.length > 8 ? streamId.substring(0, 8) : streamId;

  Future<void> _commitMigration(String streamId) async {
    final link = _link;
    if (link == null || !link.isReady) {
      _migrating.remove(streamId);
      return;
    }
    // [_migrating] is deliberately NOT cleared here — only once a p2p-delivered frame
    // for this stream actually arrives, the real proof the responder flipped.
    await host.send({
      'type': 'terminal_resync',
      'payload': {'streamId': streamId},
    }, force: TransportVia.plugin);
  }

  void _sweepMigrations() {
    if (_migrating.isEmpty) return;
    final cutoff = _now().subtract(_migrationTtl);
    _migrating.removeWhere((_, startedAt) => startedAt.isBefore(cutoff));
  }

  // ── TURN → direct upgrade ─────────────────────────────────────────────────

  void _scheduleUpgradeAttempt() {
    if (_upgradeTimer != null || _upgradeShadow != null || _upgradeDone) return;
    final delay = _upgradeAttempts < _upgradeQuickAttempts
        ? _upgradeRetryDelay
        : _upgradeSlowRetryDelay;
    _upgradeTimer = Timer(delay, () {
      _upgradeTimer = null;
      if (!_disposed) _attemptUpgrade();
    });
  }

  /// One trial: a brand-new (shadow) connection, entirely independent of the live
  /// primary, to see whether IT lands on a direct pair. Nothing here touches the
  /// routing until [_promoteToDirect] has already proven success.
  void _attemptUpgrade() {
    final policy = _policy;
    final primary = _link;
    if (_upgradeDone ||
        primary == null ||
        !primary.isReady ||
        primary.transport != TerminalP2pTransport.relay ||
        policy == null) {
      return;
    }
    // A resume can ask at any moment; one full negotiation a minute is plenty.
    final now = _now();
    final last = _lastUpgradeAttemptAt;
    if (last != null && now.difference(last) < _upgradeRetryDelay) return;
    _lastUpgradeAttemptAt = now;
    _upgradeAttempts++;
    final attempt = _upgradeAttempts;
    late final TerminalP2pLink shadow;
    shadow = links.create(
      policy: policy,
      upgrade: true,
      sendSignal: _sendSignal,
      // Identical to the primary's wiring — nothing routes real data here before
      // promotion, and after it this IS the primary.
      onData: _handleP2pData,
      onStep: (step, elapsed) => _log(
        'upgrade step · attempt=$attempt $step +${elapsed.inMilliseconds}ms',
      ),
      onState: (state, setup, reason) => _log(
        'upgrade ${state.name} · attempt=$attempt +${setup.inMilliseconds}ms'
        '${reason == null ? '' : ' reason=$reason'}',
      ),
      onUnavailable: (reason) {
        if (_link == shadow) {
          // Already promoted and now failing for real — an ordinary primary failure.
          unawaited(_demote(reason));
        } else if (_upgradeShadow == shadow) {
          // Died as a trial, before cutover — the primary was never touched.
          _upgradeShadow = null;
          _upgradeDraining.clear();
          _upgradeWaitResolve = null;
          _finishUpgradeAttempt();
        }
      },
    );
    _upgradeShadow = shadow;
    shadow.start();
    unawaited(_runUpgradeAttempt(shadow));
  }

  Future<void> _runUpgradeAttempt(TerminalP2pLink shadow) async {
    final ok = await shadow.waitUntilReady(_upgradeAttemptTimeout);
    if (_upgradeShadow != shadow || _disposed) return;
    if (!ok || shadow.transport == TerminalP2pTransport.relay) {
      _upgradeShadow = null;
      unawaited(shadow.stop(reason: 'upgrade_no_gain'));
      _finishUpgradeAttempt();
      return;
    }
    await _promoteToDirect(shadow);
  }

  void _finishUpgradeAttempt() {
    if (_upgradeAttempts == _upgradeQuickAttempts) {
      _log(
        'upgrade slowing down · still on turn after $_upgradeAttempts attempts,'
        ' retrying every ${_upgradeSlowRetryDelay.inMinutes}min',
      );
    }
    _scheduleUpgradeAttempt();
  }

  /// Cuts the primary over to [shadow], which has already proven itself a true
  /// direct pair. Every bail-out before the actual swap leaves the primary untouched.
  Future<void> _promoteToDirect(TerminalP2pLink shadow) async {
    final old = _link;
    if (old == null || _upgradeShadow != shadow || _disposed) {
      unawaited(shadow.stop(reason: 'upgrade_stale'));
      if (_upgradeShadow == shadow) _upgradeShadow = null;
      _finishUpgradeAttempt();
      return;
    }
    final streamIds = List.of(_p2pStreams);
    if (streamIds.isNotEmpty) {
      // Phase 1 — drain barrier over the OLD (still-primary, still live) connection.
      final drained = await _waitForUpgradeMilestone(() {
        final at = _now();
        for (final streamId in streamIds) {
          _upgradeDraining[streamId] = at;
        }
        for (final streamId in streamIds) {
          unawaited(
            host.send({
              'type': 'terminal_resync',
              'payload': {'streamId': streamId},
            }),
          );
        }
      }, _upgradeDrainTimeout);
      if (_upgradeShadow != shadow || _disposed) {
        _upgradeDraining.clear();
        unawaited(shadow.stop(reason: 'upgrade_stale'));
        return;
      }
      if (!drained) {
        // Timed out — the old connection is still completely untouched.
        _upgradeDraining.clear();
        _upgradeShadow = null;
        unawaited(shadow.stop(reason: 'upgrade_drain_timeout'));
        _finishUpgradeAttempt();
        return;
      }
    }
    // Phase 2 — the cutover. [_p2pStreams] is untouched: every stream in it was p2p
    // and stays p2p; only the link behind them changes.
    _link = shadow;
    _upgradeShadow = null;
    final acked = await _waitForUpgradeMilestone(() {
      for (final streamId in streamIds) {
        unawaited(
          host.send({
            'type': 'terminal_resync',
            'payload': {'streamId': streamId},
          }),
        );
      }
      _sendSignal('p2p_promote', {
        'sessionId': shadow.sessionId,
        'protocolVersion': terminalP2pProtocolVersion,
      });
    }, _promoteAckTimeout);
    if (acked) {
      _upgradeDone = true; // nothing left to upgrade to
      unawaited(old.stop(reason: 'upgraded', notifyPeer: false));
      _log('upgrade promoted · attempt=$_upgradeAttempts');
      // The streams did not change wire from their own point of view, but the
      // badge they carry did — the CLI leaves it stale at 'turn' here.
      for (final streamId in streamIds) {
        if (_p2pStreams.contains(streamId)) {
          await _dispatchLinkMode(streamId, linkModeFor(streamId));
        }
      }
    } else {
      // Keep the old connection alive rather than guess it is safe to close; it is
      // closed when the plugin itself is disposed. The cutover itself stands, so
      // this link is direct now and there is nothing more to try.
      _upgradeDone = true;
      _upgradeOrphan = old;
      _log('upgrade promote ack timeout · keeping the old connection open');
    }
  }

  /// One waiter for [_promoteToDirect]'s two sequential phases. [start] runs AFTER
  /// the timeout and resolver are armed, so a same-tick resolve cannot race past.
  Future<bool> _waitForUpgradeMilestone(
    void Function() start,
    Duration timeout,
  ) {
    final done = Completer<bool>();
    late final Timer timer;
    void settle(bool ok) {
      if (done.isCompleted) return;
      timer.cancel();
      _upgradeWaitResolve = null;
      done.complete(ok);
    }

    timer = Timer(timeout, () => settle(false));
    _upgradeWaitResolve = () => settle(true);
    start();
    return done.future;
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  /// Sent in the clear (its type is not sealed) so the backend can log outcomes; it
  /// never carries anything about the session but a word and a duration.
  void _reportP2pResult(String outcome, {Duration? setup, String? reason}) {
    unawaited(
      host.send({
        'type': 'p2p_result',
        'payload': {
          'outcome': outcome,
          if (setup != null) 'setupMs': setup.inMilliseconds.clamp(0, 1 << 31),
          if (reason != null && reason.isNotEmpty)
            'reason': reason.length > 64 ? reason.substring(0, 64) : reason,
        },
      }, force: TransportVia.ws),
    );
  }
}
