import 'dart:math';
import 'dart:typed_data';

/// What this side advertises as `a=max-message-size`. The browser's default is
/// 256 KiB and werift (the machine's WebRTC stack) enforces the PEER's advertised
/// ceiling on every send — a terminal keyframe runs to ~480 KiB, so the default
/// would make the responder's very first keyframe fail and demote the channel.
/// The CLI and the phone set the same 512 KiB.
const p2pMaxMessageSize = 512 * 1024;

/// `a=max-message-size` raised to [p2pMaxMessageSize]; added after the
/// `a=sctp-port` line when the browser left it out, since werift then assumes
/// 64 KiB. Only the number is touched: a description whose line endings do not
/// all match is rejected, so the `\r\n` around it stays put.
String raiseMaxMessageSize(String sdp) {
  final line = RegExp(r'^(a=max-message-size:)\d+', multiLine: true);
  if (line.hasMatch(sdp)) {
    return sdp.replaceAllMapped(
      line,
      (match) => '${match[1]}$p2pMaxMessageSize',
    );
  }
  final sctp = RegExp(r'^a=sctp-port:\d+(\r?\n)', multiLine: true);
  return sdp.replaceFirstMapped(
    sctp,
    (match) => '${match[0]}a=max-message-size:$p2pMaxMessageSize${match[1]}',
  );
}

/// A lower-case uuid v4: the negotiation's `sessionId`.
String p2pSessionId([Random? random]) {
  final source = random ?? Random.secure();
  final bytes = Uint8List.fromList(
    List.generate(16, (_) => source.nextInt(256)),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

/// A candidate line that proves a server answered: server-reflexive or relay.
final reflexiveCandidate = RegExp(r'\btyp (srflx|relay)\b');
