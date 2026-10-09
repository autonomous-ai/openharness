import 'dart:typed_data';

import '../../ws/viewer_p2p.dart';

/// Puts one surface's parts back together. Only the newest seq is kept: a part of a newer seq
/// drops an incomplete older one (a lost part means a stale frame, and the next one is coming),
/// and parts of an older or already-finished seq are ignored. One assembler per surface/stream.
class ViewerFrameAssembler {
  int _seq = -1;
  int _parts = 0;
  bool _dead =
      false; // this seq is finished or inconsistent: ignore the rest of it
  final Map<int, Uint8List> _have = {};

  ViewerFrame? add(ViewerPart p) {
    if (p.seq < _seq) return null;
    if (p.seq > _seq) {
      _seq = p.seq;
      _parts = p.parts;
      _dead = false;
      _have.clear();
    }
    if (_dead) return null;
    if (p.parts != _parts) {
      _dead = true;
      _have.clear();
      return null;
    }
    if (_have.containsKey(p.part)) return null;
    _have[p.part] = p.bytes;
    if (_have.length < _parts) return null;
    _dead = true;
    final jpeg = BytesBuilder(copy: false);
    for (var i = 0; i < _parts; i++) {
      jpeg.add(_have[i]!);
    }
    _have.clear();
    return ViewerFrame(
      streamId: p.streamId,
      seq: p.seq,
      width: p.width,
      height: p.height,
      scale: p.scale,
      jpeg: jpeg.takeBytes(),
    );
  }
}
