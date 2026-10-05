import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

import '../clipboard/native_clipboard.dart';
import '../logging/typing_trace.dart';
import '../state/app_state.dart';

import '../terminal/terminal_snapshot.dart';
import '../terminal/terminal_binary.dart';
import '../terminal/terminal_font_store.dart';
import '../terminal/terminal_link_opener.dart';
import '../terminal/remote_media_download.dart';
import '../terminal/remote_scroll_physics.dart';
import '../terminal/terminal_links.dart';
import '../terminal/output_blocks.dart';
import '../terminal/terminal_prompt_zone.dart';
import '../phone/tty.dart';
import '../terminal/terminal_session.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../terminal/terminal_viewport.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'terminal_pane_badges.dart';

/// A run of output rows drawn and pressed as one — [TerminalPanel.lineBands]. [first] and [last]
/// are absolute buffer lines, inclusive; [key] is the host's own name for it, and [label] is what a
/// screen reader says.
typedef TerminalLineBand = ({String key, int first, int last, String label});

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

  /// Runs of output rows drawn on a faint band, each one tap target — on the phone, an open
  /// question's answers. Asked again on every paint and every tap rather than held, so a band
  /// stays on its lines as the pane scrolls and repaints. Null draws none.
  final List<TerminalLineBand> Function(Terminal terminal)? lineBands;

  /// A tap anywhere on a [lineBands] band, its description lines included. Taken before
  /// [onLineTap], and whether or not [onInputTap] is set: a band is drawn to be pressed.
  final void Function(TerminalLineBand band)? onBandTap;

  /// Pastes the phone's clipboard into the session — the Paste of a long press on the prompt
  /// (see `_TerminalPanelState._openPromptMenu`). Null offers no Paste there.
  final VoidCallback? onPaste;

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
    this.lineBands,
    this.onBandTap,
    this.onPaste,
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

  /// The [TerminalLineBand.key] under a finger that is down on it: drawn brighter until the finger
  /// lifts or the pane scrolls. A notifier for the reason [_hoveredLink] is one — a press repaints
  /// the bands, not the pane.
  final ValueNotifier<String?> _pressedBand = ValueNotifier(null);

  /// The bands' own box, which a band's rect is measured into — see [_bandRect].
  final GlobalKey _bandsKey = GlobalKey();

  /// Whether [_releaseBandOnUp] is on the pointer router, waiting for the pressing finger to lift.
  bool _bandReleaseRouted = false;

  /// The selection handles' own box, which their positions are measured into — see
  /// [_selectionEnds].
  final GlobalKey _handlesKey = GlobalKey();

  /// The end of the selection the finger on a handle is moving, or null while none is.
  _SelectionEnd? _draggingEnd;

  /// From the finger to the middle of the row its handle marks, held for the drag: the finger is
  /// on the knob, not on the text, and the end must not jump to where the finger is.
  Offset _handleGrab = Offset.zero;

  /// The pane's menu while it is on screen — see [_syncMenu].
  ContextMenuController? _menu;

  /// Whether [_syncMenu] is already due after this frame.
  bool _menuPending = false;

  /// The cell a long press on the prompt opened its menu at, or null while that menu is closed —
  /// see [_openPromptMenu].
  CellOffset? _promptMenuCell;

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
    _controller.addListener(_scheduleMenu);
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
    // A sheet pushed over the page, or taken off it — see [_syncMenu].
    _scheduleMenu();
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
      _draggingEnd = null;
      _promptMenuCell = null;
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
      _promptMenuCell = null;
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
    if (oldWidget.visible != widget.visible) _scheduleMenu();
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
    _hideMenu();
    _controller.removeListener(_scheduleMenu);
    _controller.dispose();
    _scrollController.dispose();
    _focusNode.dispose();
    _hoveredLink.dispose();
    _linkModifierDown.dispose();
    _previewProgress.dispose();
    _unrouteBandRelease();
    _pressedBand.dispose();
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
    if (kTypingTrace) typingEvent('panel view → the new terminal');

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
    // The prompt's menu points at a cell of the screen just replaced.
    _promptMenuCell = null;
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
    if (kTypingTrace) typingEvent('panel focus=${_focusNode.hasFocus}');
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
    if (kTypingTrace) {
      typingEvent('panel claims the keyboard (navigating=$navigating)');
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
    final text = _selectedText(widget.session.terminal.buffer, selection);
    _controller.clearSelection();
    await Clipboard.setData(ClipboardData(text: text));
    HapticFeedback.lightImpact();
  }

  /// What [selection] copies as. A whole message, as a long press selected it, copies as the agent
  /// wrote it ([outputBlockText]: no mark, no hang, the TUI's own wraps joined). Anything else — a
  /// word, ends moved by a handle — copies exactly as marked.
  String _selectedText(Buffer buffer, BufferRange selection) {
    final range = selection.normalized;
    final block = outputBlockAt(buffer, range.begin.y);
    if (block != null && outputBlockRange(buffer, block) == range) {
      return outputBlockText(buffer, block);
    }
    return buffer.getText(range);
  }

  /// A long press on an agent's message selects all of it — the `⏺` block, mark to last line —
  /// rather than the word under the finger: the message is what anybody copies from a phone, and
  /// a word at a time it took a dozen drags. The handles then move either end.
  ///
  /// A long press on the prompt opens its menu instead — Paste, Select — the menu a long press in
  /// any text field opens: see [_openPromptMenu]. Anywhere else (a plain shell's output) xterm
  /// selects the word, as it always did.
  bool _onTerminalLongPressStart(
    LongPressStartDetails details,
    CellOffset cell,
  ) {
    _promptMenuCell = null;
    final buffer = _viewTerminal.buffer;
    final block = outputBlockAt(buffer, cell.y);
    if (block != null) {
      _select(outputBlockRange(buffer, block));
      HapticFeedback.selectionClick();
      return true;
    }
    if (isPromptTap(buffer, cell.y) && _openPromptMenu(cell)) {
      HapticFeedback.selectionClick();
      return true;
    }
    return false;
  }

  /// Opens the prompt's menu at [cell], when it would hold anything: Select while there is a word
  /// under the finger, Select All and Remove while something is typed (see [promptInputRange]),
  /// Paste while the session takes input.
  ///
  /// ⚠️ **Paste is the page's, not the panel's.** What it reads and how it sends lives in
  /// `phone/terminal_paste.dart`, behind [TerminalPanel.onPaste]: the panel's own [_paste] is the
  /// desktop's ⌘V, whose last resort is a Ctrl+V for the engine to read ITS clipboard — on a
  /// phone that is the far machine's clipboard, not the one the person just copied to.
  bool _openPromptMenu(CellOffset cell) {
    final buffer = _viewTerminal.buffer;
    if (!_canPasteHere &&
        buffer.getWordBoundary(cell) == null &&
        promptInputRange(buffer) == null) {
      return false;
    }
    _controller.clearSelection();
    _promptMenuCell = cell;
    _scheduleMenu();
    return true;
  }

  bool get _canPasteHere =>
      widget.onPaste != null && widget.session.acceptsInput;

  void _closePromptMenu() {
    if (_promptMenuCell == null) return;
    _promptMenuCell = null;
    _scheduleMenu();
  }

  void _select(BufferRange range) {
    final buffer = _viewTerminal.buffer;
    _controller.setSelection(
      buffer.createAnchorFromOffset(range.begin),
      buffer.createAnchorFromOffset(range.end),
      mode: SelectionMode.line,
    );
  }

  /// What the selection menu's Select All selects: the next whole thing around the selection —
  /// the text typed into the prompt when the selection is inside it, the message it lies in, then
  /// everything the terminal holds. Null once the selection is already all there is.
  BufferRange? _selectAllTarget() {
    final selection = _controller.selection?.normalized;
    if (selection == null) return null;
    final buffer = _viewTerminal.buffer;
    final input = promptInputRange(buffer);
    if (input != null &&
        input.contains(selection.begin) &&
        input.contains(selection.end)) {
      return input == selection ? null : input;
    }
    final message = _wholeMessage();
    if (message != null) return message;
    final all = _allText(buffer);
    return all == null || all == selection ? null : all;
  }

  /// Everything the terminal holds, its history included: from its first row with text to the end
  /// of its last. Null for a terminal with nothing on it.
  BufferRangeLine? _allText(Buffer buffer) {
    final lines = buffer.lines;
    var first = 0;
    while (first < lines.length && lines[first].getTrimmedLength() == 0) {
      first++;
    }
    if (first >= lines.length) return null;
    var last = lines.length - 1;
    while (last > first && lines[last].getTrimmedLength() == 0) {
      last--;
    }
    return BufferRangeLine(
      CellOffset(0, first),
      CellOffset(lines[last].getTrimmedLength(), last),
    );
  }

  /// The message the selection lies in, while the selection is not already all of it. Null for a
  /// selection outside any message, or across two.
  BufferRange? _wholeMessage() {
    final selection = _controller.selection?.normalized;
    if (selection == null) return null;
    final buffer = _viewTerminal.buffer;
    final block = outputBlockAt(buffer, selection.begin.y);
    if (block == null || outputBlockAt(buffer, selection.end.y) != block) {
      return null;
    }
    final range = outputBlockRange(buffer, block);
    return range == selection ? null : range;
  }

  /// Brings the pane's menu in line with it after this frame — once, however many selection
  /// changes, scrolls and output chunks ask in it.
  ///
  /// After the frame because the menu reads where its rows were laid out, and because what asks
  /// can be mid-build (a route's status) or mid-layout (a scroll the renderer corrected).
  void _scheduleMenu() {
    if (_menuPending) return;
    if (_menu == null &&
        _controller.selection == null &&
        _promptMenuCell == null) {
      return;
    }
    _menuPending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _menuPending = false;
      if (mounted) _syncMenu();
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  /// Shows the pane's menu — the selection's (Copy, Select All), or the prompt's (Paste, Select) —
  /// at what it is about, or moves it along; hides it when there is neither.
  ///
  /// ⚠️ **Hidden while anything covers the page.** The menu lives in the app's root overlay, above
  /// every route, so a sheet pushed over this page (its `…` actions) would open UNDER it. Hidden
  /// too while a handle is being dragged, as the system's own is, and on a page swiped away.
  void _syncMenu() {
    final show =
        widget.visible &&
        _draggingEnd == null &&
        (_controller.selection != null || _promptMenuCell != null) &&
        (ModalRoute.of(context)?.isCurrent ?? true);
    if (!show) {
      _hideMenu();
      return;
    }
    final menu = _menu;
    if (menu != null && menu.isShown) {
      menu.markNeedsBuild();
      return;
    }
    _menu = ContextMenuController()
      ..show(context: context, contextMenuBuilder: _buildMenu);
  }

  void _hideMenu() {
    _menu?.remove();
    _menu = null;
  }

  /// The system's own text toolbar ([AdaptiveTextSelectionToolbar]: iOS's dark bar on an
  /// iPhone), pointed the way Flutter points it at text — above the first row, or under the last
  /// when there is no room above. Nothing while those rows are scrolled out of the pane.
  Widget _buildMenu(BuildContext context) {
    final selection = _controller.selection?.normalized;
    final prompt = _promptMenuCell;
    final render = _laidOutTerminalView()?.renderTerminal;
    if ((selection == null && prompt == null) ||
        render == null ||
        !render.attached ||
        !render.hasSize) {
      return const SizedBox.shrink();
    }
    final row = render.lineHeight;
    final from = selection?.begin ?? prompt!;
    final to = selection?.end ?? CellOffset(prompt!.x + 1, prompt.y);
    final begin = render.getOffset(from);
    final end = render.getOffset(to) + Offset(0, row);
    if (end.dy <= 0 || begin.dy >= render.size.height) {
      return const SizedBox.shrink();
    }
    final anchors = TextSelectionToolbarAnchors.fromSelection(
      renderBox: render,
      startGlyphHeight: row,
      endGlyphHeight: row,
      selectionEndpoints: [
        TextSelectionPoint(begin + Offset(0, row), null),
        TextSelectionPoint(end, null),
      ],
    );
    if (selection != null) {
      final all = _selectAllTarget();
      return AdaptiveTextSelectionToolbar.buttonItems(
        anchors: anchors,
        buttonItems: [
          ContextMenuButtonItem(
            type: ContextMenuButtonType.copy,
            onPressed: () => unawaited(_copySelection()),
          ),
          if (all != null)
            ContextMenuButtonItem(
              type: ContextMenuButtonType.selectAll,
              onPressed: () => _select(all),
            ),
        ],
      );
    }
    final buffer = _viewTerminal.buffer;
    final word = buffer.getWordBoundary(prompt!);
    final input = promptInputRange(buffer);
    // Closed by a touch anywhere else, as a text field's is: nothing is selected to tap away.
    return TapRegion(
      onTapOutside: (_) => _closePromptMenu(),
      child: AdaptiveTextSelectionToolbar.buttonItems(
        anchors: anchors,
        buttonItems: [
          if (word != null)
            ContextMenuButtonItem(
              label: 'Select',
              onPressed: () {
                _closePromptMenu();
                _select(word);
              },
            ),
          if (input != null)
            ContextMenuButtonItem(
              type: ContextMenuButtonType.selectAll,
              onPressed: () {
                _closePromptMenu();
                _select(input);
              },
            ),
          if (_canPasteHere)
            ContextMenuButtonItem(
              type: ContextMenuButtonType.paste,
              onPressed: () {
                _closePromptMenu();
                widget.onPaste?.call();
              },
            ),
          // Empties what is typed: Ctrl+K, then Ctrl+U — see [TerminalSession.clearPrompt]. Only
          // while something is typed and the prompt is this phone's to type into.
          if (input != null && widget.session.acceptsInput)
            ContextMenuButtonItem(
              label: 'Remove',
              onPressed: () {
                _closePromptMenu();
                widget.session.clearPrompt();
              },
            ),
        ],
      ),
    );
  }

  /// Where the selection's ends are drawn, in the handles' own box: the top of the first selected
  /// cell's left edge, and the top of the cell after the last one. Null with no selection, or
  /// before layout.
  ///
  /// Measured through the terminal's render box, as [_bandRect] is, so the scroll offset and
  /// xterm's padding are counted exactly as the selection's own paint counts them.
  ({Offset begin, Offset end, double row})? _selectionEnds() {
    final selection = _controller.selection?.normalized;
    final render = _laidOutTerminalView()?.renderTerminal;
    final box = _handlesKey.currentContext?.findRenderObject();
    if (selection == null || render == null || !render.attached) return null;
    if (box is! RenderBox || !box.attached || !box.hasSize) return null;
    Offset at(CellOffset cell) =>
        box.globalToLocal(render.localToGlobal(render.getOffset(cell)));
    return (
      begin: at(selection.begin),
      end: at(selection.end),
      row: render.lineHeight,
    );
  }

  void _onHandleDragStart(DragStartDetails details) {
    _draggingEnd = null;
    final ends = _selectionEnds();
    final box = _handlesKey.currentContext?.findRenderObject();
    if (ends == null || box is! RenderBox) return;
    final local = box.globalToLocal(details.globalPosition);
    final end = _SelectionHandlesPainter.handleAt(local, ends);
    if (end == null) return;
    final marked = switch (end) {
      _SelectionEnd.begin => ends.begin,
      _SelectionEnd.end => ends.end,
    };
    _handleGrab = marked + Offset(0, ends.row / 2) - local;
    _draggingEnd = end;
    _scheduleMenu();
    HapticFeedback.selectionClick();
  }

  /// Moves the dragged end to the cell boundary nearest the finger (less [_handleGrab]). The two
  /// ends never cross: at least one cell stays selected, and a drag past the other end stops there.
  void _onHandleDragUpdate(DragUpdateDetails details) {
    final dragging = _draggingEnd;
    if (dragging == null) return;
    final selection = _controller.selection?.normalized;
    final render = _laidOutTerminalView()?.renderTerminal;
    if (selection == null || render == null || !render.attached) return;
    final buffer = _viewTerminal.buffer;
    final local = render.globalToLocal(details.globalPosition + _handleGrab);
    final row = render.getCellOffset(local).y;
    final rowLeft = render.getOffset(CellOffset(0, row)).dx;
    final column = ((local.dx - rowLeft) / render.cellSize.width).round().clamp(
      0,
      buffer.viewWidth,
    );
    final moved = CellOffset(column, row);
    final begin = dragging == _SelectionEnd.begin ? moved : selection.begin;
    final end = dragging == _SelectionEnd.end ? moved : selection.end;
    if (!begin.isBefore(end)) return;
    if (begin == selection.begin && end == selection.end) return;
    _controller.setSelection(
      buffer.createAnchorFromOffset(begin),
      buffer.createAnchorFromOffset(end),
      mode: SelectionMode.line,
    );
  }

  void _onHandleDragEnd([DragEndDetails? _]) {
    _draggingEnd = null;
    _scheduleMenu();
  }

  Future<void> _copyOrPaste() async {
    final terminal = widget.session.terminal;
    final selection = _controller.selection;
    if (selection != null) {
      final text = _selectedText(terminal.buffer, selection);
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
  /// platform-channel read for an actual image (all but Windows; see its doc).
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
  /// Flutter's [Clipboard] reads `text/plain` and nothing else, and Gboard hands
  /// the bytes over directly, so there is no clipboard to read at all. (The
  /// actions sheet's Paste reads the system clipboard's image instead, through
  /// [NativeClipboard]: see `phone/terminal_paste.dart`.)
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
    // Output can move a selection's lines, and the menu pointing at them.
    if (_controller.selection != null) _scheduleMenu();
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
    _scheduleMenu();
    _rememberFollowTail();
    _scheduleLinkRefresh();
    // A press that turned into a scroll is no longer a press.
    _pressedBand.value = null;
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
    if (_controller.selection != null) return false;
    final band = _bandAt(cell.y);
    if (band == null && widget.onInputTap == null) return false;
    _pressedBand.value = band?.key;
    if (band != null && !_bandReleaseRouted) {
      _bandReleaseRouted = true;
      GestureBinding.instance.pointerRouter.addGlobalRoute(_releaseBandOnUp);
    }
    return _inputTapClaimed = true;
  }

  /// Up or gone, the finger is off the band — whatever xterm makes of it. Its tap has no cancel,
  /// and a press that became a long press, or a drag with nothing to scroll, would stay lit.
  void _releaseBandOnUp(PointerEvent event) {
    if (event is! PointerUpEvent && event is! PointerCancelEvent) return;
    _unrouteBandRelease();
    _pressedBand.value = null;
  }

  void _unrouteBandRelease() {
    if (!_bandReleaseRouted) return;
    _bandReleaseRouted = false;
    GestureBinding.instance.pointerRouter.removeGlobalRoute(_releaseBandOnUp);
  }

  void _onTerminalTapUp(TapUpDetails details, CellOffset cell) {
    if (!_inputTapClaimed) {
      _onLinkTapUp(details, cell);
      return;
    }
    _inputTapClaimed = false;
    _pressedBand.value = null;
    // Read again, not remembered from the press: what is under the finger now is what it meant.
    if (_bandAt(cell.y) case final band?) {
      widget.onBandTap?.call(band);
      return;
    }
    final buffer = _viewTerminal.buffer;
    if (cell.y >= 0 &&
        cell.y < buffer.lines.length &&
        (widget.onLineTap?.call(buffer.lines[cell.y].getText()) ?? false)) {
      return;
    }
    if (!isPromptTap(buffer, cell.y)) return;
    widget.onInputTap?.call();
  }

  /// The bands the host asks for now, or none when there is nothing to press them with.
  List<TerminalLineBand> _bands() {
    if (widget.onBandTap == null) return const [];
    return widget.lineBands?.call(_viewTerminal) ?? const [];
  }

  /// The band drawn across buffer line [line], if any.
  TerminalLineBand? _bandAt(int line) {
    for (final band in _bands()) {
      if (line >= band.first && line <= band.last) return band;
    }
    return null;
  }

  /// Where [band] is drawn, in the bands' own box: the full width, its rows' height less a point
  /// top and bottom, so two answers on adjacent rows read as two. Null before layout.
  ///
  /// Measured through the terminal's render box rather than worked out from the line height, so
  /// the scroll offset and xterm's own padding are counted exactly as its text is.
  Rect? _bandRect(TerminalLineBand band) {
    final render = _laidOutTerminalView()?.renderTerminal;
    final box = _bandsKey.currentContext?.findRenderObject();
    if (render == null || box is! RenderBox || !render.attached) return null;
    if (!box.attached || !box.hasSize) return null;
    final origin = box.globalToLocal(render.localToGlobal(Offset.zero));
    final top = render.getOffset(CellOffset(0, band.first)).dy;
    final bottom =
        render.getOffset(CellOffset(0, band.last)).dy + render.lineHeight;
    return Rect.fromLTRB(
      0,
      origin.dy + top + 1,
      box.size.width,
      origin.dy + bottom - 1,
    );
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
    if (kTypingTrace) typingCount('panel.build');
    grid.AppTheme.watch(context);
    final session = widget.session;
    _syncTerminal(session.terminal);
    final colors = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final foreground = colors.foreground;
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
                        // This view is only ever handed the next screen of its
                        // own session — a keyframe — since another session gets
                        // a view of its own (a fresh `_terminalViewKey`): what
                        // the keyboard holds is still the line being typed.
                        keepsInputAcrossTerminals: true,
                        // What is typed shows at once, ahead of the machine's echo a
                        // round trip away (owner's call, 2026-10-05) — only once this
                        // terminal has been seen echoing, so a password prompt
                        // shows nothing. See xterm's `TerminalView.predictsEcho`.
                        predictsEcho: true,
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
                        onLongPressStart: _onTerminalLongPressStart,
                        // Constant on purpose. The click cursor is applied by
                        // [_LinkTooltip]'s own MouseRegion, which repaints
                        // without rebuilding this view.
                        mouseCursor: SystemMouseCursors.text,
                        onSecondaryTapDown: (_, _) => _copyOrPaste(),

                        onAltBufferScroll: session.scrollViaTmuxCopyMode
                            ? (up) => session.sendScrollCommand(up, 1)
                            : null,
                        altBufferScrollPhysics: const RemoteScrollPhysics(),
                        altBufferScrollPaced: true,
                        altBufferScrollAnimated: true,
                        // How many redraws slid and how many jumped — the
                        // scroll's smoothness, for the trace.
                        onAltBufferScrollShift: kTypingTrace
                            ? (rows) => typingCount(
                                rows == 0 ? 'scroll.jumped' : 'scroll.slid',
                              )
                            : null,
                      ),
                    ),
                  ),
                ),
                // The bands the host asks for — on the phone, an open question's answers. They
                // take no hit themselves: a tap goes through to xterm, which hands it to [_bandAt].
                if (widget.lineBands != null && widget.onBandTap != null)
                  Positioned.fill(
                    child: CustomPaint(
                      key: _bandsKey,
                      painter: _LineBandPainter(
                        bands: _bands,
                        rectOf: _bandRect,
                        pressed: _pressedBand,
                        color: foreground.withValues(alpha: 0.06),
                        pressedColor: foreground.withValues(alpha: 0.16),
                        onTap: (band) => widget.onBandTap?.call(band),
                        // Output, a scroll and a press are what move or light a band; a new
                        // question rebuilds the page, and with it this painter.
                        repaint: Listenable.merge([
                          session.outputTicks,
                          _scrollController,
                          _pressedBand,
                        ]),
                      ),
                    ),
                  ),
                // The selection's two ends, green, each with a knob to drag it by. Only the knobs and
                // their rows take a touch ([_SelectionHandlesPainter.hitTest]); everywhere else the
                // touch goes through to xterm, so a tap still clears the selection and a drag still
                // scrolls.
                //
                // ⚠️ **The drag is claimed on touch-down** ([_EagerPanGestureRecognizer]). The page
                // swipes between agents on a horizontal drag, and its recognizer would otherwise win
                // every sideways move of a handle before the handle's own pan saw it.
                Positioned.fill(
                  child: RawGestureDetector(
                    behavior: HitTestBehavior.deferToChild,
                    gestures: {
                      _EagerPanGestureRecognizer:
                          GestureRecognizerFactoryWithHandlers<
                            _EagerPanGestureRecognizer
                          >(_EagerPanGestureRecognizer.new, (recognizer) {
                            recognizer
                              ..dragStartBehavior = DragStartBehavior.down
                              ..onStart = _onHandleDragStart
                              ..onUpdate = _onHandleDragUpdate
                              ..onEnd = _onHandleDragEnd
                              ..onCancel = _onHandleDragEnd;
                          }),
                    },
                    child: CustomPaint(
                      key: _handlesKey,
                      painter: _SelectionHandlesPainter(
                        ends: _selectionEnds,
                        color: colors.green,
                        // The selection, a scroll and output are what move an end.
                        repaint: Listenable.merge([
                          _controller,
                          _scrollController,
                          session.outputTicks,
                        ]),
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
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The two ends of a selection: where it starts, and where it stops.
enum _SelectionEnd { begin, end }

/// A pan that claims its pointer on touch-down — see the handles in [_TerminalPanelState.build].
///
/// Accepted while the arena is still open, which makes it the arena's eager winner: no drag
/// recognizer above it (the page's swipe between agents) can take the pointer from it afterwards.
class _EagerPanGestureRecognizer extends PanGestureRecognizer {
  _EagerPanGestureRecognizer()
    : super(supportedDevices: {PointerDeviceKind.touch});

  @override
  void addAllowedPointer(PointerDownEvent event) {
    super.addAllowedPointer(event);
    resolvePointer(event.pointer, GestureDisposition.accepted);
  }
}

/// A selection's handles, drawn: a 2pt bar the height of a row at each end, with a knob above the
/// first and below the last, as iOS draws its own.
///
/// Hit only on a knob or its bar, generously ([_reach]) — a row is ~16pt and a thumb is not.
/// Everywhere else the touch belongs to xterm underneath.
class _SelectionHandlesPainter extends CustomPainter {
  _SelectionHandlesPainter({
    required this.ends,
    required this.color,
    required Listenable repaint,
  }) : super(repaint: repaint);

  final ({Offset begin, Offset end, double row})? Function() ends;
  final Color color;

  static const _knob = 6.0;
  static const _reach = 24.0;

  /// The knob centres, and the bars the knobs hang from.
  static ({Offset knob, Rect bar}) _begin(
    ({Offset begin, Offset end, double row}) ends,
  ) => (
    knob: ends.begin - const Offset(0, _knob),
    bar: Rect.fromLTWH(ends.begin.dx - 1, ends.begin.dy, 2, ends.row),
  );

  static ({Offset knob, Rect bar}) _end(
    ({Offset begin, Offset end, double row}) ends,
  ) => (
    knob: ends.end + Offset(0, ends.row + _knob),
    bar: Rect.fromLTWH(ends.end.dx - 1, ends.end.dy, 2, ends.row),
  );

  /// The handle under [position], if any. The end one first: on a one-row selection the two knobs
  /// are a row apart, and the end is the one somebody most often moves.
  static _SelectionEnd? handleAt(
    Offset position,
    ({Offset begin, Offset end, double row}) ends,
  ) {
    bool near(({Offset knob, Rect bar}) handle) =>
        (position - handle.knob).distance <= _reach ||
        handle.bar.inflate(_reach / 2).contains(position);
    if (near(_end(ends))) return _SelectionEnd.end;
    if (near(_begin(ends))) return _SelectionEnd.begin;
    return null;
  }

  @override
  void paint(Canvas canvas, Size size) {
    final at = ends();
    if (at == null) return;
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    final paint = Paint()..color = color;
    for (final handle in [_begin(at), _end(at)]) {
      canvas.drawRect(handle.bar, paint);
      canvas.drawCircle(handle.knob, _knob, paint);
    }
    canvas.restore();
  }

  @override
  bool? hitTest(Offset position) {
    final at = ends();
    return at != null && handleAt(position, at) != null;
  }

  /// Always: a rebuild is also a layout that can have moved the ends — the keyboard raised, the
  /// font changed — without the selection, the scroll or the output saying so.
  @override
  bool shouldRepaint(_SelectionHandlesPainter old) => true;
}

/// [TerminalPanel.lineBands], drawn: a faint wash across each band's rows, brighter while pressed.
///
/// ⚠️ **Over the text, not under it.** xterm owns its render box's whole background (see
/// `RenderTerminal._paint`), so there is no under; the wash is light enough to leave the text as it
/// is, the way xterm's own selection sits over the glyphs it marks.
///
/// Each band is also a button to a screen reader, named by [TerminalLineBand.label]: the rows are
/// only paint to VoiceOver, and the answers must still be there to press.
class _LineBandPainter extends CustomPainter {
  _LineBandPainter({
    required this.bands,
    required this.rectOf,
    required this.pressed,
    required this.color,
    required this.pressedColor,
    required this.onTap,
    required Listenable repaint,
  }) : super(repaint: repaint);

  final List<TerminalLineBand> Function() bands;
  final Rect? Function(TerminalLineBand band) rectOf;
  final ValueListenable<String?> pressed;
  final Color color;
  final Color pressedColor;
  final void Function(TerminalLineBand band) onTap;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint();
    for (final band in bands()) {
      final rect = rectOf(band);
      if (rect == null || !rect.overlaps(Offset.zero & size)) continue;
      paint.color = band.key == pressed.value ? pressedColor : color;
      canvas.drawRect(rect, paint);
    }
  }

  /// Never hit: the tap belongs to xterm underneath, which finds the band itself.
  @override
  bool? hitTest(Offset position) => false;

  @override
  SemanticsBuilderCallback get semanticsBuilder =>
      (size) => [
        for (final band in bands())
          if (rectOf(band) case final rect?
              when rect.overlaps(Offset.zero & size))
            CustomPainterSemantics(
              key: ValueKey<String>('line-band-${band.key}'),
              rect: rect.intersect(Offset.zero & size),
              properties: SemanticsProperties(
                button: true,
                label: band.label,
                textDirection: TextDirection.ltr,
                onTap: () => onTap(band),
              ),
            ),
      ];

  @override
  bool shouldRepaint(_LineBandPainter old) => true;

  @override
  bool shouldRebuildSemantics(_LineBandPainter old) => true;
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
