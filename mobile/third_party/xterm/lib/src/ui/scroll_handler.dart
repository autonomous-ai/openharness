import 'dart:async';
import 'dart:math' show max;

import 'package:flutter/widgets.dart';
import 'package:xterm/core.dart';
import 'package:xterm/src/ui/infinite_scroll_view.dart';

/// AUTONOMOUS PATCH: how something other than the finger asks a full-screen
/// program to scroll — `RemoteScrollMirror` keeping the program ahead of the
/// finger — through the same pacing the finger's wheel events go through.
class RemoteScrollLink {
  void Function(int lines)? _send;
  bool Function()? _idle;
  int Function()? _cancel;
  bool Function(int direction)? _page;
  Object? _owner;

  /// Scroll the program [lines] rows, positive towards newer ones. Dropped when
  /// no scroll handler is listening: the program is not on its alternate screen.
  void send(int lines) => _send?.call(lines);

  /// Press Page Down ([direction] positive) or Page Up once — only when nothing
  /// else asked is still on its way. False when it was not sent: something is,
  /// or nobody is listening, or the program is scrolled another way.
  bool sendPage(int direction) => _page?.call(direction) ?? false;

  /// Whether every row asked for has gone out and been answered.
  bool get idle => _idle?.call() ?? true;

  /// Rows asked for and not yet sent are not sent — how many, negative for up,
  /// so whoever asked can take them off its books. What is already on its way
  /// still lands.
  int cancel() => _cancel?.call() ?? 0;

  void _attach(
    Object owner,
    void Function(int) send,
    bool Function() idle,
    int Function() cancel,
    bool Function(int direction) page,
  ) {
    _owner = owner;
    _send = send;
    _idle = idle;
    _cancel = cancel;
    _page = page;
  }

  void _detach(Object owner) {
    if (!identical(_owner, owner)) return;
    _owner = null;
    _send = null;
    _idle = null;
    _cancel = null;
    _page = null;
  }
}

/// Handles scrolling gestures in the alternate screen buffer. In alternate
/// screen buffer, the terminal don't have a scrollback buffer, instead, the
/// scroll gestures are converted to escape sequences based on the current
/// report mode declared by the application.
class TerminalScrollGestureHandler extends StatefulWidget {
  const TerminalScrollGestureHandler({
    super.key,
    required this.terminal,
    required this.getCellOffset,
    required this.getLineHeight,
    this.simulateScroll = true,
    this.onAltBufferScroll,
    this.physics,
    this.paced = false,
    this.onWheelsSent,
    this.link,
    this.onScrollPosition,
    this.onScrollStart,
    this.onScrollEnd,
    required this.child,
  });

  final Terminal terminal;

  /// Returns the cell offset for the pixel offset.
  final CellOffset Function(Offset) getCellOffset;

  /// Returns the pixel height of lines in the terminal.
  final double Function() getLineHeight;

  /// Whether to simulate scroll events in the terminal when the application
  /// doesn't declare it supports mouse wheel events. true by default as it
  /// is the default behavior of most terminals.
  final bool simulateScroll;

  /// When set, takes over alt-buffer scroll entirely — [terminal].mouseInput/keyInput are never
  /// called, this is asked instead. For a program that owns terminal mouse-tracking but doesn't
  /// correctly handle wheel reports itself (confirmed live: Grok's CLI echoes the raw SGR escape
  /// bytes into its own prompt as literal characters instead of scrolling), the caller supplying
  /// this hook is expected to know a backend-native way to scroll instead (tmux copy-mode) and not
  /// need the emulator's own mouse/key simulation at all.
  final void Function(bool up)? onAltBufferScroll;

  /// AUTONOMOUS PATCH: the scroll's physics, layered over the platform's — see
  /// `TerminalView.altBufferScrollPhysics`.
  final ScrollPhysics? physics;

  /// AUTONOMOUS PATCH: wheel events go out as fast as the program redraws for
  /// them, not as fast as the finger moves — see
  /// `TerminalView.altBufferScrollPaced`.
  final bool paced;

  /// AUTONOMOUS PATCH: told of each batch of wheel lines as it goes out,
  /// negative for up — see `TerminalView.altBufferScrollAnimated`.
  final void Function(int lines)? onWheelsSent;

  /// AUTONOMOUS PATCH: where something else sends its wheel lines in — see
  /// [RemoteScrollLink].
  final RemoteScrollLink? link;

  /// AUTONOMOUS PATCH: offered the scroll's position first — true takes it, and
  /// then it is not turned into wheel events here: `TerminalView.altBufferScrollMirror`,
  /// where the mirror decides what the program is asked for (through [link]).
  /// False — it cannot take it now — and the scroll goes out as wheels as ever.
  final bool Function(double pixels)? onScrollPosition;

  /// AUTONOMOUS PATCH: a scroll began, at the scrollable's [pixels]; and one
  /// ended — the finger up and any fling run out.
  final void Function(double pixels)? onScrollStart;
  final VoidCallback? onScrollEnd;

  final Widget child;

  @override
  State<TerminalScrollGestureHandler> createState() =>
      _TerminalScrollGestureHandlerState();
}

class _TerminalScrollGestureHandlerState
    extends State<TerminalScrollGestureHandler> {
  /// Whether the application is in alternate screen buffer. If false, then this
  /// widget does nothing.
  var isAltBuffer = false;

  /// The variable that tracks the line offset in last scroll event. Used to
  /// determine how many the scroll events should be sent to the terminal.
  var lastLineOffset = 0;

  /// This variable tracks the last offset where the scroll gesture started.
  /// Used to calculate the cell offset of the terminal mouse event.
  var lastPointerPosition = Offset.zero;

  /// AUTONOMOUS PATCH ([TerminalScrollGestureHandler.paced]): lines scrolled
  /// and not yet sent, negative for up.
  var _unsentLines = 0;

  /// Batches of wheel events sent that no write from the program has answered.
  var _batchesInFlight = 0;

  /// Lets the next batch go when no answer comes: a program already at the top
  /// of its history has nothing to redraw, and a scroll that waited for it
  /// would never move again.
  Timer? _answerWait;

  /// Two, so the next batch is on its way while the program redraws the last.
  static const _maxBatchesInFlight = 2;

  static const _answerWaitLimit = Duration(milliseconds: 120);

  /// The most wheel events in one batch of the finger's own scroll; the rest go
  /// in the next.
  ///
  /// ⚠️ **A batch arrives all at once, and Claude Code speeds up wheel events
  /// that come close together** — see [_exactBurst]. 41 wheels sent as one
  /// batch scrolled it ~200 rows instead of 41, past anything the screen could
  /// be matched with (measured on a phone, 2026-10-06).
  static const _maxBatchLines = 12;

  /// The most wheel events in one batch from the mirror: as many as are sure to
  /// scroll Claude Code one row each.
  ///
  /// Its fullscreen renderer (2.1.290, `wheelScrollAccelerationEnabled` on by
  /// default) scrolls the first wheel event after a pause of over 40ms one row,
  /// and each one closer than 40ms to the last 0.3 of a row more, up to 6 —
  /// floored, so the first four are one row each (read from its code; changing
  /// its settings is not an option, as they reach every app showing the agent).
  ///
  /// ⚠️ **Not more, even to catch up with a fling.** Bigger batches, counted by
  /// that ramp (12 wheels for 26 rows), moved the program 15–30 rows between two
  /// frames and often more than a screen — and a frame with no row in common
  /// with the last cannot be placed: 39 of 59 frames lost (measured on a phone,
  /// 2026-10-06). At four a batch the program moves ~80 rows a second at most,
  /// and a fling faster than that waits at the edge of what is known.
  static const _exactBurst = 4;

  /// The least time between two batches from the mirror, so the first wheel of
  /// each comes after a pause and scrolls one row — see [_exactBurst].
  static const _burstGap = Duration(milliseconds: 50);

  /// Since the last batch of wheel events went out.
  final _sinceBatch = Stopwatch();

  /// Sends a batch from the mirror once [_burstGap] has passed.
  Timer? _gapWait;

  /// Whether [_unsentLines] were asked for through [RemoteScrollLink] — by the
  /// mirror, which keeps its own books of every row it asked for.
  var _unsentFromLink = false;

  /// The direction of the last wheel events sent: -1 up, 1 down, 0 none yet.
  var _lastSentSign = 0;

  @override
  void initState() {
    widget.terminal.addListener(_onTerminalUpdated);
    isAltBuffer = widget.terminal.isUsingAltBuffer;
    widget.link?._attach(
      this,
      _queueLinkLines,
      _pacingIdle,
      _cancelLinkLines,
      _sendLinkPage,
    );
    super.initState();
  }

  @override
  void dispose() {
    widget.terminal.removeListener(_onTerminalUpdated);
    widget.link?._detach(this);
    _resetPacing();
    super.dispose();
  }

  bool _pacingIdle() => _unsentLines == 0 && _batchesInFlight == 0;

  @override
  void didUpdateWidget(covariant TerminalScrollGestureHandler oldWidget) {
    if (oldWidget.terminal != widget.terminal) {
      oldWidget.terminal.removeListener(_onTerminalUpdated);
      widget.terminal.addListener(_onTerminalUpdated);
      isAltBuffer = widget.terminal.isUsingAltBuffer;
      _resetPacing();
    } else if (!widget.paced) {
      _resetPacing();
    }
    if (!identical(oldWidget.link, widget.link)) {
      oldWidget.link?._detach(this);
      widget.link?._attach(
        this,
        _queueLinkLines,
        _pacingIdle,
        _cancelLinkLines,
        _sendLinkPage,
      );
    }
    super.didUpdateWidget(oldWidget);
  }

  void _onTerminalUpdated() {
    if (isAltBuffer != widget.terminal.isUsingAltBuffer) {
      isAltBuffer = widget.terminal.isUsingAltBuffer;
      _resetPacing();
      setState(() {});
      return;
    }
    // AUTONOMOUS PATCH: the program wrote — on the alternate buffer, its redraw
    // for the wheel events in flight — so another batch may go. Any write
    // counts: one that answers nothing only lets the next batch go sooner.
    if (_batchesInFlight > 0) {
      _batchesInFlight--;
      if (_batchesInFlight == 0) {
        _answerWait?.cancel();
        _answerWait = null;
      }
      _sendUnsentLines();
    }
  }

  /// Send a single scroll event to the terminal. If [simulateScroll] is true,
  /// then if the application doesn't recognize mouse wheel events, this method
  /// will simulate scroll events by sending up/down arrow keys.
  void _sendScrollEvent(bool up) {
    final onAltBufferScroll = widget.onAltBufferScroll;
    if (onAltBufferScroll != null) {
      onAltBufferScroll(up);
      return;
    }

    final position = widget.getCellOffset(lastPointerPosition);

    final handled = widget.terminal.mouseInput(
      up ? TerminalMouseButton.wheelUp : TerminalMouseButton.wheelDown,
      TerminalMouseButtonState.down,
      position,
    );

    if (!handled && widget.simulateScroll) {
      widget.terminal.keyInput(
        up ? TerminalKey.arrowUp : TerminalKey.arrowDown,
      );
    }
  }

  void _onScroll(double offset) {
    final currentLineOffset = offset ~/ widget.getLineHeight();

    // AUTONOMOUS PATCH: the mirror moves the screen and asks the program for
    // rows itself. Kept in step, so a switch back never sends the whole gap.
    final onScrollPosition = widget.onScrollPosition;
    if (onScrollPosition != null && onScrollPosition(offset)) {
      lastLineOffset = currentLineOffset;
      return;
    }

    final delta = currentLineOffset - lastLineOffset;

    if (widget.paced) {
      _queueLines(delta);
    } else {
      if (delta != 0) {
        widget.onWheelsSent?.call(delta);
        _lastSentSign = delta.sign;
        _sinceBatch
          ..reset()
          ..start();
      }
      for (var i = 0; i < delta.abs(); i++) {
        _sendScrollEvent(delta < 0);
      }
    }

    lastLineOffset = currentLineOffset;
  }

  /// AUTONOMOUS PATCH ([TerminalScrollGestureHandler.paced]): [delta] more
  /// lines to scroll — sent now if the program has kept up, else in the next
  /// batch, together with the lines scrolled while it caught up.
  void _queueLines(int delta) {
    if (delta == 0) return;
    _unsentFromLink = false;
    // Turned back: what still waits would carry the screen away from the finger.
    if (_unsentLines != 0 && (_unsentLines < 0) != (delta < 0)) {
      _unsentLines = 0;
    }
    // At most a screen waits. On a slow link the rest of a fast fling is
    // dropped, rather than played out long after the fling has stopped.
    final screen = max(1, widget.terminal.viewHeight);
    _unsentLines = (_unsentLines + delta).clamp(-screen, screen);
    _sendUnsentLines();
  }

  /// AUTONOMOUS PATCH: [lines] more from [RemoteScrollLink]. The mirror counts
  /// every row it asks for, so none is dropped here, as [_queueLines] drops them
  /// for the finger: a turn back nets against what still waits, and there is no
  /// cap of a screen — the mirror bounds what it asks for itself.
  void _queueLinkLines(int lines) {
    if (lines == 0) return;
    // What the finger left waiting is not the mirror's to send.
    if (!_unsentFromLink) _unsentLines = 0;
    _unsentFromLink = true;
    _unsentLines += lines;
    _sendUnsentLines();
  }

  /// AUTONOMOUS PATCH: [RemoteScrollLink.cancel] — the mirror's rows still
  /// waiting are dropped, and how many is returned. Left to go out, they
  /// scrolled the program on for seconds after the finger let go: the screen
  /// moved by itself (reported on a phone, 2026-10-06).
  int _cancelLinkLines() {
    if (!_unsentFromLink) return 0;
    final dropped = _unsentLines;
    _unsentLines = 0;
    _gapWait?.cancel();
    _gapWait = null;
    return dropped;
  }

  /// AUTONOMOUS PATCH: [RemoteScrollLink.sendPage] — Page Up or Page Down,
  /// alone: nothing waiting and nothing unanswered, so the program draws this
  /// page by itself, never two at once. Answered like a batch of wheel events
  /// (any write from the program), and paced with them.
  bool _sendLinkPage(int direction) {
    if (direction == 0 || _unsentLines != 0 || _batchesInFlight > 0) {
      return false;
    }
    // A program scrolled by other means than its keys.
    if (widget.onAltBufferScroll != null) return false;
    _batchesInFlight++;
    _answerWait?.cancel();
    _answerWait = Timer(_answerWaitLimit, _onAnswerWaitOver);
    widget.terminal.keyInput(
      direction < 0 ? TerminalKey.pageUp : TerminalKey.pageDown,
    );
    return true;
  }

  void _sendUnsentLines() {
    if (_unsentLines == 0 || _batchesInFlight >= _maxBatchesInFlight) return;
    final fromLink = _unsentFromLink;
    if (fromLink && _sinceBatch.isRunning && _sinceBatch.elapsed < _burstGap) {
      _gapWait ??= Timer(_burstGap - _sinceBatch.elapsed, () {
        _gapWait = null;
        _sendUnsentLines();
      });
      return;
    }
    final most = fromLink ? _exactBurst : _maxBatchLines;
    final lines = _unsentLines.clamp(-most, most);
    final sign = lines.sign;
    _unsentLines -= lines;
    _batchesInFlight++;
    _answerWait?.cancel();
    _answerWait = Timer(_answerWaitLimit, _onAnswerWaitOver);
    widget.onWheelsSent?.call(lines);
    var sent = lines.abs();
    // Claude Code drops the first wheel event after a turn (it takes a lone one
    // for a trackpad's bounce). The mirror counts rows, so it is sent one more
    // to drop; the finger's own scroll just moves a row less, as it always has.
    if (fromLink && _lastSentSign != 0 && sign != _lastSentSign) sent++;
    _lastSentSign = sign;
    _sinceBatch
      ..reset()
      ..start();
    for (var i = 0; i < sent; i++) {
      _sendScrollEvent(sign < 0);
    }
  }

  void _onAnswerWaitOver() {
    _answerWait = null;
    _batchesInFlight = 0;
    _sendUnsentLines();
  }

  void _resetPacing() {
    _answerWait?.cancel();
    _answerWait = null;
    _gapWait?.cancel();
    _gapWait = null;
    _unsentLines = 0;
    _unsentFromLink = false;
    _batchesInFlight = 0;
  }

  @override
  Widget build(BuildContext context) {
    if (!isAltBuffer) {
      return widget.child;
    }

    return Listener(
      onPointerSignal: (event) {
        lastPointerPosition = event.position;
      },
      onPointerDown: (event) {
        lastPointerPosition = event.position;
      },
      child: NotificationListener<ScrollNotification>(
        // AUTONOMOUS PATCH: where a scroll begins and ends — for
        // [TerminalScrollGestureHandler.onScrollStart] and `onScrollEnd`. Only
        // this scrollable's own, and passed on for the page to see as well.
        onNotification: (notification) {
          if (notification.depth != 0) return false;
          if (notification is ScrollStartNotification) {
            widget.onScrollStart?.call(notification.metrics.pixels);
          } else if (notification is ScrollEndNotification) {
            widget.onScrollEnd?.call();
          }
          return false;
        },
        child: InfiniteScrollView(
          onScroll: _onScroll,
          physics: widget.physics,
          child: widget.child,
        ),
      ),
    );
  }
}
