import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/app_dialog.dart'
    show kDialogVeilBlur, kSheetVeilOpacity;
import 'package:harness_mobile/state/app_state.dart';

import '../demo/sample_mode.dart' show SampleMode;
import 'agents_page.dart' show openNewAgent;
import 'find_models.dart';
import 'tty.dart';
import 'tty_controls.dart';
import 'voice_input_controller.dart';
import 'phone_search_actions.dart';
import 'phone_search_controller.dart';
import 'phone_search_results.dart';

/// Find: the one way to another agent. A full-screen page in from the left edge over Focus —
/// Snapchat's way to its chats — pulled by a swipe right on the terminal, or a tap on the agent's
/// name. The agents you were last in come first; a field runs across the top. A swipe left sends it
/// back.
///
/// ```
///  ╭─────────────────────────────╮
///  │  ┌──────────────────┐       │░░░
///  │  │ ⌕ Find an agent  │   +   │░░░  ← focused, the + gives way to Cancel
///  │  └──────────────────┘       │░░░
///  │  ╭───────────────────────╮  │░░░
///  │  │ ▣  fix login test   ✓ │  │░░░  ← the one on screen
///  │  │ ▣  docs rewrite       │  │░░░
/// ```
///
/// ⚠️ **One list, and it is the same list focused or not.** The sheet used to open on the account's
/// desk tabs and trade them for results on focus; a phone has no tabs now (see
/// `docs/plans/2026-09-26-001-mobile-zero-questions.md`). The rows are the account's harnesses by
/// when their conversation last moved ([Agent.updatedAt], the same moment on every app) — so
/// the two or three you work with on the go are the top rows; typing filters them, and return
/// opens the first. The desktop's modes work here too: `>` commands, `#` projects, `@` machines,
/// `?` help.
///
/// ⚠️ **Full height, and a keyboard lifts only its foot.** It runs up under the status bar; a
/// keyboard, when it comes, takes the drawer's foot onto its own top rather than covering the rows.
///
/// The field takes focus on opening so a query can be typed immediately.
///
/// ⚠️ **Not a route.** Pushed, the sheet would sit in a navigator above the shell, and an agent
/// opened from it would be pushed over the shell rather than take the home screen (see
/// [openAgent]). Worse, the terminal beneath would still be the current route of ITS navigator: it
/// would read the field's keyboard as its own and claim the input back, and the query would be typed
/// into the shell. In place, the page holds its terminal still for as long as this is up — see
/// `_heldForSearch` in `terminal_page.dart`.
///
/// ⚠️ **It must stay mounted only while it is up.** The field inside keeps the keyboard once tapped,
/// so a copy left built behind the terminal would keep it and eat every keystroke the terminal is
/// owed.
class TerminalSearchOverlay extends StatefulWidget {
  const TerminalSearchOverlay({
    super.key,
    required this.notifier,
    required this.animation,
    required this.onClose,
    this.showing,
    this.bottomInset = 0,
    this.voice,
  });

  /// The field's mic: what is said becomes the query. Null leaves the mic out.
  final VoiceInputController? voice;

  final AppNotifier notifier;

  /// The open/close animation the terminal page drives — 0 gone, 1 up.
  ///
  /// Run by the page rather than here, because the page is what decides when
  /// this widget stops existing: the sheet has to be all the way down before
  /// the overlay comes down, and a controller owned by a widget being unmounted
  /// cannot outlive itself to say so.
  final Animation<double> animation;

  final VoidCallback onClose;

  /// The agent on screen: the row wearing the check.
  final AgentRef? showing;

  /// The strip at the foot of the window the sheet runs down over — the home
  /// indicator, Android's navigation bar — which its lists keep their last row
  /// clear of. Zero while a keyboard is up: the page already ends at its top.
  ///
  /// Handed in because the page is what knows it. The MediaQuery here does not
  /// carry the window's inset — see `_windowBottomInset` in
  /// `terminal_page.dart`.
  final double bottomInset;

  /// How wide Find stands over a window [width] wide: all of it. Find is a page of its own, the way
  /// Snapchat's chats are — a strip of terminal left showing beside it read as a layer, and cost the
  /// list width for long names. A swipe left takes it back.
  ///
  /// Public because the page's swipe right drives the slide under the finger, and a finger that
  /// moves one drawer-width has opened it all the way.
  static double drawerWidth(double width) => width;

  @override
  State<TerminalSearchOverlay> createState() => _TerminalSearchOverlayState();
}

class _TerminalSearchOverlayState extends State<TerminalSearchOverlay>
    with TickerProviderStateMixin {
  /// How dark the page goes behind the sheet — a step past Material's
  /// `black54`, with the page blurred under it as well. The phone sheets stand
  /// on the same veil ([kSheetVeilOpacity]), so every sheet over a terminal
  /// dims it alike.
  ///
  /// ⚠️ **Blurred, because what is behind this sheet is a live terminal.**
  /// Dimmed text is still text: at any tint that leaves the page reading as
  /// the page, its lines stayed legible — and moving — and the eye went on
  /// picking words out of them instead of settling on the list it came to
  /// choose from. The blur takes the letterforms away, at the strength the
  /// app's dialogs use for the same job ([kDialogVeilBlur]); the tint only has
  /// to set the depth, which is why it can stay this far short of theirs.
  static const double _scrim = kSheetVeilOpacity;

  /// A fling left faster than this closes Find however little it moved — [BottomSheet]'s own figure,
  /// so it lets go like the app's sheets do.
  static const double _flingSpeed = 700;

  final _controller = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Terminal search');
  late final PhoneSearchController _search = PhoneSearchController(
    notifier: widget.notifier,
    history: widget.notifier.searchHistory,
    commands: () => phoneSearchCommands(context, widget.notifier),
  );

  /// The results, for the return key to open the top row of.
  final _results = GlobalKey<PhoneSearchResultsState>();

  /// The sheet's own box, measured to turn a drag's pixels into a share of its
  /// height.
  final _sheetKey = GlobalKey(debugLabel: 'Terminal search sheet');

  /// Whether the field has been tapped: Cancel beside it instead of `+`.
  ///
  /// ⚠️ **Entered on focus, left on Cancel — not tied to focus both ways.** The keyboard goes away
  /// for reasons that are not "stop searching" — the return key puts it away on purpose. The query
  /// stays through that, the way a search does anywhere on a phone; only Cancel, or Back, ends it.
  bool _searching = false;

  /// How far a finger has pulled the sheet down, as a share of its height.
  late final AnimationController _pull = AnimationController(vsync: this);

  /// How tall the keyboard stands, in logical pixels — the sheet's foot goes
  /// on its top (see [_layOut]).
  ///
  /// Read off [View], for the reason `didChangeMetrics` in `terminal_page.dart`
  /// gives: the MediaQuery here has had the inset taken out. And written on
  /// every metrics tick, because nothing that reads [View] is rebuilt when it
  /// moves — this is what carries the sheet up with the keys, frame by frame.
  final _keyboard = ValueNotifier<double>(0);

  late final _metrics = _MetricsWatch(_readKeyboard);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(_metrics);
    _focus.addListener(_onFocus);
    _search.addListener(_followQuery);
    // The order the box opens in comes off disk. Not awaited: what is known
    // draws now, and the visits fold in a frame later.
    widget.notifier.searchHistory.load().then((_) {
      if (mounted) _search.setQuery(_search.query);
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // A keyboard already up when the sheet opens — the terminal's own.
    _readKeyboard();
  }

  void _readKeyboard() {
    if (!mounted) return;
    final view = View.of(context);
    _keyboard.value = view.viewInsets.bottom / view.devicePixelRatio;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(_metrics);
    _keyboard.dispose();
    _focus.removeListener(_onFocus);
    _search.removeListener(_followQuery);
    _controller.dispose();
    _focus.dispose();
    _search.dispose();
    _pull.dispose();
    super.dispose();
  }

  /// A tap on the field is what starts a search — see [_searching].
  void _onFocus() {
    if (!_focus.hasFocus || _searching) return;
    setState(() => _searching = true);
  }

  /// Cancel: the query goes, and the list is the recent agents again.
  void _cancel() {
    if (!_searching) return;
    _focus.unfocus();
    _controller.clear();
    _search.reset();
    setState(() => _searching = false);
  }

  /// Puts the query in the field when it moved without a keystroke — a chip,
  /// a `?` row taking its mode, a project or a machine narrowing the search,
  /// Back stepping out of one.
  ///
  /// ⚠️ **Only while searching.** After Cancel the field is emptied at once and
  /// the query only once the results have faded (see [_cancel]); a change
  /// announced in between would otherwise put the cancelled query back in the
  /// field on its way out.
  void _followQuery() {
    if (!_searching) return;
    final query = _search.query;
    if (query == _controller.text) return;
    _controller.value = TextEditingValue(
      text: query,
      selection: TextSelection.collapsed(offset: query.length),
    );
  }

  /// Back steps out of a chosen project or machine first, then out of the
  /// search, and only then out of the sheet — the steps `#`/`@` and the field
  /// took on the way in.
  void _back() {
    if (!_searching) {
      _close();
      return;
    }
    if (_search.back()) return;
    _cancel();
  }

  /// ⚠️ Drops the keyboard BEFORE handing back, so the terminal underneath does
  /// not inherit an inset that belongs to this field. The page's own keyboard
  /// tracking reads the inset, not the focus, and would otherwise come back
  /// believing the terminal had raised it.
  void _close() {
    _focus.unfocus();
    widget.onClose();
  }

  /// `+`: away first, then the new-agent form. Null while no machine can take one.
  /// `+ New Harness` — in the project the query matched when there is one; else on the machine of
  /// the harness on screen, as a swipe left does; else the command's first ready machine.
  void Function(({String machineId, String folder, String label})? place)?
  _newAgent() {
    final showing = widget.showing;
    final here = showing == null
        ? null
        : widget.notifier.stateOf(showing.machineId);
    final command = phoneSearchCommands(
      context,
      widget.notifier,
    ).where((command) => command.id == 'agent.new').firstOrNull;
    final ready = here != null && here.nodeOnline != false && !here.needsLink;
    if (!ready && command == null) return null;
    return (place) {
      _close();
      if (place != null) {
        unawaited(
          openNewAgent(
            context,
            widget.notifier,
            place.machineId,
            folder: place.folder,
            voice: widget.voice,
          ),
        );
      } else if (ready) {
        unawaited(
          openNewAgent(
            context,
            widget.notifier,
            showing!.machineId,
            voice: widget.voice,
          ),
        );
      } else {
        command!.run();
      }
    };
  }

  /// A drag left, anywhere over the page, pushes Find back the way it came. Measured against the
  /// drawer's width, so the drawer stays under the finger.
  void _onPull(DragUpdateDetails details) {
    final width = _sheetKey.currentContext?.size?.width ?? 0;
    if (width <= 0) return;
    _pull.value -= details.primaryDelta! / width;
  }

  /// Let go: closed on a fling left or past half its width, and back otherwise.
  void _onRelease(DragEndDetails details) {
    if ((details.primaryVelocity ?? 0) < -_flingSpeed || _pull.value > 0.5) {
      _close();
      return;
    }
    _settle();
  }

  void _settle() {
    _pull.animateTo(
      0,
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // Built once per build and handed down whole, so the frames of the slide
    // and of a pull — and of a keyboard resizing the page — move it without
    // building it again.
    final sheet = _sheet(context);
    return PopScope(
      // Back steps out of the search and then closes Find — never leaves the
      // agent: the terminal is still underneath, and this is what covers it.
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      // The terminal under the dimming is not what a screen reader should be
      // walking while Find is up.
      child: BlockSemantics(
        child: GestureDetector(
          // A drag left anywhere — on the drawer or on the strip of terminal
          // beside it — sends Find back. The list scrolls on the other axis.
          onHorizontalDragUpdate: _onPull,
          onHorizontalDragEnd: _onRelease,
          onHorizontalDragCancel: _settle,
          child: LayoutBuilder(
            builder: (context, box) => _layOut(context, box.biggest, sheet),
          ),
        ),
      ),
    );
  }

  Widget _layOut(BuildContext context, Size area, Widget sheet) {
    final screen = MediaQuery.sizeOf(context).height;
    final width = TerminalSearchOverlay.drawerWidth(area.width);
    return AnimatedBuilder(
      animation: Listenable.merge([widget.animation, _pull, _keyboard]),
      child: sheet,
      builder: (context, sheet) {
        // ⚠️ **The drawer stands on the keyboard as measured, not on the
        // page's foot.** The page does not always end at the keyboard's top:
        // where it has been resized for the keys this is zero, and where it
        // has not it runs on under them and this is how far — so the foot
        // lands on the keys either way. Taken against the window's height,
        // because this overlay starts at the window's top.
        //
        // ⚠️ **Read from the view HERE, not from the notifier's last value.**
        // [_keyboard] is written from metrics ticks and is what makes this
        // rebuild, but the value it holds can be a frame behind the page.
        final view = View.of(context);
        final keyboard = view.viewInsets.bottom / view.devicePixelRatio;
        final covered = math.min(
          area.height,
          math.max(0.0, area.height - (screen - keyboard)),
        );
        final height = math.max(0.0, area.height - covered);
        final open = widget.animation.value;
        final pull = _pull.value;
        // How much of the veil is up: all of it with the drawer, and less of it
        // as a finger pushes the drawer back — the blur and the tint clear
        // together, so a pull shows the terminal coming back into focus.
        final veil = math.max(0.0, open * (1 - pull));
        final blur = kDialogVeilBlur * veil;
        return Stack(
          children: [
            Positioned.fill(
              child: Semantics(
                button: true,
                label: MaterialLocalizations.of(context)
                    .modalBarrierDismissLabel,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: _close,
                  // Clipped, so the blur reads only the page this overlay
                  // covers — a filter with no clip above it takes in the whole
                  // screen.
                  child: ClipRect(
                    child: BackdropFilter(
                      // Off while there is nothing to blur: the first frame of
                      // the way in, the last of the way out.
                      enabled: blur > 0,
                      filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
                      child: ColoredBox(
                        color: Colors.black.withValues(alpha: _scrim * veil),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            Positioned(
              left: 0,
              top: 0,
              width: width,
              height: height,
              child: Transform.translate(
                offset: Offset(-(1 - open + pull) * width, 0),
                child: sheet,
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _sheet(BuildContext context) {
    final media = MediaQuery.of(context);
    final tty = Tty.of(context);
    return Container(
      key: _sheetKey,
      color: tty.ground,
      child: MediaQuery(
        data: media.copyWith(
          padding: media.padding.copyWith(top: 0, bottom: 0),
        ),
        child: Material(
          type: MaterialType.transparency,
          child: ListenableBuilder(
            listenable: _search,
            builder: (context, _) {
              final newAgent = _newAgent();
              final hasText = _controller.text.isNotEmpty;
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox(height: media.padding.top + 8),
                  // The field takes the keyboard on entry, like ⌘P.
                  // No Cancel: a swipe left is the way out, as it was the way in.
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
                    child: Row(
                      children: [
                        Expanded(
                          child: TtyField(
                            controller: _controller,
                            focus: _focus,
                            autofocus: true,
                            hint: _search.canGoBack
                                ? 'Search in ${_search.scopeName}'
                                : _search.hint.replaceAll('…', ''),
                            onChanged: _search.setQuery,
                            onSubmitted: () =>
                                _results.currentState?.openFirst(),
                            action: TextInputAction.search,
                            trailing: [
                              if (hasText)
                                _FieldClear(onTap: _clearField)
                              else if (widget.voice case final voice?)
                                ListenableBuilder(
                                  listenable: voice,
                                  builder: (context, _) => TtyFieldMic(
                                    live:
                                        voice.status ==
                                            VoiceInputStatus.listening ||
                                        voice.status ==
                                            VoiceInputStatus.starting,
                                    onTap: () => _talk(voice),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (SampleMode.ofNotifier(widget.notifier) != null)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(
                        Tty.origin,
                        4,
                        Tty.origin,
                        0,
                      ),
                      child: TtyText(
                        'Sample harnesses',
                        color: Tty.of(context).faint,
                        size: TtySize.meta,
                      ),
                    ),
                  const SizedBox(height: 4),
                  Expanded(
                    child: switch ((_search.isModelMode, widget.showing)) {
                      // `:` — the models the harness on screen can run on.
                      (true, final showing?) => FindModels(
                        notifier: widget.notifier,
                        machineId: showing.machineId,
                        agentId: showing.agentId,
                        query: _search.matchQuery,
                        onPicked: _close,
                      ),
                      _ => PhoneSearchResults(
                        key: _results,
                        notifier: widget.notifier,
                        controller: _search,
                        showing: widget.showing,
                        onOpen: _close,
                        onNewHarness: newAgent == null
                            ? null
                            : (place) => newAgent(place),
                      ),
                    },
                  ),
                  // Over the home indicator while the keyboard is down; on the keys once it is up.
                  SizedBox(height: widget.bottomInset),
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  void _clearField() {
    _controller.clear();
    _search.setQuery('');
  }

  /// The field's mic: talk, and what was said becomes the query.
  void _talk(VoiceInputController voice) {
    if (voice.status == VoiceInputStatus.listening) {
      unawaited(
        voice.submit((text) async {
          if (!mounted) return false;
          final query = text.trim().replaceAll(RegExp(r'[.!?]+$'), '');
          _controller.value = TextEditingValue(
            text: query,
            selection: TextSelection.collapsed(offset: query.length),
          );
          _search.setQuery(query);
          return true;
        }),
      );
      return;
    }
    if (voice.status == VoiceInputStatus.idle) {
      unawaited(voice.startListening());
    }
  }
}

/// The field's `✕`: empties it.
class _FieldClear extends StatelessWidget {
  const _FieldClear({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: 'Clear',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: SizedBox(
          width: 44,
          height: 44,
          child: Icon(LucideIcons.x300, size: 18, color: tty.faint),
        ),
      ),
    );
  }
}

class _MetricsWatch extends WidgetsBindingObserver {
  _MetricsWatch(this.onChange);

  final VoidCallback onChange;

  @override
  void didChangeMetrics() => onChange();
}
