import 'dart:ui';

import 'package:xterm/src/core/buffer/line.dart';

/// Recorded drawings of buffer lines, reused for as long as a line's
/// [BufferLine.paintVersion] holds.
///
/// A frame used to draw every visible cell again, one paragraph per cell, even
/// when a single line had changed — and a blinking cursor repainted the whole
/// grid twice a second. Lines keep their identity while they scroll (see
/// `Buffer.scrollUp`/`index`), so a drawing keyed by the line object follows
/// it up the screen and only the lines that actually changed are recorded
/// again.
///
/// The cache holds only what the last frame drew: [endFrame] disposes every
/// drawing the frame did not use, so it never outgrows the viewport.
class LinePictureCache {
  final _entries = <BufferLine, _LinePicture>{};
  var _frame = 0;

  /// The number of lines with a drawing held.
  int get length => _entries.length;

  /// Starts a frame; every [lookup] or [store] until [endFrame] marks its line
  /// as still on screen.
  void beginFrame() => _frame++;

  /// The drawing of [line] if it is current and was recorded at [phase], or
  /// null when it must be recorded.
  Picture? lookup(BufferLine line, [Offset phase = Offset.zero]) {
    final entry = _entries[line];
    if (entry == null ||
        entry.version != line.paintVersion ||
        entry.phase != phase) {
      return null;
    }
    entry.frame = _frame;
    return entry.picture;
  }

  /// Holds [picture] as the drawing of [line] at its current version, recorded
  /// at [phase], replacing (and disposing) any older one.
  void store(BufferLine line, Picture picture, [Offset phase = Offset.zero]) {
    final old = _entries[line];
    if (old != null && !identical(old.picture, picture)) old.picture.dispose();
    _entries[line] = _LinePicture(picture, line.paintVersion, phase, _frame);
  }

  /// Disposes every drawing the current frame did not use: lines that scrolled
  /// out of view, were dropped from the buffer, or belong to the other buffer.
  void endFrame() {
    _entries.removeWhere((_, entry) {
      if (entry.frame == _frame) return false;
      entry.picture.dispose();
      return true;
    });
  }

  /// Disposes everything — the drawings no longer match what a line would draw
  /// (theme, font, text scale or pixel ratio changed), or nothing is drawn.
  void clear() {
    for (final entry in _entries.values) {
      entry.picture.dispose();
    }
    _entries.clear();
  }
}

class _LinePicture {
  _LinePicture(this.picture, this.version, this.phase, this.frame);

  final Picture picture;
  final int version;
  final Offset phase;
  int frame;
}
