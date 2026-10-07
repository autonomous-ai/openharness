import 'dart:typed_data';

import 'terminal_p2p_policy.dart';

/// The WebRTC half of the phone's P2P terminal transport, kept behind an
/// interface so the routing above it (`TerminalP2pPlugin`) can be tested with a
/// scripted link and no native peer connection. Mirrors `TerminalP2pInitiator`
/// in the harness CLI's `terminalP2p.ts`, whose constants these are.

const terminalP2pChannel = 'terminal-v1';

/// Covers BOTH peers' gathering plus a TURN allocation — see the CLI's own note on
/// why 10s was too tight. A terminal opened before the channel is ready falls back
/// to the relay after `openWaitMs` regardless, so a long budget costs nothing visible.
const terminalP2pNegotiationTimeout = Duration(seconds: 25);
const terminalP2pMaxBufferedBytes = 2 * 1024 * 1024;
const terminalP2pBufferedLowThreshold = 256 * 1024;

/// ICE `disconnected` is "checks failing but still trying" and self-heals after a
/// wifi blip or NAT rebind; only after this does it count as a real failure.
const terminalP2pDisconnectGrace = Duration(seconds: 5);

/// The signaling frames both peers exchange, E2EE-sealed, through the relay socket.
/// `p2p_promote`/`p2p_promote_ack` belong to the TURN-to-direct upgrade orchestration
/// in the plugin, not to a link's own protocol — they just ride the same channel.
const terminalP2pSignalTypes = {
  'p2p_offer',
  'p2p_answer',
  'p2p_ice_candidate',
  'p2p_abort',
  'p2p_promote',
  'p2p_promote_ack',
};

/// JSON frame types the machine may send down the data channel — anything else that
/// arrives there is dropped, as the CLI's `TERMINAL_P2P_UP_TYPES` does.
const terminalP2pUpTypes = {
  'terminal_capabilities_result',
  'terminal_ready',
  'terminal_keyframe',
  'terminal_output',
  'terminal_closed',
  'terminal_error',
  'terminal_chunked_upload_begin_result',
  'terminal_chunked_upload_progress',
  'terminal_paste_image_result',
  'terminal_paste_file_result',
};

enum TerminalP2pLinkState { connecting, open, failed, closed }

/// Which path ICE nominated once the channel is open. `relay` means the bytes go
/// through TURN — still WebRTC, still end-to-end encrypted, but billed per GB.
enum TerminalP2pTransport { direct, relay }

typedef TerminalP2pSignalSink = void Function(
  String type,
  Map<String, dynamic> payload,
);
typedef TerminalP2pDataSink = void Function(Object data);
typedef TerminalP2pStateSink = void Function(
  TerminalP2pLinkState state,
  Duration setup,
  String? reason,
);

abstract interface class TerminalP2pLink {
  /// Lower-case uuid v4; every signal for this negotiation carries it.
  String get sessionId;

  /// Open and under the send-buffer ceiling.
  bool get isReady;

  /// Null while negotiating, or when no candidate pair could be read.
  TerminalP2pTransport? get transport;

  void start();

  /// False when [type] is not a signal at all; true once handled — including a
  /// signal for some other session, which is swallowed rather than acted on.
  Future<bool> handleSignal(String type, Map<String, dynamic> payload);

  /// [data] is a `String` (a sealed JSON frame) or a `Uint8List` (a sealed HTRM
  /// frame). False means the caller must put the frame on the relay instead.
  bool send(Object data);

  /// [send], but a failure caused purely by backpressure gets one bounded chance to
  /// drain first — a burst of upload chunks can cross the ceiling well before the
  /// network has moved any of it.
  Future<bool> sendWithBackpressureRetry(
    Object data, {
    Duration drain = const Duration(seconds: 5),
  });

  Future<bool> waitUntilReady(Duration timeout);

  Future<void> stop({String reason = 'closed', bool notifyPeer = true});
}

abstract interface class TerminalP2pLinkFactory {
  TerminalP2pLink create({
    required TerminalP2pPolicy policy,
    required TerminalP2pSignalSink sendSignal,
    required TerminalP2pDataSink onData,
    TerminalP2pStateSink? onState,
    void Function(String reason)? onUnavailable,
    void Function(String step, Duration elapsed)? onStep,
    bool upgrade = false,
  });
}

/// Does the nominated pair send its bytes through a TURN allocation? BOTH ends
/// decide this: one relay candidate is enough for ICE to connect, so a pair of our
/// srflx with the peer's relay is fully relayed.
bool isRelayedPair(String? localType, String? remoteType) =>
    localType == 'relay' || remoteType == 'relay';

/// A `Uint8List` view of whatever binary the data channel handed over.
Uint8List asBytes(Object data) => data is Uint8List
    ? data
    : data is List<int>
    ? Uint8List.fromList(data)
    : Uint8List(0);
