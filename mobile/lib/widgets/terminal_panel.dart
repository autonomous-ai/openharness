import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

import '../clipboard/native_clipboard.dart';
import '../state/app_state.dart';

import '../terminal/terminal_snapshot.dart';
import '../terminal/terminal_binary.dart';
import '../terminal/terminal_font_store.dart';
import '../terminal/terminal_link_opener.dart';
import '../terminal/remote_media_download.dart';
import '../terminal/terminal_links.dart';
import '../terminal/terminal_prompt_zone.dart';
import '../phone/tty.dart';
import '../terminal/terminal_session.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../terminal/terminal_viewport.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'terminal_pane_badges.dart';

/// One agent's terminal: xterm, its input, its scrollback and its links.
///
/// ⚠️ **No tile chrome.** The desktop's copy of this widget also draws a pane's header strip —
/// engine, title, status, pin, close, drag handle — with a Find bar in it, and a composer box under
/// the terminal. None of that has a copy here: the phone names the agent in its own title over the
/// page (`phone/terminal_title.dart`), has no tile to close, zoom or drag, and types into the
/// terminal itself.
class TerminalPanel extends StatefulWidget {
  final AppNotifier notifier;
  final TerminalSession session;

  /// Only the focused page may claim keyboard focus on mount/rebuild.
  final bool focused;
  final bool visible;
  final String? tabId;

  /// True while the software keyboard is mid-animation and the pane's height is
  /// still a moving target.
  ///
  /// Holds the remote resize for the duration, WITHOUT touching focus — that is
  /// the whole reason this is not just `visible: false`, which releases the
  /// keyboard this animation is raising.
  ///
  /// ⚠️ What stutters is the RESIZE, not painting. Every frame of the keyboard
  /// sliding gives the view a new height, xterm re-derives rows from it in
  /// `performLayout` and fires `onResize` → `session.resize` → a
  /// `terminal_resize` frame and a real SIGWINCH on the far machine. A
  /// full-screen TUI redraws for each one, and those redraws come back as
  /// keyframes. `autoResize: false` is what closes that loop (see
  /// `RenderTerminal._resizeTerminalIfNeeded`), so the shell is asked exactly
  /// once, for the height the keyboard settles at.
  ///
  /// ⚠️ **It does not stop painting, and it used to.** `renderingEnabled: false`
  /// closed the same loop but froze the output for the whole slide as well —
  /// see [_TerminalPanelState._live].
  final bool settling;
  final int focusRequest;

  /// Where the reader is while scrolled up in the history — tmux's copy-mode position,
  /// `[above/total]`: lines between the view and the end, and lines of history in all — or null at
  /// the end, following the stream. Null for a host that draws no position.
  final ValueNotifier<({int above, int total})?>? scrollback;

  /// Bumped by the host to go back to the end and follow the stream again — the position's tap.
  final int jumpToEndRequest;

  /// Takes over the tap that would raise the software keyboard. Null leaves it
  /// to xterm, which is what every desktop tile does.
  ///
  /// Set on the phone, where the page raises the keyboard itself, with what the
  /// mic heard typed into the prompt first (`phone/terminal_page.dart`).
  /// Claimed on tap DOWN — xterm then neither raises the keyboard nor reports
  /// the click to a mouse-tracking program — but run on tap UP, so a scroll
  /// that began as a press opens nothing. A tap that clears a selection, or
  /// opens a link, is still exactly that.
  ///
  /// Run only for a tap on the prompt ([isPromptTap]). Every other claimed tap
  /// is swallowed: somebody tapping the output is reading it, and a keyboard
  /// jumping up would cover half of what they were reading.
  final VoidCallback? onInputTap;

  /// A tap on a row of output, with that row's text — before [onInputTap] is considered. True
  /// when the host took it: on the phone, an answer's own line while a question is open.
  final bool Function(String line)? onLineTap;

  /// Test seam for OS actions; normal panes use the platform launcher.
  final TerminalLinkOpener? linkOpener;
  final RemoteMediaDownloader? mediaDownloader;

  const TerminalPanel({
    super.key,
    required this.notifier,
    required this.session,
    required this.focused,
    this.visible = true,
    this.tabId,
    this.settling = false,
    this.focusRequest = 0,
    this.scrollback,
    this.jumpToEndRequest = 0,
    this.onInputTap,
    this.onLineTap,
    this.linkOpener,
    this.mediaDownloader,
  });

  @override
  State<TerminalPanel> createState() => _TerminalPanelState();
}

class _TerminalPanelState extends State<TerminalPanel>
    with WidgetsBindingObserver
    implements TerminalViewport {
  static const _dialScale = 2.5;
  static const _dialStopVelocity = 40.0;
  static const _dialDecayPerSecond = 0.002;

  final TerminalController _controller = TerminalController();
  final ScrollController _scrollController = ScrollController(
    keepScrollOffset: false,
  );
  final FocusNode _focusNode = FocusNode();
  late Terminal _viewTerminal;
  late GlobalKey<TerminalViewState> _terminalViewKey;
  Timer? _dialInertiaTimer;
  Timer? _cursorBlinkTimer;
  ValueListenable<TickerModeData>? _tickerMode;
  double _dialVelocity = 0;
  bool _cursorBlinkVisible = true;
  double _alternateScrollRemainder = 0;
  int? _lastInertiaMicros;
  late final TerminalLinkOpener _linkOpener;
  Offset? _linkPointerPosition;

  /// The link under the pointer, and whether the modifier that would open it is
  /// down. Both change on ordinary mouse movement and on every modifier press,
  /// and both feed ONLY the tooltip and the cursor shape.
  ///
  /// ⚠️ NOT setState. A rebuild of this element rebuilds [TerminalView] with it,
  /// and that is the one widget in the pane whose element must not be churned
  /// while output is streaming: it carries the input connection, the scroll
  /// position and the retained render object. Hovering a link, or tapping ⌘,
  /// used to rebuild the whole pane; now it repaints two leaves.
  final ValueNotifier<String?> _hoveredLink = ValueNotifier(null);
  final ValueNotifier<bool> _linkModifierDown = ValueNotifier(false);

  /// Download progress for a link preview. Ticks once per chunk, so it gets the
  /// same treatment as [_hoveredLink] — see the note there.
  final ValueNotifier<RemoteMediaProgress?> _previewProgress = ValueNotifier(
    null,
  );
  String? _pressedLink;

  /// Whether the tap in progress was claimed for [TerminalPanel.onInputTap].
  bool _inputTapClaimed = false;
  bool _openingLink = false;
  bool _linkRefreshPending = false;
  bool _followTail = true;
  TerminalStyle _terminalFont = terminalFontStore.value;
  bool _observingLinkModifiers = false;
  late final RemoteMediaDownloader _mediaDownloader;
  MediaDownloadCancellation? _previewCancellation;

  @override
  void initState() {
    super.initState();
    _viewTerminal = widget.session.terminal;
    _viewTerminal.addListener(_scheduleLinkRefresh);
    _scrollController.addListener(_onScrollChanged);
    _terminalViewKey = GlobalKey<TerminalViewState>();
    _linkOpener = widget.linkOpener ?? TerminalLinkOpener();
    _mediaDownloader = widget.mediaDownloader ?? RemoteMediaDownloader();
    _focusNode.addListener(_handleFocusChange);
    WidgetsBinding.instance.addObserver(this);
    widget.session.attachViewport(this);
    widget.session.addListener(_onSessionChanged);
    widget.session.outputTicks.addListener(_onOutput);
    terminalFontStore.addListener(_onFontChanged);
    // Colours repaint the view in place — no relayout, no resize frame — but
    // they still need a rebuild to reach it, and this widget reads the store
    // directly rather than through a builder.
    terminalThemeStore.addListener(_onFontChanged);
    _afterTerminalMounted();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _updateTickerMode();
  }

  @override
  void activate() {
    super.activate();
    _updateTickerMode();
  }

  @override
  void deactivate() {
    _stopCursorBlink();
    super.deactivate();
  }

  void _updateTickerMode() {
    final mode = TickerMode.getValuesNotifier(context);
    if (!identical(mode, _tickerMode)) {
      _tickerMode?.removeListener(_syncCursorBlink);
      _tickerMode = mode..addListener(_syncCursorBlink);
    }
    _syncCursorBlink();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) =>
      _syncCursorBlink();

  @override
  void didUpdateWidget(TerminalPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.visible && _focusNode.hasFocus) {
      widget.session.inputTabId = widget.tabId;
    }
    if (oldWidget.jumpToEndRequest != widget.jumpToEndRequest) _jumpToEnd();
    if (!identical(oldWidget.session, widget.session)) {
      _previewCancellation?.cancel();
      _previewProgress.value = null;
      oldWidget.session.setCursorBlinkPhase(true);
      oldWidget.session.removeListener(_onSessionChanged);
      oldWidget.session.outputTicks.removeListener(_onOutput);
      oldWidget.session.detachViewport(this);
      widget.session.attachViewport(this);
      widget.session.addListener(_onSessionChanged);
      widget.session.outputTicks.addListener(_onOutput);
      // A new agent starts at its end. Cleared after the frame: this is build.
      final scrollback = widget.scrollback;
      if (scrollback != null) {
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => scrollback.value = null,
        );
      }
      _cancelDialInertia();
      _controller.clearSelection();
      _viewTerminal.removeListener(_scheduleLinkRefresh);
      _viewTerminal = widget.session.terminal;
      _viewTerminal.addListener(_scheduleLinkRefresh);
      _pressedLink = null;
      _hoveredLink.value = null;
      _observeLinkModifiers(false);
      _terminalViewKey = GlobalKey<TerminalViewState>();
      _followTail = true;
      _cursorBlinkVisible = true;
      widget.session.setCursorBlinkPhase(true);
      _afterTerminalMounted();
    }
    if (oldWidget.visible && !widget.visible) {
      _rememberFollowTail();
      _focusNode.unfocus();
      _cancelDialInertia();
      _linkPointerPosition = null;
      _hoveredLink.value = null;
      _pressedLink = null;
      _observeLinkModifiers(false);
    }
    if (widget.visible && !oldWidget.visible) _afterTerminalMounted();
    // The keyboard has finished moving and the pane's height is final. Measure
    // it once and ask the shell for that size — the single SIGWINCH this whole
    // gate exists to reduce the animation to.
    //
    // `claimFocus: false` on purpose: the keyboard is already up, or already
    // gone, and whoever owns the caret decided that. Re-claiming here would
    // summon the keyboard again just as the user finished dismissing it.
    if (oldWidget.settling && !widget.settling && widget.visible) {
      _afterTerminalMounted(claimFocus: false);
    }
    if (widget.focused &&
        (!oldWidget.focused || oldWidget.focusRequest != widget.focusRequest)) {
      _claimFocusAfterFrame();
    }
    _syncCursorBlink();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _tickerMode?.removeListener(_syncCursorBlink);
    _previewCancellation?.cancel();
    _viewTerminal.removeListener(_scheduleLinkRefresh);
    _scrollController.removeListener(_onScrollChanged);
    _observeLinkModifiers(false);
    widget.session.setCursorBlinkPhase(true);
    widget.session.removeListener(_onSessionChanged);
    widget.session.outputTicks.removeListener(_onOutput);
    widget.session.detachViewport(this);
    terminalFontStore.removeListener(_onFontChanged);
    terminalThemeStore.removeListener(_onFontChanged);
    _cancelDialInertia();
    _cursorBlinkTimer?.cancel();
    _focusNode.removeListener(_handleFocusChange);
    _controller.dispose();
    _scrollController.dispose();
    _focusNode.dispose();
    _hoveredLink.dispose();
    _linkModifierDown.dispose();
    _previewProgress.dispose();
    super.dispose();
  }

  /// Whether the renderer may resize the remote shell to this view's height,
  /// and run the cursor clock.
  ///
  /// A parked page may not because it is not the one being read; a settling one
  /// may not because its height is still moving. Focus is deliberately NOT part
  /// of this — see [TerminalPanel.settling].
  ///
  /// ⚠️ **Painting is not gated on it, and on a phone it must not be.** A
  /// mounted panel there is on screen: the pager builds only the pages the
  /// viewport touches. Gating paint on [TerminalPanel.visible] meant the agent
  /// sliding in never laid out — its scroll offset sat at zero, so it drew the
  /// OLDEST lines of its scrollback until the swipe passed halfway, then jumped
  /// to the end — while the agent sliding out froze. Gating it on settling
  /// stopped the output dead for the whole keyboard slide.
  bool get _live => widget.visible && !widget.settling;

  void _onSessionChanged() {
    if (!mounted) return;
    // ⚠️ **A keyframe replaces the emulator itself, and nothing above this pane rebuilds for it.**
    // The daemon answers every resize with one — so every keyboard the phone raises or lowers ends
    // in one — and the page redraws only for what IT shows (the status, the first frame, the
    // agent), all of which read the same after the swap. The view then stayed on the OLD
    // [Terminal], frozen at its pre-resize screen, while every byte after went into the new one.
    // [build] is what moves the view across ([_syncTerminal]); this is what asks for a build.
    //
    // After the frame when the swap lands mid-frame, as [setState] may not be called then.
    if (!identical(widget.session.terminal, _viewTerminal)) {
      if (SchedulerBinding.instance.schedulerPhase ==
          SchedulerPhase.persistentCallbacks) {
        SchedulerBinding.instance.addPostFrameCallback((_) {
          if (mounted) setState(() {});
        });
      } else {
        setState(() {});
      }
    }
    _syncCursorBlink();
    // A pane can open BEFORE its screen exists: over the relay it mounts empty
    // and the retained scrollback is replayed a moment later, so the jump in
    // `_afterTerminalMounted` lands on nothing and the screen then fills in
    // above the reader. xterm does not close this — its own `_scrollToBottom`
    // answers typing and the keyboard opening, never new output.
    //
    // Gated on [_followTail], which is kept as "the view is showing its end",
    // so a pane the reader has scrolled up in — or one restored to a saved
    // position — is not at the end, and is never followed.
    // Visible only. A parked pane holds the offset it was left at while output
    // arrives behind it — `swarm_screen_test` pins that — and comes back to the
    // end through `_afterTerminalMounted`, which is where returning is handled.
    if (_followTail && widget.visible) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !widget.visible) return;
        if (!_followTail || !_scrollController.hasClients) return;
        final position = _scrollController.position;
        // ⚠️ A position can be attached before its first layout, and until then `maxScrollExtent`
        // is a null-check that THROWS — it did, once per output frame, for a pane whose session
        // was already streaming while the terminal was still behind "Attaching…". Nothing to
        // follow yet; the next frame after layout does it.
        if (!position.hasContentDimensions || !position.hasPixels) return;
        if (position.pixels != position.maxScrollExtent) {
          position.jumpTo(position.maxScrollExtent);
        }
      });
    }
  }

  /// The vendored renderer already treats a changed `textStyle` as a full re-layout — see
  /// `RenderTerminal.textStyle`'s setter — which recomputes cols/rows from the new cell size and
  /// resizes the remote session automatically. This just needs to get the new value into `build()`.
  void _onFontChanged() {
    if (!mounted) return;
    if (_terminalFont != terminalFontStore.value) {
      _terminalFont = terminalFontStore.value;
      _afterTerminalMounted(claimFocus: false);
    }
    setState(() {});
  }

  void _syncTerminal(Terminal terminal) {
    if (identical(_viewTerminal, terminal)) return;

    final previous = _viewTerminal.buffer;
    final next = terminal.buffer;
    final render = _laidOutTerminalView()?.renderTerminal;
    final lineHeight = render?.lineHeight;
    final position = _scrollController.hasClients
        ? _scrollController.position
        : null;
    final viewportRow = position != null && lineHeight != null
        ? (position.pixels / lineHeight).floor()
        : null;
    final viewportFraction = position != null && lineHeight != null
        ? position.pixels / lineHeight - viewportRow!
        : 0.0;
    final atEnd = _followTail || position == null;
    final selection = _controller.selection;
    final selectedText = selection == null ? null : previous.getText(selection);
    final locations = remapTerminalRows(previous, next, [
      if (!atEnd) ?viewportRow,
      ?selection?.begin.y,
      ?selection?.end.y,
    ]);
    int row(int old) => locations[old] ?? old.clamp(0, next.lines.length - 1);
    CellOffset location(CellOffset old) =>
        CellOffset(old.x.clamp(0, terminal.viewWidth - 1), row(old.y));
    // Selection anchors belong to a specific circular buffer. Detach them
    // before the TerminalView starts laying out the replacement terminal.
    _controller.clearSelection();
    _viewTerminal.removeListener(_scheduleLinkRefresh);
    _viewTerminal = terminal;
    _viewTerminal.addListener(_scheduleLinkRefresh);
    _pressedLink = null;
    _hoveredLink.value = null;
    _observeLinkModifiers(false);
    _cancelDialInertia();
    _alternateScrollRemainder = 0;
    _cursorBlinkVisible = true;
    widget.session.setCursorBlinkPhase(true);
    if (position != null &&
        lineHeight != null &&
        !atEnd &&
        viewportRow != null) {
      // Correct before the retained renderer lays out the replacement, so its
      // first frame already shows the reader's location without a scroll flash.
      position.correctPixels(
        (row(viewportRow) + viewportFraction) * lineHeight,
      );
    }
    if (selection != null &&
        locations.containsKey(selection.begin.y) &&
        locations.containsKey(selection.end.y)) {
      final range = selection is BufferRangeBlock
          ? BufferRangeBlock(location(selection.begin), location(selection.end))
          : BufferRangeLine(location(selection.begin), location(selection.end));
      if (next.getText(range) == selectedText) {
        _controller.setSelection(
          next.createAnchorFromOffset(range.begin),
          next.createAnchorFromOffset(range.end),
        );
      }
    }
    _followTail = atEnd;
    _afterTerminalMounted(scrollToEnd: atEnd);
  }

  void _handleFocusChange() {
    if (_focusNode.hasFocus) widget.session.inputTabId = widget.tabId;
    _syncCursorBlink();
  }

  /// Re-establishes the native text-input connection on pane activation.
  ///
  /// Replacing an agent remounts TerminalView but deliberately keeps this
  /// FocusNode. A plain requestFocus is a no-op when that node already owns
  /// focus, leaving macOS without a TextInputConnection until the user clicks
  /// the terminal. TerminalView.requestKeyboard handles both cases: it moves
  /// focus when needed, or opens the connection immediately when focus stayed
  /// on this tile. That is essential for ordinary keys and IMEs alike.
  bool _claimFocus(TerminalViewState view, {bool navigating = false}) {
    if (!_canClaimInput ||
        (!navigating && (!widget.focused || !widget.visible))) {
      return false;
    }
    view.requestKeyboard();
    return true;
  }

  bool get _canClaimInput =>
      mounted &&
      _focusNode.canRequestFocus &&
      ModalRoute.of(context)?.isCurrent != false;

  @override
  bool focusInput() {
    // The model has already selected this retained view, but widget visibility
    // and focus flags will not catch up until the canvas's next frame.
    if (!_canClaimInput ||
        !identical(widget.notifier.focusedPane?.session, widget.session)) {
      return false;
    }
    final view = _laidOutTerminalView();
    if (view == null) return false;
    return _claimFocus(view, navigating: true);
  }

  @override
  void clearInputBuffer() => _terminalViewKey.currentState?.clearInputBuffer();

  void _claimFocusAfterFrame() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final view = _laidOutTerminalView();
      if (view != null) _claimFocus(view);
    });
  }

  /// Retaining a renderer must not retain a polling loop. Only the focused,
  /// interactive terminal in the active window needs a cursor clock. Observe
  /// ticker mode without rebuilding the subtree when a route covers it.
  void _syncCursorBlink() {
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    final enabled =
        mounted &&
        // `_live`, not `visible`: a cursor phase is a markNeedsPaint on the
        // terminal, and nothing should repaint it while the keyboard slides.
        _live &&
        _focusNode.hasFocus &&
        widget.session.acceptsInput &&
        (_tickerMode?.value.enabled ?? false) &&
        (lifecycle == null || lifecycle == AppLifecycleState.resumed);
    if (!enabled) {
      _stopCursorBlink();
      return;
    }
    _cursorBlinkTimer ??= Timer.periodic(
      const Duration(milliseconds: 500),
      (_) => _setCursorBlinkVisible(!_cursorBlinkVisible),
    );
  }

  void _stopCursorBlink() {
    _cursorBlinkTimer?.cancel();
    _cursorBlinkTimer = null;
    _setCursorBlinkVisible(true);
  }

  void _setCursorBlinkVisible(bool visible) {
    if (visible == _cursorBlinkVisible) return;
    _cursorBlinkVisible = visible;
    widget.session.setCursorBlinkPhase(visible);
    _repaintTerminalCursor();
  }

  void _repaintTerminalCursor() {
    _laidOutTerminalView()?.renderTerminal.markNeedsPaint();
  }

  /// The terminal view, but only once its render object can be read.
  ///
  /// `currentState?.renderTerminal` reads as null-safe and is not: the `?.`
  /// answers "is the State there", while the getter behind it is
  /// `_viewportKey.currentContext!.findRenderObject()`. Three call sites here
  /// relied on that misreading, one of them a timer that keeps ticking while a
  /// keyframe swaps the emulator underneath it.
  ///
  /// Insurance, NOT a diagnosis. The app has been crashing with exactly the
  /// error this bang produces, and the obvious theory — that the viewport is
  /// built during layout, leaving a window where the State exists and the
  /// context does not — was tested and is FALSE: the library builds it inside
  /// `Scrollable.viewportBuilder`, which runs during build, so the context is
  /// there as soon as the State is. Whatever is actually throwing has not been
  /// found yet; see the trace written by TerminalSession on a renderer fault.
  /// This only makes sure these three sites are not the ones that do it.
  TerminalViewState? _laidOutTerminalView() {
    final state = _terminalViewKey.currentState;
    if (state == null) return null;
    try {
      state.renderTerminal;
      return state;
    } catch (_) {
      return null;
    }
  }

  /// The one thing a pane nobody is looking at contributes to its session: how
  /// big it is, before the stream opens. True when there is nothing (more) to
  /// do; false when the view has not laid out yet and this should be asked
  /// again next frame.
  ///
  /// ⚠️ **Only until `streamId` is set.** The phone's pager mounts the pages
  /// either side of the one on screen and attaches them ahead of a swipe (see
  /// `AgentSwipeHost`); their `open(waitForViewportSize: true)` would otherwise
  /// wait two seconds for a measurement that never came, fall back to 80×24,
  /// and pay a resize and a second keyframe on arrival. Once the stream is open
  /// a parked pane goes back to saying nothing: a resize from a page nobody is
  /// looking at is a SIGWINCH and a full TUI redraw on the far machine, which
  /// is what gating everything else on `visible` is for.
  bool _reportInitialViewport() {
    if (widget.session.streamId != null) return true;
    final view = _laidOutTerminalView();
    if (view == null) return false;
    final renderTerminal = view.renderTerminal;
    final cellSize = renderTerminal.cellSize;
    final renderSize = renderTerminal.size;
    if (cellSize.width <= 0 || cellSize.height <= 0) return false;
    widget.session.reportViewport(
      renderSize.width ~/ cellSize.width,
      renderSize.height ~/ cellSize.height,
    );
    return true;
  }

  void _afterTerminalMounted({
    bool clearSelection = false,
    bool scrollToEnd = true,
    bool claimFocus = true,
    int retries = 2,
  }) {
    // Request alignment before this frame's layout, so even a retained pane's
    // first visible paint uses its new size.
    if (scrollToEnd) {
      _cancelDialInertia();
      _followTail = true;
      _laidOutTerminalView()?.scrollToBottom();
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (!widget.visible) {
        // A parked pane does one thing, and only until its stream opens — see
        // [_reportInitialViewport]. Retried like the visible path below: the
        // view may not have laid out yet on the frame this was asked in.
        if (!_reportInitialViewport() && retries > 0) {
          _afterTerminalMounted(
            clearSelection: clearSelection,
            scrollToEnd: scrollToEnd,
            claimFocus: claimFocus,
            retries: retries - 1,
          );
        }
        return;
      }
      if (clearSelection) _controller.clearSelection();
      final view = _laidOutTerminalView();
      if (view == null) {
        if (retries > 0) {
          _afterTerminalMounted(
            clearSelection: clearSelection,
            scrollToEnd: scrollToEnd,
            claimFocus: claimFocus,
            retries: retries - 1,
          );
        }
        return;
      }
      final renderTerminal = view.renderTerminal;
      final cellSize = renderTerminal.cellSize;
      final renderSize = renderTerminal.size;
      if (cellSize.width > 0 && cellSize.height > 0) {
        widget.session.reportViewport(
          renderSize.width ~/ cellSize.width,
          renderSize.height ~/ cellSize.height,
        );
      }
      if (scrollToEnd && _followTail) view.scrollToBottom();
      if (claimFocus) _claimFocus(view);
      if (_linkPointerPosition != null) _hoverLink(_linkPointerPosition);
    });
  }

  @override
  void scroll(int phase, int dy, int velocity) {
    if (phase == 0) _cancelDialInertia();
    if (dy != 0) _applyDialDelta(-dy * _dialScale);
    if (phase == 2) _startDialInertia(velocity.toDouble());
  }

  void _applyDialDelta(double delta) {
    final terminal = widget.session.terminal;
    if (terminal.isUsingAltBuffer) {
      final lineHeight =
          _laidOutTerminalView()?.renderTerminal.lineHeight ?? 16.0;
      _alternateScrollRemainder += delta;
      while (_alternateScrollRemainder.abs() >= lineHeight) {
        final up = _alternateScrollRemainder < 0;
        if (widget.session.scrollViaTmuxCopyMode) {
          widget.session.sendScrollCommand(up, 1);
        } else {
          final handled = terminal.mouseInput(
            up ? TerminalMouseButton.wheelUp : TerminalMouseButton.wheelDown,
            TerminalMouseButtonState.down,
            CellOffset(terminal.viewWidth ~/ 2, terminal.viewHeight ~/ 2),
          );
          if (!handled) {
            terminal.keyInput(up ? TerminalKey.arrowUp : TerminalKey.arrowDown);
          }
        }
        _alternateScrollRemainder += up ? lineHeight : -lineHeight;
      }
      return;
    }

    if (!_scrollController.hasClients) return;
    final position = _scrollController.position;
    final target = (position.pixels + delta)
        .clamp(position.minScrollExtent, position.maxScrollExtent)
        .toDouble();
    position.jumpTo(target);
  }

  void _startDialInertia(double velocity) {
    _cancelDialInertia();
    if (velocity.abs() < _dialStopVelocity) return;
    _dialVelocity = velocity;
    _lastInertiaMicros = DateTime.now().microsecondsSinceEpoch;
    _dialInertiaTimer = Timer.periodic(const Duration(milliseconds: 16), (_) {
      if (!mounted) {
        _cancelDialInertia();
        return;
      }
      final now = DateTime.now().microsecondsSinceEpoch;
      final previous = _lastInertiaMicros ?? now;
      final elapsedSeconds = math.min((now - previous) / 1000000, 0.05);
      _lastInertiaMicros = now;
      _applyDialDelta(-_dialVelocity * elapsedSeconds * _dialScale);
      _dialVelocity *= math.pow(_dialDecayPerSecond, elapsedSeconds).toDouble();
      if (_dialVelocity.abs() < _dialStopVelocity) _cancelDialInertia();
    });
  }

  void _cancelDialInertia() {
    _dialInertiaTimer?.cancel();
    _dialInertiaTimer = null;
    _dialVelocity = 0;
    _lastInertiaMicros = null;
  }

  /// Copies what is selected and lets it go — the phone's Copy: a long press, then this.
  Future<void> _copySelection() async {
    final selection = _controller.selection;
    if (selection == null) return;
    final text = widget.session.terminal.buffer.getText(selection);
    _controller.clearSelection();
    await Clipboard.setData(ClipboardData(text: text));
    HapticFeedback.lightImpact();
  }

  Future<void> _copyOrPaste() async {
    final terminal = widget.session.terminal;
    final selection = _controller.selection;
    if (selection != null) {
      final text = terminal.buffer.getText(selection);
      _controller.clearSelection();
      await Clipboard.setData(ClipboardData(text: text));
      return;
    }
    await _paste();
  }

  /// Paste — including the kinds of clipboard this app cannot fully read.
  ///
  /// ⚠️ FLUTTER'S OWN `Clipboard` API ONLY SEES `text/plain`. A screenshot has no
  /// text at all, so a naive body finds `null` and returns, silently: the single
  /// most common thing anyone pastes into a coding agent did nothing, with no
  /// error and nothing in a log. [NativeClipboard] closes that gap with a native
  /// platform-channel read for an actual image (macOS/Linux only; see its doc).
  ///
  /// The engines running in these panes read the system clipboard THEMSELVES —
  /// Claude Code attaches an image on Ctrl+V — so on a LOCAL pane that is already
  /// true with zero help from us: a bare Ctrl+V is all that ever ran here, before
  /// native image paste existed, and it still works because the engine and this
  /// app share the exact same OS clipboard. The wire-based `pasteImage` (chunked
  /// upload, daemon writes the far side's OS clipboard, daemon replays Ctrl+V) is
  /// reserved for a genuinely REMOTE pane, whose engine reads a DIFFERENT
  /// clipboard than this one — which, on a phone, is every pane.
  /// An image handed over by the software keyboard's own clipboard.
  ///
  /// This is the phone's ONLY way to get an image into a pane: Flutter's
  /// [Clipboard] reads `text/plain` and nothing else, and the native reader
  /// [_paste] falls back on is macOS/Linux. Gboard hands the bytes over directly,
  /// so there is no clipboard to read at all.
  ///
  /// ⚠️ A pane on a phone is ALWAYS remote — the agent runs on another machine,
  /// whose engine reads a different OS clipboard — so unlike the desktop there is
  /// no local shortcut here: every paste is the chunked upload.
  void _onContentInserted(KeyboardInsertedContent content) {
    final bytes = content.data;
    if (bytes == null || bytes.isEmpty) return;
    if (!widget.session.acceptsInput) return;
    if (bytes.length > terminalLocalImagePasteMaxPayloadBytes) return;
    final machine = widget.notifier.stateOf(widget.session.machineId);
    if (machine == null || !machine.terminalImagePasteAvailable) return;
    unawaited(widget.session.pasteImage(bytes));
  }

  Future<void> _paste() async {
    if (!widget.session.acceptsInput) return;
    final text = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
    if (text != null && text.isNotEmpty) {
      // A binary TerminalBinaryKind.paste frame rides the same AEAD channel as every other terminal
      // byte, so this works identically for a local or a relayed machine — see pasteText's doc. Only
      // the CLI's own version gates it: an older daemon never advertises the capability.
      final machine = widget.notifier.stateOf(widget.session.machineId);
      if (machine != null && machine.terminalPasteRawAvailable) {
        await widget.session.pasteText(text);
      } else {
        widget.session.terminal.paste(text);
      }
      return;
    }
    final machine = widget.notifier.stateOf(widget.session.machineId);
    if (machine != null && machine.terminalImagePasteAvailable) {
      final imageBytes = await NativeClipboard.readImagePng();
      if (imageBytes != null &&
          imageBytes.isNotEmpty &&
          imageBytes.length <= terminalLocalImagePasteMaxPayloadBytes) {
        await widget.session.pasteImage(imageBytes);
        return;
      }
    }
    widget.session.terminal.keyInput(TerminalKey.keyV, ctrl: true);
  }

  /// ⌘V (Ctrl+V off Apple) — taken from xterm so the fallthrough above applies.
  ///
  /// xterm binds paste itself, but only ever to its text-only action. `onKeyEvent`
  /// is the one hook that runs BEFORE its shortcut map (terminal_view.dart), so
  /// this is where the binding has to be replaced rather than added.
  KeyEventResult _onTerminalKey(FocusNode node, KeyEvent event) {
    widget.session.inputTabId = widget.tabId;
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    if (event.logicalKey != LogicalKeyboardKey.keyV) {
      return KeyEventResult.ignored;
    }
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isShiftPressed) {
      return KeyEventResult.ignored; // ⇧⌘V is a different verb
    }

    final apple =
        defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.iOS;
    final pasting = apple ? keyboard.isMetaPressed : keyboard.isControlPressed;
    if (!pasting) return KeyEventResult.ignored;
    unawaited(_paste());
    return KeyEventResult.handled;
  }

  bool get _linkModifierPressed {
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isAltPressed || keyboard.isShiftPressed) return false;
    return defaultTargetPlatform == TargetPlatform.macOS
        ? keyboard.isMetaPressed && !keyboard.isControlPressed
        : keyboard.isControlPressed && !keyboard.isMetaPressed;
  }

  bool _onLinkModifierChanged(KeyEvent event) {
    const modifiers = [
      LogicalKeyboardKey.metaLeft,
      LogicalKeyboardKey.metaRight,
      LogicalKeyboardKey.controlLeft,
      LogicalKeyboardKey.controlRight,
      LogicalKeyboardKey.altLeft,
      LogicalKeyboardKey.altRight,
      LogicalKeyboardKey.shiftLeft,
      LogicalKeyboardKey.shiftRight,
    ];
    if (_linkPointerPosition != null &&
        mounted &&
        modifiers.contains(event.logicalKey)) {
      // Refresh the cursor even when the mouse has not moved. Published, not
      // setState: the cursor is one leaf, and a rebuild here would take the
      // streaming TerminalView with it.
      _linkModifierDown.value = _linkModifierPressed;
    }
    return false; // Modifier observation never consumes a terminal key.
  }

  /// Modifier keys only change the pointer over a link. Do not fan every key
  /// out to the retained terminal pool when no pointer feedback can change.
  void _observeLinkModifiers(bool enabled) {
    if (_observingLinkModifiers == enabled) return;
    _observingLinkModifiers = enabled;
    final keyboard = HardwareKeyboard.instance;
    if (enabled) {
      keyboard.addHandler(_onLinkModifierChanged);
      _linkModifierDown.value = _linkModifierPressed;
    } else {
      keyboard.removeHandler(_onLinkModifierChanged);
      // Nothing is watching the modifier any more, so the cursor must not stay
      // latched on a ⌘ that was down when the pointer left the link.
      _linkModifierDown.value = false;
    }
  }

  void _scheduleLinkRefresh() {
    if (!widget.visible ||
        _linkPointerPosition == null ||
        _linkRefreshPending) {
      return;
    }
    _linkRefreshPending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _linkRefreshPending = false;
      if (mounted && widget.visible) _hoverLink(_linkPointerPosition);
    });
  }

  void _rememberFollowTail() {
    if (!_scrollController.hasClients) return;
    final position = _scrollController.position;
    _followTail = position.maxScrollExtent - position.pixels < 1;
    _publishScrollback(position);
  }

  /// Tells the host where the reader is — see [TerminalPanel.scrollback].
  void _publishScrollback(ScrollPosition position) {
    final scrollback = widget.scrollback;
    if (scrollback == null) return;
    if (_followTail) {
      scrollback.value = null;
      return;
    }
    final line = _laidOutTerminalView()?.renderTerminal.lineHeight ?? 0;
    if (line <= 0) return;
    final terminal = widget.session.terminal;
    final next = (
      above: ((position.maxScrollExtent - position.pixels) / line).round(),
      total: math.max(0, terminal.buffer.lines.length - terminal.viewHeight),
    );
    if (scrollback.value != next) scrollback.value = next;
  }

  bool _scrollbackPending = false;

  /// Output arrived. Below a reader scrolled up in the history the view holds still, and the
  /// position counts the new lines — once per frame, after the layout that placed them.
  void _onOutput() {
    if (_followTail || !widget.visible || widget.scrollback == null) return;
    if (_scrollbackPending) return;
    _scrollbackPending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scrollbackPending = false;
      if (!mounted || !_scrollController.hasClients) return;
      _publishScrollback(_scrollController.position);
    });
  }

  /// Back to the end, following the stream again — the host's position tap.
  ///
  /// Runs from `didUpdateWidget`, inside a build, so [scrollback] is left to the host that asked —
  /// it clears it with the tap — and to the scroll that follows.
  void _jumpToEnd() {
    _cancelDialInertia();
    // A fling still coasting up through the history would carry on past the tap and take the view
    // straight back off the end: stopped where it is, first.
    //
    // Jumped to the laid-out end, so the scroll it reports reads as "at the end"; the layout the
    // render asks for below then settles it against any output since.
    if (_scrollController.hasClients) {
      final position = _scrollController.position;
      position.jumpTo(position.maxScrollExtent);
    }
    _followTail = true;
    _laidOutTerminalView()?.scrollToBottom();
  }

  void _onScrollChanged() {
    _rememberFollowTail();
    _scheduleLinkRefresh();
  }

  String? _linkAtPointer(Offset globalPosition) {
    final view = _laidOutTerminalView();
    if (view == null) return null;
    final render = view.renderTerminal;
    final local = render.globalToLocal(globalPosition);
    if (!(Offset.zero & render.size).contains(local)) return null;
    return terminalLinkAt(_viewTerminal, render.getCellOffset(local));
  }

  void _hoverLink(Offset? globalPosition) {
    _linkPointerPosition = widget.visible ? globalPosition : null;
    final target = _linkPointerPosition == null
        ? null
        : _linkAtPointer(_linkPointerPosition!);
    _observeLinkModifiers(target != null);
    _hoveredLink.value = target;
  }

  bool _onTerminalTapDown(TapDownDetails details, CellOffset cell) {
    _inputTapClaimed = false;
    if (_onLinkTapDown(details, cell)) return true;
    if (widget.onInputTap == null || _controller.selection != null) {
      return false;
    }
    return _inputTapClaimed = true;
  }

  void _onTerminalTapUp(TapUpDetails details, CellOffset cell) {
    if (!_inputTapClaimed) {
      _onLinkTapUp(details, cell);
      return;
    }
    _inputTapClaimed = false;
    final buffer = _viewTerminal.buffer;
    if (cell.y >= 0 &&
        cell.y < buffer.lines.length &&
        (widget.onLineTap?.call(buffer.lines[cell.y].getText()) ?? false)) {
      return;
    }
    if (!isPromptTap(buffer, cell.y)) return;
    widget.onInputTap?.call();
  }

  /// Whether a tap on a link opens it. On a phone, always: there is no ⌘ or ctrl to hold, and a
  /// URL or `file:line` you cannot open by touching it is a dead word. Elsewhere, with the modifier.
  bool get _linkTapOpens =>
      defaultTargetPlatform == TargetPlatform.iOS ||
      defaultTargetPlatform == TargetPlatform.android ||
      _linkModifierPressed;

  bool _onLinkTapDown(TapDownDetails details, CellOffset cell) {
    _pressedLink = _linkTapOpens
        ? _linkAtPointer(details.globalPosition)
        : null;
    return _pressedLink != null;
  }

  void _onLinkTapUp(TapUpDetails details, CellOffset cell) {
    final target = _pressedLink;
    _pressedLink = null;
    // Read the current buffer again: streamed output may have replaced the
    // text between press and release, or this pane may now show another agent.
    if (target == null ||
        !_linkTapOpens ||
        target != _linkAtPointer(details.globalPosition)) {
      return;
    }
    unawaited(_openLink(target));
  }

  Future<void> _openLink(String target) async {
    if (_openingLink) return;
    _openingLink = true;
    final session = widget.session;
    final notifier = widget.notifier;
    final cancellation = MediaDownloadCancellation();
    _previewCancellation = cancellation;
    try {
      final message = await _linkOpener.open(
        target,
        // The agent runs on another machine: a file it names is there, not here.
        isCancelled: () =>
            cancellation.isCancelled ||
            !mounted ||
            !identical(session, widget.session),
        downloadRemote: (path) async {
          _previewProgress.value = const RemoteMediaProgress('', 0, null);
          return _mediaDownloader.download(
            readChunk: ({required offset, revision}) =>
                notifier.readRemoteMediaChunk(
                  session.machineId,
                  session.agentId,
                  path,
                  offset: offset,
                  revision: revision,
                ),
            cancellation: cancellation,
            onProgress: (progress) {
              if (mounted &&
                  !cancellation.isCancelled &&
                  identical(session, widget.session)) {
                _previewProgress.value = progress;
              }
            },
          );
        },
      );
      if (!mounted || !identical(session, widget.session) || message == null) {
        return;
      }
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(message)));
    } finally {
      _openingLink = false;
      if (identical(_previewCancellation, cancellation)) {
        _previewCancellation = null;
        // `mounted` gates the notifier, not a rebuild: a download can outlive
        // the pane, and writing to a disposed ValueNotifier throws.
        if (mounted) _previewProgress.value = null;
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final session = widget.session;
    _syncTerminal(session.terminal);
    return ColoredBox(
      color: grid.AppPalette.windowBg,
      child: Column(
        children: [
          Expanded(
            child: Stack(
              children: [
                Positioned.fill(
                  child: MouseRegion(
                    onEnter: (event) => _hoverLink(event.position),
                    onHover: (event) => _hoverLink(event.position),
                    onExit: (_) => _hoverLink(null),
                    child: _LinkTooltip(
                      link: _hoveredLink,
                      modifierDown: _linkModifierDown,
                      child: TerminalView(
                        session.terminal,
                        key: _terminalViewKey,
                        controller: _controller,
                        autoResize: _live,
                        resizeBuffer: false,
                        scrollController: _scrollController,
                        focusNode: _focusNode,
                        autofocus: widget.focused,
                        readOnly: !session.acceptsInput,
                        // iOS answers Backspace over an empty native buffer
                        // with nothing at all (`deleteBackward` in
                        // FlutterTextInputPlugin.mm), so a line the keyboard
                        // did not type — text typed on the desktop, a voice
                        // transcript, a recalled command — could not be
                        // rubbed out. xterm keeps a padding for Backspace to
                        // eat instead — see test/terminal_ime_input_test.dart.
                        //
                        // Unconditional: this package builds for iOS and
                        // Android only. ⚠️ Lost once already in a merge
                        // (cb47ba35 → TestFlight build 11), which is why
                        // test/terminal_panel_backspace_test.dart pins it.
                        deleteDetection: true,
                        theme: terminalScreenThemeFor(
                          grid.AppTheme.palette.value,
                          terminalThemeStore.value,
                        ),
                        // ⚠️ **Nothing top or bottom, and that is the whole
                        // point of writing it out rather than `all(10)`.**
                        // This padding is laid OUTSIDE the scroll view (see
                        // xterm's `TerminalView.build`: a `Container` wraps
                        // the `Scrollable`), so a vertical inset is a strip
                        // the terminal can never draw into — scrolled to
                        // either end, the last line stopped 10px short of the
                        // edge and the gap travelled with the content rather
                        // than staying put like a margin. The sides are
                        // margins beside chrome, not under it, and stay.
                        padding: const EdgeInsets.symmetric(
                          horizontal: Tty.origin,
                        ),
                        textStyle: terminalFontStore.value,
                        // ⚠️ The terminal is NOT app chrome, and the user said so:
                        // it carries its own font settings (Settings ▸ Terminal,
                        // [terminalFontStore]) precisely because its type is a grid
                        // a remote program is drawing into, not a label.
                        //
                        // Without this, `TerminalView` falls back to
                        // `MediaQuery.textScalerOf(context)` (xterm's
                        // terminal_view.dart:257), so the app-wide UI size would
                        // change the cell size — and a changed cell size is not
                        // cosmetic here: it re-derives `rows`, which fires
                        // `Terminal.resize` → `session.resize` → a `terminal_resize`
                        // frame on the wire and a real SIGWINCH at the far end.
                        //
                        // Read in `createRenderObject`, not only on update, so this
                        // holds from the very first frame — no scaled first paint
                        // and no startup resize.
                        textScaler: TextScaler.noScaling,
                        // ⚠️ PNG alone, and not because other types are rare.
                        // The daemon writes what it receives to a file it names
                        // `<uuid>.png` outright (`cli/src/lib/pasteDropFiles.ts`),
                        // so a JPEG would arrive on the far machine under a name
                        // that lies about it. Widening this means teaching the
                        // CLI the real type first — and an older CLI, which
                        // `terminalImagePasteAvailable` already gates on, would
                        // still not know it.
                        allowedMimeTypes: const ['image/png'],
                        onContentInserted: _onContentInserted,
                        onKeyEvent: _onTerminalKey,
                        onTapDown: _onTerminalTapDown,
                        onTapUp: _onTerminalTapUp,
                        // Constant on purpose. The click cursor is applied by
                        // [_LinkTooltip]'s own MouseRegion, which repaints
                        // without rebuilding this view.
                        mouseCursor: SystemMouseCursors.text,
                        onSecondaryTapDown: (_, _) => _copyOrPaste(),

                        onAltBufferScroll: session.scrollViaTmuxCopyMode
                            ? (up) => session.sendScrollCommand(up, 1)
                            : null,
                      ),
                    ),
                  ),
                ),
                // Both bars tick once per transferred chunk. Listening here
                // keeps that traffic off the pane's own element, so a paste
                // or a preview download cannot stutter the live terminal.
                Positioned(
                  left: 14,
                  right: 14,
                  bottom: 12,
                  child: _TransferOverlay(
                    session: session,
                    preview: _previewProgress,
                    onCancelPreview: () => _previewCancellation?.cancel(),
                  ),
                ),
                // A long press selects on a phone, and nothing else offered to copy what it
                // selected: `Copy` rides the selection, top right, until used or cleared.
                // Under the phone's title (three rows, laid over the pane's top), not behind it.
                Positioned(
                  top: 60,
                  right: 8,
                  child: ListenableBuilder(
                    listenable: _controller,
                    builder: (context, _) => _controller.selection == null
                        ? const SizedBox.shrink()
                        : _SelectionActions(
                            onCopy: () => unawaited(_copySelection()),
                            onClear: _controller.clearSelection,
                          ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The "⌘-click to open" hint, and the click cursor that goes with it.
///
/// Both answer the same two facts — which link is under the pointer, and
/// whether the modifier is down — and both used to live in the pane's own
/// `build`, which meant a mouse crossing a URL rebuilt [TerminalView]. Reading
/// the notifiers HERE confines that to this subtree: the terminal element, its
/// input connection and its scroll position are never touched.
class _LinkTooltip extends StatelessWidget {
  const _LinkTooltip({
    required this.link,
    required this.modifierDown,
    required this.child,
  });

  final ValueListenable<String?> link;
  final ValueListenable<bool> modifierDown;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final modifier = defaultTargetPlatform == TargetPlatform.macOS
        ? '⌘'
        : 'Ctrl';
    return ValueListenableBuilder<String?>(
      valueListenable: link,
      // The terminal is passed through untouched, so rebuilding this builder
      // re-parents nothing: `child` is the same element every time.
      child: child,
      builder: (context, target, child) => ValueListenableBuilder<bool>(
        valueListenable: modifierDown,
        child: child,
        builder: (context, down, child) => MouseRegion(
          opaque: false,
          cursor: target != null && down
              ? SystemMouseCursors.click
              : MouseCursor.defer,
          child: Tooltip(
            message: target == null ? '' : '$modifier-click to open\n$target',
            child: child,
          ),
        ),
      ),
    );
  }
}

/// The upload and preview-download bars stacked in the pane's corner.
///
/// Kept out of the pane's `build` because both tick once per chunk: a 4 MB
/// paste is hundreds of notifications, and each one would otherwise rebuild the
/// streaming terminal beside it.
class _TransferOverlay extends StatelessWidget {
  const _TransferOverlay({
    required this.session,
    required this.preview,
    required this.onCancelPreview,
  });

  final TerminalSession session;
  final ValueListenable<RemoteMediaProgress?> preview;
  final VoidCallback onCancelPreview;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: session,
      builder: (context, _) => ValueListenableBuilder<RemoteMediaProgress?>(
        valueListenable: preview,
        builder: (context, download, _) {
          final upload = session.uploadProgress;
          if (upload == null && download == null) {
            return const SizedBox.shrink();
          }
          return Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (upload != null)
                TransferProgressBadge(
                  label: 'Uploading ${upload.label}',
                  fraction: upload.percent,
                  onCancel: () => unawaited(session.cancelUpload()),
                ),
              if (upload != null && download != null) const SizedBox(height: 8),
              if (download != null)
                TransferProgressBadge(
                  label: download.totalBytes == null
                      ? 'Preparing preview…'
                      : 'Downloading ${download.filename}',
                  fraction: download.fraction,
                  onCancel: onCancelPreview,
                ),
            ],
          );
        },
      ),
    );
  }
}

/// `Copy  ×` over a selection — the phone has no right click and no ⌘C.
class _SelectionActions extends StatelessWidget {
  const _SelectionActions({required this.onCopy, required this.onClear});

  final VoidCallback onCopy;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    Widget action(String label, VoidCallback onTap, {bool bold = false}) =>
        Semantics(
          button: true,
          label: label == '×' ? 'Clear selection' : label,
          excludeSemantics: true,
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minWidth: 44, minHeight: 40),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Center(
                  widthFactor: 1,
                  child: Text(
                    label,
                    style: tty.style(
                      size: 15,
                      weight: bold ? FontWeight.w700 : FontWeight.w400,
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
    return Material(
      color: Color.alphaBlend(tty.text.withValues(alpha: 0.12), tty.ground),
      elevation: 2,
      borderRadius: BorderRadius.circular(6),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [action('Copy', onCopy, bold: true), action('×', onClear)],
      ),
    );
  }
}
