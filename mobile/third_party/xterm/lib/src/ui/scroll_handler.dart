import 'dart:async';
import 'dart:math' show max;

import 'package:flutter/widgets.dart';
import 'package:xterm/core.dart';
import 'package:xterm/src/ui/infinite_scroll_view.dart';

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

  @override
  void initState() {
    widget.terminal.addListener(_onTerminalUpdated);
    isAltBuffer = widget.terminal.isUsingAltBuffer;
    super.initState();
  }

  @override
  void dispose() {
    widget.terminal.removeListener(_onTerminalUpdated);
    _resetPacing();
    super.dispose();
  }

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

    final delta = currentLineOffset - lastLineOffset;

    if (widget.paced) {
      _queueLines(delta);
    } else {
      if (delta != 0) widget.onWheelsSent?.call(delta);
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

  void _sendUnsentLines() {
    if (_unsentLines == 0 || _batchesInFlight >= _maxBatchesInFlight) return;
    final lines = _unsentLines;
    _unsentLines = 0;
    _batchesInFlight++;
    _answerWait?.cancel();
    _answerWait = Timer(_answerWaitLimit, _onAnswerWaitOver);
    widget.onWheelsSent?.call(lines);
    for (var i = 0; i < lines.abs(); i++) {
      _sendScrollEvent(lines < 0);
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
    _unsentLines = 0;
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
      child: InfiniteScrollView(
        onScroll: _onScroll,
        physics: widget.physics,
        child: widget.child,
      ),
    );
  }
}
