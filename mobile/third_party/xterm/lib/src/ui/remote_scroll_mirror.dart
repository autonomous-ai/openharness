import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/scheduler.dart';
import 'package:xterm/src/core/buffer/line.dart';
import 'package:xterm/src/core/cell.dart';
import 'package:xterm/src/utils/circular_buffer.dart';
import 'package:xterm/src/utils/input_trace.dart';

/// AUTONOMOUS PATCH: a full-screen program's scroll, moved by the finger here
/// and filled in by the program — `TerminalView.altBufferScrollMirror`.
///
/// ⚠️ **On the alternate screen the phone has no history to scroll.** The
/// program (Claude Code's fullscreen renderer) holds it, and every step of a
/// scroll is a wheel event out and a redraw back: drawn as it lands, the screen
/// moves 50–150ms behind the finger, in steps as uneven as the link (measured
/// on a phone, 2026-10-05). No easing of those steps feels like a native list.
///
/// So while a scroll runs, the rows that scroll — the program's own header and
/// prompt rows stay as they are — are drawn from a document of rows kept here,
/// at exactly where the finger puts them, every frame. The program is asked to
/// scroll a few rows AHEAD of the finger ([_lead]), so the rows about to come
/// into view are usually here before they are needed; each whole frame it draws
/// is matched against the document ([_align]) and written into it. When the
/// scroll is over the program is brought back to the row on screen, and drawing
/// goes back to the live screen.
///
/// Coordinates: document row `d` is one row of the program's content. Screen
/// row `i` of the program shows document row [_remote] + i; screen row `s` of
/// the PHONE shows document row [display] + s, a fraction while the finger is
/// between rows. [offset] is the distance between the two, in pixels.
class RemoteScrollMirror {
  RemoteScrollMirror({
    required this.onFrame,
    required this.requestLines,
    required this.requestsIdle,
  });

  /// Something drawn from here moved: paint again.
  final VoidCallback onFrame;

  /// Ask the program to scroll [lines] rows — positive is down, towards newer
  /// rows — through the scroll's pacing.
  final void Function(int lines) requestLines;

  /// Whether every row asked for has gone out and been answered.
  final bool Function() requestsIdle;

  /// How many rows the program is kept ahead of the finger, at most.
  static const _lead = 10;

  /// A match is believed only with at least this many rows agreeing on it…
  static const _minAgree = 4;

  /// …and at least this share of the rows that could show it.
  static const _minAgreeShare = 0.35;

  /// Rows kept either side of the program's screen.
  static const _keepRows = 300;

  /// How fast the screen catches up with the finger after being held at the
  /// edge of what is known, in radians a second (a critically damped spring).
  static const _omega = 40.0;

  /// The longest the program gets to come back to the row on screen.
  static const _settleLimit = Duration(milliseconds: 1500);

  /// Ask again when the program has not moved for this long and nothing is out.
  static const _resyncAfter = Duration(milliseconds: 120);

  final _clock = Stopwatch()..start();

  // The grid the document is in; any change and it is dropped.
  int _rowCount = 0;
  int _columns = 0;
  double _lineHeight = 0;

  /// The rows that scroll, as screen rows; null until a scroll has shown them.
  int? _top;
  int? _bottom;

  /// What the program's screen showed last, one entry per screen row: what a
  /// new frame is compared with.
  List<_Row>? _lastFrame;

  final _document = <int, _DocRow>{};
  int _documentMin = 0;
  int _documentMax = -1;

  /// The document row of the program's screen row 0.
  int _remote = 0;

  /// The document row the program has been asked to show at its row 0.
  int _requested = 0;
  int _requestedAtMs = 0;
  int _frameAtMs = 0;

  bool _scrolling = false;
  bool _active = false;
  bool _settling = false;
  Timer? _settleTimer;

  double _anchorPixels = 0;
  double _anchorRow = 0;
  double _lastPixels = 0;

  /// Where the finger puts document row 0 — fractional.
  double _target = 0;
  double _lastTarget = 0;
  int _direction = 0;

  /// How fast the finger — or the fling — was moving, in rows a second.
  double _fingerVelocity = 0;
  int _lastMoveMs = 0;

  double _display = 0;
  double _velocity = 0;
  bool _chasing = false;
  int? _tick;
  Duration? _lastTick;

  // Trace only.
  int _framesAligned = 0;
  int _framesLost = 0;
  int _clampedUpdates = 0;
  int _startedAtMs = 0;

  /// Whether the rows that scroll are being drawn from here.
  bool get isActive => _active;

  int get top => _top ?? 0;

  int get bottom => _bottom ?? -1;

  /// The document row shown at the phone's screen row 0.
  double get display => _display;

  /// How far the program's rows are drawn from where the program has them —
  /// what a cursor inside the scrolling rows moves by.
  double get offset => (_remote - _display) * _lineHeight;

  /// Document row [row], as last seen; null when it never has been.
  BufferLine? rowAt(int row) => _document[row]?.line;

  int get _nowMs => _clock.elapsedMilliseconds;

  /// A scroll began with the scrollable at [pixels]; [screen]'s first
  /// [rowCount] rows are what the program shows now.
  void begin(
    double pixels,
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
    double lineHeight,
  ) {
    if (_scrolling) return;
    if (!_sameGrid(screen, rowCount, lineHeight)) {
      _forget();
      _takeGrid(screen, rowCount, lineHeight);
    }
    _scrolling = true;
    _settling = false;
    _settleTimer?.cancel();
    _settleTimer = null;
    _startedAtMs = _nowMs;
    _framesAligned = 0;
    _framesLost = 0;
    _clampedUpdates = 0;
    _resyncs = 0;
    // The document may be from the last scroll; the screen may have moved
    // since, under output. This frame says where it is now, or that it is gone.
    _frame(screen, rowCount);
    _anchorPixels = pixels;
    _lastPixels = pixels;
    _anchorRow = _active ? _display : _remote.toDouble();
    _target = _anchorRow;
    _lastTarget = _target;
    // A scroll that catches the last one still settling keeps its books: rows
    // asked for are still on their way.
    if (!_active) _requested = _remote;
    _direction = 0;
    _fingerVelocity = 0;
    _lastMoveMs = _nowMs;
    if (!_active) _display = _remote.toDouble();
    _activateIfReady();
    inputTrace(
      () => 'mirror: begin · ${_document.length} rows known'
          ' (${_documentMin - _remote}..${_documentMax - _remote} from the screen)'
          ' · scrolling rows ${_top ?? '?'}..${_bottom ?? '?'}',
    );
  }

  /// The scrollable is at [pixels]: the finger, or a fling, moved.
  void scrollTo(
    double pixels,
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
    double lineHeight,
  ) {
    if (!_scrolling) begin(pixels, screen, rowCount, lineHeight);
    if (!_scrolling || _lineHeight <= 0) return;
    _lastPixels = pixels;
    _lastTarget = _target;
    _target = _anchorRow + (pixels - _anchorPixels) / _lineHeight;
    final moved = _target - _lastTarget;
    if (moved.abs() > 1e-6) _direction = moved > 0 ? 1 : -1;
    final now = _nowMs;
    final elapsed = now - _lastMoveMs;
    if (elapsed >= 4) {
      _fingerVelocity = moved * 1000 / elapsed;
      _lastMoveMs = now;
    }
    _follow();
    _requestRemote();
    if (_active) onFrame();
  }

  /// The scroll is over: the finger is up and any fling has run out.
  void end() {
    if (!_scrolling) return;
    _scrolling = false;
    _direction = 0;
    if (!_active) {
      // Never shown from here: the program was only ever followed.
      inputTrace(() => 'mirror: end · never shown from the document');
      return;
    }
    _settling = true;
    _target = _target.roundToDouble();
    _settleTimer?.cancel();
    _settleTimer = Timer(_settleLimit, _settleTimedOut);
    // ⚠️ Glided to the whole row, never set there: the last step of a fling is
    // often bigger than what is left to the row, and following exactly would
    // jump it. Starting at the finger's own speed, so the scroll does not stop
    // dead before it eases in.
    if (!_chasing) {
      _chasing = true;
      _velocity = _fingerVelocity.clamp(-40.0, 40.0);
    }
    _requestRemote();
    _scheduleTick();
  }

  /// A whole frame from the program: [screen]'s first [rowCount] rows.
  void frame(
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
    double lineHeight,
  ) {
    if (!_scrolling && !_active) return;
    if (!_sameGrid(screen, rowCount, lineHeight)) {
      inputTrace(() => 'mirror: the grid changed — back to the live screen');
      reset();
      return;
    }
    _frame(screen, rowCount);
    _activateIfReady();
    if (!_active) {
      // Still learning which rows scroll: the program follows the finger.
      _requestRemote();
      return;
    }
    _follow();
    _requestRemote();
    _checkSettled();
    onFrame();
  }

  /// Everything dropped: the document, the scroll, the drawing from here.
  void reset() {
    final wasActive = _active;
    _scrolling = false;
    _settling = false;
    _settleTimer?.cancel();
    _settleTimer = null;
    _cancelTick();
    _active = false;
    _chasing = false;
    _velocity = 0;
    _forget();
    if (wasActive) onFrame();
  }

  void dispose() {
    _settleTimer?.cancel();
    _settleTimer = null;
    _cancelTick();
    _document.clear();
    _lastFrame = null;
  }

  /* The document */

  bool _sameGrid(
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
    double lineHeight,
  ) =>
      rowCount == _rowCount &&
      lineHeight == _lineHeight &&
      screen.length >= rowCount &&
      rowCount > 0 &&
      screen[0].length == _columns;

  void _takeGrid(
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
    double lineHeight,
  ) {
    _rowCount = rowCount;
    _lineHeight = lineHeight;
    _columns = rowCount > 0 && screen.length > 0 ? screen[0].length : 0;
  }

  void _forget() {
    _document.clear();
    _documentMin = 0;
    _documentMax = -1;
    _lastFrame = null;
    _top = null;
    _bottom = null;
    _remote = 0;
    _requested = 0;
    _rowCount = 0;
    _columns = 0;
    _lineHeight = 0;
  }

  /// Matches the screen against what is known, moves [_remote] by what it
  /// finds, and writes the scrolling rows into the document.
  void _frame(IndexAwareCircularBuffer<BufferLine> screen, int rowCount) {
    if (screen.length < rowCount) return;
    _frameAtMs = _nowMs;
    final rows = [
      for (var i = 0; i < rowCount; i++) _Row.of(screen[i]),
    ];
    final last = _lastFrame;
    _lastFrame = rows;
    if (last == null || last.length != rowCount) return;

    // The rows that differ from the last frame where they stand.
    final changed = <int>[
      for (var i = 0; i < rowCount; i++)
        if (!rows[i].blank && rows[i].signature != last[i].signature) i,
    ];
    final top = _top;
    final bottom = _bottom;
    final changedScrolling = top == null || bottom == null
        ? changed.length
        : changed.where((i) => i >= top && i <= bottom).length;
    if (changedScrolling < 3) {
      // Nothing that scrolls moved: a spinner, a prompt row, a cursor.
      _store(screen);
      return;
    }

    final shift = _align(rows, last, changed);
    if (shift == null) {
      _framesLost++;
      _lost();
      _store(screen);
      return;
    }
    _framesAligned++;
    _remote += shift.rows;
    _widenScrollingRows(shift, rows, last);
    _store(screen);
  }

  /// The shift that turned what is known into [rows] — [rows] screen row `i`
  /// shows document row `_remote + shift + i` — or null when nothing is sure.
  _Shift? _align(List<_Row> rows, List<_Row> last, List<int> changed) {
    // The document, once there is one. Before it — the scrolling rows not yet
    // known — the last frame stands in, every row of it; after, the last
    // frame's own rows are in the document, and its fixed rows (a header, the
    // prompt) are not content to match against.
    final useLast = _top == null || _bottom == null;
    int? known(int row) {
      final kept = _document[row];
      if (kept != null) return kept.signature;
      if (!useLast) return null;
      final i = row - _remote;
      if (i >= 0 && i < last.length) return last[i].signature;
      return null;
    }

    final expected = _requested - _remote;
    final reach = _rowCount + 2 * _lead;
    final scores = <({int rows, int agree, int share})>[];
    for (var k = -reach; k <= reach; k++) {
      if (k == 0) continue;
      var agree = 0;
      var comparable = 0;
      for (final i in changed) {
        final signature = known(_remote + k + i);
        if (signature == null) continue;
        comparable++;
        if (signature == rows[i].signature) agree++;
      }
      if (agree >= _minAgree && agree >= comparable * _minAgreeShare) {
        scores.add((rows: k, agree: agree, share: comparable));
      }
    }
    if (scores.isEmpty) return null;
    scores.sort((a, b) => b.agree.compareTo(a.agree));
    final best = scores.first;
    var chosen = best;
    if (scores.length > 1 && scores[1].agree * 2 >= best.agree) {
      // Repeated rows agree with more than one shift: the one nearest to what
      // was asked for is the program's answer.
      final close = scores.where((s) => s.agree * 10 >= best.agree * 8);
      chosen = close.reduce(
        (a, b) =>
            (a.rows - expected).abs() <= (b.rows - expected).abs() ? a : b,
      );
      final rivals = scores.where(
        (s) =>
            s != chosen &&
            (s.rows - expected).abs() == (chosen.rows - expected).abs() &&
            s.agree * 10 >= best.agree * 8,
      );
      if (rivals.isNotEmpty) return null;
    }
    // The rows that moved with it: what bounds the scrolling rows.
    var first = -1;
    var lastRow = -1;
    for (final i in changed) {
      if (known(_remote + chosen.rows + i) == rows[i].signature) {
        if (first < 0) first = i;
        lastRow = i;
      }
    }
    return _Shift(chosen.rows, first, lastRow);
  }

  /// The scrolling rows: those the shift moved, and next to them the rows that
  /// came in with it — up to a row that stood still.
  void _widenScrollingRows(_Shift shift, List<_Row> rows, List<_Row> last) {
    bool stoodStill(int i) =>
        !rows[i].blank && rows[i].signature == last[i].signature;
    var top = shift.first;
    var bottom = shift.last;
    if (top < 0) return;
    // Rows come in on the side the content moves away from.
    for (var n = 0; n < shift.rows.abs() && top > 0; n++) {
      if (shift.rows > 0 || stoodStill(top - 1)) break;
      top--;
    }
    for (var n = 0; n < shift.rows.abs() && bottom < _rowCount - 1; n++) {
      if (shift.rows < 0 || stoodStill(bottom + 1)) break;
      bottom++;
    }
    final known = _top != null && _bottom != null;
    var newTop = known ? math.min(_top!, top) : top;
    var newBottom = known ? math.max(_bottom!, bottom) : bottom;
    // A row at the edge that stood still while everything else moved is the
    // program's own — a status line — and not part of what scrolls.
    while (newTop < newBottom && stoodStill(newTop) && newTop < shift.first) {
      newTop++;
    }
    while (
        newBottom > newTop && stoodStill(newBottom) && newBottom > shift.last) {
      newBottom--;
    }
    if (newTop != _top || newBottom != _bottom) {
      inputTrace(() => 'mirror: scrolling rows $newTop..$newBottom');
    }
    _top = newTop;
    _bottom = newBottom;
  }

  /// The program's scrolling rows into the document, at [_remote].
  void _store(IndexAwareCircularBuffer<BufferLine> screen) {
    final top = _top;
    final bottom = _bottom;
    if (top == null || bottom == null) return;
    for (var i = top; i <= bottom; i++) {
      final row = _remote + i;
      final line = screen[i];
      final kept = _document[row];
      if (kept != null && kept.sameCells(line)) continue;
      _document[row] = _DocRow.copyOf(line);
    }
    final first = _remote + top;
    final last = _remote + bottom;
    if (_documentMax < _documentMin) {
      _documentMin = first;
      _documentMax = last;
    } else {
      _documentMin = math.min(_documentMin, first);
      _documentMax = math.max(_documentMax, last);
    }
    // Only what a scroll could come back to.
    if (_documentMax - _documentMin > 2 * _keepRows + _rowCount) {
      final low = _remote - _keepRows;
      final high = _remote + _rowCount + _keepRows;
      _document.removeWhere((row, _) => row < low || row > high);
      _documentMin = math.max(_documentMin, low);
      _documentMax = math.min(_documentMax, high);
    }
  }

  /// The frame could not be placed: the program drew something else. What is
  /// known is no longer worth anything; start again from this screen.
  void _lost() {
    inputTrace(() => 'mirror: frame not placed — starting again from it');
    _document.clear();
    _documentMin = 0;
    _documentMax = -1;
    final wasActive = _active;
    _active = false;
    _chasing = false;
    _velocity = 0;
    _remote = 0;
    _requested = 0;
    _display = 0;
    if (_scrolling) {
      // The finger carries on from this screen.
      _anchorPixels = _lastPixels;
      _anchorRow = 0;
      _target = 0;
      _lastTarget = 0;
    } else {
      _settling = false;
      _settleTimer?.cancel();
      _settleTimer = null;
    }
    if (wasActive) onFrame();
  }

  void _activateIfReady() {
    if (_active || !_scrolling) return;
    if (_top == null || _bottom == null || _lastFrame == null) return;
    // From the live screen: what is drawn does not move on the switch.
    _active = true;
    _display = _remote.toDouble();
    _velocity = 0;
    _chasing = true;
    _scheduleTick();
    inputTrace(
      () => 'mirror: drawing from the document · rows $_top..$_bottom'
          ' · ${_nowMs - _startedAtMs}ms after the scroll began',
    );
  }

  /* The screen */

  /// Where the screen may be: everything it shows must be known.
  double _clamp(double row) {
    final top = _top ?? 0;
    final bottom = _bottom ?? -1;
    if (_documentMax < _documentMin) return _remote.toDouble();
    final low = (_documentMin - top).toDouble();
    final high = (_documentMax - bottom).toDouble();
    if (high < low) return _remote.toDouble();
    return row.clamp(low, high);
  }

  /// The screen to where the finger is — exactly, unless it is catching up.
  void _follow() {
    if (!_active) return;
    final goal = _clamp(_target);
    if (goal != _target) _clampedUpdates++;
    if (!_chasing) {
      final stride = (_target - _lastTarget).abs() + 1e-6;
      if ((goal - _display).abs() <= stride) {
        _display = goal;
        return;
      }
      _chasing = true;
      _velocity = 0;
    }
    _scheduleTick();
  }

  void _scheduleTick() {
    if (_tick != null) return;
    _tick = SchedulerBinding.instance.scheduleFrameCallback(_onTick);
  }

  void _cancelTick() {
    final id = _tick;
    if (id != null) SchedulerBinding.instance.cancelFrameCallbackWithId(id);
    _tick = null;
    _lastTick = null;
  }

  void _onTick(Duration timeStamp) {
    _tick = null;
    if (!_active) {
      _lastTick = null;
      return;
    }
    final last = _lastTick;
    _lastTick = timeStamp;
    final seconds = last == null
        ? 1 / 60
        : math.max(0, (timeStamp - last).inMicroseconds) / 1e6;
    if (_chasing) {
      // A critically damped spring towards the goal, solved exactly.
      final goal = _clamp(_target);
      final x = _display - goal;
      final decay = math.exp(-_omega * seconds);
      final u = _velocity + _omega * x;
      final next = (x + u * seconds) * decay;
      _velocity = (_velocity - _omega * u * seconds) * decay;
      // Never beyond what is known, however the speed it started with carries
      // it: a row past the document would be drawn as nothing.
      final at = _clamp(goal + next);
      if (at != goal + next) _velocity = 0;
      _display = at;
      if ((at - goal).abs() < 0.01 && _velocity.abs() < 0.5) {
        _display = goal;
        _velocity = 0;
        _chasing = false;
      }
      onFrame();
    }
    _resyncIfStalled();
    _checkSettled();
    if (_active && (_chasing || _settling)) _scheduleTick();
  }

  /* The program */

  /// The program asked to scroll to where the finger is, and a little ahead.
  void _requestRemote() {
    final lead = _scrolling && _active
        ? math.min(_lead, ((_bottom ?? 0) - (_top ?? 0)) ~/ 3) * _direction
        : 0;
    // Settling, the row the screen is coming to rest on — not where it is
    // on the way there.
    final goal = (_settling ? _clamp(_target).round() : _target.round()) + lead;
    final lines = goal - _requested;
    if (lines == 0) return;
    _requested = goal;
    _requestedAtMs = _nowMs;
    requestLines(lines);
  }

  /// Rows asked for and never answered — the program was at an end, or the
  /// pacing let them go — leave the books wrong: start them again from where
  /// the program is.
  void _resyncIfStalled() {
    if (_requested == _remote) return;
    final now = _nowMs;
    if (now - _frameAtMs < _resyncAfter.inMilliseconds) return;
    if (now - _requestedAtMs < _resyncAfter.inMilliseconds) return;
    if (!requestsIdle()) return;
    if (_resyncs < _maxResyncs) {
      _resyncs++;
      _requested = _remote;
      _requestRemote();
      return;
    }
    if (!_settling) return;
    // The program will not come to the row on screen — it scrolls in steps of
    // its own, or it is at an end — so the screen goes to the program's row: a
    // glide of a row or two, rather than a jump when the settle runs out.
    inputTrace(
      () => 'mirror: settling on the program\'s row $_remote'
          ' (asked for ${_clamp(_target).round()})',
    );
    _requested = _remote;
    _target = _remote.toDouble();
    if (!_chasing) {
      _chasing = true;
      _velocity = 0;
    }
    _scheduleTick();
  }

  /// Asked again this many times at most in one scroll: a program at the top
  /// of its history answers nothing, however often it is asked.
  static const _maxResyncs = 3;
  int _resyncs = 0;

  void _checkSettled() {
    if (!_active || !_settling || _chasing) return;
    if (_display != _remote.toDouble()) return;
    final took = _nowMs - _startedAtMs;
    inputTrace(
      () => 'mirror: done in ${took}ms · frames placed $_framesAligned,'
          ' lost $_framesLost · held at the edge $_clampedUpdates times',
    );
    _settling = false;
    _settleTimer?.cancel();
    _settleTimer = null;
    _active = false;
    _cancelTick();
    onFrame();
  }

  void _settleTimedOut() {
    _settleTimer = null;
    if (!_active || !_settling) return;
    inputTrace(
      () => 'mirror: the program did not come back to row'
          ' ${_display.round()} (it is at $_remote) — showing where it is',
    );
    _settling = false;
    _active = false;
    _chasing = false;
    _velocity = 0;
    _display = _remote.toDouble();
    _cancelTick();
    onFrame();
  }
}

/// One screen row, for matching: what it says, and whether it says anything.
class _Row {
  const _Row(this.signature, this.blank);

  factory _Row.of(BufferLine line) {
    final data = line.data;
    final cells = line.length;
    var hash = cells;
    var blank = true;
    for (var i = 0; i < cells; i++) {
      var codePoint = data[i * 4 + 3] & CellContent.codepointMask;
      if (codePoint == 0) codePoint = 0x20;
      if (codePoint != 0x20) blank = false;
      hash = 0x1fffffff & (hash * 31 + codePoint);
    }
    return _Row(hash, blank);
  }

  /// The characters the row shows — not their colours, which Claude Code
  /// changes on a row as it scrolls (see `RemoteScrollAnimator._signature`).
  final int signature;

  final bool blank;
}

/// One row of the document: a copy of the line as it was drawn, kept while the
/// program's screen moves on and writes over the original.
class _DocRow {
  _DocRow(this.line, this.signature);

  factory _DocRow.copyOf(BufferLine source) {
    final line = BufferLine(source.length)
      ..copyFrom(source, 0, 0, source.length);
    return _DocRow(line, _Row.of(line).signature);
  }

  final BufferLine line;
  final int signature;

  /// Whether [other] draws exactly this — every cell, colours included — so the
  /// copy, and its recorded drawing, can stay.
  bool sameCells(BufferLine other) {
    if (other.length != line.length) return false;
    final a = line.data;
    final b = other.data;
    final end = line.length * 4;
    if (a.length < end || b.length < end) return false;
    for (var i = 0; i < end; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}

/// [rows]: the program's screen row `i` now shows what document row
/// `_remote + rows + i` held; [first]..[last]: the rows that agreed.
class _Shift {
  const _Shift(this.rows, this.first, this.last);

  final int rows;
  final int first;
  final int last;
}
