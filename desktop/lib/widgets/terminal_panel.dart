import 'pull_request_badge.dart';
import '../shared/theme/prompt_style.dart';
import 'prompt_context.dart';

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

import '../clipboard/native_clipboard.dart';
import '../core/models.dart';
import '../state/app_state.dart';
import '../state/model_start_watch.dart';

import 'agent_drag.dart';
import 'rename_agent_dialog.dart';
import 'terminal_composer.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import 'terminal_find_bar.dart';
import '../terminal/terminal_search.dart';
import '../terminal/terminal_snapshot.dart';
import '../terminal/terminal_binary.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_link_opener.dart';
import '../terminal/remote_media_download.dart';
import '../terminal/terminal_links.dart';
import '../terminal/terminal_session.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../terminal/terminal_viewport.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import '../theme/app_theme.dart';
import 'engine_identity.dart';
import 'grid_model_picker.dart';
import 'pane_header_actions.dart';
import 'pane_model_status.dart';

/// The pane header's own horizontal inset.
const double _stripPadding = 14;

/// What sits in a header row beside a status: the engine mark (17) and its gap (10), the gap
/// before the status (8), and the gap and link badge after the row (8 + 18). The "Starting up…"
/// chip is never given more than the row's room less these.
const double _headerFurniture = 17 + 10 + 8 + 8 + 18;

typedef TerminalNotice = ({
  String label,
  String detail,
  IconData icon,

  /// A way out of what the notice describes, shown as the header's button —
  /// a machine that needs linking offers to ask for its password. Null where
  /// the state is merely reported and nothing here would fix it.
  String? actionLabel,
  VoidCallback? onAction,

  /// Whether this one also earns the band across the top of the pane, over the
  /// output. The chip is the resting place for a notice; the band is for the
  /// few that are CONFUSING as well as blocking — a pane still printing while
  /// its keyboard is locked — where the sentence has to be read, not hovered.
  /// An offline machine is neither confusing nor rare, and a band on every one
  /// of those would cost rows in every tile.
  bool banner,
});

/// A [TerminalNotice] without spelling out the fields it does not have.
///
/// A record has no default values, so every caller of a five-field one has to
/// name all five — which is how widening this typedef broke eight untouched
/// call sites at once. This is the one place that knows the full shape.
TerminalNotice terminalNotice({
  required String label,
  required String detail,
  required IconData icon,
  String? actionLabel,
  VoidCallback? onAction,
  bool banner = false,
}) => (
  label: label,
  detail: detail,
  icon: icon,
  actionLabel: actionLabel,
  onAction: onAction,
  banner: banner,
);

class TerminalPanel extends StatefulWidget {
  final AppNotifier notifier;
  final TerminalSession session;

  /// Takes this tile off the grid. Null when the terminal is the whole window,
  /// where there is nothing to close it back to.
  final VoidCallback? onClose;

  final VoidCallback? onDelete;

  final VoidCallback? onToggleZoom;
  final bool zoomed;

  /// This native terminal took the keyboard, so its grid tile becomes focused.
  final VoidCallback? onRendererFocus;

  /// Only the focused grid tile may claim keyboard focus on mount/rebuild.
  final bool focused;
  final bool visible;

  /// Coalesces streaming output for an unfocused tile without delaying input.
  final Duration? outputRepaintInterval;
  final Size? viewportSize;

  /// A shared terminal can move to another tab without being remounted.
  final (String, int)? paneLocation;
  final (int, int, int?)? layoutRequest;
  final bool compactHeader;

  /// The tile's own header strip — engine, title, status, pin, close — and
  /// whether it is built at all. False on the phone, where [PhoneHeader] already
  /// names the agent above this panel, there is no tile to pin, close or drag,
  /// and the pane takes the full remaining height (`phone/terminal_page.dart`
  /// in the mobile package). Find has no way in there — every
  /// [TerminalFindAction] caller lives in the desktop screens — so the row's
  /// Find overlay goes with it.
  final bool showHeader;
  final int focusRequest;

  /// Whether the navigation that focused or showed this tile was a person's
  /// gesture on this app (`AppNotifier.paneFocusByUser`). A device's — the
  /// dial turning, a question shown there — moves the keyboard here just the
  /// same, but never retakes a terminal another client holds.
  final bool focusByUser;

  /// Whether this tile's composer textbox is showing. Only consulted for a remote machine.
  final bool composerVisible;
  final bool readOnly;
  final TerminalNotice? notice;

  /// Flips [composerVisible]. Null where there is no composer to toggle.
  final VoidCallback? onToggleComposer;

  /// Lets the header be dragged to trade places with another tile. Null when
  /// this is the only tile — see [_TerminalHeader.paneDrag].
  final PaneDragHandle? paneDrag;

  /// Test seam for OS actions; normal panes use the platform launcher.
  final TerminalLinkOpener? linkOpener;
  final RemoteMediaDownloader? mediaDownloader;

  const TerminalPanel({
    super.key,
    required this.notifier,
    required this.session,
    required this.focused,
    this.visible = true,
    this.outputRepaintInterval,
    this.viewportSize,
    this.paneLocation,
    this.layoutRequest,
    this.compactHeader = false,
    this.showHeader = true,
    this.focusRequest = 0,
    this.focusByUser = true,
    this.composerVisible = false,
    this.readOnly = false,
    this.notice,
    this.onToggleComposer,
    this.onClose,
    this.onDelete,
    this.onToggleZoom,
    this.zoomed = false,
    this.onRendererFocus,
    this.paneDrag,
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
  final FocusNode _composerFocus = FocusNode();
  final _findBarKey = GlobalKey<TerminalFindBarState>();
  TerminalSearch? _find;
  String _lastFindQuery = '';
  bool _lastFindCaseSensitive = false;
  CellAnchor? _lastFindAnchor;
  Buffer? _lastFindBuffer;
  TerminalHighlight? _findHighlight;
  Buffer? _findPaintedBuffer;
  BufferRangeLine? _findPaintedRange;
  Buffer? _findOriginBuffer;
  CellAnchor? _findOriginLine;
  double _findOriginFraction = 0;
  bool _findOriginAtEnd = false;
  bool _findRevealPending = false;
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
  String? _hoveredLink;
  List<TerminalLinkSpan> _hoveredLinkSpans = const [];
  Rect? _hoveredLinkAnchor;
  final _linkUnderlineKey = GlobalKey();
  String? _pressedLink;
  bool _openingLink = false;
  bool _linkRefreshPending = false;
  bool _followTail = true;
  TerminalStyle _terminalFont = terminalFontStore.value;
  bool _observingLinkModifiers = false;
  late final RemoteMediaDownloader _mediaDownloader;
  MediaDownloadCancellation? _previewCancellation;
  RemoteMediaProgress? _previewProgress;
  Object? _headerPresentation;
  Widget? _header;

  /// Opens this pane's model picker from outside its header — the model note's "Pick another".
  final GridModelPickerController _pickerController = GridModelPickerController();

  /// What this pane's "Starting up…" chip said at the last build, so a change for another agent's
  /// pane does not rebuild this one. See [ModelStartWatch].
  ModelStartPhase? _startPhase;

  /// Whether the model note holds a line under the header — see [_syncNoteLine].
  bool _noted = false;

  /// Set while the in-pane control banner is answering a keystroke that went
  /// nowhere (see [_nudgeControlBanner]); cleared by [_controlNudgeTimer].
  bool _controlNudged = false;
  int _controlNudge = 0;
  Timer? _controlNudgeTimer;

  /// Set when THIS pane asked for the stream back, so the banner can stay up
  /// through `opening` saying so. A first open, or a resync, is not that and
  /// shows nothing.
  bool _retakingControl = false;

  /// The status the last frame was built for. The grid normally rebuilds this
  /// panel on every session change, but the banner must not depend on that.
  TerminalSessionStatus? _builtStatus;
  bool _wasBlocked = false;

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
    _composerFocus.addListener(_handleComposerFocusChange);
    WidgetsBinding.instance.addObserver(this);
    widget.session.attachViewport(this);
    widget.session.addListener(_onSessionChanged);
    terminalFontStore.addListener(_onFontChanged);
    // Colours repaint the view in place — no relayout, no resize frame — but
    // they still need a rebuild to reach it, and this widget reads the store
    // directly rather than through a builder.
    terminalThemeStore.addListener(_onFontChanged);
    widget.notifier.modelStarts.addListener(_onModelStartsChanged);
    _startPhase = _startPhaseNow();
    _noted = _gridNote() != null;
    _afterTerminalMounted();
  }

  ModelStartPhase? _startPhaseNow() => widget.notifier.modelStarts.phaseOf(
    widget.session.machineId,
    widget.session.agentId,
  );

  /// The chip is driven by timers and turn events, neither of which rebuilds the pane grid — so
  /// the pane listens for it itself, and rebuilds only when ITS phase moved.
  void _onModelStartsChanged() {
    if (!mounted) return;
    final phase = _startPhaseNow();
    if (phase == _startPhase) return;
    setState(() => _startPhase = phase);
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
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _syncCursorBlink();
    // ⚠️ **The window coming forward is NOT a retake.** It used to be: the tile
    // the person left focused took its stream back on every `inactive →
    // resumed`, on the reading that somebody had returned to the app. But the
    // window comes forward for things nobody did to a pane — ⌘-Tab to read
    // something, a notification, a screen waking, another app handing focus
    // back — and every one of them pulled the terminal off the phone the
    // person was actually typing into. Measured 2026-09-22: a phone holding
    // one agent lost it 13s later to a window that was never touched, over and
    // over.
    //
    // Taking control is a gesture AIMED at a pane now: a click in it, ⏎ on its
    // band, its button, or a focus move (⌘1–9, ⌘]). Coming back to the window
    // and typing costs one ⏎, which is what the band promises anyway.
  }

  @override
  void didUpdateWidget(TerminalPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.notifier, widget.notifier)) {
      oldWidget.notifier.modelStarts.removeListener(_onModelStartsChanged);
      widget.notifier.modelStarts.addListener(_onModelStartsChanged);
    }
    _startPhase = _startPhaseNow();
    _syncNoteLine();
    if (!identical(oldWidget.session, widget.session)) {
      _closeFind(restore: false, focus: false, rebuild: false);
      _clearLastFind();
      _lastFindQuery = '';
      _previewCancellation?.cancel();
      _previewProgress = null;
      oldWidget.session.setCursorBlinkPhase(true);
      oldWidget.session.removeListener(_onSessionChanged);
      oldWidget.session.detachViewport(this);
      widget.session.attachViewport(this);
      widget.session.addListener(_onSessionChanged);
      _composerFocusPending = false;
      _cancelDialInertia();
      _controller.clearSelection();
      _viewTerminal.removeListener(_scheduleLinkRefresh);
      _viewTerminal = widget.session.terminal;
      _viewTerminal.addListener(_scheduleLinkRefresh);
      _pressedLink = null;
      _hoveredLink = null;
      _hoveredLinkSpans = const [];
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
      _composerFocus.unfocus();
      _cancelDialInertia();
      _linkPointerPosition = null;
      _hoveredLink = null;
      _hoveredLinkSpans = const [];
      _pressedLink = null;
      _observeLinkModifiers(false);
    }
    if (widget.visible &&
        (!oldWidget.visible || oldWidget.paneLocation != widget.paneLocation)) {
      _afterTerminalMounted();
    }
    // Shown again (a tab switched to, a zoom undone) while it is the tile the
    // person left focused: they are back on it — unless a device switched the
    // tab, which is nobody being back anywhere.
    if (widget.visible &&
        !oldWidget.visible &&
        widget.focused &&
        widget.focusByUser) {
      _autoTakeControlAfterBuild();
    }
    if (oldWidget.viewportSize != widget.viewportSize ||
        oldWidget.layoutRequest != widget.layoutRequest) {
      // Geometry can change while a resize handle or another control owns
      // the keyboard. Refresh the viewport without claiming input ownership.
      _afterTerminalMounted(claimFocus: false);
    }
    if (widget.focused &&
        (!oldWidget.focused || oldWidget.focusRequest != widget.focusRequest)) {
      _claimFocusAfterFrame();
      // ⌘1–9, ⌘], an attention jump, a click: the person chose this tile.
      // The dial choosing it is not that — the keyboard still lands here, the
      // stream stays with whoever has it (see `AppNotifier.paneFocusByUser`).
      if (widget.focusByUser) _autoTakeControlAfterBuild();
    }
    // Showing or hiding the box changes how many rows the terminal has. Re-measure so the remote
    // grid is resized to what is actually on screen.
    if (oldWidget.composerVisible != widget.composerVisible) {
      _afterTerminalMounted();
    }
    _syncCursorBlink();
  }

  @override
  void dispose() {
    _closeFind(restore: false, focus: false, rebuild: false);
    _clearLastFind();
    WidgetsBinding.instance.removeObserver(this);
    _tickerMode?.removeListener(_syncCursorBlink);
    _previewCancellation?.cancel();
    _viewTerminal.removeListener(_scheduleLinkRefresh);
    _scrollController.removeListener(_onScrollChanged);
    _observeLinkModifiers(false);
    widget.session.setCursorBlinkPhase(true);
    widget.session.removeListener(_onSessionChanged);
    widget.session.detachViewport(this);
    terminalFontStore.removeListener(_onFontChanged);
    terminalThemeStore.removeListener(_onFontChanged);
    widget.notifier.modelStarts.removeListener(_onModelStartsChanged);
    _pickerController.dispose();
    _cancelDialInertia();
    _cursorBlinkTimer?.cancel();
    _controlNudgeTimer?.cancel();
    _focusNode.removeListener(_handleFocusChange);
    _composerFocus.removeListener(_handleComposerFocusChange);
    _controller.dispose();
    _scrollController.dispose();
    _focusNode.dispose();
    _composerFocus.dispose();
    super.dispose();
  }

  /// Whether this pane shows the composer.
  ///
  /// Only a machine reached over the network charges a round trip per keystroke, so only it gets
  /// the box — typing into a local pane already costs well under a millisecond and it would be
  /// dead weight across the bottom.
  ///
  /// The test is `isLocalMachine`, NOT `isRemote`: the app only ever lists machines whose authMode
  /// is `remote` (see the filter in `_loadMachines`), so `isRemote` is true for every pane,
  /// including this very computer. What separates them is whether the machine's computerId is this
  /// one, which is what puts it on the loopback transport.
  bool get _showsComposer {
    final machineState = widget.notifier.stateOf(widget.session.machineId);
    return machineState?.isLocalMachine != true && widget.composerVisible;
  }

  /// The composer refuses focus while it is disabled, which it is until the stream goes live. When
  /// a selection lands on a still-attaching agent, the claim is parked here and made again from
  /// [_onSessionChanged] the moment it starts accepting input.
  bool _composerFocusPending = false;

  void _onSessionChanged() {
    if (!mounted) return;
    _syncCursorBlink();
    if (_controlNudged && !_inputBlocked) {
      _controlNudgeTimer?.cancel();
      _controlNudgeTimer = null;
      setState(() => _controlNudged = false);
    }
    if (_retakingControl &&
        widget.session.status != TerminalSessionStatus.opening) {
      setState(() => _retakingControl = false);
    } else if (_builtStatus != widget.session.status) {
      setState(() {});
    }
    // The band promises ⏎, so the focused tile puts the keyboard in its
    // terminal the moment the stream is lost: a composer being disabled drops
    // it on the floor, and a pane reached by mouse may never have held it —
    // either way the focused tile would be the one place ⏎ did nothing.
    // Only when the keyboard is this pane's or nobody's, though: a person
    // mid-word in the command dock or a rename field keeps it, and the band's
    // text is there to click when they come back.
    if (_inputBlocked &&
        !_wasBlocked &&
        widget.focused &&
        widget.visible &&
        _keyboardIsOursOrIdle) {
      _claimFocusAfterFrame();
    }
    // Retaken from outside this tile (another tile's gesture, through
    // `retakeTakenOverPanes`): keep the band up through the handshake exactly
    // as this tile's own ⏎ would, rather than dropping it a beat early.
    if (_wasBlocked &&
        !_retakingControl &&
        widget.session.status == TerminalSessionStatus.opening) {
      setState(() => _retakingControl = true);
    }
    _wasBlocked = _inputBlocked;
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
        if (position.pixels != position.maxScrollExtent) {
          position.jumpTo(position.maxScrollExtent);
        }
      });
    }
    if (!_composerFocusPending) return;
    if (!widget.focused || !_showsComposer) {
      _composerFocusPending = false;
      return;
    }
    if (widget.readOnly || !widget.session.acceptsInput) return;
    _composerFocusPending = false;
    // Deferred a frame on purpose. This panel registers its session listener before the composer
    // registers its own (a parent's initState runs first), so at this instant the field is still
    // built as disabled — and a disabled field REFUSES focus. Claiming after the frame the
    // composer rebuilds in is what makes the claim actually land.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_canClaimInput || !widget.focused || !_showsComposer) return;
      if (widget.readOnly || !widget.session.acceptsInput) return;
      _composerFocus.requestFocus();
    });
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
    final originRow = _findOriginLine?.attached == true
        ? _findOriginLine!.y
        : null;
    final originFraction = _findOriginFraction;
    final originAtEnd = _findOriginAtEnd;
    final match =
        _find?.match?.begin ??
        (_lastFindAnchor?.attached == true ? _lastFindAnchor!.offset : null);
    final selection = _controller.selection;
    final selectedText = selection == null ? null : previous.getText(selection);
    final locations = remapTerminalRows(previous, next, [
      if (!atEnd) ?viewportRow,
      ?originRow,
      ?match?.y,
      ?selection?.begin.y,
      ?selection?.end.y,
    ]);
    int row(int old) => locations[old] ?? old.clamp(0, next.lines.length - 1);
    CellOffset location(CellOffset old) =>
        CellOffset(old.x.clamp(0, terminal.viewWidth - 1), row(old.y));
    final wasFinding = _find != null;
    // A screen refresh replaces the search model in place. Keep its editor's
    // input connection (and any active composition) if it owns the keyboard.
    _closeFind(
      restore: false,
      focus: false,
      rebuild: false,
      releaseFocus: false,
    );
    _clearLastFind();
    // Selection anchors belong to a specific circular buffer. Detach them
    // before the TerminalView starts laying out the replacement terminal.
    _controller.clearSelection();
    _viewTerminal.removeListener(_scheduleLinkRefresh);
    _viewTerminal = terminal;
    _viewTerminal.addListener(_scheduleLinkRefresh);
    _pressedLink = null;
    _hoveredLink = null;
    _hoveredLinkSpans = const [];
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
    if (match != null) {
      _lastFindBuffer = next;
      _lastFindAnchor = next.createAnchorFromOffset(location(match));
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
    if (wasFinding) {
      _findOriginBuffer = next;
      _findOriginAtEnd = originAtEnd;
      _findOriginFraction = originFraction;
      if (originRow != null) {
        _findOriginLine = next.createAnchor(0, row(originRow));
      }
      _findRevealPending = true;
      _find = TerminalSearch(
        terminal,
        origin: match == null ? null : location(match),
      )..addListener(_onFindChanged);
      _find!.setQuery(_lastFindQuery, caseSensitive: _lastFindCaseSensitive);
    }
    _followTail = atEnd;
    // Resizes and resyncs are output updates, not requests to enter this pane.
    // Its retained renderer/editor keeps its current focus; a command bar or
    // other control must keep any keyboard ownership it already has.
    _afterTerminalMounted(scrollToEnd: atEnd, claimFocus: false);
  }

  /// Typing in the composer focuses the tile, exactly like clicking into the terminal does.
  void _handleComposerFocusChange() {
    if (_composerFocus.hasFocus) widget.onRendererFocus?.call();
  }

  void _handleFocusChange() {
    _syncCursorBlink();
    if (_focusNode.hasFocus) {
      widget.onRendererFocus?.call();
    }
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
    if (_find != null) {
      final bar = _findBarKey.currentState;
      if (bar == null) return false;
      bar.focusSearch(selectAll: false);
      return true;
    }
    // On a remote pane the box gets the caret, not the terminal. Landing in the terminal would
    // hand the user the per-keystroke path by default — the exact cost the box exists to avoid.
    // Except while the pane has lost control: the box is being disabled (it
    // may still hold focus this frame, and drops it on the next) and the
    // terminal is where ⏎ takes control back (see [_onTerminalKey]), so the
    // keyboard is moved there rather than left to fall to the route.
    if (_composerFocus.hasFocus && !_inputBlocked) return true;
    if (_showsComposer && !widget.readOnly && !_inputBlocked) {
      if (widget.session.acceptsInput && _composerFocus.canRequestFocus) {
        _composerFocus.requestFocus();
        return true;
      }
      _composerFocusPending = true;
      return false;
    }
    view.requestKeyboard();
    return true;
  }

  /// Whether pulling focus into the terminal would take it from nobody: the
  /// keyboard is already in this pane (terminal or composer) or has fallen
  /// back to a scope with no field under it.
  bool get _keyboardIsOursOrIdle {
    final primary = FocusManager.instance.primaryFocus;
    return primary == null ||
        primary is FocusScopeNode ||
        identical(primary, _focusNode) ||
        identical(primary, _composerFocus);
  }

  /// Another client took the stream ([TerminalSessionStatus.takenOver]) and
  /// only a person can take it back. That state alone: `closed`/`error` are
  /// usually a beat long — the app reattaches them itself
  /// (`_paneNeedsAttach`) — and a band that flashes up for those frames is
  /// noise, where a taken-over pane stays taken over until somebody acts.
  /// Never a pane-level [TerminalPanel.notice] (offline, unlinked — nothing
  /// here would help) and never a shared read-only view.
  bool get _inputBlocked =>
      !widget.readOnly &&
      widget.notice == null &&
      // A watcher is the same situation seen from the other side: this window
      // has the output but another client has the terminal, and the band's
      // button is how a person here asks for it.
      (widget.session.watching ||
          widget.session.status == TerminalSessionStatus.takenOver);

  /// Retakes the stream, the same path as the header chip: `selectAgent` on a
  /// dead pane is `reopen()`, and a repeat while it is already `opening` only
  /// re-focuses the tile, so a held ⏎ sends one `terminal_open`.
  ///
  /// Every caller is a person acting on this app (⏎, the band's button, the
  /// header chip, [_autoTakeControl]), so every other tile the same client
  /// took comes back with this one — one gesture, the whole app.
  Future<void> _takeControl() async {
    final session = widget.session;
    if (_inputBlocked && !_retakingControl) {
      setState(() => _retakingControl = true);
    }
    unawaited(widget.notifier.retakeTakenOverPanes());
    await widget.notifier.selectAgent(session.machineId, session.agentId);
    // `selectAgent` declines quietly when the pane cannot be attached (machine
    // gone offline meanwhile, agent withdrawn). No status change means no
    // listener call, so the flag is taken back here rather than left armed
    // for an `opening` this pane never asked for.
    if (mounted &&
        _retakingControl &&
        identical(widget.session, session) &&
        session.status != TerminalSessionStatus.opening) {
      setState(() => _retakingControl = false);
    }
  }

  /// A person came back to this app, at this pane. Every stream another
  /// client took from the app comes back — this tile through its own path
  /// (which keeps its band up as "Taking control…"), the rest through
  /// `retakeTakenOverPanes` — whether or not THIS tile was one of them: a
  /// click into a pane that is working fine is still the person being here.
  /// The band stays for what this cannot cover (an attach the daemon declines).
  ///
  /// ⚠️ Only ever from a USER gesture — a click, a key that focused the tile, a
  /// tab switched to, the window brought to the front — never from a session
  /// or focus-node callback. Those fire on BOTH ends of a takeover: this app's
  /// pane pulls the keyboard into its terminal the moment it loses the stream
  /// (`_onSessionChanged`), and a retake on that would have two apps trading
  /// the one stream forever.
  void _autoTakeControl() {
    if (!mounted || !widget.visible) return;
    if (_inputBlocked) {
      unawaited(_takeControl());
    } else {
      unawaited(widget.notifier.retakeTakenOverPanes());
    }
  }

  /// [_autoTakeControl] from `didUpdateWidget`, which runs inside the build:
  /// a reopen notifies the session's listeners at once, and a `setState` from
  /// there is the "called during build" error the crash log was full of.
  /// Deferred one frame, the retake lands on a built tree.
  void _autoTakeControlAfterBuild() {
    final session = widget.session;
    final request = widget.focusRequest;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          !widget.focused ||
          !widget.focusByUser ||
          widget.focusRequest != request ||
          !identical(widget.session, session)) {
        return;
      }
      _autoTakeControl();
    });
  }

  /// A keystroke was typed into a pane that cannot take it. Flash the banner
  /// and say so for a moment, rather than letting the key vanish in silence.
  void _nudgeControlBanner() {
    if (!mounted) return;
    _controlNudgeTimer?.cancel();
    _controlNudgeTimer = Timer(const Duration(seconds: 2), () {
      _controlNudgeTimer = null;
      if (mounted) setState(() => _controlNudged = false);
    });
    setState(() {
      _controlNudged = true;
      _controlNudge++;
    });
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
    final findEnabled =
        mounted &&
        widget.visible &&
        (_tickerMode?.value.enabled ?? false) &&
        (lifecycle == null || lifecycle == AppLifecycleState.resumed);
    _find?.setEnabled(findEnabled);
    if (!findEnabled) _clearFindHighlight();
    final enabled =
        mounted &&
        widget.visible &&
        !widget.readOnly &&
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

  void _afterTerminalMounted({
    bool clearSelection = false,
    bool scrollToEnd = true,
    bool claimFocus = true,
    int retries = 2,
  }) {
    // Request alignment before this frame's layout, so even a retained pane's
    // first visible paint uses its new size. Keep Find's explicit location.
    if (scrollToEnd && _find == null) {
      _cancelDialInertia();
      _followTail = true;
      _laidOutTerminalView()?.scrollToBottom();
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !widget.visible) return;
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
      if (scrollToEnd && _followTail && _find == null) {
        view.scrollToBottom();
      }
      // Never over the composer: a rebuild that re-focuses this tile while someone is typing into
      // the box would pull the caret out from under them mid-sentence.
      if (claimFocus) _claimFocus(view);
      if (_find != null) _onFindChanged();
      if (_linkPointerPosition != null) _hoverLink(_linkPointerPosition);
    });
  }

  @override
  void find(TerminalFindAction action) {
    if (!mounted || !widget.visible || !widget.focused) return;
    final wasClosed = _find == null;
    if (wasClosed) {
      final view = _laidOutTerminalView();
      if (view == null || !_scrollController.hasClients) return;
      final position = _scrollController.position;
      final height = view.renderTerminal.lineHeight;
      final row = (position.pixels / height).floor().clamp(
        0,
        _viewTerminal.buffer.lines.length - 1,
      );
      _findOriginBuffer = _viewTerminal.buffer;
      _findOriginLine = _findOriginBuffer!.createAnchor(0, row);
      _findOriginFraction = position.pixels / height - row;
      _findOriginAtEnd = position.maxScrollExtent - position.pixels < 1;
      var origin = CellOffset(0, row);
      if (action != TerminalFindAction.open &&
          _lastFindAnchor?.attached == true &&
          identical(_lastFindBuffer, _viewTerminal.buffer)) {
        final last = _lastFindAnchor!.offset;
        origin = CellOffset(
          last.x + (action == TerminalFindAction.next ? 1 : 0),
          last.y,
        );
      }
      _find = TerminalSearch(_viewTerminal, origin: origin)
        ..addListener(_onFindChanged);
      _findRevealPending = true;
      _find!.setQuery(_lastFindQuery, caseSensitive: _lastFindCaseSensitive);
      _findBarKey.currentState?.focusSearch(search: _find);
      setState(() {});
    } else if (action == TerminalFindAction.open) {
      _findBarKey.currentState?.focusSearch();
    }
    if (action != TerminalFindAction.open &&
        !(wasClosed && action == TerminalFindAction.next)) {
      _stepFind(action == TerminalFindAction.next ? 1 : -1);
    }
  }

  void _queryFind(String query, bool caseSensitive) {
    _lastFindQuery = query;
    _lastFindCaseSensitive = caseSensitive;
    _findRevealPending = true;
    _find?.setQuery(query, caseSensitive: caseSensitive);
  }

  void _stepFind(int delta) {
    _findRevealPending = true;
    _find?.step(delta);
  }

  void _onFindChanged() {
    final search = _find;
    if (!mounted || search == null || !widget.visible) return;
    final range = search.match;
    if (range != _findPaintedRange ||
        !identical(_findPaintedBuffer, _viewTerminal.buffer)) {
      _clearFindHighlight();
      if (range != null) {
        _findPaintedBuffer = _viewTerminal.buffer;
        _findPaintedRange = range;
        _findHighlight = _controller.highlight(
          p1: _viewTerminal.buffer.createAnchorFromOffset(range.begin),
          p2: _viewTerminal.buffer.createAnchorFromOffset(range.end),
          color: const Color(0x99cf8e25),
        );
      }
    }
    if (_findRevealPending && search.hasSnapshot && range != null) {
      final render = _laidOutTerminalView()?.renderTerminal;
      if (render == null || !_scrollController.hasClients) return;
      _findRevealPending = false;
      final position = _scrollController.position;
      final top = range.begin.y * render.lineHeight + 10;
      final bottom = (range.end.y + 1) * render.lineHeight + 10;
      final safeTop = position.pixels + 10;
      final safeBottom = position.pixels + position.viewportDimension - 10;
      final offset = top < safeTop
          ? top - 10
          : bottom > safeBottom
          ? bottom - position.viewportDimension + 10
          : position.pixels;
      final target = offset.clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      );
      if (target != position.pixels) position.jumpTo(target);
    }
  }

  void _clearFindHighlight() {
    final highlight = _findHighlight;
    _findHighlight = null;
    _findPaintedBuffer = null;
    _findPaintedRange = null;
    if (highlight == null) return;
    highlight.dispose();
    highlight.p1.dispose();
    highlight.p2.dispose();
  }

  void _clearLastFind() {
    _lastFindAnchor?.dispose();
    _lastFindAnchor = null;
    _lastFindBuffer = null;
  }

  void _closeFind({
    bool restore = true,
    bool focus = true,
    bool rebuild = true,
    bool releaseFocus = true,
  }) {
    final search = _find;
    if (search == null) return;
    final match = search.match;
    if (match != null) {
      _clearLastFind();
      _lastFindAnchor = _viewTerminal.buffer.createAnchorFromOffset(
        match.begin,
      );
      _lastFindBuffer = _viewTerminal.buffer;
    }
    _find = null;
    if (releaseFocus) _findBarKey.currentState?.releaseSearchFocus();
    search.removeListener(_onFindChanged);
    search.dispose();
    _clearFindHighlight();
    if (restore &&
        identical(_findOriginBuffer, _viewTerminal.buffer) &&
        _scrollController.hasClients) {
      final height = _laidOutTerminalView()?.renderTerminal.lineHeight;
      final position = _scrollController.position;
      if (height != null) {
        final offset = _findOriginAtEnd
            ? position.maxScrollExtent
            : _findOriginLine?.attached == true
            ? (_findOriginLine!.y + _findOriginFraction) * height
            : 0.0;
        position.jumpTo(
          offset.clamp(position.minScrollExtent, position.maxScrollExtent),
        );
      }
    }
    _findOriginLine?.dispose();
    _findOriginLine = null;
    _findOriginBuffer = null;
    if (rebuild && mounted) setState(() {});
    if (focus) {
      // The retained terminal is already mounted. Return its input connection
      // now: the next key can arrive before Find's removal is painted.
      final view = _laidOutTerminalView();
      if (view != null) {
        _claimFocus(view);
      } else {
        _claimFocusAfterFrame();
      }
    }
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
  /// clipboard than this one — see `MachineState.isLocalMachine`.
  Future<void> _paste() async {
    final target = widget.session;
    final streamId = target.streamId;
    bool stillOwnsPaste() =>
        mounted &&
        identical(widget.session, target) &&
        !widget.readOnly &&
        target.acceptsInput &&
        target.streamId == streamId;
    if (!stillOwnsPaste()) return;

    ClipboardData? data;
    try {
      data = await Clipboard.getData(Clipboard.kTextPlain);
    } on PlatformException {
      if (mounted && stillOwnsPaste()) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(
            content: Text('Could not read the clipboard. Try Paste again.'),
          ),
        );
      }
      return;
    }
    // Reading the clipboard crosses a platform boundary. The pane may have
    // changed agents, become read only, closed, or reconnected in that time.
    if (!stillOwnsPaste()) return;
    final text = data?.text;
    if (text != null && text.isNotEmpty) {
      final machine = widget.notifier.stateOf(target.machineId);
      _controller.clearSelection();
      if (machine != null && machine.terminalPasteRawAvailable) {
        await target.pasteText(text);
      } else {
        target.terminal.paste(text);
      }
      return;
    }
    // An empty clipboard has no input for a shell. Ctrl-V there means
    // quoted-insert, so the agent image-paste fallback would change its mode.
    if (isTerminalEngine(target.engineId)) return;
    final machine = widget.notifier.stateOf(target.machineId);
    if (machine != null &&
        !machine.isLocalMachine &&
        machine.terminalImagePasteAvailable) {
      final imageBytes = await NativeClipboard.readImagePng();
      if (!stillOwnsPaste()) return;
      if (imageBytes != null &&
          imageBytes.isNotEmpty &&
          imageBytes.length <= terminalLocalImagePasteMaxPayloadBytes) {
        await target.pasteImage(imageBytes);
        return;
      }
    }
    target.terminal.keyInput(TerminalKey.keyV, ctrl: true);
  }

  /// ⌘⌫ — kill back to the start of the line, the way a macOS text field does it.
  ///
  /// The pty has no Command key. What a prompt understands is readline's ^U (`\x15`), and it means
  /// the same thing: verified against a live Claude Code and Codex, it clears back to the start of
  /// the CURRENT line and leaves the lines composed above it standing — which is exactly what ⌘⌫
  /// does in a Mac field. Asked of the keytab as `^U` rather than written as a byte so a terminal
  /// carrying its own handler still answers with whatever ^U means to it.
  ///
  /// Taken HERE, in the pane's own hook, and not in the input handler with ⌥⌫: a ⌘ chord never
  /// reaches `keyInput` at all. xterm hands every one of them back to the app untouched (patch 3 in
  /// `third_party/xterm/README.autonomous.md`) — and `TerminalKeyboardEvent` has no `meta` field to
  /// answer it with even if it did. Nothing in `app_shortcuts.dart` claims ⌘⌫ either, so the chord
  /// went up the focus chain and off the end of it, doing nothing.
  ///
  /// Apple only. Elsewhere ⌘ is Super, where killing a line is not what it means, and the app's own
  /// Super chords have to keep reaching the app.
  KeyEventResult _onDeleteToLineStart() {
    final keyboard = HardwareKeyboard.instance;
    final apple =
        defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.iOS;
    if (!apple || !keyboard.isMetaPressed) return KeyEventResult.ignored;
    // ⌃ and ⌥ each carry a kill of their own to the pty (^U and Meta+⌫); a chord mixing them with
    // ⌘ is nobody's idea of this one, so it is left for the shell to make sense of.
    if (keyboard.isControlPressed || keyboard.isAltPressed) {
      return KeyEventResult.ignored;
    }
    if (widget.readOnly || !widget.session.acceptsInput) {
      return KeyEventResult.ignored;
    }
    widget.session.terminal.keyInput(TerminalKey.keyU, ctrl: true);
    return KeyEventResult.handled;
  }

  /// ⌘V (Ctrl+V off Apple) — taken from xterm so the fallthrough above applies. ⌘⌫ joins it here,
  /// for the reason spelled out on [_onDeleteToLineStart].
  ///
  /// xterm binds paste itself, but only ever to its text-only action. `onKeyEvent`
  /// is the one hook that runs BEFORE its shortcut map (terminal_view.dart), so
  /// this is where the binding has to be replaced rather than added. The chord taken is the
  /// platform's exact one: Linux reserves Ctrl-V for the terminal program and pastes with
  /// Ctrl-Shift-V.
  KeyEventResult _onTerminalKey(FocusNode node, KeyEvent event) {
    final keyboard = HardwareKeyboard.instance;
    // A pane that lost control still gets the keys (xterm's read-only mode
    // keeps the focus node, it only stops opening an input connection), and
    // dropping them silently is how people sit typing into a frozen pane. ⏎
    // takes control back; any other plain key nudges the banner that says so.
    // ⌘/⌃ chords are left alone: they are the app's and the pane's shortcuts.
    if (event is KeyDownEvent &&
        _inputBlocked &&
        !keyboard.isMetaPressed &&
        !keyboard.isControlPressed) {
      if (event.logicalKey == LogicalKeyboardKey.enter ||
          event.logicalKey == LogicalKeyboardKey.numpadEnter) {
        unawaited(_takeControl());
        return KeyEventResult.handled;
      }
      if (_isTypingKey(event)) {
        _nudgeControlBanner();
        return KeyEventResult.ignored;
      }
    }
    // A held ⌘⌫ repeats, the way a held Backspace does — unlike ⌘V, where a second paste is never
    // what the finger that stayed down meant.
    if ((event is KeyDownEvent || event is KeyRepeatEvent) &&
        event.logicalKey == LogicalKeyboardKey.backspace) {
      return _onDeleteToLineStart();
    }
    if (event is! KeyDownEvent || event.logicalKey != LogicalKeyboardKey.keyV) {
      return KeyEventResult.ignored;
    }
    if (keyboard.isAltPressed) return KeyEventResult.ignored;
    final apple =
        defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.iOS;
    final pasting = apple
        ? keyboard.isMetaPressed &&
              !keyboard.isControlPressed &&
              !keyboard.isShiftPressed
        : keyboard.isControlPressed &&
              !keyboard.isMetaPressed &&
              keyboard.isShiftPressed ==
                  (defaultTargetPlatform == TargetPlatform.linux);
    if (!pasting) return KeyEventResult.ignored;
    unawaited(_paste());
    return KeyEventResult.handled;
  }

  /// A key that would have put something into the terminal: a character, or
  /// one of the editing/navigation keys a prompt answers. Not a bare modifier
  /// or a function key, which nobody expects to echo.
  static bool _isTypingKey(KeyEvent event) {
    final character = event.character;
    if (character != null && character.isNotEmpty) return true;
    return _editingKeys.contains(event.logicalKey);
  }

  // Not const: LogicalKeyboardKey overrides `==`, which a const set refuses.
  static final Set<LogicalKeyboardKey> _editingKeys = {
    LogicalKeyboardKey.backspace,
    LogicalKeyboardKey.delete,
    LogicalKeyboardKey.tab,
    LogicalKeyboardKey.escape,
    LogicalKeyboardKey.space,
    LogicalKeyboardKey.arrowUp,
    LogicalKeyboardKey.arrowDown,
    LogicalKeyboardKey.arrowLeft,
    LogicalKeyboardKey.arrowRight,
  };

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
      setState(() {}); // Refresh the cursor even when the mouse has not moved.
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
    } else {
      keyboard.removeHandler(_onLinkModifierChanged);
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
  }

  void _onScrollChanged() {
    _rememberFollowTail();
    _scheduleLinkRefresh();
  }

  CellOffset? _cellAtPointer(Offset globalPosition) {
    final view = _laidOutTerminalView();
    if (view == null) return null;
    final render = view.renderTerminal;
    final local = render.globalToLocal(globalPosition);
    if (!(Offset.zero & render.size).contains(local)) return null;
    return render.getCellOffset(local);
  }

  /// Puts the link tooltip under the link itself (over it near the bottom
  /// edge). The tooltip wraps the whole pane, so Flutter's default would
  /// centre it on the pane, however far that is from the pointer.
  Offset _linkTooltipPosition(TooltipPositionContext context) {
    final anchor = _hoveredLinkAnchor;
    return positionDependentBox(
      size: context.overlaySize,
      childSize: context.tooltipSize,
      target: anchor?.center ?? context.target,
      verticalOffset: anchor == null
          ? context.verticalOffset
          : anchor.height / 2 + 4,
      preferBelow: context.preferBelow,
    );
  }

  /// The global rect of the hovered link's last row. Measured on hover, as
  /// the tooltip positions itself mid-layout, when nothing may be measured.
  Rect? _linkAnchor(List<TerminalLinkSpan> spans) {
    final render = _laidOutTerminalView()?.renderTerminal;
    if (render == null || !render.attached || spans.isEmpty) return null;
    final last = spans.last;
    final cell = render.cellSize;
    return render.localToGlobal(
          render.getOffset(CellOffset(last.start, last.row)),
        ) &
        Size((last.end - last.start + 1) * cell.width, cell.height);
  }

  String? _linkAtPointer(Offset globalPosition) {
    final cell = _cellAtPointer(globalPosition);
    return cell == null ? null : terminalLinkAt(_viewTerminal, cell);
  }

  void _hoverLink(Offset? globalPosition) {
    _linkPointerPosition = widget.visible ? globalPosition : null;
    final cell = _linkPointerPosition == null
        ? null
        : _cellAtPointer(_linkPointerPosition!);
    final target = cell == null ? null : terminalLinkAt(_viewTerminal, cell);
    _observeLinkModifiers(target != null);
    // Walking the link's extent costs a lookup per cell, so it runs when the
    // pointer reaches a new link, not on every move along the same one.
    final onSpans =
        cell != null &&
        _hoveredLinkSpans.any(
          (s) => s.row == cell.y && s.start <= cell.x && cell.x <= s.end,
        );
    if (target == _hoveredLink && (target == null || onSpans)) {
      _hoveredLinkAnchor = _linkAnchor(_hoveredLinkSpans); // it may scroll
      return;
    }
    setState(() {
      _hoveredLink = target;
      _hoveredLinkSpans = target == null
          ? const []
          : terminalLinkSpans(_viewTerminal, cell!, target);
      _hoveredLinkAnchor = _linkAnchor(_hoveredLinkSpans);
    });
  }

  bool _onLinkTapDown(TapDownDetails details, CellOffset cell) {
    _pressedLink = _linkModifierPressed
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
        !_linkModifierPressed ||
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
        isLocalMachine:
            notifier.stateOf(session.machineId)?.isLocalMachine == true,
        isCancelled: () =>
            cancellation.isCancelled ||
            !mounted ||
            !identical(session, widget.session),
        downloadRemote: (path) async {
          setState(
            () => _previewProgress = const RemoteMediaProgress('', 0, null),
          );
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
                setState(() => _previewProgress = progress);
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
        if (mounted) setState(() => _previewProgress = null);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final session = widget.session;
    _syncTerminal(session.terminal);
    _builtStatus = session.status;
    final machineState = widget.notifier.stateOf(session.machineId);
    final remote = machineState != null && !machineState.isLocalMachine;
    final showComposer = _showsComposer;
    return KeymapRegion(
      contextKind: KeymapContext.terminal,
      composing: () =>
          _focusNode.hasFocus &&
          _terminalViewKey.currentState?.isComposing == true,
      child: ColoredBox(
        color: grid.AppPalette.windowBg,
        child: Column(
          children: [
            if (widget.showHeader)
              Stack(
                children: [
                  Visibility(
                    visible: _find == null,
                    maintainSize: true,
                    maintainAnimation: true,
                    maintainState: true,
                    child: _buildHeader(context),
                  ),
                  // Attach the focused pane's input before Find is requested.
                  // Hidden/unfocused panes need no dormant editor or index.
                  if (_find != null || (widget.visible && widget.focused))
                    Positioned.fill(
                      child: Offstage(
                        offstage: _find == null,
                        child: LayoutBuilder(
                          builder: (context, constraints) => Row(
                            children: [
                              if (constraints.maxWidth > 520)
                                Expanded(
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: _stripPadding,
                                    ),
                                    child: Text(
                                      session.agentName,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: grid.AppType.monoLabel(
                                        color: Colors.white70,
                                        fontWeight: FontWeight.w400,
                                      ),
                                    ),
                                  ),
                                )
                              else
                                const Spacer(),
                              SizedBox(
                                width: math.min(constraints.maxWidth, 380),

                                child: Padding(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 6,
                                    vertical: 4,
                                  ),
                                  child: TerminalFindBar(
                                    key: _findBarKey,
                                    search: _find,
                                    initialQuery: _lastFindQuery,
                                    initialCaseSensitive:
                                        _lastFindCaseSensitive,
                                    readOnly:
                                        widget.readOnly ||
                                        !session.acceptsInput,
                                    onQuery: _queryFind,
                                    onStep: _stepFind,
                                    onClose: _closeFind,
                                    onFocus: () =>
                                        widget.onRendererFocus?.call(),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              ),

            // Goes with the row above it: the phone draws its own rule under
            // [PhoneHeader], and keeping this one would stack two.
            if (widget.showHeader) Divider(height: 1, color: AppColors.border),
            ?_modelNote(),
            Expanded(
              // Any press into the pane's body — the terminal, the band, its
              // scrollbar; not the header, which is chrome — is the person
              // coming back to it, and takes the stream back when it was
              // taken. Translucent: the press still reaches what it landed on.
              child: Listener(
                behavior: HitTestBehavior.translucent,
                onPointerDown: (_) => _autoTakeControl(),
                child: Stack(
                  children: [
                    Positioned.fill(
                      child: MouseRegion(
                        onEnter: (event) => _hoverLink(event.position),
                        onHover: (event) => _hoverLink(event.position),
                        onExit: (_) => _hoverLink(null),
                        child: Tooltip(
                          // With the address: an OSC 8 label such as `!125`
                          // does not say where it leads.
                          message: _hoveredLink == null
                              ? ''
                              : '${defaultTargetPlatform == TargetPlatform.macOS ? '⌘' : 'Ctrl'}-click to open\n$_hoveredLink',
                          positionDelegate: _linkTooltipPosition,
                          child: CustomPaint(
                            key: _linkUnderlineKey,
                            foregroundPainter: _LinkUnderlinePainter(
                              spans: _hoveredLinkSpans,
                              source: session.terminal,
                              terminal: _laidOutTerminalView,
                              host: () =>
                                  _linkUnderlineKey.currentContext
                                          ?.findRenderObject()
                                      as RenderBox?,
                              repaint: _scrollController,
                            ),
                            child: TerminalView(
                              session.terminal,
                              key: _terminalViewKey,
                              controller: _controller,
                              autoResize: widget.visible && !session.readOnly,
                              resizeBuffer: false,
                              renderingEnabled: widget.visible,
                              outputRepaintInterval:
                                  widget.outputRepaintInterval,
                              scrollController: _scrollController,
                              focusNode: _focusNode,
                              autofocus: widget.focused && !showComposer,
                              readOnly:
                                  widget.readOnly || !session.acceptsInput,
                              theme: terminalThemeFor(
                                grid.AppTheme.palette.value,
                                terminalThemeStore.value,
                              ),
                              padding: const EdgeInsets.all(10),
                              textStyle: terminalFontStore.value,
                              // The chosen point size already sizes each terminal cell.
                              // Applying the OS text scale again would change rows/cols
                              // and resize the remote terminal unexpectedly.
                              textScaler: TextScaler.noScaling,
                              onKeyEvent: _onTerminalKey,
                              onTapDown: _onLinkTapDown,
                              onTapUp: _onLinkTapUp,
                              mouseCursor:
                                  _hoveredLink != null && _linkModifierPressed
                                  ? SystemMouseCursors.click
                                  // An I-beam invites typing; a blocked pane does not.
                                  : _inputBlocked
                                  ? SystemMouseCursors.basic
                                  : SystemMouseCursors.text,
                              onSecondaryTapDown: (_, _) => _copyOrPaste(),

                              onAltBufferScroll: session.scrollViaTmuxCopyMode
                                  ? (up) => session.sendScrollCommand(up, 1)
                                  : null,
                            ),
                          ),
                        ),
                      ),
                    ),
                    // Keep the control notice beside the work. This band covers the
                    // frozen output itself, where the eyes already are, and
                    // stays through `opening` so the pane does not jump when
                    // it is answered.
                    //
                    // It also carries a pane-level notice that has something to
                    // DO about itself (a failed start offering Check again or
                    // Restart). One strip, never two: a noticed pane is already
                    // excluded from `_inputBlocked` — nothing the takeover band
                    // offers would help a pane whose machine or launch is the
                    // problem — so these two conditions cannot both hold.
                    if (_inputBlocked ||
                        (_retakingControl &&
                            session.status == TerminalSessionStatus.opening))
                      Positioned(
                        top: 0,
                        left: 0,
                        right: 0,
                        child: _ControlBanner(
                          busy: !_inputBlocked,
                          nudged: _controlNudged,
                          nudge: _controlNudge,
                          takerName: session.takenOverBy?.label(
                            (id) => widget.notifier
                                .stateOf(id)
                                ?.machine
                                .displayName,
                          ),
                          onTakeControl: _inputBlocked
                              ? () => unawaited(_takeControl())
                              : null,
                        ),
                      )
                    else if (widget.notice case final notice?
                        when notice.banner && notice.onAction != null)
                      Positioned(
                        top: 0,
                        left: 0,
                        right: 0,
                        child: _ControlBanner.notice(notice),
                      ),
                    if (session.uploadProgress != null ||
                        _previewProgress != null)
                      Positioned(
                        left: 14,
                        right: 14,
                        bottom: 12,
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (session.uploadProgress != null)
                              _TransferProgressBadge(
                                label:
                                    'Uploading ${session.uploadProgress!.label}',
                                fraction: session.uploadProgress!.percent,
                                onCancel: () =>
                                    unawaited(session.cancelUpload()),
                              ),
                            if (session.uploadProgress != null &&
                                _previewProgress != null)
                              const SizedBox(height: 8),
                            if (_previewProgress != null)
                              _TransferProgressBadge(
                                label: _previewProgress!.totalBytes == null
                                    ? 'Preparing preview…'
                                    : 'Downloading ${_previewProgress!.filename}',
                                fraction: _previewProgress!.fraction,
                                onCancel: () => _previewCancellation?.cancel(),
                              ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
            // The grip is shown whether or not the box is: collapsed, it is the only way back.
            if (!widget.compactHeader &&
                remote &&
                widget.onToggleComposer != null)
              ComposerGrip(
                expanded: widget.composerVisible,
                onPressed: widget.onToggleComposer!,
              ),
            if (showComposer)
              TerminalComposer(
                session: session,
                focusNode: _composerFocus,
                inputEnabled: !widget.readOnly,
              ),
          ],
        ),
      ),
    );
  }

  /// This agent's model note (`grid.note`), or null when nothing is wrong. Read from the app's
  /// agents, which the pane grid rebuilds this panel on.
  GridNote? _gridNote() => widget.notifier
      .stateOf(widget.session.machineId)
      ?.agents
      .where((agent) => agent.id == widget.session.agentId)
      .firstOrNull
      ?.gridNote;

  /// The note taking or giving back its line resizes the terminal, so the pane re-measures then,
  /// as it does when the composer comes or goes.
  void _syncNoteLine() {
    final noted = _gridNote() != null;
    if (noted == _noted) return;
    _noted = noted;
    _afterTerminalMounted(claimFocus: false, scrollToEnd: false);
  }

  /// The note under the header while the daemon says this agent's model will not answer, or null.
  ///
  /// In flow rather than over the output, like the composer: a note can stand for hours, and a
  /// band that long over the top rows would hide what the agent last said. "Pick another" is
  /// offered only where the header has a picker to open.
  Widget? _modelNote() {
    final note = _gridNote();
    if (note == null) return null;
    final hasPicker =
        widget.showHeader &&
        !widget.readOnly &&
        modelPickerSupports(widget.session.engineId);
    return PaneModelNote(
      note: note,
      onPickAnother: hasPicker ? _pickerController.open : null,
    );
  }

  /// Visibility and focus affect the renderer, not its title and controls.
  /// Retain that subtree until its presentation changes. Callback wrappers
  /// resolve the current widget so cached controls never retain an old action.
  Widget _buildHeader(BuildContext context) {
    final session = widget.session;
    final machine = widget.notifier.stateOf(session.machineId);
    final agent = machine?.agents
        .where((a) => a.id == session.agentId)
        .firstOrNull;
    final presentation = (
      theme: Theme.of(context),
      brightness: grid.AppTheme.brightness.value,
      fontFamily: AppFonts.sans,
      terminalFont: terminalFontStore.value,
      notifier: widget.notifier,
      session: session,
      name: session.agentName,
      status: session.status,
      notice: widget.notice,
      readOnly: widget.readOnly,
      error: session.errorMessage ?? session.errorCode,
      link: session.linkMode,
      machine: machine?.machine,
      local: machine?.isLocalMachine,
      agent: agent,
      // Named on its own even though `agent` is already here: an Agent has no
      // equality, so a frame that changed nothing but the verdict must still
      // be seen as a change by the one field that can say so.
      verdict: agent?.verdict,
      project: agent == null ? null : machine?.projectOf(agent),
      compact: widget.compactHeader,
      close: widget.onClose != null,
      delete: widget.onDelete != null,
      composer: widget.composerVisible,
      toggleComposer: widget.onToggleComposer != null,
      zoomed: widget.zoomed,
      zoom: widget.onToggleZoom != null,
      dragId: widget.paneDrag?.ref.paneId,
      dragSize: widget.paneDrag?.size,
      starting: _startPhase,
    );
    if (_headerPresentation != presentation) {
      _headerPresentation = presentation;
      _header = _TerminalHeader(
        notifier: widget.notifier,
        session: session,
        notice: widget.notice,
        readOnly: widget.readOnly,
        compact: widget.compactHeader,
        zoomed: widget.zoomed,
        onToggleZoom: widget.onToggleZoom == null
            ? null
            : () => widget.onToggleZoom?.call(),
        onClose: widget.onClose == null ? null : () => widget.onClose?.call(),
        onDelete: widget.onDelete == null
            ? null
            : () => widget.onDelete?.call(),
        onReconnect: () => unawaited(_takeControl()),
        paneDrag: widget.paneDrag,
        starting: _startPhase,
        pickerController: _pickerController,
      );
    }
    return _header!;
  }
}

class _TerminalHeader extends StatelessWidget {
  final AppNotifier notifier;
  final TerminalSession session;
  final TerminalNotice? notice;
  final bool readOnly;
  final VoidCallback? onClose;

  /// Ends the agent (with a confirmation), as the rail's row menu does. Null
  /// where the pane cannot name a live agent to end.
  final VoidCallback? onDelete;

  /// Retakes a dead or taken-over stream — the panel's `_takeControl`, so the
  /// chip and the in-pane band drive one path.
  final VoidCallback onReconnect;
  final bool compact;
  final VoidCallback? onToggleZoom;
  final bool zoomed;

  /// This strip's drag gesture, or null when there is nothing to drag.
  ///
  /// Null with a SINGLE pane, and then the strip is inert on purpose: there is
  /// no other tile to trade places with, so a drag would have no meaning to
  /// give it. It used to move the WINDOW here (window_manager's
  /// DragToMoveArea, left over from hiding the title bar) — but once AppKit's
  /// `startDragging` takes a gesture it keeps it, so the two meanings cannot
  /// share one drag. The window is moved from HarnessTopBar now.
  final PaneDragHandle? paneDrag;

  /// What the "Starting up…" chip says, or null when this pane is not waiting on a resting model.
  /// Drawn where the status chip goes, and only when there is no status: "Connecting" or
  /// "Reconnect" is the more urgent thing to know.
  final ModelStartPhase? starting;

  /// Opens this pane's model picker from the model note — see [GridModelPicker.controller].
  final GridModelPickerController? pickerController;

  const _TerminalHeader({
    required this.notifier,
    required this.session,
    this.notice,
    this.readOnly = false,
    this.onClose,
    this.onDelete,
    required this.onReconnect,
    this.compact = false,
    this.onToggleZoom,
    this.zoomed = false,
    this.paneDrag,
    this.starting,
    this.pickerController,
  });

  @override
  Widget build(BuildContext context) =>
      MediaQuery.withNoTextScaling(child: Builder(builder: _buildHeader));

  Widget _buildHeader(BuildContext context) {
    TerminalFontScope.watch(context);
    final titleStyle = workspaceBarTextStyle(
      color: terminalThemeFor(
        grid.AppTheme.palette.value,
        terminalThemeStore.value,
      ).foreground,
    );
    final color = switch (session.status) {
      TerminalSessionStatus.controlling => AppColors.success,
      TerminalSessionStatus.opening ||
      TerminalSessionStatus.resyncing => AppColors.warning,
      TerminalSessionStatus.takenOver => AppColors.warning,
      TerminalSessionStatus.error => AppColors.danger,
      TerminalSessionStatus.closed => AppColors.mutedStrong,
    };
    final profile = notifier
        .stateOf(session.machineId)
        ?.agents
        .where((agent) => agent.id == session.agentId)
        .firstOrNull
        ?.codexHome;
    final taker = session.takenOverBy?.label(
      (id) => notifier.stateOf(id)?.machine.displayName,
    );
    final status =
        notice ??
        switch (session.status) {
          TerminalSessionStatus.controlling => null,
          TerminalSessionStatus.opening => terminalNotice(
            label: 'Connecting',
            icon: Icons.sync,
            detail:
                'Connecting to this terminal. Retained output is read only.',
          ),
          TerminalSessionStatus.resyncing => terminalNotice(
            label: 'Restoring',
            icon: Icons.sync,
            detail: 'Restoring this terminal. Retained output is read only.',
          ),
          TerminalSessionStatus.takenOver => terminalNotice(
            label: 'Take control',
            icon: Icons.lock_outline,
            detail:
                'Read only: ${taker ?? 'another app'} controls this terminal. Take control moves input ownership to this app.',
          ),
          TerminalSessionStatus.error ||
          TerminalSessionStatus.closed => terminalNotice(
            label: 'Reconnect',
            icon: Icons.refresh,
            detail:
                session.errorMessage ??
                session.errorCode ??
                'This stream is closed. Retained output is read only.',
          ),
        };
    // A notice that carries its own way out owns the button — a machine that
    // needs linking asks for its password there. Otherwise the button is the
    // session's own reconnect, which a notice has always suppressed.
    final noticeAction = notice?.onAction;
    final canReconnect =
        notice == null &&
        !readOnly &&
        (session.status == TerminalSessionStatus.error ||
            session.status == TerminalSessionStatus.closed ||
            session.status == TerminalSessionStatus.takenOver);
    final statusAction = noticeAction ?? (canReconnect ? onReconnect : null);
    final starting = status == null ? this.starting : null;
    final machine = notifier.stateOf(session.machineId);
    final agent = machine?.agents
        .where((a) => a.id == session.agentId)
        .firstOrNull;
    final project = agent == null ? null : machine?.projectOf(agent);
    final machineName = machine?.machine.displayName ?? session.machineId;
    final identityDetail = [
      session.agentName,
      machineName,
      if (project != null) project.cwd,
      ?project?.branchDetail,
      if (profile != null) 'Codex profile: $profile',
      'Double-click to rename',
    ].join('\n');
    // Reserve space for the pane-local model selector.
    // Engines without a picker keep their existing header width.
    final showModelPicker = !compact && modelPickerSupports(session.engineId);
    // The picker: a model id up to 220px and its padding.
    final pickerWidth = showModelPicker ? 250.0 : 0.0;
    final closeWidth = onClose == null
        ? 0.0
        : workspaceBarCellSizeOf(context).width * 3;
    final actionsWidth = pickerWidth + closeWidth;
    // A fork says so first: "forked from X" is the one fact about this pane
    // that the folder and the branch — shared with its source — cannot tell.
    final forkedFrom = agent?.forkedFrom;
    final header = SizedBox(
      height: compact ? 38 : 46,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: _stripPadding),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final scale = grid.appTextScaleOf(context);
            final narrow = constraints.maxWidth < 560 * math.max(1, scale);
            // Workspace panes show PR state once in the main status bar.
            // Standalone terminals retain their own PR badge.
            final showPr =
                !compact &&
                agent != null &&
                project?.shownBranch != null &&
                constraints.maxWidth >= 360 * math.max(1, scale);
            final badgeWidth = showPr ? (narrow ? 150.0 : 180.0) : 0.0;
            // The room the left side needs: the mark, the whole name as it will be drawn, and
            // the status beside it — capped at 45% so a very long name still leaves the right
            // side most of the header.
            double titleRoom() {
              final name = TextPainter(
                text: TextSpan(text: session.agentName, style: titleStyle),
                textDirection: TextDirection.ltr,
                textScaler: MediaQuery.textScalerOf(context),
                maxLines: 1,
              )..layout();
              final width = name.width;
              name.dispose();
              final statusRoom = status != null
                  ? 120.0
                  : starting != null
                  ? paneStartingChipWidth(
                      starting,
                      MediaQuery.textScalerOf(context),
                    )
                  : 16.0;
              return math.min(
                17 + 10 + width + 8 + statusRoom + 8,
                constraints.maxWidth * .45,
              );
            }

            final desiredRightWidth = narrow
                ? math.max(
                    (showModelPicker ? 96.0 : 0.0) + badgeWidth,
                    constraints.maxWidth * .36,
                  )
                : math.max(
                    actionsWidth + badgeWidth,
                    // Everything the name does not use. A fixed 55% left the folder and branch
                    // shortened to "…" beside a short name with half the header empty.
                    constraints.maxWidth - titleRoom(),
                  );
            // The name/status retain space while model and project text yield.
            final rightWidth = math.min(
              compact ? closeWidth : desiredRightWidth,
              math.max(0.0, constraints.maxWidth - 99),
            );
            return Row(
              children: [
                if (agent != null)
                  EngineMark.forAgent(agent, size: 17)
                else
                  EngineMark(engine: session.engineId, size: 17),
                // Icon and name, the same as every other pane (owner,
                // 2026-09-15): a harness agent is its harness here, and the
                // engine it runs on is the dialog's and the tooltip's to say.
                const SizedBox(width: 10),
                Expanded(
                  child: Row(
                    children: [
                      Flexible(
                        child: Tooltip(
                          message: identityDetail,
                          waitDuration: const Duration(milliseconds: 700),
                          child: GestureDetector(
                            behavior: HitTestBehavior.opaque,
                            onDoubleTap: () => unawaited(
                              showAgentRenameDialog(
                                context,
                                notifier,
                                session.machineId,
                                session.agentId,
                                session.agentName,
                              ),
                            ),
                            child: Text(
                              session.agentName,
                              key: const ValueKey('terminal-pane-title'),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: titleStyle,
                            ),
                          ),
                        ),
                      ),
                      if (status != null || starting != null || !compact)
                        const SizedBox(width: 8),
                      if (status != null && narrow)
                        Tooltip(
                          message: '${status.label}: ${status.detail}',
                          child: IconButton(
                            tooltip: status.actionLabel ?? status.label,
                            onPressed: statusAction,
                            icon: Icon(status.icon, size: 14),
                            style: IconButton.styleFrom(
                              foregroundColor: color,
                              disabledForegroundColor: color,
                              fixedSize: const Size(28, 28),
                              minimumSize: const Size(28, 28),
                              padding: EdgeInsets.zero,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                          ),
                        )
                      else if (status != null)
                        ConstrainedBox(
                          constraints: BoxConstraints(
                            maxWidth: math.max(
                              0,
                              math.min(
                                constraints.maxWidth * .22,
                                constraints.maxWidth - actionsWidth - 110,
                              ),
                            ),
                          ),
                          child: Align(
                            alignment: Alignment.centerLeft,
                            child: Tooltip(
                              message: status.detail,
                              child: TextButton(
                                onPressed: statusAction,
                                style: TextButton.styleFrom(
                                  foregroundColor: color,
                                  disabledForegroundColor: AppColors.textSoft,
                                  minimumSize: Size.zero,
                                  tapTargetSize:
                                      MaterialTapTargetSize.shrinkWrap,
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 6,
                                    vertical: 4,
                                  ),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(status.icon, size: 14),
                                    const SizedBox(width: 6),
                                    Flexible(
                                      child: Text(
                                        // The chip names the STATE; what
                                        // pressing it does is in the tooltip
                                        // and in `actionLabel`. "Link
                                        // required" that can be pressed reads
                                        // better than a bare verb where every
                                        // neighbour is a status.
                                        status.label,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: grid.AppType.monoLabel(
                                          fontWeight: FontWeight.w400,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        )
                      else if (starting != null && narrow)
                        PaneStartingChip(phase: starting, narrow: true)
                      else if (starting != null)
                        // Never wider than the room this row is sure to have: the name's
                        // share (at most 45%) or what the actions and the PR badge leave —
                        // less [_headerFurniture]. Its words shorten rather than push the
                        // row past the header's edge.
                        ConstrainedBox(
                          constraints: BoxConstraints(
                            maxWidth: math.max(
                              0,
                              math.min(
                                constraints.maxWidth * .45 - _headerFurniture,
                                constraints.maxWidth -
                                    actionsWidth -
                                    badgeWidth -
                                    _headerFurniture,
                              ),
                            ),
                          ),
                          child: PaneStartingChip(phase: starting),
                        )
                      else if (!compact)
                        Padding(
                          padding: const EdgeInsets.all(4),
                          child: Icon(Icons.circle, size: 8, color: color),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                // Which of the three paths carries this pane's bytes. Absent for a local machine's own
                // terminal, which has no such distinction and so gets no badge.
                //
                // The wire word and the word a person reads differ for the middle state, deliberately:
                // the CLI sends 'turn' (it is a TURN allocation) but both middle and last are relays to
                // a reader, so they read as "relay" and "ws". 'relay' on the wire kept its original
                // meaning — the backend WebSocket — so an older CLI is never mislabelled.
                if (!compact && !narrow && session.linkMode != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 2),
                    child: _LinkModeMark(mode: session.linkMode!),
                  ),
                ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: rightWidth),
                  child: PaneHeaderActions(
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (showPr)
                          Flexible(
                            child: ConstrainedBox(
                              constraints: BoxConstraints(maxWidth: badgeWidth),
                              child: PullRequestBadge(
                                compact: narrow,
                                identity: (
                                  session.machineId,
                                  agent.id,
                                  project?.cwd,
                                  project?.shownBranch,
                                ),
                                read: () => notifier.readAgentPullRequest(
                                  session.machineId,
                                  agent.id,
                                ),
                              ),
                            ),
                          ),
                        if (onClose != null)
                          PaneCloseButton(onPressed: onClose!),
                      ],
                    ),
                    modelPicker: showModelPicker
                        ? GridModelPicker(
                            key: ValueKey((
                              'pane-model',
                              session.machineId,
                              session.agentId,
                            )),
                            paneHeader: true,
                            enabled: !readOnly && !session.readOnly,
                            compact: narrow,
                            notifier: notifier,
                            machineId: session.machineId,
                            currentModel: agent?.gridModel,
                            subscriptionModel: agent?.modelName,
                            webSearch: agent?.gridWebSearch,
                            engineLabel: session.engineId,
                            controller: pickerController,
                            onSelected: (model) => unawaited(
                              notifier.retargetAgentToGridModel(
                                session.machineId,
                                session.agentId,
                                model.id,
                                gridName: model.grid,
                              ),
                            ),
                            onUseOwnLogin: () => unawaited(
                              notifier.clearAgentGrid(
                                session.machineId,
                                session.agentId,
                              ),
                            ),
                            // Discovery opens the local Models popover. Selection above
                            // continues to target this pane's existing session.
                            onRunLocalModel: () => unawaited(
                              notifier.runLocalModel(
                                context,
                                machineId: session.machineId,
                              ),
                            ),
                          )
                        : null,
                    details: compact || narrow
                        ? null
                        : Tooltip(
                            message: [
                              if (forkedFrom != null)
                                'Forked from ${forkedFrom.name}',
                              if (project != null) project.cwd,
                              ?project?.branchDetail,
                              machineName,
                            ].join('\n'),
                            child: PromptContextView(
                              contextData: PromptContext(
                                // This computer goes without saying.
                                machine: machine?.isLocalMachine == true
                                    ? null
                                    : machineName,
                                // The folder as it was chosen and its repository's branch;
                                // the full working folder is in the tooltip.
                                project: narrow ? null : project?.label,
                                // Not a branch Harness made up that waits for the
                                // session's name, nor a commit an agent checked out.
                                branch: narrow ? null : project?.shownBranch,
                                leading: !narrow && forkedFrom != null
                                    ? 'forked from ${forkedFrom.name}'
                                    : null,
                              ),
                            ),
                          ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
    final strip = PaneHeaderHoverRegion(child: header);
    final handle = paneDrag;
    if (handle == null) return strip;

    return Draggable<PaneDragRef>(
      data: handle.ref,
      // The grip is kept where the hand took it, so the ghost stays under the
      // cursor at the same spot on the header it was picked up by.
      dragAnchorStrategy: childDragAnchorStrategy,
      onDragStarted: () => paneDragging.value = handle.ref,
      onDragEnd: (_) => paneDragging.value = null,
      onDraggableCanceled: (_, _) => paneDragging.value = null,
      feedback: _PaneGhost(session: session, size: handle.size, header: strip),

      // The header itself does NOT change — the whole tile fades instead, in
      // _PaneCell, so what dims is the thing that is moving rather than one
      // strip of it.
      child: strip,
    );
  }
}

/// A domain harness's verdict on the agent's workspace, in one word or one count.
///
/// Green "Ready" is the harness's one machine fact — fab-ready, every gate passed. Red carries the
/// error count, amber the warning count when nothing blocks, grey "Checked" a clean run that the
/// harness still would not call ready. The summary rides in the tooltip; the findings themselves
/// live in the harness's own viewer, which is the pane beside this one.
/// The pane header's transport badge: a compact topology for the path carrying terminal bytes.
///
/// The three shapes describe one hop, an intermediate hop, and a central server respectively. That
/// makes the modes distinguishable without colour while keeping the badge small enough for a four-pane
/// layout. The wire name `relay` still means the backend WebSocket; only its human-facing label is WS.
/// Underlines the link under the pointer, in each span's own text colour —
/// the terminal's cells carry no underline for it, so this paints on top.
class _LinkUnderlinePainter extends CustomPainter {
  _LinkUnderlinePainter({
    required this.spans,
    required this.source,
    required this.terminal,
    required this.host,
    super.repaint,
  });

  final List<TerminalLinkSpan> spans;
  final Terminal source;
  final TerminalViewState? Function() terminal;
  final RenderBox? Function() host;

  @override
  void paint(Canvas canvas, Size size) {
    if (spans.isEmpty) return;
    final render = terminal()?.renderTerminal;
    final box = host();
    if (render == null || box == null || !render.attached) return;
    final lines = source.buffer.lines;
    final cell = render.cellSize;
    final thickness = math.max(1.0, cell.height / 16).roundToDouble();
    final paint = Paint()..strokeWidth = thickness;
    for (final span in spans) {
      if (span.row >= lines.length) continue;
      final from = box.globalToLocal(
        render.localToGlobal(
          render.getOffset(CellOffset(span.start, span.row)),
        ),
      );
      final y = from.dy + cell.height - thickness;
      if (y < 0 || y > size.height) continue;
      paint.color = render.resolveForegroundColor(
        lines[span.row].getForeground(span.start),
      );
      canvas.drawLine(
        Offset(from.dx, y),
        Offset(from.dx + (span.end - span.start + 1) * cell.width, y),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_LinkUnderlinePainter old) => !identical(old.spans, spans);
}

class _LinkModeMark extends StatelessWidget {
  final String mode;

  const _LinkModeMark({required this.mode});

  @override
  Widget build(BuildContext context) {
    final (icon, color, label) = switch (mode) {
      'p2p' => (
        LucideIcons.link2,
        AppColors.success,
        'P2P · Direct peer connection',
      ),
      'turn' => (
        LucideIcons.waypoints,
        AppColors.warning,
        'TURN · Via Cloudflare relay',
      ),
      _ => (
        LucideIcons.server,
        AppColors.mutedStrong,
        'WS · Via Harness WebSocket relay',
      ),
    };
    return Tooltip(
      message: label,
      child: Icon(icon, size: 14, color: color, semanticLabel: label),
    );
  }
}

/// The band over a pane another client took the stream of. It says what
/// happened, that keys go nowhere, and how to get it back — the header's chip
/// carries the same fact, but at 11pt in a corner it was being read by nobody,
/// and people sat typing. Taken-over only, not closed/error: see
/// [_TerminalPanelState._inputBlocked] for why those keep the chip alone.
///
/// ⏎ is named on the button itself and in the line under the title, always:
/// the first cut showed it only once the terminal held focus and hid the line
/// on a compact header, which is every pane in swarm mode — so the one thing
/// a person needed to know was the one thing the band left out.
///
/// While the pane is retaking the stream [busy] is set and the band keeps its
/// place with the button swapped for a spinner, so answering it does not jump
/// the layout.
class _ControlBanner extends StatelessWidget {
  final bool busy;

  /// A key was just typed into the pane; see [_TerminalPanelState._nudgeControlBanner].
  final bool nudged;
  final int nudge;
  final VoidCallback? onTakeControl;

  /// Who has the terminal now, when the daemon said (`terminal_closed.takenBy`
  /// — the fleet's current name for that machine when this app knows it);
  /// null from an older daemon or a taker that did not introduce itself.
  final String? takerName;

  /// The pane-level notice this band is speaking for instead, when it is one a
  /// person can act on. Null for the takeover band above.
  final TerminalNotice? notice;

  const _ControlBanner({
    required this.busy,
    required this.nudged,
    required this.nudge,
    required this.onTakeControl,
    this.takerName,
  }) : notice = null;

  /// The band for a notice that offers a way out — the same strip, the same
  /// wording rules, so a pane never grows a second one. The header's chip says
  /// the same thing in a corner; this is where it can be read.
  const _ControlBanner.notice(TerminalNotice this.notice)
    : busy = false,
      nudged = false,
      nudge = 0,
      onTakeControl = null,
      takerName = null;

  String get title => notice != null
      ? notice!.label
      : busy
      ? 'Taking control…'
      : takerName == null
      ? 'Another app took control of this terminal'
      : '$takerName took control of this terminal';

  String? get detail {
    if (notice != null) return notice!.detail;
    if (busy) return null;
    if (nudged) return 'Keys are ignored — press ⏎ to take control.';
    return 'Typing is paused. Click here or press ⏎ to take control.';
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // A notice that failed is red; everything else on this strip is the amber
    // of "paused, and you can do something about it".
    final ink = notice != null && notice!.icon == Icons.error_outline
        ? AppColors.danger
        : AppColors.warning;
    final detail = this.detail;
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    // Composited over the pane's own ground, as [UpdateNotice] is over the
    // window's: the terminal theme behind this band may be any colour, and a
    // bare 12% wash would read differently on each of them.
    return Semantics(
      container: true,
      liveRegion: true,
      child: Stack(
        children: [
          // The flash is the ground only. Re-keyed per nudge so each ignored
          // key restarts it from full, and kept OUT of the content's ancestry
          // so the button is not remounted (and does not lose focus or hover)
          // on every keystroke.
          Positioned.fill(
            child: TweenAnimationBuilder<double>(
              key: ValueKey(nudge),
              tween: Tween(begin: 1, end: 0),
              duration: reduceMotion
                  ? Duration.zero
                  : const Duration(milliseconds: 450),
              curve: Curves.easeOut,
              builder: (context, flash, _) {
                final wash = ink.withValues(alpha: 0.12 + 0.18 * flash);
                return DecoratedBox(
                  decoration: BoxDecoration(
                    color: Color.alphaBlend(wash, grid.AppPalette.panelBg),
                    border: Border(
                      bottom: BorderSide(color: ink.withValues(alpha: 0.55)),
                    ),
                  ),
                );
              },
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 12, 10),
            child: LayoutBuilder(
              builder: (context, constraints) {
                // A quarter-width tile at large text cannot seat the sentence
                // and the button on one line; there the button takes a line of
                // its own under the title rather than running off the edge.
                final narrow =
                    constraints.maxWidth < 340 * grid.appTextScaleOf(context);
                final lead = notice != null
                    ? Icon(notice!.icon, size: 16, color: ink)
                    : !busy
                    ? Icon(Icons.lock_outline, size: 16, color: ink)
                    : SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: ink,
                        ),
                      );
                final text = Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: grid.AppType.label(
                        color: AppColors.text,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (detail != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        detail,
                        maxLines: narrow ? 1 : 2,
                        overflow: TextOverflow.ellipsis,
                        style: grid.AppType.body(
                          color: nudged ? ink : AppColors.textSoft,
                          height: 1.3,
                        ),
                      ),
                    ],
                  ],
                );
                // A press anywhere on the band takes the stream back (the
                // panel's Listener over the whole body); the text needs no
                // gesture of its own.
                final prose = MouseRegion(
                  cursor: SystemMouseCursors.basic,
                  child: Row(
                    children: [
                      lead,
                      const SizedBox(width: 10),
                      Expanded(child: text),
                    ],
                  ),
                );
                final button = notice != null
                    ? (notice!.actionLabel == null
                          ? null
                          : _ControlBannerButton(
                              label: notice!.actionLabel!,
                              onPressed: notice!.onAction,
                              showReturnKey: false,
                            ))
                    : busy
                    ? null
                    : _ControlBannerButton(onPressed: onTakeControl);
                if (narrow) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      prose,
                      if (button != null) ...[
                        const SizedBox(height: 8),
                        Align(alignment: Alignment.centerRight, child: button),
                      ],
                    ],
                  );
                }
                return Row(
                  children: [
                    Expanded(child: prose),
                    if (button != null) ...[const SizedBox(width: 12), button],
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// `Take control ⏎` — the action with its key drawn on it, in the button's own
/// ink rather than [KeyCap]'s well fill, which would sit as a grey square on
/// the accent.
class _ControlBannerButton extends StatelessWidget {
  final VoidCallback? onPressed;
  final String label;

  /// ⏎ is drawn only where the key really does this — taking the stream back
  /// (`_onTerminalKey`). A notice's action has no chord behind it.
  final bool showReturnKey;
  const _ControlBannerButton({
    required this.onPressed,
    this.label = 'Take control',
    this.showReturnKey = true,
  });

  @override
  Widget build(BuildContext context) {
    final onAccent = Theme.of(context).colorScheme.onPrimary;
    return FilledButton(
      onPressed: onPressed,
      style: FilledButton.styleFrom(
        minimumSize: const Size(0, 28),
        padding: const EdgeInsets.fromLTRB(12, 0, 8, 0),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        visualDensity: VisualDensity.compact,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(child: Text(label, style: grid.AppType.label())),
          if (showReturnKey) ...[
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
              decoration: BoxDecoration(
                border: Border.all(color: onAccent.withValues(alpha: 0.6)),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Semantics(
                label: 'Return',
                child: Icon(Icons.keyboard_return, size: 12, color: onAccent),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Image/file transfer progress with a cancel action, kept in the pane's corner.
class _TransferProgressBadge extends StatelessWidget {
  final String label;
  final double? fraction;
  final VoidCallback onCancel;
  const _TransferProgressBadge({
    required this.label,
    required this.fraction,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final percentLabel = fraction == null
        ? ''
        : ' · ${(fraction! * 100).round()}%';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: grid.AppPalette.panelBg.withValues(alpha: 0.93),
        border: Border.all(color: AppColors.borderStrong),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '$label$percentLabel',
                  overflow: TextOverflow.ellipsis,
                  style: grid.AppType.label(color: AppColors.textSoft),
                ),
              ),
              const SizedBox(width: 8),
              InkWell(
                onTap: onCancel,
                child: Text(
                  'CANCEL',
                  style: grid.AppType.label(color: AppColors.textSoft),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(
              minHeight: 4,
              value: fraction,
              backgroundColor: AppColors.border,
              color: AppColors.accent,
            ),
          ),
        ],
      ),
    );
  }
}

/// The whole tile, carried under the cursor.
///
/// ⚠️ THIS IS DRAWN, NOT PHOTOGRAPHED, AND THE PHOTOGRAPH IS WHY. The obvious
/// way to carry "the whole pane" is RepaintBoundary.toImage() on press — and it
/// FROZE THE APP. That call is a GPU readback on the raster thread, and the
/// raster thread in this app is never idle: every pane holds a terminal that
/// repaints on its own, so asking it to stop and hand a surface back on every
/// pointer-down deadlocked the window. It is not a tuning problem; there is
/// nothing to tune down to.
///
/// So the ghost is built from what is already known — the pane's measured size
/// and its own header — and the body is a plain surface rather than a copy of
/// the scrollback. It reads as the tile because it is tile-SHAPED and carries
/// the tile's name, which is what the eye is following.
///
/// See-through on purpose: a full-size opaque copy sits exactly over the tile
/// being aimed at and hides the "Swap with this pane" highlight that says the
/// drop will land.
class _PaneGhost extends StatelessWidget {
  const _PaneGhost({
    required this.session,
    required this.size,
    required this.header,
  });

  final TerminalSession session;

  /// The tile's size, handed down from the grid's LayoutBuilder.
  final Size size;

  final Widget header;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final tile = size;
    return Material(
      color: Colors.transparent,
      child: Opacity(
        opacity: 0.75,
        child: Container(
          width: tile.width,
          height: tile.height,
          decoration: BoxDecoration(
            color: grid.AppPalette.windowBg,
            border: Border.all(color: AppColors.accent, width: 1.5),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.45),
                blurRadius: 24,
                offset: const Offset(0, 10),
              ),
            ],
          ),
          child: Column(
            children: [
              header,
              Divider(height: 1, color: AppColors.border),
              Expanded(
                child: Center(
                  child: Text(
                    session.agentName,
                    style: grid.AppType.monoLabel(
                      color: AppColors.mutedStrong,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
