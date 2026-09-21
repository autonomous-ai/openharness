import 'dart:typed_data';

/// What a relay [WsConn] needs from an end-to-end session with the machine behind it.
///
/// Where the harness CLI is the transport (macOS, Linux) nothing does — the CLI already opened the
/// session and hands over plaintext — so only a viewer build supplies one
/// (`viewer/e2ee_relay_codec.dart`). The codec speaks the loopback formats on the app's side
/// (plain JSON payloads, HTRL binary frames), so nothing above [WsConn] can tell the two apart.
abstract interface class RelayCodec {
  /// Sent once the relay acks `machine_select`.
  Map<String, dynamic> helloFrame();

  /// True once the machine's `e2e_welcome` has made the session usable.
  Future<bool> handleWelcome(Map<String, dynamic> payload);

  bool handleRekey(Map<String, dynamic> payload);

  /// The machine's `features.terminalP2p` from its welcome — 0 when it offers no
  /// P2P terminal channel (or before the welcome).
  int get terminalP2pVersion;

  /// The frame as it may cross the relay. Null when it must travel sealed and the session is not
  /// up yet — it must then not go at all: sent in the clear it leaks, and a terminal frame is
  /// rejected by the relay outright.
  Map<String, dynamic>? encodeFrame(Map<String, dynamic> frame);

  /// Null means drop it: stale, replayed or not authentic.
  Map<String, dynamic>? decodeFrame(Map<String, dynamic> frame);

  /// A loopback (HTRL) frame, sealed for the relay; null when it cannot be.
  Uint8List? encodeBinary(Uint8List localFrame);

  /// A relay frame, opened back into loopback (HTRL) form; null means drop it.
  Uint8List? decodeBinary(Uint8List wireFrame);
}

/// A fresh session for each connection to [machineId]; null when this device has no link to it —
/// the machine could only answer `e2e_denied`, so there is nothing worth dialing.
typedef RelayCodecFactory = Future<RelayCodec?> Function(String machineId);
