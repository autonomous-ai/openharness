import 'dart:ui';
import 'dart:typed_data';

import 'package:xterm/src/core/buffer/line.dart';

/// Recorded drawings of buffer lines, reused while their final cells match.
///
/// A frame used to draw every visible cell again, one paragraph per cell, even
/// when a single line had changed — and a blinking cursor repainted the whole
/// grid twice a second. Lines keep their identity while they scroll (see
/// `Buffer.scrollUp`/`index`), so a drawing keyed by the line object follows
/// it up the screen and only the lines that actually changed are recorded
/// again.
///
/// A TUI can erase a row and write the same cells back before the next paint.
/// Its version changes, but its drawing does not. Keep an exact cell snapshot
/// to recognize that case; unchanged versions still take the constant-time path.
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
    if (entry == null || entry.phase != phase) {
      return null;
    }
    if (entry.version != line.paintVersion) {
      if (!entry.matchesCells(line)) return null;
      entry.version = line.paintVersion;
    }
    entry.frame = _frame;
    return entry.picture;
  }

  /// Holds [picture] as the drawing of [line] at its current version, recorded
  /// at [phase], replacing (and disposing) any older one.
  void store(BufferLine line, Picture picture, [Offset phase = Offset.zero]) {
    final old = _entries[line];
    if (old != null && !identical(old.picture, picture)) old.picture.dispose();
    if (old == null) {
      _entries[line] = _LinePicture(picture, line, phase, _frame);
    } else {
      old.update(picture, line, phase, _frame);
    }
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
  _LinePicture(this.picture, BufferLine line, this.phase, this.frame)
      : version = line.paintVersion,
        length = line.length,
        cells = Uint32List.fromList(line.data);

  Picture picture;
  int version;
  Offset phase;
  int length;
  Uint32List cells;
  int frame;

  void update(Picture picture, BufferLine line, Offset phase, int frame) {
    this.picture = picture;
    version = line.paintVersion;
    this.phase = phase;
    this.frame = frame;
    length = line.length;
    final data = line.data;
    // Reuse storage when a row really changes on every frame. The snapshot is
    // still private to this drawing; it never aliases the live terminal cells.
    if (cells.length == data.length) {
      cells.setAll(0, data);
    } else {
      cells = Uint32List.fromList(data);
    }
  }

  bool matchesCells(BufferLine line) {
    final data = line.data;
    if (length != line.length || cells.length != data.length) return false;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i] != data[i]) return false;
    }
    // Hyperlink destinations are not drawn by TerminalPainter.paintLine;
    // hover/selection overlays keep reading the live buffer independently.
    return true;
  }
}
