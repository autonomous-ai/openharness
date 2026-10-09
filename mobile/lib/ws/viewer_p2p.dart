import 'dart:typed_data';

import '../terminal/terminal_binary.dart';

/// The viewer surface's half of the p2p data channel (`viewer-v1`): a surface's
/// frames come down as binary parts, its `surface_*` frames go up sealed. Not
/// [ready] means the relay carries them. A `TerminalTransportPlugin` that has
/// one offers it as `viewer`.
abstract interface class ViewerP2p {
  /// The machine speaks it (`p2pViewer`) and the current link's viewer channel is
  /// up. Says nothing about the terminal channel.
  bool get ready;

  /// `{type, payload}` sealed by the session's codec, on the viewer channel. False
  /// when not [ready], when [type] is not one the envelope seals, or when the send
  /// failed.
  bool send(String type, Map<String, dynamic> payload);

  /// The assembled frames of one surface (its 32-hex id). Subscribe before
  /// sending `surface_open`: parts for a surface nobody listens to are dropped.
  /// Cancelling the last subscription releases the surface; call [frames] again
  /// for a new stream after that.
  Stream<ViewerFrame> frames(String surfaceId);

  /// Changes of [ready]; re-emitted when the link behind it is replaced.
  Stream<bool> get readiness;

  /// How the link is carried, for the logs: 'direct', or 'turn' through a relay server.
  String get via;
}

/// One part of a viewer surface's JPEG frame, as the machine split it (cli/src/lib/viewerFrameParts.ts).
class ViewerPart {
  final String streamId;
  final int seq, part, parts, width, height;
  final double scale;
  final Uint8List bytes;
  const ViewerPart({
    required this.streamId,
    required this.seq,
    required this.part,
    required this.parts,
    required this.width,
    required this.height,
    required this.scale,
    required this.bytes,
  });
}

class ViewerFrame {
  final String streamId;
  final int seq, width, height;
  final double scale;
  final Uint8List jpeg;
  const ViewerFrame({
    required this.streamId,
    required this.seq,
    required this.width,
    required this.height,
    required this.scale,
    required this.jpeg,
  });
}

/// A loopback (HTRL) frame as a viewer part; null when it is anything else.
ViewerPart? decodeViewerPart(Uint8List localFrame) {
  final frame = decodeTerminalLocal(localFrame);
  final meta = frame?.viewer;
  if (frame == null || meta == null) return null;
  return ViewerPart(
    streamId: frame.streamId,
    seq: frame.seq,
    part: meta.part,
    parts: meta.parts,
    width: meta.width,
    height: meta.height,
    scale: meta.centiScale / 100,
    bytes: frame.bytes,
  );
}
