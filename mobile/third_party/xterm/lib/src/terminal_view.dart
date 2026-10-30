import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:xterm/src/core/buffer/cell_offset.dart';

import 'package:xterm/src/core/input/keys.dart';
import 'package:xterm/src/terminal.dart';
import 'package:xterm/src/ui/controller.dart';
import 'package:xterm/src/ui/cursor_type.dart';
import 'package:xterm/src/ui/custom_text_edit.dart';
import 'package:xterm/src/ui/gesture/gesture_handler.dart';
import 'package:xterm/src/ui/input_map.dart';
import 'package:xterm/src/ui/keyboard_listener.dart';
import 'package:xterm/src/ui/keyboard_visibility.dart';
import 'package:xterm/src/ui/render.dart';
import 'package:xterm/src/ui/remote_scroll_mirror.dart' show RemoteScrollMemory;
import 'package:xterm/src/ui/scroll_handler.dart';
import 'package:xterm/src/ui/shortcut/actions.dart';
import 'package:xterm/src/ui/shortcut/shortcuts.dart';
import 'package:xterm/src/ui/terminal_text_style.dart';
import 'package:xterm/src/ui/terminal_theme.dart';
import 'package:xterm/src/ui/themes.dart';
import 'dart:async';
import 'dart:math' show max, min;

import 'package:xterm/src/utils/input_trace.dart';
import 'package:xterm/src/utils/unicode_v11.dart';

class TerminalView extends StatefulWidget {
  const TerminalView(
    this.terminal, {
    super.key,
    this.controller,
    this.theme = TerminalThemes.defaultTheme,
    this.textStyle = const TerminalStyle(),
    this.textScaler,
    this.padding,
    this.scrollController,
    this.autoResize = true,
    this.resizeBuffer = true,
    this.renderingEnabled = true,
    this.backgroundOpacity = 1,
    this.focusNode,
    this.autofocus = false,
    this.onTapDown,
    this.onTapUp,
    this.onLongPressStart,
    this.onSecondaryTapDown,
    this.onSecondaryTapUp,
    this.mouseCursor = SystemMouseCursors.text,
    this.keyboardType = TextInputType.text,
    this.keyboardAppearance = Brightness.dark,
    this.cursorType = TerminalCursorType.block,
    this.alwaysShowCursor = false,
    this.deleteDetection = false,
    this.allowedMimeTypes = const <String>[],
    this.onContentInserted,
    this.shortcuts,
    this.onKeyEvent,
    this.readOnly = false,
    this.hardwareKeyboardOnly = false,
    this.simulateScroll = true,
    this.onAltBufferScroll,
    this.altBufferScrollPhysics,
    this.altBufferScrollPaced = false,
    this.altBufferScrollAnimated = false,
    this.onAltBufferScrollShift,
    this.altBufferScrollMirror = false,
    this.altBufferScrollPageKeys = false,
    this.altBufferScrollMemory,
    this.keepsInputAcrossTerminals = false,
    this.predictsEcho = false,
  });

  /// The underlying terminal that this widget renders.
  final Terminal terminal;

  final TerminalController? controller;

  /// The theme to use for this terminal.
  final TerminalTheme theme;

  /// The style to use for painting characters.
  final TerminalStyle textStyle;

  final TextScaler? textScaler;

  /// Padding around the inner [Scrollable] widget.
  final EdgeInsets? padding;

  /// Scroll controller for the inner [Scrollable] widget.
  final ScrollController? scrollController;

  /// Should this widget automatically notify the underlying terminal when its
  /// size changes. [true] by default.
  final bool autoResize;

  /// Resize the emulator together with the viewport. Set false for a remote
  /// grid: report the requested size through Terminal.onResize and retain the
  /// captured cells until the remote side supplies its resized screen.
  final bool resizeBuffer;

  /// Whether output should schedule renderer layout/paint work. Disable while
  /// retaining a hidden view; the terminal buffer continues receiving output.
  /// Re-enabling reconciles geometry and scroll position on the next layout.
  /// An enclosing disabled [TickerMode] also suspends rendering updates.
  final bool renderingEnabled;

  /// Opacity of the terminal background. Set to 0 to make the terminal
  /// background transparent.
  final double backgroundOpacity;

  /// An optional focus node to use as the focus node for this widget.
  final FocusNode? focusNode;

  /// True if this widget will be selected as the initial focus when no other
  /// node in its scope is currently focused.
  final bool autofocus;

  /// Return true to handle this primary click in the host instead of sending
  /// mouse reports to the terminal or clearing its selection. The matching
  /// tap up still calls [onTapUp]; dragging does not complete a click.
  final bool Function(TapDownDetails, CellOffset)? onTapDown;

  /// Callback for a primary click handled locally, including [onTapDown].
  final void Function(TapUpDetails, CellOffset)? onTapUp;

  /// Return true to take a touch long press in the host instead of selecting
  /// the word under it. The drag that follows the press is then the host's
  /// too: the terminal neither selects nor extends a selection for it.
  final bool Function(LongPressStartDetails, CellOffset)? onLongPressStart;

  /// Function called when the user taps on the terminal with a secondary
  /// button.
  final void Function(TapDownDetails, CellOffset)? onSecondaryTapDown;

  /// Function called when the user stops holding down a secondary button.
  final void Function(TapUpDetails, CellOffset)? onSecondaryTapUp;

  /// The mouse cursor for mouse pointers that are hovering over the terminal.
  /// [SystemMouseCursors.text] by default.
  final MouseCursor mouseCursor;

  /// The type of information for which to optimize the text input control.
  /// [TextInputType.text] by default so native IMEs can compose text.
  final TextInputType keyboardType;

  /// The appearance of the keyboard. [Brightness.dark] by default.
  ///
  /// This setting is only honored on iOS devices.
  final Brightness keyboardAppearance;

  /// The type of cursor to use. [TerminalCursorType.block] by default.
  final TerminalCursorType cursorType;

  /// Whether to always show the cursor. This is useful for debugging.
  /// [false] by default.
  final bool alwaysShowCursor;

  /// Workaround to detect delete key for platforms and IMEs that does not
  /// emit hardware delete event. Prefered on mobile platforms. [false] by
  /// default.
  final bool deleteDetection;

  /// Clipboard content types this terminal accepts from a software keyboard —
  /// see [CustomTextEdit.allowedMimeTypes]. Empty means the keyboard refuses the
  /// paste itself, without asking.
  final List<String> allowedMimeTypes;

  /// One accepted clipboard item, handed straight to the host: a pty takes bytes,
  /// and what to do with an image is the embedder's decision, not this widget's.
  final void Function(KeyboardInsertedContent content)? onContentInserted;

  /// Shortcuts for this terminal. This has higher priority than input handler
  /// of the terminal If not provided, [defaultTerminalShortcuts] will be used.
  final Map<ShortcutActivator, Intent>? shortcuts;

  /// Keyboard event handler of the terminal. This has higher priority than
  /// [shortcuts] and input handler of the terminal.
  final FocusOnKeyEventCallback? onKeyEvent;

  /// True if no input should send to the terminal.
  final bool readOnly;

  /// True if only hardware keyboard events should be used as input. This will
  /// also prevent any on-screen keyboard to be shown.
  final bool hardwareKeyboardOnly;

  /// If true, when the terminal is in alternate buffer (for example running
  /// vim, man, etc), if the application does not declare that it can handle
  /// scrolling, the terminal will simulate scrolling by sending up/down arrow
  /// keys to the application. This is standard behavior for most terminal
  /// emulators. True by default.
  final bool simulateScroll;

  /// See `TerminalScrollGestureHandler.onAltBufferScroll` for why a caller would ever supply this —
  /// a program that owns terminal mouse-tracking but doesn't correctly handle wheel reports needs a
  /// backend-native way to scroll instead of the emulator's own mouse/key simulation.
  final void Function(bool up)? onAltBufferScroll;

  /// AUTONOMOUS PATCH: the physics of the alternate buffer's scroll — the one
  /// that turns a drag into wheel events for the program — layered over the
  /// platform's own. Null keeps the platform's.
  final ScrollPhysics? altBufferScrollPhysics;

  /// AUTONOMOUS PATCH: the alternate buffer's scroll sends its wheel events
  /// only as fast as the program answers them — at most two batches without a
  /// write back — and lines scrolled meanwhile go together in the next batch.
  /// A remote program redraws at the far end of a link, and wheel events sent
  /// faster than that queue up, moving its screen long after the finger
  /// stopped. False sends each line as it is scrolled, as upstream.
  final bool altBufferScrollPaced;

  /// AUTONOMOUS PATCH: a full-screen program's redraw that answers the wheel
  /// slides into place over a few frames, rather than jumping there a line or
  /// more at a time — see `RemoteScrollAnimator`. Purely visual: the emulator
  /// holds the new screen at once. False draws each redraw as it lands, as
  /// upstream.
  final bool altBufferScrollAnimated;

  /// AUTONOMOUS PATCH: with [altBufferScrollAnimated], told of each redraw
  /// that answered the wheel — the rows it slid, or 0 when it could not be read
  /// as a scroll and jumped. For measuring; nothing depends on it.
  final void Function(int rows)? onAltBufferScrollShift;

  /// AUTONOMOUS PATCH: a full-screen program's scroll is moved by the finger on
  /// the phone and only filled in by the program — the scrolling rows drawn from
  /// rows already seen, the program kept a few rows ahead, and brought back to
  /// the row on screen when the scroll is over. See `RemoteScrollMirror`. Takes
  /// the place of [altBufferScrollAnimated]'s slide. False leaves the screen to
  /// follow the program's redraws.
  final bool altBufferScrollMirror;

  /// AUTONOMOUS PATCH: with [altBufferScrollMirror], whether the program may be
  /// scrolled a page at a time with its Page Up and Page Down keys while the
  /// finger is far ahead of it — for a program known to take them as half a
  /// screen of its transcript (Claude Code), and only while it shows its
  /// prompt. See `RemoteScrollMirror._sendPage`.
  final bool altBufferScrollPageKeys;

  /// AUTONOMOUS PATCH: with [altBufferScrollMirror], what is known of this
  /// program's rows, kept by the embedder for the program (an agent) across
  /// the emulators a keyframe replaces and the views opened on it — see
  /// [RemoteScrollMemory]. Null keeps it in the view only.
  final RemoteScrollMemory? altBufferScrollMemory;

  /// AUTONOMOUS PATCH: the keyboard's buffer — and what it is composing — is
  /// kept when [terminal] is replaced, for an embedder that replaces it only
  /// with the next screen of the SAME stream (a keyframe), and gives another
  /// stream a view of its own.
  ///
  /// ⚠️ Emptied there, it was emptied under somebody typing: every keyframe —
  /// one ends each keyboard raised — reset the buffer while the keyboard could
  /// still have an edit on its way, which was then read against the emptied
  /// buffer and typed what was already typed a second time. False keeps
  /// upstream's reset, for a view that is handed another stream's terminal.
  final bool keepsInputAcrossTerminals;

  /// AUTONOMOUS PATCH: what is typed is drawn at the cursor at once, faint,
  /// until the terminal's own echo of it arrives — a remote program's echo is a
  /// round trip away, 50–120ms measured on a phone, and the keys look dead until
  /// then. Drawn over the screen only: nothing is written to the emulator and
  /// nothing extra is sent. See [TerminalViewState._predictEcho] for when a key
  /// is predicted at all.
  final bool predictsEcho;

  @override
  State<TerminalView> createState() => TerminalViewState();
}

class TerminalViewState extends State<TerminalView> {
  late FocusNode _focusNode;

  late final ShortcutManager _shortcutManager;

  final _customTextEditKey = GlobalKey<CustomTextEditState>();

  final _scrollableKey = GlobalKey<ScrollableState>();

  final _viewportKey = GlobalKey();

  String? _composingText;

  int _composingBacktrackCells = 0;

  // ── AUTONOMOUS PATCH: local echo — see [TerminalView.predictsEcho] ──────────

  /// What is drawn ahead of the echo: [_pending], once the cursor rests at the
  /// input point; nothing otherwise.
  String _predicted = '';

  /// Every key typed and sent since the last one seen echoed, drawn or not. One
  /// typed while the input point was not known (just after Enter or a delete)
  /// waits here, and is drawn the moment the first echo shows where it lands —
  /// keys typed faster than the echo came back used to be lost to prediction
  /// one after another (16 of 52 misses, iPhone 14, 2026-10-19).
  String _pending = '';

  /// Deletes sent and not yet echoed: while set, [_echoFrom] waits for the
  /// cursor to step back along its line, which is the input point again.
  int _pendingDeletes = 0;

  /// The wait for a key's echo was extended once already — see [_echoNeverCame].
  bool _waitedLonger = false;

  /// Where the cursor was, and its line's [BufferLine.paintVersion], when the
  /// oldest key not yet echoed went out. Null while nothing is awaited.
  ({int x, int y, int version})? _echoFrom;

  /// Where the cursor rested after the last echo: the input point. A key typed
  /// with the cursor anywhere else — a program mid-redraw, output streaming —
  /// is not predicted, since the echo will not land at the cursor.
  ({int x, int y})? _inputPoint;

  /// Whether this terminal has been seen to echo what is typed. Off at first,
  /// and off again after a key whose echo never came (a password prompt): only
  /// a key seen echoed turns prediction back on.
  bool _echoes = false;

  Timer? _echoTimeout;

  /// How long a key's echo may take before it is taken not to be coming.
  static const _echoWait = Duration(milliseconds: 400);

  /// How much longer an echo is waited for when nothing was drawn ahead of it —
  /// see [_echoNeverCame].
  static const _lateEchoWait = Duration(milliseconds: 1600);

  late TerminalController _controller;

  late ScrollController _scrollController;

  RenderTerminal get renderTerminal =>
      _viewportKey.currentContext!.findRenderObject() as RenderTerminal;

  /// AUTONOMOUS PATCH: [lines] wheel lines just went to a full-screen program —
  /// see [TerminalView.altBufferScrollAnimated].
  void _expectAltBufferScroll(int lines) {
    final render = _viewportKey.currentContext?.findRenderObject();
    if (render is RenderTerminal) render.expectRemoteScroll(lines);
  }

  /// AUTONOMOUS PATCH: what [TerminalView.altBufferScrollMirror] asks the
  /// program to scroll through — the scroll handler's own pacing.
  final _remoteScrollLink = RemoteScrollLink();

  RenderTerminal? get _renderOrNull {
    final render = _viewportKey.currentContext?.findRenderObject();
    return render is RenderTerminal ? render : null;
  }

  void _mirrorScrollStart(double pixels) =>
      _renderOrNull?.mirrorScrollStart(pixels);

  bool _mirrorScrollTo(double pixels) =>
      _renderOrNull?.mirrorScrollTo(pixels) ?? false;

  void _mirrorScrollEnd() => _renderOrNull?.mirrorScrollEnd();

  @override
  void initState() {
    _focusNode = widget.focusNode ?? FocusNode();
    _controller = widget.controller ?? TerminalController();
    _scrollController = widget.scrollController ?? ScrollController();
    widget.terminal.addListener(_onTerminalChanged);
    _shortcutManager = ShortcutManager(
      shortcuts: widget.shortcuts ?? defaultTerminalShortcuts,
    );
    super.initState();
  }

  @override
  void didUpdateWidget(TerminalView oldWidget) {
    if (!identical(oldWidget.terminal, widget.terminal)) {
      inputTrace(
        () => 'view terminal SWAPPED (composing "${_composingText ?? ''}")'
            '${widget.keepsInputAcrossTerminals ? ' → input kept' : ' → IME reset after frame'}',
      );
      oldWidget.terminal.removeListener(_onTerminalChanged);
      widget.terminal.addListener(_onTerminalChanged);
      // A new screen: nothing predicted on the old one is where it was drawn.
      _dropPrediction();
      _inputPoint = null;
      if (!widget.keepsInputAcrossTerminals) {
        // A marked string is owned by the old native input session. TerminalView
        // states are reused while switching agents, so never carry that overlay
        // or editing buffer into the newly selected terminal.
        _composingText = null;
        _composingBacktrackCells = 0;
        final currentTerminal = widget.terminal;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || !identical(widget.terminal, currentTerminal)) return;
          _customTextEditKey.currentState?.resetEditingState();
        });
      }
    }
    if (oldWidget.focusNode != widget.focusNode) {
      if (oldWidget.focusNode == null) {
        _focusNode.dispose();
      }
      _focusNode = widget.focusNode ?? FocusNode();
    }
    if (oldWidget.controller != widget.controller) {
      if (oldWidget.controller == null) {
        _controller.dispose();
      }
      _controller = widget.controller ?? TerminalController();
    }
    if (oldWidget.scrollController != widget.scrollController) {
      if (oldWidget.scrollController == null) {
        _scrollController.dispose();
      }
      _scrollController = widget.scrollController ?? ScrollController();
    }
    _shortcutManager.shortcuts = widget.shortcuts ?? defaultTerminalShortcuts;
    super.didUpdateWidget(oldWidget);
  }

  @override
  void dispose() {
    _echoTimeout?.cancel();
    widget.terminal.removeListener(_onTerminalChanged);
    if (widget.focusNode == null) {
      _focusNode.dispose();
    }
    if (widget.controller == null) {
      _controller.dispose();
    }
    if (widget.scrollController == null) {
      _scrollController.dispose();
    }
    _shortcutManager.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    Widget child = Scrollable(
      key: _scrollableKey,
      controller: _scrollController,
      viewportBuilder: (context, offset) {
        return _TerminalView(
          key: _viewportKey,
          terminal: widget.terminal,
          controller: _controller,
          offset: offset,
          padding: MediaQuery.of(context).padding,
          autoResize: widget.autoResize,
          resizeBuffer: widget.resizeBuffer,
          renderingEnabled: widget.renderingEnabled,
          textStyle: widget.textStyle,
          textScaler: widget.textScaler ?? MediaQuery.textScalerOf(context),
          theme: widget.theme,
          focusNode: _focusNode,
          cursorType: widget.cursorType,
          alwaysShowCursor: widget.alwaysShowCursor,
          onEditableRect: _onEditableRect,
          composingText: _composingText,
          composingBacktrackCells: _composingBacktrackCells,
          animateRemoteScroll: widget.altBufferScrollAnimated,
          onRemoteScrollShift: widget.onAltBufferScrollShift,
          mirrorRemoteScroll: widget.altBufferScrollMirror,
          mirrorPageKeys: widget.altBufferScrollPageKeys,
          remoteScrollMemory: widget.altBufferScrollMemory,
          remoteScrollLink: _remoteScrollLink,
        );
      },
    );

    child = TerminalScrollGestureHandler(
      terminal: widget.terminal,
      simulateScroll: widget.simulateScroll,
      onAltBufferScroll: widget.onAltBufferScroll,
      physics: widget.altBufferScrollPhysics,
      paced: widget.altBufferScrollPaced,
      onWheelsSent:
          widget.altBufferScrollAnimated ? _expectAltBufferScroll : null,
      link: widget.altBufferScrollMirror ? _remoteScrollLink : null,
      onScrollPosition: widget.altBufferScrollMirror ? _mirrorScrollTo : null,
      onScrollStart: widget.altBufferScrollMirror ? _mirrorScrollStart : null,
      onScrollEnd: widget.altBufferScrollMirror ? _mirrorScrollEnd : null,
      getCellOffset: (offset) => renderTerminal.getCellOffset(offset),
      getLineHeight: () => renderTerminal.lineHeight,
      child: child,
    );

    if (!widget.hardwareKeyboardOnly) {
      child = CustomTextEdit(
        key: _customTextEditKey,
        focusNode: _focusNode,
        autofocus: widget.autofocus,
        inputType: widget.keyboardType,
        keyboardAppearance: widget.keyboardAppearance,
        deleteDetection: widget.deleteDetection,
        allowedMimeTypes: widget.allowedMimeTypes,
        onContentInserted: widget.onContentInserted,
        onInsert: _onInsert,
        onDelete: (count) {
          inputTrace(() => 'view delete ×$count');
          _probeDelete(count);
          _scrollToBottom();
          for (var index = 0; index < count; index++) {
            widget.terminal.keyInput(TerminalKey.backspace);
          }
        },
        onComposing: _onComposing,
        onAction: (action) {
          _restartPrediction();
          _scrollToBottom();
          if (action == TextInputAction.done ||
              action == TextInputAction.newline) {
            widget.terminal.keyInput(TerminalKey.enter);
            _customTextEditKey.currentState?.resetEditingState();
          }
        },
        onKeyEvent: _handleKeyEvent,
        readOnly: widget.readOnly,
        child: child,
      );
    } else if (!widget.readOnly) {
      // Only listen for key input from a hardware keyboard.
      child = CustomKeyboardListener(
        child: child,
        focusNode: _focusNode,
        autofocus: widget.autofocus,
        onInsert: _onInsert,
        onComposing: (text) => _onComposing(text, 0),
        onKeyEvent: _handleKeyEvent,
      );
    }

    child = TerminalActions(
      terminal: widget.terminal,
      controller: _controller,
      child: child,
    );

    child = KeyboardVisibilty(
      onKeyboardShow: _onKeyboardShow,
      child: child,
    );

    child = TerminalGestureHandler(
      terminalView: this,
      terminalController: _controller,
      onTapUp: _onTapUp,
      onTapDown: _onTapDown,
      onLongPressStart:
          widget.onLongPressStart != null ? _onLongPressStart : null,
      onSecondaryTapDown:
          widget.onSecondaryTapDown != null ? _onSecondaryTapDown : null,
      onSecondaryTapUp:
          widget.onSecondaryTapUp != null ? _onSecondaryTapUp : null,
      readOnly: widget.readOnly,
      child: child,
    );

    child = MouseRegion(
      cursor: widget.mouseCursor,
      child: child,
    );

    child = Container(
      color: widget.theme.background.withOpacity(widget.backgroundOpacity),
      padding: widget.padding,
      child: child,
    );

    return child;
  }

  void requestKeyboard() {
    _customTextEditKey.currentState?.requestKeyboard();
  }

  void closeKeyboard() {
    _customTextEditKey.currentState?.closeKeyboard();
  }

  /// AUTONOMOUS PATCH: empties the native input buffer, the way a submitted
  /// line does, for an embedder that has cleared the prompt by other means
  /// (a Ctrl+U sent from its own key strip).
  void clearInputBuffer() {
    _customTextEditKey.currentState?.resetEditingState();
  }

  Rect get cursorRect {
    return renderTerminal.cursorOffset & renderTerminal.cellSize;
  }

  Rect get globalCursorRect {
    return renderTerminal.localToGlobal(renderTerminal.cursorOffset) &
        renderTerminal.cellSize;
  }

  void _onTapUp(TapUpDetails details) {
    final offset = renderTerminal.getCellOffset(
      renderTerminal.globalToLocal(details.globalPosition),
    );
    widget.onTapUp?.call(details, offset);
  }

  bool _onTapDown(TapDownDetails details) {
    final offset = renderTerminal.getCellOffset(
      renderTerminal.globalToLocal(details.globalPosition),
    );
    if (widget.onTapDown?.call(details, offset) ?? false) return true;
    if (_controller.selection != null) {
      _controller.clearSelection();
    } else {
      if (!widget.hardwareKeyboardOnly) {
        _customTextEditKey.currentState?.requestKeyboard();
      } else {
        _focusNode.requestFocus();
      }
    }
    return false;
  }

  bool _onLongPressStart(LongPressStartDetails details) {
    final offset = renderTerminal.getCellOffset(
      renderTerminal.globalToLocal(details.globalPosition),
    );
    return widget.onLongPressStart?.call(details, offset) ?? false;
  }

  void _onSecondaryTapDown(TapDownDetails details) {
    final offset = renderTerminal.getCellOffset(details.localPosition);
    widget.onSecondaryTapDown?.call(details, offset);
  }

  void _onSecondaryTapUp(TapUpDetails details) {
    final offset = renderTerminal.getCellOffset(details.localPosition);
    widget.onSecondaryTapUp?.call(details, offset);
  }

  bool get hasInputConnection {
    return _customTextEditKey.currentState?.hasInputConnection == true;
  }

  void _onInsert(String text) {
    if (text.isEmpty) return;

    final key = charToTerminalKey(text.trim());

    // On mobile platforms there is no guarantee that virtual keyboard will
    // generate hardware key events. So we need first try to send the key
    // as a hardware key event. If it fails, then we send it as a text input.
    final consumed = key == null ? false : widget.terminal.keyInput(key);
    inputTrace(
      () =>
          'view insert "${traceText(text)}" as ${consumed ? 'key $key' : 'text'}',
    );

    if (!consumed) {
      widget.terminal.textInput(text);
      _predictEcho(text);
    } else {
      _restartPrediction();
    }

    _scrollToBottom();
  }

  void _onComposing(String? text, int backtrackCells) {
    // A pre-edit is drawn at the cursor too, and owns it while it lasts.
    if (text != null) _dropPrediction();
    if (text != null && _terminalAlreadyEchoes(text)) {
      text = null;
      backtrackCells = 0;
    }
    if (!mounted ||
        (_composingText == text &&
            _composingBacktrackCells == backtrackCells)) {
      return;
    }
    setState(() {
      _composingText = text;
      _composingBacktrackCells = backtrackCells;
    });
  }

  /// The native macOS input client keeps a marked range while a remote TUI
  /// has already echoed the exact same characters. Keeping our own preview in
  /// that case duplicates the cells and makes them look underlined/stale until
  /// the next keyframe. A real CJK pre-edit has not reached the PTY yet, so it
  /// does not match the cells before the cursor and remains visible.
  bool _terminalAlreadyEchoes(String text) {
    if (text.isEmpty) return false;
    final buffer = widget.terminal.buffer;
    if (buffer.cursorX <= 0) return false;
    return buffer.currentLine.getText(0, buffer.cursorX).endsWith(text);
  }

  void _onTerminalChanged() {
    if (mounted) _followEcho();
    final text = _composingText;
    if (!mounted || text == null || !_terminalAlreadyEchoes(text)) return;
    setState(() {
      _composingText = null;
      _composingBacktrackCells = 0;
    });
  }

  /// AUTONOMOUS PATCH: [text] just went to the terminal — drawn at the cursor
  /// ahead of its echo, when one is expected there. See [TerminalView.predictsEcho].
  ///
  /// ⚠️ **Only where the echo will land, and only once one has been seen.**
  /// Every key is a probe ([_echoFrom]): its echo arriving — the cursor moving
  /// on along its line — is what turns prediction on ([_echoes]), and a key
  /// whose echo never comes ([_echoWait]) turns it off, which is what keeps a
  /// password prompt from showing what is typed into it. And a key is drawn
  /// only with the cursor resting where the last echo left it ([_inputPoint]):
  /// a program redrawing or streaming output moves the cursor about, and a
  /// guess drawn there would be drawn in the wrong place.
  void _predictEcho(String text) {
    if (!widget.predictsEcho) return;
    if (!_echoable(text) || _composingText != null) {
      _dropPrediction();
      return;
    }
    if (_pendingDeletes > 0) {
      // A word retyped right after its deletes (Telex turns `duoc` into
      // `được` that way): where its echo lands depends on the deletes', which
      // have not come back. Nothing of it is drawn, and it is no probe either.
      _restartPrediction();
      inputTrace(() => 'echo not predicted (a word rewritten)');
      return;
    }
    final now = _cursorMark();
    _echoFrom ??= now;
    _pending += text;
    _drawPending(now);
    if (_predicted.isEmpty) {
      final at = _inputPoint;
      inputTrace(
        () => 'echo not predicted (seen echoing=$_echoes,'
            ' at input point=${at != null && at.x == now.x && at.y == now.y})',
      );
    }
    // ⚠️ From the oldest key not yet echoed, not restarted by each new one: restarted, a prompt
    // that never echoes was never found out while somebody kept typing into it, and prediction
    // stayed on over the whole password (review, 2026-10-19). An echo arriving restarts it.
    _echoTimeout ??= Timer(_echoWait, _echoNeverCame);
  }

  /// Draws all of [_pending] at the cursor — only with the cursor resting at the
  /// input point, a terminal seen echoing, and room left on the line.
  void _drawPending(({int x, int y, int version}) now) {
    final at = _inputPoint;
    if (_pending.isNotEmpty &&
        _echoes &&
        at != null &&
        at.x == now.x &&
        at.y == now.y &&
        now.x + _cells(_pending) <= widget.terminal.viewWidth) {
      _setPredicted(_pending);
      inputTrace(() => 'echo predicted "${traceText(_predicted)}"');
    } else if (_predicted.isNotEmpty) {
      _setPredicted('');
    }
  }

  /// The terminal changed: an echo arriving takes the keys it drew off the
  /// prediction, and shows where the rest lands; deletes echoed show where the
  /// input point now is; anything else at the cursor takes the prediction down.
  void _followEcho() {
    final from = _echoFrom;
    if (from == null) return;
    final now = _cursorMark();
    // Nothing at the cursor yet — a blink, a redraw elsewhere on the screen.
    if (now == from) return;
    if (_pendingDeletes > 0) {
      if (now.y == from.y && now.x < from.x) {
        // The deletes are echoed: where the cursor stepped back to is the input
        // point, and the next key is drawn at once rather than waiting for its
        // own echo (12 of 52 misses came right after a delete, 2026-10-19).
        // Counted in cells, as [_probeDelete] measured them.
        _pendingDeletes = max(0, _pendingDeletes - (from.x - now.x));
        _inputPoint = (x: now.x, y: now.y);
        inputTrace(() => 'echo after a delete: input point back at ${now.x}');
        if (_pendingDeletes > 0) {
          _echoFrom = now;
        } else {
          _dropPrediction();
        }
        return;
      }
      _dropPrediction();
      return;
    }
    if (now.y == from.y && now.x > from.x) {
      // ⚠️ **An echo is what was typed, drawn back.** The cursor moving on is not
      // enough: a prompt that masks what is typed (`*` for each key: sudo with
      // pwfeedback, `gh auth login`'s token) moves it just the same, and taking
      // that for an echo drew the rest of the password ahead of it (review,
      // 2026-10-19). Anything else at the cursor turns prediction off until a key
      // IS seen echoed. A password starting with the very character its prompt
      // masks with is the one case this cannot tell apart.
      if (!_shows(from, now.x, _pending)) {
        inputTrace(() => 'echo not what was typed — off');
        _echoes = false;
        _restartPrediction();
        return;
      }
      _echoes = true;
      _inputPoint = (x: now.x, y: now.y);
      _pending = _afterCells(_pending, now.x - from.x);
      if (_pending.isEmpty) {
        _dropPrediction();
      } else {
        _echoFrom = now;
        _drawPending(now);
        // The next key's echo gets a wait of its own, from now: what is drawn
        // must not outstay an echo that does not come by the longer wait a slow
        // first echo was given.
        _waitedLonger = false;
        _echoTimeout?.cancel();
        _echoTimeout = Timer(_echoWait, _echoNeverCame);
      }
      return;
    }
    // The cursor went elsewhere, or its line was redrawn without it moving on:
    // the screen is the truth now.
    _dropPrediction();
  }

  /// A key's echo did not come in [_echoWait].
  ///
  /// A guess drawn on screen whose echo never came is a terminal not echoing
  /// what is typed right now — a password prompt — and turns prediction off
  /// until a key is seen echoed again. That is what this wait is for, so it
  /// stays short. With nothing drawn ahead of it the echo costs no safety, and a
  /// program can be slow to echo the first key after Enter (Claude Code
  /// starting a turn: 9 of 19 such misses came right after Enter, 2026-10-19):
  /// it is waited for [_lateEchoWait] longer, prediction staying on, so that the
  /// echo, when it comes, still shows where the next keys land. Deletes whose
  /// echo never came — nothing to delete — just stop being waited for.
  void _echoNeverCame() {
    _echoTimeout = null;
    if (_pendingDeletes > 0) {
      _dropPrediction();
      return;
    }
    if (_predicted.isEmpty && _echoes && !_waitedLonger && _echoFrom != null) {
      _waitedLonger = true;
      inputTrace(() =>
          'echo slow, nothing drawn — waiting ${_lateEchoWait.inMilliseconds}ms more');
      _echoTimeout = Timer(_lateEchoWait, _echoNeverCame);
      return;
    }
    inputTrace(() => 'echo never came — off');
    _echoes = false;
    _dropPrediction();
  }

  /// AUTONOMOUS PATCH: [count] deletes just went out. What was drawn goes, and
  /// so does the input point — but the deletes are a probe of their own: once
  /// their echo steps the cursor back along its line, the input point is where
  /// it rests ([_followEcho]).
  void _probeDelete(int count) {
    // Deletes sent before the earlier ones were echoed (a held backspace) step
    // on from where those leave the cursor; started over, the probe ended at
    // the first echo, with the cursor still to step back.
    final awaited = _pendingDeletes;
    final from = _echoFrom;
    _restartPrediction();
    if (!widget.predictsEcho || !_echoes || count <= 0) return;
    if (awaited > 0 && from != null) {
      _pendingDeletes = awaited + _cellsBefore(from.x - awaited, count);
      _echoFrom = from;
    } else {
      _echoFrom = _cursorMark();
      _pendingDeletes = _cellsBefore(_echoFrom!.x, count);
    }
    _echoTimeout = Timer(_echoWait, _echoNeverCame);
  }

  /// How far back [count] deletes step the cursor from column [fromX]: the
  /// cells of the last [count] characters before it on the cursor's line, two
  /// for a wide one. Counted as one each, a wide character's delete ended the
  /// probe a delete early, and the next key was drawn a cell off (review,
  /// 2026-10-19).
  int _cellsBefore(int fromX, int count) {
    final buffer = widget.terminal.buffer;
    final y = buffer.absoluteCursorY;
    if (y < 0 || y >= buffer.lines.length) return count;
    final line = buffer.lines[y];
    var x = min(max(fromX, 0), line.length);
    var cells = 0;
    var deletes = 0;
    for (; deletes < count && x > 0; deletes++) {
      final wide =
          x >= 2 && line.getCodePoint(x - 1) == 0 && line.getWidth(x - 2) == 2;
      final step = wide ? 2 : 1;
      x -= step;
      cells += step;
    }
    // Deletes past the start of the line step nothing back on it; they are
    // still waited for, so that nothing is drawn before their echo has settled.
    return cells + (count - deletes);
  }

  /// A key that moves the cursor or the line rather than adding to it — a
  /// delete, Enter, an arrow: what is drawn goes, and so does the input point,
  /// so the next key waits for its own echo before anything is drawn ahead of
  /// it. A Telex word arrives as deletes and the word retyped, and drawn at once
  /// the new word sat after the old one until the deletes were echoed; and
  /// after Enter the cursor may be at a password prompt.
  void _restartPrediction() {
    _dropPrediction();
    _inputPoint = null;
  }

  void _dropPrediction() {
    _echoTimeout?.cancel();
    _echoTimeout = null;
    _echoFrom = null;
    _pending = '';
    _pendingDeletes = 0;
    _waitedLonger = false;
    if (_predicted.isNotEmpty) _setPredicted('');
  }

  void _setPredicted(String text) {
    _predicted = text;
    final render = _viewportKey.currentContext?.findRenderObject();
    if (render is RenderTerminal) render.predictedText = text;
  }

  ({int x, int y, int version}) _cursorMark() {
    final buffer = widget.terminal.buffer;
    final y = buffer.absoluteCursorY;
    final lines = buffer.lines;
    final version = y >= 0 && y < lines.length ? lines[y].paintVersion : -1;
    return (x: buffer.cursorX, y: y, version: version);
  }

  /// Whether a terminal echoes [text] as it is: printable characters taking a
  /// cell or two each.
  static bool _echoable(String text) {
    if (text.isEmpty) return false;
    for (final rune in text.runes) {
      if (rune < 0x20 || rune == 0x7f || unicodeV11.wcwidth(rune) <= 0) {
        return false;
      }
    }
    return true;
  }

  /// Whether the cells from [from] up to [toX] on its line show [typed] — as
  /// much of it as fills them, and nothing else. A cell never written stands for
  /// a typed space: a TUI may move the cursor past a blank instead of printing it.
  bool _shows(({int x, int y, int version}) from, int toX, String typed) {
    final lines = widget.terminal.buffer.lines;
    if (from.y < 0 || from.y >= lines.length) return false;
    final line = lines[from.y];
    var x = from.x;
    for (final rune in typed.runes) {
      if (x >= toX) break;
      if (x >= line.length) return false;
      final cell = line.getCodePoint(x);
      if (cell != rune && !(rune == 0x20 && cell == 0)) return false;
      final width = unicodeV11.wcwidth(rune);
      x += width > 0 ? width : 1;
    }
    return x == toX;
  }

  static int _cells(String text) {
    var cells = 0;
    for (final rune in text.runes) {
      final width = unicodeV11.wcwidth(rune);
      if (width > 0) cells += width;
    }
    return cells;
  }

  /// [text] without the characters filling its first [cells] cells.
  static String _afterCells(String text, int cells) {
    var used = 0;
    var index = 0;
    final runes = text.runes.toList();
    while (index < runes.length && used < cells) {
      final width = unicodeV11.wcwidth(runes[index]);
      used += width > 0 ? width : 0;
      index++;
    }
    return String.fromCharCodes(runes.skip(index));
  }

  @visibleForTesting
  String? get debugComposingText => _composingText;

  /// AUTONOMOUS PATCH: what is drawn at the cursor ahead of its echo.
  @visibleForTesting
  String get debugPredictedText => _predicted;

  /// Live input-client composition, independent of its visual preview (which
  /// may already match echoed terminal cells). Workspace shortcuts must let
  /// the IME finish its marked text before claiming a key.
  bool get isComposing {
    final range =
        _customTextEditKey.currentState?.currentTextEditingValue?.composing;
    return range != null && range.isValid && !range.isCollapsed;
  }

  KeyEventResult _handleKeyEvent(FocusNode focusNode, KeyEvent event) {
    final resultOverride = widget.onKeyEvent?.call(focusNode, event);
    if (resultOverride != null && resultOverride != KeyEventResult.ignored) {
      return resultOverride;
    }

    // ignore: invalid_use_of_protected_member
    final shortcutResult = _shortcutManager.handleKeypress(
      focusNode.context!,
      event,
    );

    if (shortcutResult != KeyEventResult.ignored) {
      return shortcutResult;
    }

    if (event is KeyUpEvent) {
      return KeyEventResult.ignored;
    }

    final key = keyToTerminalKey(event.logicalKey);
    final reservesTerminalKey = HardwareKeyboard.instance.isControlPressed ||
        HardwareKeyboard.instance.isMetaPressed;

    // Let the native text input client process Backspace while editable. Some
    // IMEs emit it internally to replace an earlier committed letter (Telex
    // does this for transformations such as `u` to `ư`).
    //
    // ONLY WHERE THE EMBEDDER HOLDS UP ITS END. This hands the key to the
    // platform and sends nothing, which is a bargain only Apple's embedder
    // keeps: AppKit turns Backspace into `deleteBackward:` and ships the
    // selector to Dart over `TextInputClient.performSelectors`, which
    // CustomTextEdit answers (see its performSelector). The GTK embedder has
    // no performSelectors channel method at all, and its key handler names
    // GDK_KEY_BackSpace explicitly to do NOTHING with it — "already handled
    // inside the framework in RenderEditable", which is true of an
    // EditableText and false of the bare TextInputClient below. So on Linux
    // the key was dropped here, dropped again by the engine, and no byte ever
    // reached the pty: everything typed except Backspace.
    //
    // Everywhere else the key falls through to keyInput() at the bottom, where
    // the keytab turns it into ^? (\x7f). Composition is not at risk either
    // way — while an IME is composing, CustomTextEdit._onKeyEvent never calls
    // this method.
    final nativeClientOwnsBackspace =
        defaultTargetPlatform == TargetPlatform.macOS ||
            defaultTargetPlatform == TargetPlatform.iOS;
    if (key == TerminalKey.backspace &&
        nativeClientOwnsBackspace &&
        !widget.hardwareKeyboardOnly &&
        !reservesTerminalKey) {
      return KeyEventResult.skipRemainingHandlers;
    }

    // On macOS a physical key arrives before the platform text-input client
    // reports its composing value. Forwarding printable keys here therefore
    // leaks IME pre-edit input (for example `ni`) to the PTY before the final
    // committed text (`に`) arrives. Let TextInputClient own all text without
    // Control/Command; it will call _onInsert exactly once on commit.
    final isTextInput = _isPrintableText(event.character);
    if (isTextInput && !reservesTerminalKey) {
      // Do not let another Flutter shortcut consume this before macOS gets a
      // chance to update the native text-input client.
      return KeyEventResult.skipRemainingHandlers;
    }

    if (key == null) {
      return KeyEventResult.ignored;
    }

    // ⌘ IS THE APP'S MODIFIER, NEVER THE TERMINAL'S. No terminal emulator sends
    // a Command chord to the pty — Terminal.app and iTerm both reserve it for
    // themselves — but this fell through to keyInput() below, which is not even
    // given `meta`, so ⌘] arrived as a bare bracketRight: it typed "]" into the
    // shell AND returned handled, which stopped the chord from ever reaching
    // the app's own Shortcuts above. That is one bug wearing two faces, and it
    // ate every app shortcut whose base key has a terminal mapping — moving
    // between panes, closing one, opening an agent, reloading.
    //
    // Returning `ignored` (not skipRemainingHandlers) is the point: the event
    // keeps travelling UP the focus chain to those Shortcuts. xterm's own
    // ⌘C/⌘V/⌘A are matched earlier, by the shortcut map, so they still work.
    //
    // Not gated on Apple: ⌘ is this app's modifier on every desktop it runs on
    // (app_shortcuts.dart declares every one of them `meta: true`, which is
    // the Super key on Linux). Gating it there meant a focused terminal on
    // Linux swallowed Super+key — typing the bare letter into the shell — and
    // the app's own Shortcuts never saw a single chord.
    if (HardwareKeyboard.instance.isMetaPressed) {
      return KeyEventResult.ignored;
    }

    // ⌃⇥ IS THE APP'S, EVERYWHERE. Ctrl generally belongs to the terminal — it
    // is how a shell gets ^C, ^D, ^Z — so this is a single named exception
    // rather than a rule about Ctrl: no shell or tmux binding uses Ctrl+Tab,
    // and it is the chord every tabbed app moves between views with, so the
    // hand reaches for it here too. Without this the terminal answered it and
    // the app's Shortcuts never saw the key.
    if (key == TerminalKey.tab && HardwareKeyboard.instance.isControlPressed) {
      return KeyEventResult.ignored;
    }

    final handled = widget.terminal.keyInput(
      key,
      ctrl: HardwareKeyboard.instance.isControlPressed,
      alt: HardwareKeyboard.instance.isAltPressed,
      shift: HardwareKeyboard.instance.isShiftPressed,
    );

    if (handled) {
      _restartPrediction();
      _scrollToBottom();
      if (key == TerminalKey.enter) {
        _customTextEditKey.currentState?.resetEditingState();
      }
    }

    return handled ? KeyEventResult.handled : KeyEventResult.ignored;
  }

  bool _isPrintableText(String? text) {
    if (text == null || text.isEmpty) return false;

    // Backspace, Enter, Tab, Escape, Delete and macOS function/navigation
    // keys can all carry a `character` value. They remain terminal controls;
    // only actual printable text is deferred to the native IME.
    return text.runes.every(
      (rune) =>
          rune >= 0x20 && rune != 0x7f && (rune < 0xf700 || rune > 0xf8ff),
    );
  }

  void _onKeyboardShow() {
    if (_focusNode.hasFocus) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _scrollToBottom();
      });
    }
  }

  void _onEditableRect(Rect rect, Rect caretRect) {
    _customTextEditKey.currentState?.setEditableRect(rect, caretRect);
  }

  /// Show the latest output when the current buffer and viewport are laid out.
  void scrollToBottom() {
    // A resize can land between ticks of a fling or driven scroll. Cancelling
    // that activity is part of returning to live output; otherwise its next
    // tick overwrites the freshly aligned offset with an old history position.
    final position = _scrollableKey.currentState?.position;
    if (position is ScrollPositionWithSingleContext) position.goIdle();
    renderTerminal.scrollToBottom();
  }

  void _scrollToBottom() => scrollToBottom();
}

class _TerminalView extends LeafRenderObjectWidget {
  const _TerminalView({
    super.key,
    required this.terminal,
    required this.controller,
    required this.offset,
    required this.padding,
    required this.autoResize,
    required this.resizeBuffer,
    required this.renderingEnabled,
    required this.textStyle,
    required this.textScaler,
    required this.theme,
    required this.focusNode,
    required this.cursorType,
    required this.alwaysShowCursor,
    this.onEditableRect,
    this.composingText,
    this.composingBacktrackCells = 0,
    this.animateRemoteScroll = false,
    this.onRemoteScrollShift,
    this.mirrorRemoteScroll = false,
    this.mirrorPageKeys = false,
    this.remoteScrollMemory,
    this.remoteScrollLink,
  });

  final Terminal terminal;

  final TerminalController controller;

  final ViewportOffset offset;

  final EdgeInsets padding;

  final bool autoResize;

  final bool resizeBuffer;

  final bool renderingEnabled;

  final TerminalStyle textStyle;

  final TextScaler textScaler;

  final TerminalTheme theme;

  final FocusNode focusNode;

  final TerminalCursorType cursorType;

  final bool alwaysShowCursor;

  final EditableRectCallback? onEditableRect;

  final String? composingText;

  final int composingBacktrackCells;

  final bool animateRemoteScroll;

  final void Function(int rows)? onRemoteScrollShift;

  final bool mirrorRemoteScroll;

  final bool mirrorPageKeys;

  final RemoteScrollMemory? remoteScrollMemory;

  final RemoteScrollLink? remoteScrollLink;

  @override
  RenderTerminal createRenderObject(BuildContext context) {
    return RenderTerminal(
      terminal: terminal,
      controller: controller,
      offset: offset,
      padding: padding,
      autoResize: autoResize,
      resizeBuffer: resizeBuffer,
      renderingEnabled:
          renderingEnabled && TickerMode.valuesOf(context).enabled,
      textStyle: textStyle,
      textScaler: textScaler,
      theme: theme,
      focusNode: focusNode,
      cursorType: cursorType,
      alwaysShowCursor: alwaysShowCursor,
      onEditableRect: onEditableRect,
      composingText: composingText,
      composingBacktrackCells: composingBacktrackCells,
      devicePixelRatio: MediaQuery.maybeDevicePixelRatioOf(context) ?? 1.0,
      animateRemoteScroll: animateRemoteScroll,
      onRemoteScrollShift: onRemoteScrollShift,
      mirrorRemoteScroll: mirrorRemoteScroll,
      mirrorPageKeys: mirrorPageKeys,
      remoteScrollMemory: remoteScrollMemory,
      remoteScrollLink: remoteScrollLink,
    );
  }

  @override
  void updateRenderObject(BuildContext context, RenderTerminal renderObject) {
    renderObject
      ..renderingEnabled =
          renderingEnabled && TickerMode.valuesOf(context).enabled
      ..terminal = terminal
      ..controller = controller
      ..offset = offset
      ..padding = padding
      ..autoResize = autoResize
      ..resizeBuffer = resizeBuffer
      ..textStyle = textStyle
      ..textScaler = textScaler
      ..theme = theme
      ..focusNode = focusNode
      ..cursorType = cursorType
      ..alwaysShowCursor = alwaysShowCursor
      ..onEditableRect = onEditableRect
      ..composingText = composingText
      ..composingBacktrackCells = composingBacktrackCells
      ..devicePixelRatio = MediaQuery.maybeDevicePixelRatioOf(context) ?? 1.0
      ..animateRemoteScroll = animateRemoteScroll
      ..onRemoteScrollShift = onRemoteScrollShift
      ..mirrorRemoteScroll = mirrorRemoteScroll
      ..mirrorPageKeys = mirrorPageKeys
      ..remoteScrollMemory = remoteScrollMemory
      ..remoteScrollLink = remoteScrollLink;
  }
}
