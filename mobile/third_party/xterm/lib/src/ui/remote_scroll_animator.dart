import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter/scheduler.dart';
import 'package:xterm/src/core/buffer/line.dart';
import 'package:xterm/src/core/cell.dart';
import 'package:xterm/src/ui/scroll_shift.dart';
import 'package:xterm/src/utils/circular_buffer.dart';

/// Hands over [line]'s recorded drawing if it still shows [version], or null —
/// `TerminalPainter.takeLinePicture`. The caller owns, and disposes, what it gets.
typedef TakeLinePicture = Picture? Function(BufferLine line, int version);

/// AUTONOMOUS PATCH: slides a full-screen program's content to where its redraw
/// put it, instead of letting the screen jump there — `RenderTerminal`'s side of
/// `TerminalView.altBufferScrollAnimated`.
///
/// ⚠️ **On the alternate screen a scroll is the program's redraw.** The phone
/// sends wheel events and the program answers with a new screen, a few lines on
/// from the last: the text jumps a whole line or more at a time, at whatever
/// moments the replies land. When a redraw arrives within [_armedFor] of a wheel
/// event, it is compared with the screen before it ([detectScrollShift]). Found
/// moved by `n` rows, the moved rows are drawn `n` rows back — exactly where
/// they were — and eased to their place over a few frames. The rows that left
/// are drawn from their last recording ([ghosts]) as they slide out.
///
/// Only a visual offset: the emulator, hit-testing and selection all see the
/// new screen at once. A change that is not a recognisable scroll — output, a
/// redraw of something else — ends any slide on the spot, which is how the
/// screen behaved before.
class RemoteScrollAnimator {
  RemoteScrollAnimator({
    required this.onFrame,
    required this.takePicture,
    this.onShift,
  });

  /// The slide moved: draw again.
  final VoidCallback onFrame;

  final TakeLinePicture takePicture;

  /// Told of each redraw that answered a wheel: the rows it slid, or 0 when it
  /// could not be read as a scroll and the screen jumped.
  void Function(int rows)? onShift;

  /// A redraw this long after the last wheel event is not that scroll's answer.
  static const _armedFor = Duration(milliseconds: 400);

  /// How fast a slide eases in: it keeps `e^-1` of its distance after this
  /// long, and is all but there after three times it.
  static const _easeSeconds = 0.040;

  /// Closer than this, in logical pixels, a slide is there.
  static const _stillBelow = 0.5;

  final _clock = Stopwatch()..start();
  int _armedUntilMs = -1;
  bool _up = false;
  bool _down = false;

  /// The screen as last laid out — what was drawn, and what a redraw is
  /// compared with. Kept only while armed or sliding.
  List<BufferLine>? _lines;
  List<int>? _versions;
  List<int>? _signatures;

  int _top = 0;
  int _bottom = -1;
  double _offset = 0;
  double _lineHeight = 0;

  /// Rows that slid out of the region, by the row they would occupy now —
  /// outside [top]..[bottom] — each drawn from its last recording.
  final _ghosts = <int, Picture>{};

  int? _frameCallbackId;
  Duration? _lastTick;

  bool get _armed => _clock.elapsedMilliseconds < _armedUntilMs;

  /// Whether rows [top]..[bottom] are drawn [offset] pixels from their place.
  bool get isSliding => _offset != 0;

  int get top => _top;

  int get bottom => _bottom;

  double get offset => _offset;

  Iterable<MapEntry<int, Picture>> get ghosts => _ghosts.entries;

  /// [lines] wheel lines were just sent, negative for up. The first [rowCount]
  /// rows of [screen], each [lineHeight] tall, are what is on screen now.
  void expect(
    int lines,
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
    double lineHeight,
  ) {
    if (lines == 0 || screen.length < rowCount) return;
    if (!_armed) {
      _up = false;
      _down = false;
    }
    if (lines < 0) {
      _up = true;
    } else {
      _down = true;
    }
    _armedUntilMs = _clock.elapsedMilliseconds + _armedFor.inMilliseconds;
    if (_signatures == null) _remember(screen, rowCount, lineHeight);
  }

  /// The screen was laid out again: [screen]'s first [rowCount] rows, each
  /// [lineHeight] tall, are what the next frame draws.
  void update(
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
    double lineHeight,
  ) {
    if (!_armed && !isSliding) {
      _forgetScreen();
      return;
    }
    if (screen.length < rowCount) {
      reset();
      return;
    }
    final before = _signatures;
    if (before == null ||
        before.length != rowCount ||
        lineHeight != _lineHeight) {
      // A different grid: nothing to compare with.
      finish();
      _remember(screen, rowCount, lineHeight);
      return;
    }
    if (_unchanged(screen, rowCount)) return;

    final lines = List<BufferLine>.generate(rowCount, (row) => screen[row]);
    final versions = List<int>.generate(rowCount, (row) => lines[row].paintVersion);
    final signatures = List<int>.filled(rowCount, 0);
    final blank = List<bool>.filled(rowCount, false);
    for (var row = 0; row < rowCount; row++) {
      signatures[row] = _signature(lines[row]);
      blank[row] = _isBlank(lines[row]);
    }

    if (_armed) {
      final shift = detectScrollShift(
        before: before,
        after: signatures,
        blank: blank,
        up: _up,
        down: _down,
      );
      if (shift != null && _slide(shift, lineHeight)) {
        onShift?.call(shift.rows);
      } else {
        finish();
        onShift?.call(0);
      }
    } else {
      // Changed after the scroll was over: output, not a scroll. Jump.
      finish();
    }

    _lines = lines;
    _versions = versions;
    _signatures = signatures;
  }

  /// Ends any slide where it stands: everything at its place.
  void finish() {
    final id = _frameCallbackId;
    if (id != null) {
      SchedulerBinding.instance.cancelFrameCallbackWithId(id);
      _frameCallbackId = null;
    }
    _lastTick = null;
    _offset = 0;
    _disposeGhosts();
  }

  /// Back to how it was made: not armed, nothing remembered, nothing sliding.
  void reset() {
    finish();
    _forgetScreen();
    _armedUntilMs = -1;
    _up = false;
    _down = false;
  }

  void dispose() => reset();

  bool _slide(ScrollShift shift, double lineHeight) {
    final lines = _lines;
    final versions = _versions;
    if (lines == null || versions == null) return false;
    final carried = isSliding ? _offset : 0.0;
    final offset = carried + shift.rows * lineHeight;
    // Farther than the region is tall, there is nothing on screen to slide.
    if (offset.abs() >= (shift.bottom - shift.top + 1) * lineHeight) {
      return false;
    }
    if (offset == 0) {
      // This shift undid what was still sliding: everything is in place.
      finish();
      return true;
    }

    if (carried == 0) {
      _disposeGhosts();
    } else if (_ghosts.isNotEmpty) {
      // Row `r` before is row `r - rows` now.
      final moved = {
        for (final ghost in _ghosts.entries)
          ghost.key - shift.rows: ghost.value,
      };
      _ghosts
        ..clear()
        ..addAll(moved);
    }
    // The rows that left the region slide out from where they were.
    for (var row = shift.top; row <= shift.bottom; row++) {
      final at = row - shift.rows;
      if (at >= shift.top && at <= shift.bottom) continue;
      final picture = takePicture(lines[row], versions[row]);
      if (picture == null) continue;
      _ghosts.remove(at)?.dispose();
      _ghosts[at] = picture;
    }

    _top = shift.top;
    _bottom = shift.bottom;
    _offset = offset;
    _pruneGhosts();
    _scheduleTick();
    return true;
  }

  void _scheduleTick() {
    if (_frameCallbackId != null) return;
    _frameCallbackId =
        SchedulerBinding.instance.scheduleFrameCallback(_tick);
  }

  void _tick(Duration timeStamp) {
    _frameCallbackId = null;
    if (!isSliding) return;
    final last = _lastTick;
    _lastTick = timeStamp;
    final seconds = last == null
        ? 1 / 60
        : math.max(0, (timeStamp - last).inMicroseconds) / 1e6;
    _offset *= math.exp(-seconds / _easeSeconds);
    if (_offset.abs() < _stillBelow) {
      finish();
    } else {
      _pruneGhosts();
      _scheduleTick();
    }
    onFrame();
  }

  /// Drops the ghosts the slide can no longer bring into the region: it only
  /// ever closes in on zero, so a ghost out of reach now stays out of it.
  void _pruneGhosts() {
    if (_ghosts.isEmpty) return;
    final reach = _lineHeight > 0 ? (_offset.abs() / _lineHeight).ceil() : 0;
    _ghosts.removeWhere((at, picture) {
      final inReach = _offset < 0
          ? at > _bottom && at <= _bottom + reach
          : at < _top && at >= _top - reach;
      if (!inReach) picture.dispose();
      return !inReach;
    });
  }

  void _disposeGhosts() {
    for (final picture in _ghosts.values) {
      picture.dispose();
    }
    _ghosts.clear();
  }

  void _remember(
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
    double lineHeight,
  ) {
    final lines = List<BufferLine>.generate(rowCount, (row) => screen[row]);
    _lineHeight = lineHeight;
    _lines = lines;
    _versions = [for (final line in lines) line.paintVersion];
    _signatures = [for (final line in lines) _signature(line)];
  }

  void _forgetScreen() {
    _lines = null;
    _versions = null;
    _signatures = null;
  }

  bool _unchanged(IndexAwareCircularBuffer<BufferLine> screen, int rowCount) {
    final lines = _lines!;
    final versions = _versions!;
    for (var row = 0; row < rowCount; row++) {
      final line = screen[row];
      if (!identical(line, lines[row]) ||
          line.paintVersion != versions[row]) {
        return false;
      }
    }
    return true;
  }

  /// Everything the row draws — characters, colours, attributes — as one number.
  static int _signature(BufferLine line) {
    final data = line.data;
    final end = line.length * 4;
    var hash = line.length;
    for (var i = 0; i < end; i++) {
      hash = 0x1fffffff & (hash * 31 + data[i]);
    }
    return hash;
  }

  /// Nothing but spaces: such a row matches any other, so it proves no shift.
  static bool _isBlank(BufferLine line) {
    final data = line.data;
    final end = line.length * 4;
    for (var i = 3; i < end; i += 4) {
      final codePoint = data[i] & CellContent.codepointMask;
      if (codePoint != 0 && codePoint != 0x20) return false;
    }
    return true;
  }
}
