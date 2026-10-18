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
/// scroll a few rows AHEAD of the finger ([_leadRows]), so the rows about to come
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
    required this.cancelRequests,
    this.pageKeysEnabled,
    this.requestPage,
    this.readScreen,
  });

  /// The program's whole screen now, for [_prefetch] to start from — null
  /// when it cannot be read whole (a frame still arriving, another screen).
  final RemoteScreen? Function()? readScreen;

  /// Whether the program may be scrolled a page at a time with its Page Up and
  /// Page Down keys at all — see [_pageOrWait].
  final bool Function()? pageKeysEnabled;

  /// Press Page Down ([direction] positive) or Page Up once, alone; false when
  /// it was not sent.
  final bool Function(int direction)? requestPage;

  /// Something drawn from here moved: paint again.
  final VoidCallback onFrame;

  /// Ask the program to scroll [lines] rows — positive is down, towards newer
  /// rows — through the scroll's pacing.
  final void Function(int lines) requestLines;

  /// Whether every row asked for has gone out and been answered.
  final bool Function() requestsIdle;

  /// Rows asked for and not yet sent are not to be — returns how many, to come
  /// off the books.
  final int Function() cancelRequests;

  /// How many rows the program is kept ahead of the finger ([_leadRows]): at
  /// least [_leadMin], plus what the finger covers in [_leadLatency] seconds —
  /// about a round trip and the program's redraw — and never more than
  /// [_leadMax] or half the rows that scroll.
  static const _leadMin = 6;
  static const _leadMax = 16;
  static const _leadLatency = 0.15;

  /// The most rows past the last row the program was seen at that it is asked
  /// to scroll — see [_requestRemote].
  static const _maxAhead = 24;

  /// The most rows the finger is let run past the edge of what is known — see
  /// [_capLag].
  static const _maxLag = 3.0;

  /// A finger that moves less than this many rows has not moved: held on the
  /// glass, it still reports a pixel or two either way.
  static const _stillRows = 0.5;

  /// Settling, a program closer than this to the row on screen is brought the
  /// rest of the way a burst at a time, each counted from where it stopped —
  /// see [_settleStep].
  static const _landingRows = 8;

  /// The most rows asked of the program at once while it lands: as many wheel
  /// events as Claude Code scrolls one row each (`_exactBurst` in the scroll
  /// handler).
  static const _landingBurst = 4;

  /// A match is believed only with at least this many rows agreeing on it…
  static const _minAgree = 5;

  /// …and at least half the rows that could show it.
  ///
  /// ⚠️ A wrong match writes the frame's rows into the document where they do
  /// not belong — and the screen, drawn from it, shows rows out of order
  /// (reported on a phone, 2026-10-06, at 4 rows and 35%). A scroll moves rows
  /// whole, so a true match has nearly all the rows it can show agreeing; a
  /// frame no match is sure of is let go ([_lost]) rather than guessed.
  static const _minAgreeShare = 0.5;

  /// Rows kept either side of the program's screen.
  ///
  /// ⚠️ **A long session is read back over hundreds of rows.** At 300 a side,
  /// the rows read past were let go — 618 known fell to 364 mid-read — and
  /// scrolling back over them waited on the program again (measured on a
  /// phone, 2026-10-06, a session hours long). A row is about a kilobyte.
  static const _keepRows = 2000;

  /// Frames running that may go unplaced while the finger scrolls before the
  /// document starts again — see [_frame].
  ///
  /// ⚠️ **One frame no match is sure of is not the document gone wrong.** A
  /// frame caught mid-redraw, or one the program drew over with a row of its
  /// own, matches nothing; thrown away for it, every row known went, and
  /// scrolling back over them waited on the program again (36 of 59 lost
  /// frames came first in a scroll, the document thrown away each time,
  /// measured on a phone, 2026-10-06). Kept through one or two, the screen
  /// goes on from the document and the next frame says where the program is.
  static const _maxMissesInARow = 2;

  /// Rows set aside are taken back only when this many rows of a screen…
  static const _reattachAgree = 10;

  /// …or this many, when every row that could agree did (a screen of short
  /// content, 8 of 8, was turned away at ten, measured on a phone,
  /// 2026-10-06)…
  static const _reattachAgreeAll = 8;

  /// …and this share of those that could, show them, with no other placing
  /// near as good — see [_reattach].
  static const _reattachShare = 0.9;

  /// While the finger moves over rows already known, the program is let fall
  /// this far behind it at most — see [_knownFarEnough].
  static const _lazyReach = 48;

  /// A page key unanswered this long went nowhere — the program at an end of
  /// its transcript, or the key taken by something else. Not shorter: in a
  /// long session Claude Code took 130ms and more to draw a page (p90,
  /// measured on a phone, 2026-10-06).
  static const _pageWait = Duration(milliseconds: 400);

  /// A page shorter than this is not worth a key: wheel events do as well.
  static const _minPage = 6;

  /// A finger faster than this, in rows a second, is scrolled after with page
  /// keys only — see [_pageOrWait]'s `fast`.
  static const _pageSpeed = 120.0;

  /// How long the program must have drawn nothing, and the finger been off the
  /// glass, before the rows above are fetched ahead — see [_prefetch].
  static const _prefetchAfter = Duration(milliseconds: 1200);

  /// How many rows above the screen [_prefetch] has the document reach: three
  /// or four screens of a phone.
  static const _prefetchRows = 120;

  /// About how fast the program scrolls, in rows a second: four wheel events
  /// every 50ms (`_exactBurst` and `_burstGap` in the scroll handler) move it
  /// ~80, less a margin for the link.
  static const _programRowsPerSecond = 60.0;

  /// How fast the screen catches up with the finger after being held at the
  /// edge of what is known, in radians a second (a critically damped spring).
  static const _omega = 40.0;

  /// The same spring while the screen comes after rows still arriving — the
  /// finger past the edge of what is known ([_streaming]): softer, so each
  /// page that lands is part of one glide rather than a step of its own.
  ///
  /// ⚠️ **At 40 the screen jumped to each page and stopped.** Rows come in a
  /// page (~17) at a time, every 50–130ms in a long session; at [_omega] the
  /// screen caught up with each in ~100ms and stood waiting for the next —
  /// moving in pulses, ~15 a second (reported on a phone as stuttering,
  /// 2026-10-06). At 20 a landing page is spread over the time to the next:
  /// the screen moves on at the rate the rows come in, about a page behind
  /// the newest of them.
  static const _omegaStream = 20.0;

  /// The least time between two looks for where the rows set aside belong:
  /// with thousands of them, one look is thousands of comparisons, and every
  /// frame of a scroll is a new screen to look for.
  static const _reattachEvery = Duration(milliseconds: 150);

  /// How long the program must have stood still after wheel events before a
  /// page key goes — see [_wheelsGliding].
  static const _wheelsSettle = Duration(milliseconds: 40);

  /// The longest the program gets to come back to the row on screen without
  /// moving — see [_armSettleTimer].
  static const _settleLimit = Duration(milliseconds: 1500);

  /// Ask again when the program has not moved for this long and nothing is out.
  static const _resyncAfter = Duration(milliseconds: 120);

  /// A finger that has not moved for this long has stopped — see [_dropLag].
  static const _stillAfter = Duration(milliseconds: 100);

  /// How long the program must have stood still before the screen goes back to
  /// it — see [_checkSettled].
  static const _settleQuiet = Duration(milliseconds: 100);

  final _clock = Stopwatch()..start();

  // The grid the document is in; any change and it is dropped.
  int _rowCount = 0;
  int _columns = 0;
  double _lineHeight = 0;

  /// The rows that scroll, as screen rows; null until a scroll has shown them.
  int? _top;
  int? _bottom;

  /// Screen rows that are the program's own — a pinned prompt above, a "jump
  /// to bottom" line below — never taken into the rows that scroll. See
  /// [_learnFixedRows].
  final _fixedRows = <int>{};

  /// How many placed frames running each screen row outside the rows that
  /// moved stood still in — see [_learnFixedRows].
  final _stoodStill = <int, int>{};

  /// What the program's screen showed last, one entry per screen row: what a
  /// new frame is compared with.
  List<_Row>? _lastFrame;

  final _document = <int, _DocRow>{};
  int _documentMin = 0;
  int _documentMax = -1;

  /// Rows known before the document last had to start again, in their own
  /// numbering, and the first and last of them — see [_setAside].
  Map<int, _DocRow>? _aside;
  int _asideMin = 0;
  int _asideMax = -1;

  /// The screen [_reattach] last looked for among the rows set aside, and when.
  int? _reattachTried;
  int _reattachAtMs = -1 << 30;

  /// Frames running not placed while the finger scrolls, the document kept
  /// through them — see [_maxMissesInARow].
  int _missesInARow = 0;

  /// Whether the program's last whole screen showed its prompt — when a page
  /// key scrolls its transcript ([_promptShown]).
  bool _pageKeysSafe = false;

  /// Whether a page key was refused this scroll: wheel events from then on.
  bool _pageKeysRefused = false;

  /// A page key on its way, which way, when, from which row, and whether
  /// nothing else was — see [_pageOrWait] and [_pageLanded].
  bool _pageInFlight = false;
  int _pageDirection = 0;
  int _pageSentAtMs = 0;
  int _pageFromRemote = 0;

  /// When wheel rows were last asked, and a page last landed — see
  /// [_wheelsGliding].
  int _wheelsAtMs = -1 << 30;
  int _pageLandedAtMs = -1 << 30;

  /// Whether the screen is coming after rows still arriving, on the softer
  /// spring — see [_omegaStream].
  bool _streaming = false;

  /// Where what is known is kept between emulators and views — see
  /// [RemoteScrollMemory].
  RemoteScrollMemory? _memory;

  /// Whether rows were learned since what is known was last kept in [_memory].
  bool _learned = false;

  /// Fetching rows ahead while nobody scrolls ([_prefetch]): the timer that
  /// starts it, whether it runs, the program's row 0 it goes to, and since when.
  Timer? _prefetchTimer;
  bool _prefetching = false;
  int _prefetchGoal = 0;
  int _prefetchStartedAtMs = 0;

  /// The document row the program's transcript starts at, once a page up went
  /// nowhere: nothing above it to fetch.
  int? _topRow;

  /// Whether the last page key went nowhere ([_expirePage]).
  bool _pageNowhere = false;

  /// The program's own rows as they were when [_prefetch] began, drawn in
  /// place of the live ones until it is over — see [heldRow] — and the
  /// prompt's text then, which a key typed changes.
  final _held = <int, BufferLine>{};
  String? _heldPrompt;

  /// The document row of the program's screen row 0.
  int _remote = 0;

  /// The document row the program has been asked to show at its row 0.
  int _requested = 0;
  int _requestedAtMs = 0;

  /// Which way the program was last asked to scroll: -1 up, 1 down, 0 not yet.
  int _askedDirection = 0;

  /// When a frame last showed the program's rows moved.
  int _movedAtMs = 0;

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

  /// How fast the finger — or the fling — was moving, in rows a second,
  /// measured from [_velocityPixels] at [_velocityAtMs].
  double _fingerVelocity = 0;
  double _velocityPixels = 0;
  int _velocityAtMs = 0;

  /// When the finger last moved — by [_stillRows] or more, from [_stillPixels].
  int _lastMoveMs = 0;
  double _stillPixels = 0;

  double _display = 0;
  double _velocity = 0;
  bool _chasing = false;
  int? _tick;
  Duration? _lastTick;

  // Trace only.
  ({int rows, int agree, int share, int? rival})? _miss;
  int _framesAligned = 0;
  int _framesLost = 0;
  int _clampedUpdates = 0;
  double _lagDropped = 0;
  int _settleAsks = 0;
  int _rowsGuarded = 0;
  int _rowsMended = 0;
  int _asksSpared = 0;
  int _rowsAsked = 0;
  int _pagesSent = 0;
  int _startedAtMs = 0;
  int _endedAtMs = 0;

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

  /// The program's own screen row [row] to draw in place of the live one —
  /// held as it was while rows are fetched ahead ([_prefetch]), so its pinned
  /// prompt and "jump to bottom" line, which come up as the program scrolls,
  /// do not flash on a screen nobody scrolled. Null: draw the live row.
  BufferLine? heldRow(int row) => _held[row];

  /// Where what is known is kept between emulators and views — see
  /// [RemoteScrollMemory]. Null keeps it in this mirror only.
  RemoteScrollMemory? get memory => _memory;
  set memory(RemoteScrollMemory? value) {
    if (identical(value, _memory)) return;
    // What is known belongs to the program it was learned from: kept there.
    reset();
    _memory = value;
  }

  int get _nowMs => _clock.elapsedMilliseconds;

  /// A scroll began with the scrollable at [pixels]; [screen]'s first
  /// [rowCount] rows are what the program shows now — read only when
  /// [screenWhole]: not while a frame of the program's is still arriving,
  /// part old and part new (see `RenderTerminal._updateRemoteScroll`).
  void begin(
    double pixels,
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
    double lineHeight, {
    bool screenWhole = true,
  }) {
    if (_scrolling) return;
    if (!_sameGrid(screen, rowCount, lineHeight)) {
      _forget();
      _takeGrid(screen, rowCount, lineHeight);
      _load();
    }
    // Fetching ahead gives way to the finger: what it asked is still counted.
    _stopPrefetch();
    _scrolling = true;
    _settling = false;
    _settleTimer?.cancel();
    _settleTimer = null;
    _startedAtMs = _nowMs;
    _framesAligned = 0;
    _framesLost = 0;
    _clampedUpdates = 0;
    _lagDropped = 0;
    _settleAsks = 0;
    _rowsGuarded = 0;
    _rowsMended = 0;
    _asksSpared = 0;
    _rowsAsked = 0;
    _pagesSent = 0;
    _pageKeysRefused = false;
    _resyncs = 0;
    _missesInARow = 0;
    if (screenWhole) _readPrompt(screen, rowCount);
    // The document may be from the last scroll; the screen may have moved
    // since, under output. This frame says where it is now, or that it is gone.
    if (screenWhole) _frame(screen, rowCount);
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
    _velocityPixels = pixels;
    _velocityAtMs = _nowMs;
    _lastMoveMs = _nowMs;
    _stillPixels = pixels;
    if (!_active) _display = _remote.toDouble();
    _activateIfReady();
    inputTrace(
      () => 'mirror: begin · ${_document.length} rows known'
          ' (${_documentMin - _remote}..${_documentMax - _remote} from the screen)'
          '${_aside == null ? '' : ' · ${_aside!.length} set aside'}'
          ' · scrolling rows ${_top ?? '?'}..${_bottom ?? '?'}'
          '${pageKeysEnabled?.call() ?? false ? ' · page keys ${_pageKeysSafe ? 'on' : 'off, no prompt on screen'}' : ''}',
    );
  }

  /// The scrollable is at [pixels]: the finger, or a fling, moved.
  void scrollTo(
    double pixels,
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
    double lineHeight, {
    bool screenWhole = true,
  }) {
    if (!_scrolling) {
      begin(pixels, screen, rowCount, lineHeight, screenWhole: screenWhole);
    }
    if (!_scrolling || _lineHeight <= 0) return;
    _lastPixels = pixels;
    _lastTarget = _target;
    _target = _anchorRow + (pixels - _anchorPixels) / _lineHeight;
    final now = _nowMs;
    // Moved, not merely held: a finger at rest on the glass still reports a
    // pixel or two either way. Counted as moves, it was never still — and the
    // screen went on catching up with it (see [_dropLag]).
    final moved = pixels - _stillPixels;
    if (moved.abs() >= _stillRows * _lineHeight) {
      _direction = moved > 0 ? 1 : -1;
      _stillPixels = pixels;
      _lastMoveMs = now;
    }
    final elapsed = now - _velocityAtMs;
    if (elapsed >= 8) {
      _fingerVelocity =
          (pixels - _velocityPixels) / _lineHeight * 1000 / elapsed;
      _velocityPixels = pixels;
      _velocityAtMs = now;
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
    if (_missesInARow > 0) {
      // Where the program is was never found again: it cannot be brought back
      // to the row on screen, so the screen goes to the program's — the rows
      // known set aside, to be taken back ([_reattach]).
      _missesInARow = 0;
      _lost();
    }
    if (!_active) {
      // Never shown from here: the program was only ever followed — and stops
      // with the finger, so what waits for it is not sent.
      _requested -= cancelRequests();
      inputTrace(() => 'mirror: end · never shown from the document');
      return;
    }
    _settling = true;
    _endedAtMs = _nowMs;
    _armSettleTimer();
    final still = _fingerStill;
    // ⚠️ Glided to the whole row, never set there: the last step of a fling is
    // often bigger than what is left to the row, and following exactly would
    // jump it. Starting at the finger's own speed, so the scroll does not stop
    // dead before it eases in — but only if it was still moving as it let go:
    // the speed it last moved at, long before, glided on by itself.
    if (!_chasing) {
      _chasing = true;
      _velocity = still ? 0.0 : _fingerVelocity.clamp(-40.0, 40.0);
    }
    // The row the screen comes to rest on from where it is — not the row the
    // finger got to, which the screen may be behind: see [_capLag].
    _target = _restingRow().roundToDouble();
    // From here the screen only glides to that row: a change in what is known
    // is chased, never jumped by a stride the finger once took.
    _lastTarget = _target;
    // What still waits to go out was for where the finger was going.
    final dropped = cancelRequests();
    _requested -= dropped;
    inputTrace(
      () => 'mirror: end · finger'
          ' ${still ? 'still' : 'at ${_fingerVelocity.round()} rows/s'}'
          ' · resting on row ${_target.round()}'
          ' (screen at ${_display.toStringAsFixed(1)}) · program at $_remote,'
          ' asked to $_requested · $dropped waiting rows dropped',
    );
    _settleStep();
    _scheduleTick();
  }

  /// The program has [_settleLimit] to come back to the row on screen — from
  /// the last time it moved, not from when the scroll ended.
  ///
  /// ⚠️ **A long way back takes as long as it takes.** Over rows seen before,
  /// the screen runs far ahead of a program that scrolls ~80 rows a second:
  /// coming back 250 rows took 3s, and a limit from the scroll's end showed the
  /// program's row after 1.5s — the screen jumping 130 rows by itself
  /// (measured on a phone, 2026-10-06). The limit is for a program that has
  /// stopped coming.
  void _armSettleTimer() {
    _settleTimer?.cancel();
    _settleTimer = Timer(_settleLimit, _settleTimedOut);
  }

  /// Whether the finger has not moved [_stillRows] for [_stillAfter]: held
  /// still, or let go without a fling.
  bool get _fingerStill => _nowMs - _lastMoveMs >= _stillAfter.inMilliseconds;

  /// The row the screen comes to rest on from where it is, moving as it is: a
  /// critically damped spring set off at speed `v` covers `v / ω` more.
  double _restingRow() => _clamp(_display + _velocity / _omegaNow);

  /// The spring the screen moves on now — see [_omegaStream].
  double get _omegaNow => _streaming ? _omegaStream : _omega;

  /// What the screen is behind the finger is let go once the finger has
  /// stopped: the screen comes to rest where it is, and the finger's next move
  /// counts from there.
  ///
  /// ⚠️ **The screen moves only while the finger does.** Held at the edge of
  /// what is known, the screen falls behind a fast finger, and it used to
  /// catch up after the finger stopped — scrolling on by itself, the finger
  /// still or already lifted (reported on a phone, 2026-10-06).
  void _dropLag() {
    if (!_scrolling || !_active || !_fingerStill) return;
    final rest = _restingRow();
    if ((_target - rest).abs() < 0.5) return;
    _anchorRow = rest;
    _anchorPixels = _lastPixels;
    _target = rest;
    _lastTarget = rest;
    _requested -= cancelRequests();
    _requestRemote();
  }

  /// A whole frame from the program: [screen]'s first [rowCount] rows.
  void frame(
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
    double lineHeight,
  ) {
    if (!_scrolling && !_active) {
      // The program drew: fetching ahead waits until it has been quiet.
      _armPrefetch();
      return;
    }
    if (!_sameGrid(screen, rowCount, lineHeight)) {
      inputTrace(() => 'mirror: the grid changed — back to the live screen');
      reset();
      return;
    }
    _readPrompt(screen, rowCount);
    if (_held.isNotEmpty && _promptText(screen, rowCount) != _heldPrompt) {
      // A key typed while rows were fetched ahead: the program's own rows are
      // drawn live again, and it is brought back to the row on screen.
      inputTrace(() => 'mirror: typed into while fetching ahead — back');
      _held.clear();
      if (_prefetching) _endPrefetch();
      onFrame();
    }
    _frame(screen, rowCount);
    _activateIfReady();
    if (!_active) {
      // Still learning which rows scroll: the program follows the finger.
      _requestRemote();
      return;
    }
    _follow();
    if (_prefetching) {
      _prefetchStep();
    } else if (_settling) {
      _settleStep();
    } else {
      _requestRemote();
    }
    onFrame();
  }

  /// Everything dropped: the document, the scroll, the drawing from here.
  void reset() {
    final wasActive = _active;
    cancelRequests();
    _prefetchTimer?.cancel();
    _prefetchTimer = null;
    _stopPrefetch();
    _save();
    _scrolling = false;
    _settling = false;
    _settleTimer?.cancel();
    _settleTimer = null;
    _cancelTick();
    _active = false;
    _chasing = false;
    _streaming = false;
    _velocity = 0;
    _missesInARow = 0;
    _forget();
    if (wasActive) onFrame();
  }

  void dispose() {
    _save();
    _settleTimer?.cancel();
    _settleTimer = null;
    _prefetchTimer?.cancel();
    _prefetchTimer = null;
    _cancelTick();
    _document.clear();
    _aside = null;
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

  /// What is known — the rows, which of them scroll, which are the program's
  /// own — kept in [_memory], for the next emulator or view of this program.
  /// The rows kept are the document's, or the rows set aside, whichever are
  /// more.
  void _save() {
    final memory = _memory;
    final top = _top;
    final bottom = _bottom;
    if (memory == null || !_learned || _rowCount == 0) return;
    if (top == null || bottom == null) return;
    final aside = _aside;
    final useAside = aside != null && aside.length > _document.length;
    var rows = useAside ? aside : _document;
    var rowsMin = useAside ? _asideMin : _documentMin;
    var rowsMax = useAside ? _asideMax : _documentMax;
    // At most [RemoteScrollMemory.rowsKept], around where the screen was.
    if (rows.length > RemoteScrollMemory.rowsKept) {
      final centre = useAside ? (rowsMin + rowsMax) ~/ 2 : _remote;
      final low = centre - RemoteScrollMemory.rowsKept ~/ 2;
      final high = low + RemoteScrollMemory.rowsKept;
      rows = {
        for (final entry in rows.entries)
          if (entry.key >= low && entry.key < high) entry.key: entry.value,
      };
      rowsMin = math.max(rowsMin, low);
      rowsMax = math.min(rowsMax, high - 1);
    } else {
      rows = Map.of(rows);
    }
    memory._keep(
      _gridKey,
      _Known(
        rows: rows.isEmpty ? null : rows,
        rowsMin: rowsMin,
        rowsMax: rowsMax,
        top: top,
        bottom: bottom,
        fixedRows: {..._fixedRows},
      ),
    );
    _learned = false;
  }

  /// The grid the document is in, as [RemoteScrollMemory] tells grids apart.
  String get _gridKey => '$_rowCount×$_columns@$_lineHeight';

  /// What [_memory] knows of this grid: which rows scroll and which are the
  /// program's own, at once — and the rows seen, set aside, to be found again
  /// in what the program shows ([_reattach]). Nothing, for another grid: its
  /// rows wrap otherwise.
  void _load() {
    final known = _memory?._grids[_gridKey];
    if (known == null) return;
    _top = known.top;
    _bottom = known.bottom;
    _fixedRows
      ..clear()
      ..addAll(known.fixedRows);
    final rows = known.rows;
    if (rows != null && rows.isNotEmpty) {
      _aside = rows;
      _asideMin = known.rowsMin;
      _asideMax = known.rowsMax;
      _reattachTried = null;
    }
    inputTrace(
      () => 'mirror: remembered · scrolling rows $_top..$_bottom'
          ' · ${rows?.length ?? 0} rows set aside',
    );
  }

  void _forget() {
    _document.clear();
    _documentMin = 0;
    _documentMax = -1;
    // Rows of another grid: wrapped at another width, nothing to take back.
    _aside = null;
    _pageInFlight = false;
    _topRow = null;
    _learned = false;
    _lastFrame = null;
    _top = null;
    _bottom = null;
    _fixedRows.clear();
    _stoodStill.clear();
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
    final rows = [
      for (var i = 0; i < rowCount; i++) _Row.of(screen[i]),
    ];
    final last = _lastFrame;
    _lastFrame = rows;
    if (last == null || last.length != rowCount) {
      // The first screen of an emulator whose scrolling rows are known — from
      // [_memory]: written in where it stands, and what was known before is
      // looked for in it ([_reattach]). A scroll can start from it at once.
      if (_top != null && _bottom != null && _document.isEmpty) {
        _store(screen);
        _reattach(rows);
      }
      return;
    }

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
      // Nothing that scrolls moved: a spinner, a prompt row, a cursor — unless
      // the program has rows asked of it still to answer: then it may be a
      // scroll over rows too alike to tell apart, and written in where they
      // stand, its rows would go where they do not belong. Nor while where the
      // program is has not been found since a frame went unplaced.
      if (_requested == _remote && requestsIdle() && _missesInARow == 0) {
        _store(screen);
        _reattach(rows);
      }
      return;
    }

    final shift = _align(rows, last, changed);
    if (shift == null &&
        _requested == _remote &&
        requestsIdle() &&
        !_pageInFlight &&
        _missesInARow == 0) {
      // Nothing asked of the program is on its way, so it did not scroll: its
      // screen changed where it stands — an agent writing, a tool's result
      // unfolding (11 of 59 frames lost, measured on a phone, 2026-10-06). The
      // rows known around it may be stale now, so the document starts again
      // from this screen, but where it stands: the screen does not jump. What
      // was known is set aside, not thrown away: most of it is likely still
      // the program's content, only moved.
      inputTrace(
        () => 'mirror: the screen changed where it stands — the document'
            ' starts again from it, in place',
      );
      _setAside();
      _document.clear();
      _documentMin = 0;
      _documentMax = -1;
      _topRow = null;
      _store(screen);
      _reattach(rows);
      return;
    }
    final scrolling =
        top == null || bottom == null ? rowCount : bottom - top + 1;
    if (shift == null && changedScrolling * 3 < scrolling) {
      // Too few rows changed to be sure of anything: a scroll moves nearly
      // every row, but over mostly blank rows it may not. Thrown away as lost,
      // the document started again for a few rows redrawn; written in where
      // they stand, a small scroll's rows went in where they did not belong.
      // Neither: the document stays as it is, and the next frame says more.
      inputTrace(
        () => 'mirror: $changedScrolling rows changed, not placed'
            ' — the document left as it is',
      );
      return;
    }
    if (shift == null) {
      _framesLost++;
      _traceMiss(screen, rowCount, changed.length);
      if (_scrolling &&
          _active &&
          _document.isNotEmpty &&
          _missesInARow < _maxMissesInARow) {
        // The screen goes on from the document; the frame is not written in,
        // and the next one says where the program is — see [_maxMissesInARow].
        _missesInARow++;
        inputTrace(
          () => 'mirror: frame not placed — the document kept'
              ' ($_missesInARow running)',
        );
        return;
      }
      _missesInARow = 0;
      _lost();
      _store(screen);
      _reattach(rows);
      return;
    }
    _missesInARow = 0;
    _framesAligned++;
    inputTrace(
      () => 'mirror: placed k=${shift.rows} (expected ${_requested - _remote})'
          ' · rows ${shift.first}..${shift.last} agreed'
          ' ${shift.agreeing.length}/${shift.share}',
    );
    _remote += shift.rows;
    _movedAtMs = _nowMs;
    if (_pageInFlight) _pageLanded();
    // Gone further than it was asked: Claude Code speeds up wheel events it
    // reads together — as it does when busy drawing, however far apart they
    // were sent (2,583 rows moved for 1,875 wheels, measured on a phone,
    // 2026-10-06). The books follow it, or it is asked onwards from rows it
    // has passed already, and runs further still. What still waits to go out
    // would take it further again: not sent.
    if (_askedDirection > 0 && _remote > _requested ||
        _askedDirection < 0 && _remote < _requested) {
      cancelRequests();
      _requested = _remote;
    }
    if (_settling) _armSettleTimer();
    _confirmRows(shift);
    _learnFixedRows(shift, rows, last);
    _widenScrollingRows(shift, rows, last);
    _store(screen, shift);
    _reattach(rows);
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
    final reach = _rowCount + 2 * _leadMax;
    final scores = <({int rows, int agree, int share})>[];
    // Trace only: the closest any shift came, for when none is good enough.
    ({int rows, int agree, int share})? closest;
    void score(int from, int to) {
      for (var k = from; k <= to; k++) {
        if (k == 0) continue;
        var agree = 0;
        var comparable = 0;
        for (final i in changed) {
          final signature = known(_remote + k + i);
          if (signature == null) continue;
          comparable++;
          if (signature == rows[i].signature) agree++;
        }
        final best = closest;
        if (best == null || agree > best.agree) {
          closest = (rows: k, agree: agree, share: comparable);
        }
        if (agree >= _minAgree && agree >= comparable * _minAgreeShare) {
          scores.add((rows: k, agree: agree, share: comparable));
        }
      }
    }

    // Only as far as the program can have gone: it is never asked more than
    // [_maxAhead] past where it was seen. Looking through the whole document
    // found rows that repeat further off, and placed frames there.
    score(-reach, reach);
    if (scores.isEmpty && !useLast) {
      final far = _alignFar(rows, reach);
      if (far != null) return far;
    }
    if (scores.isEmpty) {
      final best = closest;
      _miss = best == null
          ? null
          : (
              rows: best.rows,
              agree: best.agree,
              share: best.share,
              rival: null
            );
      return null;
    }
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
      if (rivals.isNotEmpty) {
        _miss = (
          rows: chosen.rows,
          agree: chosen.agree,
          share: chosen.share,
          rival: rivals.first.rows,
        );
        return null;
      }
    }
    // The rows that moved with it: what bounds the scrolling rows.
    return _Shift(
      chosen.rows,
      [
        for (final i in changed)
          if (known(_remote + chosen.rows + i) == rows[i].signature) i,
      ],
      chosen.share,
    );
  }

  /// [rows] placed further off than [reach] — anywhere in the document — held
  /// to what [_reattach] is, or null.
  ///
  /// ⚠️ **Claude Code goes further than it is asked, now and then.** Asked 24
  /// rows, its screen was 70 and more away (beyond [reach]) — and every time
  /// the rows were in the document: the frame was let go, the screen jumped to
  /// the program's, and the rows set aside for it matched that screen 34 of 34
  /// a moment later (measured on a phone, 2026-10-06). Placed here, the screen
  /// goes on from the document instead. Looked for this far only under
  /// [_reattach]'s bar, never [_align]'s: rows repeat in a transcript, and a
  /// looser match this far off placed frames among them.
  _Shift? _alignFar(List<_Row> rows, int reach) {
    final top = _top;
    final bottom = _bottom;
    if (top == null || bottom == null || _documentMax < _documentMin) {
      return null;
    }
    final probe = _probeRows(rows);
    final found = _bestPlacing(
      probe,
      rows,
      _document,
      _documentMin - _remote,
      _documentMax - _remote,
      skip: (k) => k.abs() <= reach,
    );
    if (found == null || !_sureOf(found)) return null;
    inputTrace(
      () => 'mirror: placed far off · k=${found.d}'
          ' (expected ${_requested - _remote})'
          ' · ${found.agree}/${found.share} rows agreed',
    );
    return _Shift(
      found.d,
      [
        for (final i in probe)
          if (_document[_remote + found.d + i]?.signature == rows[i].signature)
            i,
      ],
      found.share,
    );
  }

  /// The screen rows a placing far off is judged by: content in the rows that
  /// scroll — not blank, not the program's own.
  List<int> _probeRows(List<_Row> rows) {
    final top = _top;
    final bottom = _bottom;
    if (top == null || bottom == null) return const [];
    return [
      for (var i = top; i <= bottom && i < rows.length; i++)
        if (!rows[i].blank && !_fixedRows.contains(i)) i,
    ];
  }

  /// The placing of [probe] rows of [rows] in [known] that most agree: screen
  /// row `i` showing `known[_remote + i + d]`, for every `d` that puts a probe
  /// row between [knownMin] and [knownMax] — and how many agree with the next
  /// best placing. Null when none agrees at all.
  ({int d, int agree, int share, int runnerUp})? _bestPlacing(
    List<int> probe,
    List<_Row> rows,
    Map<int, _DocRow> known,
    int knownMin,
    int knownMax, {
    bool Function(int d)? skip,
  }) {
    if (probe.isEmpty) return null;
    ({int d, int agree, int share})? best;
    var runnerUp = 0;
    for (var d = knownMin - probe.last; d <= knownMax - probe.first; d++) {
      if (skip != null && skip(d)) continue;
      var agree = 0;
      var comparable = 0;
      for (final i in probe) {
        final kept = known[_remote + i + d];
        if (kept == null) continue;
        comparable++;
        if (kept.signature == rows[i].signature) agree++;
      }
      if (agree == 0) continue;
      final current = best;
      if (current == null || agree > current.agree) {
        if (current != null) runnerUp = math.max(runnerUp, current.agree);
        best = (d: d, agree: agree, share: comparable);
      } else {
        runnerUp = math.max(runnerUp, agree);
      }
    }
    final found = best;
    if (found == null) return null;
    return (
      d: found.d,
      agree: found.agree,
      share: found.share,
      runnerUp: runnerUp,
    );
  }

  /// Whether a placing found far off ([_bestPlacing]) leaves no doubt:
  /// [_reattachAgree] rows agreeing — or [_reattachAgreeAll], when every row
  /// that could agreed — and [_reattachShare] of those that could, with the
  /// next best placing well behind.
  bool _sureOf(({int d, int agree, int share, int runnerUp}) found) {
    final enough = found.agree >= _reattachAgree ||
        found.agree >= _reattachAgreeAll && found.agree == found.share;
    return enough &&
        found.agree >= found.share * _reattachShare &&
        found.runnerUp * 10 < found.agree * 6;
  }

  /// The document rows [shift] found where the program now shows them: seen
  /// moving with the content, so content ([_DocRow.confirmed]) — and a screen
  /// row that moved with it scrolls, whatever it showed before.
  void _confirmRows(_Shift shift) {
    for (final i in shift.agreeing) {
      _document[_remote + i]?.confirmed = true;
      _stoodStill.remove(i);
      if (_fixedRows.remove(i)) {
        inputTrace(() => 'mirror: row $i scrolls again');
      }
    }
  }

  /// Rows the program keeps where they are while its content scrolls, learned
  /// from placed frames: outside the rows that agreed, a row that stood still
  /// in two running. One is not enough — content that came in with the scroll
  /// may stand where a row of the same text stood, by chance, and a pinned row
  /// covering content is told apart in [_store] meanwhile.
  ///
  /// ⚠️ **Taken for content, they went into the document.** Claude Code pins
  /// the prompt of the rows on screen to row 0 once that prompt has scrolled
  /// off, and puts a "jump to bottom" line over its last rows; the scrolling
  /// rows were widened over both, written into the document as rows of it, and
  /// the screen, drawn from it, showed them among the content — out of order
  /// (`scrolling rows 0..35` six times in one session, reported on a phone,
  /// 2026-10-06). What such a row wrote in and nothing has seen move since is
  /// taken out again ([_purgeWrittenFrom]).
  void _learnFixedRows(_Shift shift, List<_Row> rows, List<_Row> last) {
    final first = shift.first;
    final lastAgreed = shift.last;
    if (first < 0) return;
    for (var i = 0; i < rows.length; i++) {
      if (i >= first && i <= lastAgreed) continue;
      if (_fixedRows.contains(i)) continue;
      final row = rows[i];
      if (row.blank || row.signature != last[i].signature) {
        _stoodStill.remove(i);
        continue;
      }
      final times = (_stoodStill[i] ?? 0) + 1;
      if (times < 2) {
        _stoodStill[i] = times;
        continue;
      }
      _stoodStill.remove(i);
      _fixedRows.add(i);
      _learned = true;
      final purged = _purgeWrittenFrom(i);
      inputTrace(
        () => 'mirror: row $i is the program\'s own'
            '${purged > 0 ? ' · $purged rows it wrote taken out' : ''}',
      );
    }
  }

  /// Document rows written from screen row [i] while it came in with a scroll,
  /// and never seen moving since: out. A hole is drawn as nothing until the
  /// program shows that row again — better than a row out of place.
  int _purgeWrittenFrom(int i) {
    final before = _document.length;
    _document.removeWhere((_, row) => row.fromRow == i && !row.confirmed);
    final purged = before - _document.length;
    if (purged > 0) {
      if (_document.isEmpty) {
        _documentMin = 0;
        _documentMax = -1;
      } else {
        _documentMin = _document.keys.reduce(math.min);
        _documentMax = _document.keys.reduce(math.max);
      }
    }
    return purged;
  }

  /// The scrolling rows: those the shift moved, and next to them the rows that
  /// came in with it — up to a row that stood still.
  void _widenScrollingRows(_Shift shift, List<_Row> rows, List<_Row> last) {
    bool stoodStill(int i) =>
        !rows[i].blank && rows[i].signature == last[i].signature;
    bool fixed(int i) => _fixedRows.contains(i);
    var top = shift.first;
    var bottom = shift.last;
    if (top < 0) return;
    // Rows come in on the side the content moves away from.
    for (var n = 0; n < shift.rows.abs() && top > 0; n++) {
      if (shift.rows > 0 || stoodStill(top - 1) || fixed(top - 1)) break;
      top--;
    }
    for (var n = 0; n < shift.rows.abs() && bottom < _rowCount - 1; n++) {
      if (shift.rows < 0 || stoodStill(bottom + 1) || fixed(bottom + 1)) break;
      bottom++;
    }
    final known = _top != null && _bottom != null;
    var newTop = known ? math.min(_top!, top) : top;
    var newBottom = known ? math.max(_bottom!, bottom) : bottom;
    // A row at the edge that stood still while everything else moved is the
    // program's own — a status line — and not part of what scrolls.
    while (newTop < newBottom &&
        (fixed(newTop) || stoodStill(newTop) && newTop < shift.first)) {
      newTop++;
    }
    while (newBottom > newTop &&
        (fixed(newBottom) || stoodStill(newBottom) && newBottom > shift.last)) {
      newBottom--;
    }
    if (newTop != _top || newBottom != _bottom) {
      inputTrace(() => 'mirror: scrolling rows $newTop..$newBottom');
      _learned = true;
    }
    _top = newTop;
    _bottom = newBottom;
  }

  /// The program's scrolling rows into the document, at [_remote] — moved there
  /// by [shift], or where they stood when null.
  void _store(IndexAwareCircularBuffer<BufferLine> screen, [_Shift? shift]) {
    final top = _top;
    final bottom = _bottom;
    if (top == null || bottom == null) return;
    final agreeing = shift?.agreeing.toSet() ?? const <int>{};
    for (var i = top; i <= bottom; i++) {
      // The program's own row, inside the rows that scroll: never content.
      if (_fixedRows.contains(i)) continue;
      final row = _remote + i;
      final line = screen[i];
      final kept = _document[row];
      if (kept != null && kept.sameCells(line)) continue;
      final signature = _Row.of(line).signature;
      var confirmed = agreeing.contains(i);
      if (kept != null && kept.confirmed) {
        if (kept.signature == signature) {
          // The same text in other colours.
          confirmed = true;
        } else if (shift != null && (i < shift.first || i > shift.last)) {
          // Content seen moving, contradicted only outside the rows that moved
          // with this scroll: a row of the program's own over it, not yet
          // learned for one ([_learnFixedRows]) — kept out.
          _rowsGuarded++;
          continue;
        }
      }
      if (shift != null &&
          kept != null &&
          !kept.confirmed &&
          kept.signature != signature) {
        // Never seen moving, and now shown otherwise: put right.
        _rowsMended++;
      }
      // Written where it stood (no [shift]), a row has no screen row it came in
      // at, to be taken out by later: nothing tells it from content there.
      _document[row] = _DocRow.copyOf(line, signature, shift == null ? null : i)
        ..confirmed = confirmed;
      _learned = true;
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
    _trim();
  }

  /// Only what a scroll could come back to — around the screen as well as the
  /// program: over rows seen before the screen runs far ahead of it, and rows
  /// dropped from under it were drawn as nothing.
  void _trim() {
    if (_documentMax - _documentMin <= 2 * _keepRows + _rowCount) return;
    final shown = _active ? _display.round() : _remote;
    final low = math.min(_remote, shown) - _keepRows;
    final high = math.max(_remote, shown) + _rowCount + _keepRows;
    _document.removeWhere((row, _) => row < low || row > high);
    _documentMin = math.max(_documentMin, low);
    _documentMax = math.min(_documentMax, high);
  }

  /// The document put aside before it starts again, not thrown away: its rows
  /// are still the program's content — only where they stand against the
  /// program's screen is no longer known. [_reattach] takes them back.
  void _setAside() {
    if (_document.isEmpty) return;
    final aside = _aside;
    // The bigger of the two: a document just started again from one screen is
    // worth less than the one set aside before it.
    if (aside != null && aside.length >= _document.length) return;
    _aside = Map.of(_document);
    _asideMin = _document.keys.reduce(math.min);
    _asideMax = _document.keys.reduce(math.max);
    _reattachTried = null;
    inputTrace(() => 'mirror: ${_document.length} rows set aside');
  }

  /// Rows set aside ([_setAside]) back into the document, once the program's
  /// screen — [rows], placed at [_remote] — is found among them: then the
  /// rest of them stand where that says. Scrolled back over, they are drawn at
  /// once instead of waited for.
  ///
  /// ⚠️ **Matched across all of them, so held to more than [_align] is.** Rows
  /// repeat in a transcript, and the further a match is looked for the likelier
  /// one that is not the screen's (looking through the whole document placed
  /// frames among repeated rows, measured on a phone, 2026-10-06). Taken back
  /// only on a placing that leaves no doubt ([_sureOf]); otherwise they wait
  /// for a frame that does. Where the program shows a row differently later,
  /// [_store] writes over it, as it does any row it shows.
  void _reattach(List<_Row> rows) {
    final aside = _aside;
    final top = _top;
    final bottom = _bottom;
    if (aside == null || top == null || bottom == null) return;
    final probe = _probeRows(rows);
    if (probe.length < _reattachAgreeAll) return;
    // The same screen at the same place, already looked for: a spinner redrawn
    // on it says nothing new.
    var key = _remote;
    for (final i in probe) {
      key = 0x1fffffff & (key * 31 + rows[i].signature);
    }
    if (key == _reattachTried) return;
    final now = _nowMs;
    if (now - _reattachAtMs < _reattachEvery.inMilliseconds) return;
    _reattachTried = key;
    _reattachAtMs = now;
    // Set-aside row `_remote + i + d` is what the screen's row `i` shows.
    final found = _bestPlacing(
      probe,
      rows,
      aside,
      _asideMin - _remote,
      _asideMax - _remote,
    );
    if (found == null || !_sureOf(found)) {
      // Trace only, and only when the screen came close: what kept it out, to
      // tune [_reattachAgree] and [_reattachShare] by.
      if (found != null && found.agree * 2 >= _reattachAgree) {
        inputTrace(
          () => 'mirror: rows set aside not taken back — best placing'
              ' ${found.agree}/${found.share} of ${probe.length} rows,'
              ' next best ${found.runnerUp} · ${aside.length} set aside',
        );
      }
      return;
    }
    var taken = 0;
    for (final entry in aside.entries) {
      final row = entry.key - found.d;
      // What the document has is newer.
      if (_document.containsKey(row)) continue;
      // Not content seen moving, as far as [_store] is concerned: away from
      // the rows that matched, the program may have changed since — a result
      // unfolded, a block folded — and a row it shows differently there is
      // written over, never kept out.
      _document[row] = entry.value..confirmed = false;
      taken++;
    }
    _aside = null;
    if (taken == 0) return;
    _documentMin = math.min(_documentMin, _asideMin - found.d);
    _documentMax = math.max(_documentMax, _asideMax - found.d);
    _trim();
    inputTrace(
      () => 'mirror: $taken rows set aside taken back'
          ' (${found.agree}/${found.share} rows agreed)',
    );
  }

  /// Trace only: why the frame on [screen] was not placed, and what it and the
  /// document show at its top and bottom rows — where a program's own rows (a
  /// pinned prompt, a "jump to bottom" line) would be.
  void _traceMiss(
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
    int changed,
  ) {
    inputTrace(() {
      final miss = _miss;
      final expected = _requested - _remote;
      final why = miss == null
          ? 'nothing to compare with'
          : miss.rival != null
              ? 'k=${miss.rows} and k=${miss.rival} agree alike'
                  ' (${miss.agree}/${miss.share})'
              : 'closest k=${miss.rows} agreed ${miss.agree}/${miss.share}';
      String text(BufferLine? line) =>
          line == null ? '–' : traceText(line.getText().trimRight(), max: 36);
      final sample = [
        for (final i in [0, 1, 2, rowCount - 3, rowCount - 2, rowCount - 1])
          if (i >= 0 && i < rowCount)
            '$i "${text(screen[i])}" doc "${text(_document[_remote + expected + i]?.line)}"',
      ];
      return 'mirror: miss · $changed rows changed · expected k=$expected · $why'
          ' · scrolling rows ${_top ?? '?'}..${_bottom ?? '?'}'
          ' · document ${_documentMin - _remote}..${_documentMax - _remote}'
          ' · ${sample.join(' | ')}';
    });
  }

  /// The frame could not be placed: the program drew something else. Where
  /// what is known stands against the screen is lost; start again from this
  /// screen — what is known set aside, to be taken back once a later frame
  /// shows where it stands ([_reattach]).
  void _lost() {
    inputTrace(() => 'mirror: frame not placed — starting again from it');
    // The rows still waiting were counted in books that are gone.
    cancelRequests();
    _pageInFlight = false;
    _stopPrefetch();
    _setAside();
    _document.clear();
    _topRow = null;
    _documentMin = 0;
    _documentMax = -1;
    final wasActive = _active;
    _active = false;
    _chasing = false;
    _streaming = false;
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
    // ⚠️ Never from nothing: a scroll that began just after the document
    // started again, before any screen was written into it, drew its rows as
    // nothing — a blank screen for three frames (measured on a phone,
    // 2026-10-06). The program's next frame writes one in.
    if (_document.isEmpty || _documentMax < _documentMin) return;
    // From the live screen: what is drawn does not move on the switch.
    _active = true;
    _display = _remote.toDouble();
    _velocity = 0;
    _chasing = true;
    _streaming = false;
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
    _dropLag();
    final goal = _clamp(_target);
    if (goal != _target) {
      _clampedUpdates++;
      if (_scrolling) {
        _capLag(goal);
        _streaming = true;
      }
    }
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

  /// The finger is let run at most [_maxLag] rows past the edge of what is
  /// known, [goal]; the rest of its way is let go, and it carries on from
  /// there.
  ///
  /// ⚠️ **What the screen is behind the finger, it scrolls on by itself.** A
  /// finger faster than the program (~80 rows a second) ran hundreds of rows
  /// ahead of the screen, held at the edge 200–264 times a scroll — which went
  /// on at the program's pace once the finger had stopped, and on after it let
  /// go, as if flung (reported on a phone, 2026-10-06; [_dropLag] never let it
  /// go: a finger at rest still moved a pixel or two). Let go as it goes, the
  /// screen stops with the finger, and turns with it at once.
  void _capLag(double goal) {
    final ahead = _target - goal;
    if (ahead.abs() <= _maxLag) return;
    final by = goal + _maxLag * ahead.sign - _target;
    _anchorRow += by;
    _target += by;
    _lastTarget += by;
    _lagDropped += by.abs();
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
    _dropLag();
    if (_chasing) {
      // A critically damped spring towards the goal, solved exactly.
      final goal = _clamp(_target);
      final omega = _omegaNow;
      final x = _display - goal;
      final decay = math.exp(-omega * seconds);
      final u = _velocity + omega * x;
      final next = (x + u * seconds) * decay;
      _velocity = (_velocity - omega * u * seconds) * decay;
      // Never beyond what is known, however the speed it started with carries
      // it: a row past the document would be drawn as nothing.
      final at = _clamp(goal + next);
      if (at != goal + next) _velocity = 0;
      _display = at;
      if ((at - goal).abs() < 0.01 && _velocity.abs() < 0.5) {
        _display = goal;
        _velocity = 0;
        _chasing = false;
        _streaming = false;
      }
      onFrame();
    }
    if (_prefetching) {
      _prefetchStep();
    } else if (_settling) {
      _settleStep();
    } else {
      _resyncIfStalled();
    }
    if (_active && (_chasing || _settling || _prefetching)) _scheduleTick();
  }

  /* The program */

  /// Whether [screen] shows the program's prompt, for [_pageKeysSafe] — read
  /// only for a program whose page keys are let scroll it.
  void _readPrompt(
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
  ) {
    _pageKeysSafe =
        (pageKeysEnabled?.call() ?? false) && _promptShown(screen, rowCount);
  }

  /// Whether [screen] shows Claude Code's prompt: a row starting `❯` with a
  /// rule (`────`) right above it, and another a few rows below — its input
  /// box.
  ///
  /// ⚠️ **Not a list to choose from.** A question it asks — "Do you want to
  /// proceed?" over "❯ 1. Yes" — has its own words above the `❯`, not a rule,
  /// and Page Up or Down there would move the choice instead of scrolling. In
  /// any doubt, no page keys: wheel events only ever scroll.
  static bool _promptShown(
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
  ) =>
      _promptRow(screen, rowCount) >= 0;

  /// The text of the prompt's row ([_promptRow]), or null when none shows.
  static String? _promptText(
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
  ) {
    final row = _promptRow(screen, rowCount);
    return row < 0 ? null : screen[row].getText();
  }

  /// The screen row of Claude Code's prompt — see [_promptShown] — or -1.
  static int _promptRow(
    IndexAwareCircularBuffer<BufferLine> screen,
    int rowCount,
  ) {
    if (screen.length < rowCount) return -1;
    bool isRule(int i) {
      final text = screen[i].getText().trim();
      if (text.length < 8) return false;
      var rule = 0;
      for (final unit in text.codeUnits) {
        if (unit == 0x2500) rule++;
      }
      return rule * 10 >= text.length * 9;
    }

    final from = math.max(1, rowCount - 12);
    for (var i = rowCount - 1; i >= from; i--) {
      if (!screen[i].getText().trimLeft().startsWith('❯')) continue;
      if (!isRule(i - 1)) continue;
      for (var j = i + 1; j < rowCount && j <= i + 8; j++) {
        if (isRule(j)) return i;
      }
    }
    return -1;
  }

  /// About how many rows a page key scrolls the program: half the rows that
  /// scroll — Claude Code's page is half its transcript's height. Only an
  /// estimate: where a page lands, the frame says ([_pageLanded]).
  int get _pageRowsNow {
    final top = _top;
    final bottom = _bottom;
    if (top == null || bottom == null) return 0;
    return (bottom - top + 1) ~/ 2;
  }

  /// Whether [lines] the program is to be asked go as a page key: true when
  /// one went — or is to go, once what is on its way has landed: no wheel
  /// events meanwhile. False leaves them to wheel events.
  ///
  /// ⚠️ **Wheel events top out at ~150 rows a second; a fling runs 200–400.**
  /// Four at a time, so that each scrolls one row, the program moved 156 rows
  /// a second (p50), and the screen waited at the edge of what is known 76
  /// times a scroll, the finger let go 108 rows ahead (measured on a phone,
  /// 2026-10-06, 85 of 106 scrolls at 200 rows a second or more). Claude
  /// Code's Page Up and Down scroll half its transcript's height at once — a
  /// jump (`scrollTo`), not a glide, and never sped up — so one key moves it
  /// ~17 rows a round trip, and its frame still shares half a screen with the
  /// last, to be placed by. One at a time, and alone: two drawn as one frame
  /// would move it further than a frame can be placed.
  ///
  /// [fast] — the finger past the edge of what is known, or faster than
  /// [_pageSpeed] — and rows short of a page wait for a page's worth rather
  /// than going as wheel events.
  ///
  /// ⚠️ **Wheel rows trickled in kept the pages out.** Flicked again and again,
  /// the finger was rarely a page ahead of what was asked: four wheel events
  /// went every 50ms instead, the program glided through each over a few
  /// frames ([_wheelsGliding]), and no page could go — 137 rows a second (p50)
  /// against a finger at 296, the screen held at the edge most of each flick
  /// (measured on a phone, 2026-10-06, 56 pages in 102 flicks).
  bool _pageOrWait(int lines, {bool fast = false}) {
    final send = requestPage;
    if (send == null || !_pageKeysSafe || _pageKeysRefused) return false;
    // The page on its way lands first: nothing goes with it.
    if (_pageInFlight) return true;
    final page = _pageRowsNow;
    if (page < _minPage) return false;
    if (lines.abs() < page) return fast;
    if (!requestsIdle() || _wheelsGliding) return true;
    final direction = lines.sign;
    if (!send(direction)) {
      _pageKeysRefused = true;
      inputTrace(() => 'mirror: page key refused — wheel events from here');
      return false;
    }
    _pageInFlight = true;
    _pageNowhere = false;
    _pageDirection = direction;
    _pageSentAtMs = _nowMs;
    _pageFromRemote = _remote;
    _requested += direction * page;
    _requestedAtMs = _nowMs;
    _askedDirection = direction;
    _rowsAsked += page;
    _pagesSent++;
    return true;
  }

  /// A frame placed while a page key was on its way: once the program has
  /// moved its way, the page has landed — and where the frame shows it is
  /// where it stands. A page jumps (`scrollTo`), with nothing gliding behind
  /// it ([_wheelsGliding]) and nothing sent while it was on its way: the books
  /// counted only an estimate of it.
  void _pageLanded() {
    final moved = (_remote - _pageFromRemote) * _pageDirection;
    if (moved <= 0) return;
    _pageInFlight = false;
    _pageLandedAtMs = _nowMs;
    _requested = _remote;
  }

  /// Whether the program may still be gliding through wheel rows: asked since
  /// the last page landed, and it has moved, or they were asked, within
  /// [_wheelsSettle].
  ///
  /// ⚠️ **A page lands on top of what is still to glide.** Claude Code's page
  /// key scrolls from where its wheel rows will end up (`scrollTo` past the
  /// pending delta), and wheel rows sped up glide on for a few frames after
  /// they are answered: a page sent then moved it the page and the rest at
  /// once — further than a screen, with no row in common to place by (6 of
  /// 10 frames lost in a long session, measured on a phone, 2026-10-06).
  bool get _wheelsGliding {
    if (_wheelsAtMs <= _pageLandedAtMs) return false;
    final now = _nowMs;
    final settle = _wheelsSettle.inMilliseconds;
    return now - _movedAtMs < settle || now - _wheelsAtMs < settle;
  }

  /// A page key unanswered for [_pageWait] went nowhere: the next may go —
  /// and, the program not having moved, the books are put back to where it is.
  void _expirePage() {
    if (!_pageInFlight || _nowMs - _pageSentAtMs < _pageWait.inMilliseconds) {
      return;
    }
    _pageInFlight = false;
    _pageNowhere = _remote == _pageFromRemote;
    if (_pageNowhere && requestsIdle()) _requested = _remote;
  }

  /* Fetching ahead */

  /// [_prefetch] in [_prefetchAfter] — again from now: the program drew, the
  /// finger was on the glass, or a scroll just ended.
  void _armPrefetch() {
    if (readScreen == null || !(pageKeysEnabled?.call() ?? false)) return;
    _prefetchTimer?.cancel();
    _prefetchTimer = Timer(_prefetchAfter, _prefetch);
  }

  /// While nobody scrolls and the program is quiet, the rows above the screen
  /// fetched into the document — [_prefetchRows] of them — a page key at a
  /// time, the program then brought back to the row on screen.
  ///
  /// ⚠️ **What has not been seen comes at the program's pace.** In a long
  /// session Claude Code draws a page in 50–150ms: ~200 rows a second, against
  /// a flick of 300–400 — so every scroll into rows not yet seen caught up
  /// with their edge and waited there (measured on a phone, 2026-10-06).
  /// Fetched while the reader reads, the rows are there when the finger goes
  /// for them. Nothing on the screen moves meanwhile: the rows that scroll
  /// are drawn from the document where they are, and the program's own rows
  /// — its pinned prompt, its "jump to bottom" line, which come up as it
  /// scrolls — held as they were ([heldRow]). Only for a program whose page
  /// keys are let scroll it, while it shows its prompt; given way to the
  /// finger at once ([begin]) and to a key typed ([frame]); and only once
  /// which rows scroll is known — learned in a scroll, or remembered.
  void _prefetch() {
    _prefetchTimer = null;
    if (_scrolling || _active || _prefetching) {
      return _skipPrefetch('a scroll is on');
    }
    if (!(pageKeysEnabled?.call() ?? false)) {
      return _skipPrefetch('no page keys for this program');
    }
    // Not from the background: the link may be parked, a page key would go
    // nowhere, and be taken for the top of the transcript.
    final lifecycle = SchedulerBinding.instance.lifecycleState;
    if (lifecycle != null && lifecycle != AppLifecycleState.resumed) {
      return _skipPrefetch('the app is not in front');
    }
    final now = readScreen?.call();
    if (now == null) return _skipPrefetch('the screen cannot be read whole');
    final screen = now.lines;
    final rowCount = now.rowCount;
    if (!_sameGrid(screen, rowCount, now.lineHeight)) {
      _forget();
      _takeGrid(screen, rowCount, now.lineHeight);
      _load();
    }
    final top = _top;
    final bottom = _bottom;
    if (top == null || bottom == null) {
      return _skipPrefetch('which rows scroll is not known yet');
    }
    _readPrompt(screen, rowCount);
    if (!_pageKeysSafe) return _skipPrefetch('no prompt on the screen');
    // Where the program stands now — nothing is on its way, before the frame
    // and after it: what moved it since was output, not anything asked.
    _requested = _remote;
    _frame(screen, rowCount);
    _requested = _remote;
    if (_document.isEmpty || _documentMax < _documentMin) {
      return _skipPrefetch('nothing written from the screen');
    }
    final want = _remote + top - _prefetchRows;
    final topRow = _topRow;
    final above = _remote + top - _documentMin;
    if (_documentMin <= want) {
      return _skipPrefetch('$above rows above the screen known already');
    }
    if (topRow != null && _documentMin <= topRow) {
      return _skipPrefetch('the top of the transcript is known, $above above');
    }
    _prefetchGoal = want - top;
    _prefetching = true;
    _prefetchStartedAtMs = _nowMs;
    _heldPrompt = _promptText(screen, rowCount);
    _held.clear();
    final promptRow = _promptRow(screen, rowCount);
    for (var i = 0; i < rowCount; i++) {
      if (i >= top && i <= bottom) continue;
      // From the prompt's rule down, live: what is typed shows.
      if (promptRow >= 0 && i >= promptRow - 1) break;
      final line = screen[i];
      _held[i] = BufferLine(line.length)..copyFrom(line, 0, 0, line.length);
    }
    _active = true;
    _display = _remote.toDouble();
    _target = _display;
    _lastTarget = _target;
    _velocity = 0;
    _chasing = false;
    _streaming = false;
    _settling = false;
    _direction = 0;
    _fingerVelocity = 0;
    _startedAtMs = _nowMs;
    _framesAligned = 0;
    _framesLost = 0;
    _clampedUpdates = 0;
    _lagDropped = 0;
    _settleAsks = 0;
    _rowsGuarded = 0;
    _rowsMended = 0;
    _asksSpared = 0;
    _rowsAsked = 0;
    _pagesSent = 0;
    _pageKeysRefused = false;
    _resyncs = 0;
    _missesInARow = 0;
    inputTrace(
      () => 'mirror: fetching ahead · ${_remote - _prefetchGoal} rows up'
          ' · ${_remote + top - _documentMin} known above the screen',
    );
    _prefetchStep();
    _scheduleTick();
  }

  /// Trace only: why [_prefetch] fetched nothing this time.
  void _skipPrefetch(String why) {
    inputTrace(() => 'mirror: not fetching ahead — $why');
  }

  /// The program asked on up, a page at a time, until its screen reaches the
  /// rows wanted — or a page goes nowhere: the top of its transcript.
  void _prefetchStep() {
    if (!_prefetching) return;
    _expirePage();
    if (!_pageInFlight && _pageNowhere) {
      _topRow = _documentMin;
      _endPrefetch();
      return;
    }
    final remaining = _remote - _prefetchGoal;
    if (remaining <= 0) {
      _endPrefetch();
      return;
    }
    final page = _pageRowsNow;
    if (!_pageKeysSafe || _pageKeysRefused || page < _minPage) {
      _endPrefetch();
      return;
    }
    _pageOrWait(-math.max(page, remaining), fast: true);
  }

  /// Fetched: the program brought back to the row on screen, as a scroll that
  /// has ended is ([_settleStep]); the held rows go once it stands there.
  void _endPrefetch() {
    if (!_prefetching) return;
    _prefetching = false;
    _pageNowhere = false;
    final top = _top ?? 0;
    inputTrace(
      () => 'mirror: fetched ahead in ${_nowMs - _prefetchStartedAtMs}ms'
          ' · ${_remote + top - _documentMin} rows above the screen known'
          ' · $_pagesSent pages',
    );
    _settling = true;
    _target = _display;
    _lastTarget = _target;
    _endedAtMs = _nowMs;
    _armSettleTimer();
    _settleStep();
    _scheduleTick();
  }

  /// Fetching ahead given up — the finger came, or what is known went: the
  /// held rows go, and what was asked stays on the books.
  void _stopPrefetch() {
    _prefetchTimer?.cancel();
    _prefetchTimer = null;
    _prefetching = false;
    _pageNowhere = false;
    if (_held.isNotEmpty) {
      _held.clear();
      onFrame();
    }
  }

  /// How many rows ahead of the finger the program is asked to be — see
  /// [_leadMin].
  int _leadRows() {
    final scrolling = (_bottom ?? 0) - (_top ?? 0) + 1;
    final most = math.min(_leadMax, scrolling ~/ 2);
    final wanted = (_leadMin + _fingerVelocity.abs() * _leadLatency).round();
    return math.max(0, math.min(most, wanted));
  }

  /// The program asked to scroll to where the finger is, and a little ahead —
  /// while it scrolls; once it has ended, [_settleStep].
  void _requestRemote() {
    _expirePage();
    final moving = _scrolling && _active;
    // Held at the edge of what is known ([_capLag]), the finger is never far
    // ahead to read ahead of: the program is asked as far as it may be.
    final held = moving && _clamp(_target) != _target;
    if (moving && !held && _direction != 0 && _knownFarEnough()) {
      _asksSpared++;
      return;
    }
    final lead = moving ? (held ? _maxAhead : _leadRows()) * _direction : 0;
    final wanted = _target.round() + lead;
    // ⚠️ **Never far past where the program was last seen.** A fling runs
    // hundreds of rows ahead of a program that scrolls ~80 a second, and all of
    // them were asked for at once: they went on going out for seconds after
    // the finger let go — the screen scrolling by itself — and at the top of
    // its history the program took none of them, so the books ran hundreds of
    // rows wrong (measured on a phone, 2026-10-06). Asked [_maxAhead] at most
    // past the last row seen, the rest is asked for as the program gets there:
    // each frame asks again.
    final goal = wanted.clamp(_remote - _maxAhead, _remote + _maxAhead);
    final lines = goal - _requested;
    if (lines == 0) return;
    // While the finger moves the program is only asked onwards. Ahead of the
    // finger it is reading ahead, and pulled back each time the finger slowed
    // it turned round and round — Claude Code drops the first wheel of every
    // turn, and glides on the old way a few frames first. Coming back to the
    // row on screen is for when the scroll comes to rest.
    if (_scrolling && _direction != 0 && lines.sign != _direction) return;
    final fast = moving && (held || _fingerVelocity.abs() >= _pageSpeed);
    if (_pageOrWait(lines, fast: fast)) return;
    _requested = goal;
    _requestedAtMs = _nowMs;
    _askedDirection = lines.sign;
    _rowsAsked += lines.abs();
    _wheelsAtMs = _nowMs;
    requestLines(lines);
  }

  /// Whether the finger, moving over rows already known, is far enough from
  /// the edge of them that the program need not follow it yet.
  ///
  /// Every row the program is asked comes back as a whole redraw, read and
  /// matched on this thread while the finger moves, and over known rows it
  /// brings nothing the screen needs: they are drawn from the document. So
  /// the program is asked only once the finger nears the edge of what is
  /// known — soon enough for it to get there first: the lead, and what the
  /// finger covers while the program comes to the edge at
  /// [_programRowsPerSecond]. Never more than [_lazyReach] rows behind the
  /// finger, either: what it is not asked now it is asked when the scroll
  /// ends, and the live screen waits for it then.
  bool _knownFarEnough() {
    final top = _top;
    final bottom = _bottom;
    if (top == null || bottom == null || _documentMax < _documentMin) {
      return false;
    }
    if ((_requested - _target).abs() > _lazyReach) return false;
    final ahead = _direction > 0
        ? _documentMax - (_target + bottom)
        : (_target + top) - _documentMin;
    // The program's row 0 at which its screen reaches the edge, and how far
    // it has to come, onwards, to stand there.
    final edge = _direction > 0 ? _documentMax - bottom : _documentMin - top;
    final travel = math.max(0, (edge - _requested) * _direction);
    final seconds = travel / _programRowsPerSecond + _leadLatency;
    return ahead > _leadRows() + _fingerVelocity.abs() * seconds;
  }

  /// While the finger scrolls: rows asked for and never answered — the program
  /// was at an end, or the pacing let them go — leave the books wrong: start
  /// them again from where the program is.
  void _resyncIfStalled() {
    if (_settling || _requested == _remote) return;
    // ⚠️ A page still on its way is not a program that stopped: its answer
    // can take 150ms and more, and the scroll handler counts any batch it has
    // waited 120ms for as answered. Put back to where the program was, the
    // books read the page's frame, when it came, as the screen changing where
    // it stands — and the document started again (measured on a phone,
    // 2026-10-06). [_expirePage] says when a page went nowhere.
    if (_pageInFlight) return;
    final now = _nowMs;
    // Not moved, rather than not drawn: an agent at work redraws its spinner
    // every few frames, and a program at an end never moves however it draws.
    if (now - _movedAtMs < _resyncAfter.inMilliseconds) return;
    if (now - _requestedAtMs < _resyncAfter.inMilliseconds) return;
    if (!requestsIdle()) return;
    if (_resyncs >= _maxResyncs) return;
    _resyncs++;
    _requested = _remote;
    _requestRemote();
  }

  /// Asked again this many times at most in one scroll: a program at the top
  /// of its history answers nothing, however often it is asked.
  static const _maxResyncs = 3;
  int _resyncs = 0;

  /// The scroll has ended: the program is brought to the row the screen rests
  /// on — the screen never goes to the program, it waits for it — and the
  /// screen goes back to it once it stands there.
  ///
  /// ⚠️ **Counted from where the program stopped, not from the books.** Rows
  /// still on their way, and Claude Code's own glide through them, carried it
  /// on after the finger let go — and faster than asked: it speeds up wheel
  /// events it reads together. Asked back at once from what the books said, it
  /// went past the row, was asked back again, and swung about it for over a
  /// second, the screen gliding after it (measured on a phone, 2026-10-06: rows
  /// -909, -928, -945, -926, -896, -909). Now, far off, it is kept coming as it
  /// answers, a few rows short; a turn, and the last rows, wait until it has
  /// stood still for [_settleQuiet], and go out a burst at a time — each wheel
  /// one row.
  void _settleStep() {
    if (!_active || !_settling) return;
    _expirePage();
    final now = _nowMs;
    final row = _clamp(_target).round();
    // A page still on its way is not quiet, however long it has been out —
    // see [_resyncIfStalled].
    final quiet = !_pageInFlight &&
        requestsIdle() &&
        now - _movedAtMs >= _settleQuiet.inMilliseconds &&
        now - _requestedAtMs >= _settleQuiet.inMilliseconds;
    // Nothing on its way and standing still: the program is where it is,
    // whatever was asked of it.
    if (quiet) _requested = _remote;
    final diff = row - _remote;
    if (diff == 0) {
      if (quiet && !_chasing && _display == row) _finishSettle();
      return;
    }
    final sign = diff.sign;
    final far = diff.abs() > _landingRows;
    if (!quiet && (!far || sign != _askedDirection)) return;
    final want = far ? row - sign * _landingBurst : row;
    final goal = want.clamp(_remote - _maxAhead, _remote + _maxAhead);
    var lines = goal - _requested;
    // Asked that far already, and on its way.
    if (lines == 0 || lines.sign != sign) return;
    // Far off, a page at a time; the last rows, wheel events: each one row.
    if (far && _pageOrWait(lines)) return;
    if (!far) lines = lines.clamp(-_landingBurst, _landingBurst);
    _requested += lines;
    _requestedAtMs = now;
    _askedDirection = sign;
    _settleAsks++;
    _rowsAsked += lines.abs();
    _wheelsAtMs = _nowMs;
    requestLines(lines);
  }

  /// The program stands at the row on screen: drawn from it again.
  void _finishSettle() {
    final now = _nowMs;
    final took = now - _startedAtMs;
    inputTrace(
      () => 'mirror: done in ${took}ms, settled ${now - _endedAtMs}ms after the'
          ' finger let go · frames placed $_framesAligned,'
          ' lost $_framesLost · held at the edge $_clampedUpdates times'
          ' · ${_lagDropped.round()} rows the finger ran ahead let go'
          ' · $_settleAsks asks to come back · rows kept from the program\'s'
          ' own $_rowsGuarded, put right $_rowsMended'
          ' · $_rowsAsked rows asked ($_pagesSent pages),'
          ' $_asksSpared asks spared over known rows',
    );
    _settling = false;
    _settleTimer?.cancel();
    _settleTimer = null;
    _active = false;
    _held.clear();
    _cancelTick();
    onFrame();
    _armPrefetch();
  }

  void _settleTimedOut() {
    _settleTimer = null;
    if (!_active || !_settling) return;
    inputTrace(
      () => 'mirror: the program did not come back to row'
          ' ${_display.round()} (it is at $_remote) — showing where it is',
    );
    cancelRequests();
    _settling = false;
    _active = false;
    _chasing = false;
    _velocity = 0;
    _display = _remote.toDouble();
    _held.clear();
    _cancelTick();
    onFrame();
    _armPrefetch();
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
  _DocRow(this.line, this.signature, this.fromRow);

  /// [source], whose [signature] is known, written from the program's screen
  /// row [fromRow].
  factory _DocRow.copyOf(BufferLine source, int signature, int? fromRow) {
    final line = BufferLine(source.length)
      ..copyFrom(source, 0, 0, source.length);
    return _DocRow(line, signature, fromRow);
  }

  final BufferLine line;
  final int signature;

  /// The program's screen row it came in at with a scroll; null when written
  /// where it stood.
  final int? fromRow;

  /// Whether it has been seen moving with the content — found where a scroll
  /// took it — and so is content, not a row of the program's own written in
  /// by mistake. See [RemoteScrollMirror._learnFixedRows].
  bool confirmed = false;

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
/// `_remote + rows + i` held; [agreeing]: the screen rows that showed it, top
/// to bottom, of [share] that could.
class _Shift {
  const _Shift(this.rows, this.agreeing, this.share);

  final int rows;
  final List<int> agreeing;
  final int share;

  /// The first and last rows that agreed: what bounds the scrolling rows.
  int get first => agreeing.isEmpty ? -1 : agreeing.first;
  int get last => agreeing.isEmpty ? -1 : agreeing.last;
}

/// AUTONOMOUS PATCH: the program's whole screen, for [RemoteScrollMirror] to
/// start fetching ahead from on its own — see [RemoteScrollMirror.readScreen].
typedef RemoteScreen = ({
  IndexAwareCircularBuffer<BufferLine> lines,
  int rowCount,
  double lineHeight,
});

/// AUTONOMOUS PATCH: what a [RemoteScrollMirror] knew of one program's rows —
/// the rows seen, which rows scroll, which are the program's own — kept by the
/// embedder for each program it shows (an agent), in memory only, and handed
/// to every view of it (`TerminalView.altBufferScrollMemory`).
///
/// ⚠️ **Every new emulator threw what was known away.** A keyframe replaces
/// the emulator — on every open, every keyboard raised or lowered, every take
/// over — and the mirror was reset with it: the rows read were fetched again,
/// and the first scroll after it waited 100–700ms to learn which rows scroll
/// (measured on a phone, 2026-10-06). Kept here, a new emulator of the same
/// grid starts knowing which rows scroll, and the rows seen are set aside, to
/// be found again in what the program shows.
///
/// Kept for each grid apart, the last [gridsKept] of them: the same program
/// is shown in a taller grid with the keyboard down and a shorter one with it
/// up, and what is learned in one would otherwise overwrite the other.
class RemoteScrollMemory {
  /// How many grids are kept — the keyboard down and the keyboard up.
  static const gridsKept = 2;

  /// The most rows kept for a grid, around where the screen was: about a
  /// kilobyte each.
  static const rowsKept = 1500;

  /// By grid ([RemoteScrollMirror._gridKey]), least recently kept first.
  final _grids = <String, _Known>{};

  /// Whether which rows scroll is known in any grid — what fetching ahead
  /// before the first scroll needs.
  bool get knowsScrollingRows => _grids.isNotEmpty;

  void _keep(String grid, _Known known) {
    _grids.remove(grid);
    _grids[grid] = known;
    while (_grids.length > gridsKept) {
      _grids.remove(_grids.keys.first);
    }
  }

  /// Everything known forgotten.
  void clear() => _grids.clear();
}

/// What [RemoteScrollMemory] keeps of one grid.
class _Known {
  _Known({
    required this.rows,
    required this.rowsMin,
    required this.rowsMax,
    required this.top,
    required this.bottom,
    required this.fixedRows,
  });

  final Map<int, _DocRow>? rows;
  final int rowsMin;
  final int rowsMax;
  final int top;
  final int bottom;
  final Set<int> fixedRows;
}
