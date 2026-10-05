import 'dart:collection';
import 'dart:ui';

import 'package:xterm/src/core/buffer/line.dart';

/// Draws [line] with its top-left at [offset] — `TerminalPainter.paintLine`.
typedef LinePaint = void Function(
    Canvas canvas, Offset offset, BufferLine line);

/// AUTONOMOUS PATCH: each line's drawing, recorded once and replayed while the
/// line is unchanged ([BufferLine.paintVersion]).
///
/// ⚠️ **This is what makes a scroll cheap.** A scroll moves every line on
/// screen each frame and changes none of them, yet every frame drew each one
/// again cell by cell — a hash, a cache lookup and a `drawParagraph` for every
/// character on screen, some two thousand a frame on a phone. Now a frame
/// replays one picture per line, and only a line that changed is drawn again.
class LinePictureCache {
  LinePictureCache(this._paint, {this.capacity = 256});

  final LinePaint _paint;

  /// A few screens' worth: what a scroll back and forth passes over again. Each
  /// entry is a short display list, not pixels.
  final int capacity;

  /// Least recently drawn first.
  final _pictures = LinkedHashMap<BufferLine, _LinePicture>.identity();

  /// Draws [line] with its top-left at [offset]: its recording while that still
  /// shows the line, else a fresh one.
  void draw(Canvas canvas, Offset offset, BufferLine line) {
    var entry = _pictures.remove(line);
    if (entry == null || entry.version != line.paintVersion) {
      entry?.picture.dispose();
      final recorder = PictureRecorder();
      _paint(Canvas(recorder), Offset.zero, line);
      entry = _LinePicture(recorder.endRecording(), line.paintVersion);
    }
    // Re-inserted, so the map stays least recently drawn first.
    _pictures[line] = entry;
    if (_pictures.length > capacity) {
      _pictures.remove(_pictures.keys.first)!.picture.dispose();
    }
    canvas.save();
    canvas.translate(offset.dx, offset.dy);
    canvas.drawPicture(entry.picture);
    canvas.restore();
  }

  /// Hands over [line]'s recording if it still shows [version], and forgets it:
  /// the caller owns the picture from here, and disposes it. Null when there is
  /// none, or it shows another version.
  ///
  /// What a slide draws the rows that left the screen with
  /// (`RemoteScrollAnimator`): by the time it knows they left, the line has
  /// been written over, and only this recording still shows what it was.
  Picture? take(BufferLine line, int version) {
    final entry = _pictures[line];
    if (entry == null || entry.version != version) return null;
    _pictures.remove(line);
    return entry.picture;
  }

  /// Drops every recording — the font, the scale or the colours changed, or the
  /// lines belong to an emulator that is gone.
  void clear() {
    for (final entry in _pictures.values) {
      entry.picture.dispose();
    }
    _pictures.clear();
  }
}

/// One line's recorded drawing, and the [BufferLine.paintVersion] it shows.
class _LinePicture {
  _LinePicture(this.picture, this.version);

  final Picture picture;
  final int version;
}
