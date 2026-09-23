import 'dart:math' as math;
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/app_dialog.dart'
    show kDialogVeilBlur;
import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';
import 'desk_groups.dart';
import 'desk_tabs_panel.dart';
import 'phone_prompt_context.dart';
import 'phone_search_actions.dart';
import 'phone_search_controller.dart';
import 'phone_search_field.dart';
import 'phone_search_results.dart';
import 'sheet_list.dart';

/// The terminal's way to another agent: a sheet up from the bottom, over the
/// terminal, holding the account's tabs with a search field across its top.
///
/// ```
///  ╭──────────────────────────────────╮
///  │               ━━━                │
///  │  ┌────────────────────┐          │
///  │  │ ⌕ Search harnesses │  Cancel  │  ← focused, it grows a Cancel
///  │  └────────────────────┘          │
///  │  (▓Desktop▓) ( Docker )  (+)     │  ← until then, the tabs —
///  │    DESKTOP                    2  │    [DeskTabsPanel]
///  │  ╭────────────────────────────╮  │
///  │  │ ▣  api-3              ◌  › │  │
/// ```
///
/// Drawn the way iOS draws its own sheets — a filled search bar, pills, an
/// inset-grouped list — and the same way in both states: the results are the
/// rows the tabs are ([SheetRow]), so the field taking focus changes what is
/// listed and nothing about how.
///
/// ⚠️ **Two ways to the same place, one sheet.** An agent is found by where it
/// is — its tab — or by what it is called, and those were two doors: a grid
/// mark in the header for the tabs, and the floating Search button for a search
/// that covered the screen. The button opens both now. The sheet reads the tabs
/// until the field is focused; then the results take their place, and Cancel
/// puts the tabs back.
///
/// ⚠️ **In place, never a screen of its own.** Focusing the field once stood
/// the sheet up to the top of the screen for the results, and it read as a
/// second screen arriving over the first — the full-screen search this sheet
/// replaced. The results take the tabs' place and nothing else moves: the
/// keyboard, when it comes, takes the bottom of the sheet and leaves its top
/// where it was.
///
/// ⚠️ **The field is not focused on the way in.** The tabs are what the sheet
/// is opened to read, and a keyboard raised with it would cover half of them.
///
/// ⚠️ **Not a route.** Pushed, the sheet would sit in a navigator above the
/// shell, and an agent opened from it would be pushed over the shell rather
/// than take the home screen (see [openAgent]). Worse, the terminal beneath
/// would still be the current route of ITS navigator: it would read the
/// field's keyboard as its own and claim the input back, and the query would
/// be typed into the shell. In place, the page holds its terminal still for as
/// long as this is up — see `_heldForSearch` in `terminal_page.dart`.
///
/// ⚠️ **It must stay mounted only while it is up.** The field inside keeps the
/// keyboard once tapped, so a copy left built behind the terminal would keep it
/// and eat every keystroke the terminal is owed.
class TerminalSearchOverlay extends StatefulWidget {
  const TerminalSearchOverlay({
    super.key,
    required this.notifier,
    required this.animation,
    required this.onClose,
    this.showing,
    this.bottomInset = 0,
  });

  final AppNotifier notifier;

  /// The open/close animation the terminal page drives — 0 gone, 1 up.
  ///
  /// Run by the page rather than here, because the page is what decides when
  /// this widget stops existing: the sheet has to be all the way down before
  /// the overlay comes down, and a controller owned by a widget being unmounted
  /// cannot outlive itself to say so.
  final Animation<double> animation;

  final VoidCallback onClose;

  /// The agent on screen: the tab the sheet opens on, and the row wearing the
  /// check — in the tabs and in the results. See [DeskTabsPanel.showing].
  final AgentRef? showing;

  /// The strip at the foot of the window the sheet runs down over — the home
  /// indicator, Android's navigation bar — which its lists keep their last row
  /// clear of. Zero while a keyboard is up: the page already ends at its top.
  ///
  /// Handed in because the page is what knows it. The MediaQuery here does not
  /// carry the window's inset — see `_windowBottomInset` in
  /// `terminal_page.dart`.
  final double bottomInset;

  @override
  State<TerminalSearchOverlay> createState() => _TerminalSearchOverlayState();
}

class _TerminalSearchOverlayState extends State<TerminalSearchOverlay>
    with TickerProviderStateMixin {
  /// The corner iOS gives a sheet — rounder than a card, far less round than
  /// [BottomSheet]'s 28, whose curve made a sheet drawn like the system's
  /// own read as Material wearing its clothes.
  static const double _radius = 14;

  /// What the field says while it reads the tabs. The modes it also takes are
  /// offered as chips once it is focused — see [_SearchHead].
  static const String _hint = 'Search harnesses';

  /// How dark the page goes behind the sheet — a step past the `black54`
  /// every other sheet here draws, with the page blurred under it as well.
  ///
  /// ⚠️ **Blurred, because what is behind this sheet is a live terminal.**
  /// Dimmed text is still text: at any tint that leaves the page reading as
  /// the page, its lines stayed legible — and moving — and the eye went on
  /// picking words out of them instead of settling on the list it came to
  /// choose from. The blur takes the letterforms away, at the strength the
  /// app's dialogs use for the same job ([kDialogVeilBlur]); the tint only has
  /// to set the depth, which is why it can stay this far short of theirs.
  static const double _scrim = 0.64;

  /// A fling down faster than this closes the sheet however little it moved —
  /// [BottomSheet]'s own figure, so this sheet lets go like the others do.
  static const double _flingSpeed = 700;

  /// What the sheet stands at while it reads the tabs: this share of the
  /// screen, the strip at its foot included.
  ///
  /// ⚠️ **One height, whatever the tab holds** — see [DeskTabsPanel]. Enough
  /// for four or five rows, and the terminal keeps the rest in view above it.
  ///
  /// ⚠️ **Not [TerminalSearchOverlay.bottomInset] on top of a share.** That
  /// inset reads zero while a keyboard is up and comes back as the keyboard
  /// lands, so a height that counted it would jump by the home indicator's
  /// worth the moment Cancel's keyboard finished going down.
  static const double _restingShare = 0.64;

  /// How close under the status bar the sheet may be pushed, when a keyboard
  /// leaves it no room lower down: a strip of the dimmed page left showing,
  /// which is what says it is a layer over the terminal rather than a page of
  /// its own.
  static const double _topGap = 8;

  /// The least the sheet keeps above a keyboard: the grip, the field, the mode
  /// chips and the first rows of results. A keyboard that would leave less — a
  /// small phone, one lying on its side — lifts the sheet's top instead, since
  /// a field with no room under it is a search with nowhere to put its
  /// answers.
  static const double _minHeight = 200;

  final _controller = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Terminal search');
  late final PhoneSearchController _search = PhoneSearchController(
    notifier: widget.notifier,
    history: widget.notifier.searchHistory,
    commands: () => phoneSearchCommands(context, widget.notifier),
  );

  /// The sheet's own box, measured to turn a drag's pixels into a share of its
  /// height.
  final _sheetKey = GlobalKey(debugLabel: 'Terminal search sheet');

  /// Whether the sheet is searching: results where the tabs were, Cancel
  /// beside the field.
  ///
  /// ⚠️ **Entered on focus, left on Cancel — not tied to focus both ways.** The
  /// keyboard goes away for plenty of reasons that are not "stop searching": a
  /// drag on the results puts it away on purpose (see [PhoneSearchResults]),
  /// and so does the return key. The results stay up through all of them, the
  /// way a search does anywhere on a phone; only Cancel, or Back, ends it.
  bool _searching = false;

  /// Whether the results are BUILT — from the focus that started the search to
  /// the last frame of their fade after Cancel. Not [_searching]: they have to
  /// stay on screen to be seen going.
  bool _resultsUp = false;

  /// The tabs and the results trading places, in the same spot.
  late final AnimationController _swap = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 250),
    reverseDuration: const Duration(milliseconds: 200),
  )..addStatusListener(_onSwap);

  /// The tabs out over the first half of the swap and the results in over the
  /// later part, so the two are never both at full strength — one list printed
  /// over another reads as neither.
  late final CurvedAnimation _tabsGoing = CurvedAnimation(
    parent: _swap,
    curve: const Interval(0, 0.5, curve: Curves.easeIn),
  );
  late final Animation<double> _tabsShown = ReverseAnimation(_tabsGoing);
  late final CurvedAnimation _resultsShown = CurvedAnimation(
    parent: _swap,
    curve: const Interval(0.35, 1, curve: Curves.easeOut),
  );

  /// How far a finger has pulled the sheet down, as a share of its height.
  late final AnimationController _pull = AnimationController(vsync: this);

  @override
  void initState() {
    super.initState();
    _focus.addListener(_onFocus);
    _search.addListener(_followQuery);
    // The order the box opens in comes off disk. Not awaited: what is known
    // draws now, and the visits fold in a frame later.
    widget.notifier.searchHistory.load().then((_) {
      if (mounted) _search.setQuery(_search.query);
    });
  }

  @override
  void dispose() {
    _focus.removeListener(_onFocus);
    _search.removeListener(_followQuery);
    _controller.dispose();
    _focus.dispose();
    _search.dispose();
    _tabsGoing.dispose();
    _resultsShown.dispose();
    _swap.dispose();
    _pull.dispose();
    super.dispose();
  }

  /// A tap on the field is what starts a search — see [_searching].
  void _onFocus() {
    if (!_focus.hasFocus || _searching) return;
    // A search cancelled a moment ago can still be fading out with its query
    // in it: see [_cancel]. The empty field is the truth.
    if (_controller.text.isEmpty) _search.reset();
    setState(() {
      _searching = true;
      _resultsUp = true;
    });
    _swap.forward();
  }

  /// Cancel: the search is over and the sheet goes back to the tabs, leaving
  /// the query behind with it — the next tap on the field starts from an empty
  /// box, as a search cancelled anywhere else does.
  ///
  /// ⚠️ The field is emptied now and the search itself only once the results
  /// have faded ([_onSwap]). Emptied at once, the fading list would swap to
  /// the empty query's rows on its way out — a different list for a blink.
  void _cancel() {
    if (!_searching) return;
    _focus.unfocus();
    _controller.clear();
    setState(() => _searching = false);
    _swap.reverse();
  }

  void _onSwap(AnimationStatus status) {
    if (status != AnimationStatus.dismissed || _searching || !_resultsUp) {
      return;
    }
    _search.reset();
    setState(() => _resultsUp = false);
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

  /// A mode chip: its character in the field, and the caret after it, ready
  /// for the rest of the query.
  void _pickMode(String prefix) {
    _search.setQuery(prefix);
    _focus.requestFocus();
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

  /// A row in the tabs: away first, then the agent — see [openDeskAgent].
  void _open(DeskGroup group, AgentEntry entry) {
    final notifier = widget.notifier;
    final showing = widget.showing;
    _close();
    // ⚠️ **The agent already on screen, in the tab the phone is already in,
    // opens nothing.** The tap asks to stay where it is. Sent on, it would —
    // on a page reached by a swipe — rebuild the pager around the page it is
    // on (see [AgentHome]) and load that terminal again for nothing.
    if (showing != null &&
        entry.machineId == showing.machineId &&
        entry.agent.id == showing.agentId) {
      final groups = deskGroups(notifier, visibleAgents(agentIndex(notifier)));
      if (activeDeskGroup(notifier, groups, showing).id == group.id) return;
    }
    openDeskAgent(context, notifier, group, entry);
  }

  void _onPull(DragUpdateDetails details) {
    final height = _sheetKey.currentContext?.size?.height ?? 0;
    if (height <= 0) return;
    _pull.value += details.primaryDelta! / height;
  }

  /// Let go: closed on a fling down or past half its height — [BottomSheet]'s
  /// own rule — and back up otherwise.
  void _onRelease(DragEndDetails details) {
    if ((details.primaryVelocity ?? 0) > _flingSpeed || _pull.value > 0.5) {
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
      // Back steps out of the search and then closes the sheet — never leaves
      // the agent: the terminal is still underneath, and this is what covers
      // it.
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      // The terminal under the dimming is not what a screen reader should be
      // walking while the sheet is up.
      child: BlockSemantics(
        child: GestureDetector(
          // ⚠️ **A sideways drag anywhere over the page is claimed here and
          // goes nowhere.** The pager under the terminal swipes on exactly
          // that, and it would carry the sheet off with the page it belongs
          // to. The tab pills and the mode chips scroll sideways too, and win
          // it for themselves where they are.
          onHorizontalDragStart: (_) {},
          child: LayoutBuilder(
            builder: (context, box) => _layOut(context, box.biggest, sheet),
          ),
        ),
      ),
    );
  }

  Widget _layOut(BuildContext context, Size area, Widget sheet) {
    final view = View.of(context);
    // What a keyboard has taken off the foot of the page — the view's own
    // figure, since the MediaQuery here has had it taken out (see
    // `didChangeMetrics` in `terminal_page.dart`).
    final keyboard = view.viewInsets.bottom / view.devicePixelRatio;
    final ceiling = MediaQuery.paddingOf(context).top + _topGap;
    final full = math.max(0.0, area.height - ceiling);
    // ⚠️ **The top is placed against the page as it stands with NO keyboard**
    // — a share of the screen up from its foot — so a keyboard coming up, the
    // field's or the rename dialog's, takes the bottom of the sheet and leaves
    // its top where it was. The sheet being read stays the sheet being read.
    final top = math.max(
      ceiling,
      area.height +
          keyboard -
          MediaQuery.sizeOf(context).height * _restingShare,
    );
    final height = (area.height - top)
        .clamp(math.min(full, _minHeight), full)
        .toDouble();
    return AnimatedBuilder(
      animation: Listenable.merge([widget.animation, _pull]),
      child: sheet,
      builder: (context, sheet) {
        final open = widget.animation.value;
        final pull = _pull.value;
        // How much of the veil is up: all of it with the sheet, and less of it
        // as a finger pulls the sheet back down — the blur and the tint clear
        // together, so a pull shows the terminal coming back into focus.
        final veil = open * (1 - pull);
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
                      // the way up, the last of the way down.
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
              right: 0,
              bottom: 0,
              height: height,
              child: Transform.translate(
                offset: Offset(0, (1 - open + pull) * height),
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
    return GestureDetector(
      key: _sheetKey,
      // The whole sheet can be pulled down, as a route's sheet can. The lists
      // in it scroll on the same drag and win it where they are.
      onVerticalDragUpdate: _onPull,
      onVerticalDragEnd: _onRelease,
      onVerticalDragCancel: _settle,
      child: CustomPaint(
        foregroundPainter: _TopRim(color: AppGlass.hair),
        child: Material(
          // A step above the terminal it covers — see [sheetFill].
          color: sheetFill,
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(_radius)),
          ),
          clipBehavior: Clip.antiAlias,
          child: MediaQuery(
            // The lists run down under the strip at the foot of the window and
            // pad their own last row clear of it. The top is the sheet's edge,
            // nowhere near the status bar.
            data: media.copyWith(
              padding: media.padding.copyWith(
                top: 0,
                bottom: widget.bottomInset,
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const _Grip(),
                ListenableBuilder(
                  listenable: _search,
                  builder: (context, _) => SheetSearchField(
                    controller: _controller,
                    focus: _focus,
                    // Inside a project or a machine the box says which — the
                    // one thing on the sheet that does, other than the caption.
                    hintText: _search.canGoBack ? _search.hint : _hint,
                    onChanged: _search.setQuery,
                    onClear: () {
                      _controller.clear();
                      _search.setQuery('');
                      // Clearing is a step back into browsing, not out of the
                      // search — the caret stays where the next query will go.
                      _focus.requestFocus();
                    },
                    onCancel: _searching ? _cancel : null,
                  ),
                ),
                Expanded(child: _content()),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _content() => Stack(
    fit: StackFit.expand,
    children: [
      // ⚠️ **The tabs stay built under the results**, faded out and deaf to
      // touch, rather than coming down with the search. The tab being read is
      // their own state, and Cancel has to land back on it — not on the tab
      // the sheet happened to open on.
      IgnorePointer(
        ignoring: _searching,
        child: ExcludeSemantics(
          excluding: _searching,
          child: FadeTransition(
            opacity: _tabsShown,
            child: DeskTabsPanel(
              notifier: widget.notifier,
              showing: widget.showing,
              onOpen: _open,
              onClose: _close,
            ),
          ),
        ),
      ),
      if (_resultsUp)
        IgnorePointer(
          ignoring: !_searching,
          child: FadeTransition(
            opacity: _resultsShown,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _SearchHead(search: _search, onMode: _pickMode, onBack: _back),
                // ⚠️ Handed the query and nothing else. Ranking lives inside
                // it, so this sheet and [PhoneSearchPage] cannot drift into
                // returning different rows for the same words.
                Expanded(
                  child: PhoneSearchResults(
                    notifier: widget.notifier,
                    controller: _search,
                    // The rows the tabs under them are drawn with.
                    grouped: true,
                    showing: widget.showing,
                    // ⚠️ Nothing pops this sheet — opening an agent swaps the
                    // terminal underneath it instead — so tapping a row has to
                    // close it by hand. Without this the keyboard would still
                    // be up over an agent nobody asked to type into.
                    onOpen: _close,
                  ),
                ),
              ],
            ),
          ),
        ),
    ],
  );
}

/// What sits over the results: the modes while the field is empty, and once
/// there is a query, a caption naming what is listed and how much of it.
///
/// ```
///  (> Commands) (# Projects) (@ Machines) (? Help)   ← nothing typed yet
///    HARNESSES                                4/14   ← a query
///  ‹ MACBOOK PRO                                 9   ← inside a machine
/// ```
///
/// ⚠️ **The chips are where the modes are taught now.** The field used to
/// spell all four out in its hint — `Search harnesses  > commands  # proj…` —
/// at 13pt and still cut off on a phone. A chip is read at full size and
/// takes you into its mode, which is the lesson a hint could only describe.
///
/// ⚠️ **No caption over an untouched list.** "Recent" over the rows the
/// search opens on would cost a row of a sheet the keyboard has already
/// halved, and say nothing the order of the rows does not.
class _SearchHead extends StatelessWidget {
  const _SearchHead({
    required this.search,
    required this.onMode,
    required this.onBack,
  });

  final PhoneSearchController search;

  /// A chip tapped: the mode's character, to go in the field.
  final ValueChanged<String> onMode;

  /// The caption's chevron, inside a project or a machine.
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: search,
    builder: (context, _) {
      AppTheme.watch(context);
      final scoped = search.canGoBack;
      if (!scoped && search.query.trim().isEmpty) {
        return _ModeChips(onPick: onMode);
      }
      return SheetCaption(
        label: scoped
            ? search.scopeName ?? ''
            : search.isCommandMode || search.isHelpMode || search.isGroupMode
            ? search.title
            : 'Harnesses',
        // Only once the query has actually excluded something: `14/14` over
        // an untouched list is noise dressed as information.
        count: search.matchCount == search.total
            ? '${search.total}'
            : '${search.matchCount}/${search.total}',
        onBack: scoped ? onBack : null,
      );
    },
  );
}

/// The four modes the field takes, as a row of chips — see [_SearchHead].
class _ModeChips extends StatelessWidget {
  const _ModeChips({required this.onPick});

  final ValueChanged<String> onPick;

  /// The desktop's four, in the order the field's hint used to spell them
  /// out, with Help last: it is the one that explains the other three.
  static const _modes = [
    ('>', 'Commands'),
    ('#', 'Projects'),
    ('@', 'Machines'),
    ('?', 'Help'),
  ];

  @override
  Widget build(BuildContext context) => SizedBox(
    // A 30pt chip, the 6pt the pills keep above theirs, and the 12pt a group
    // keeps from what is over it.
    height: 48,
    child: ListView.separated(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(kSheetInset, 6, kSheetInset, 12),
      itemCount: _modes.length,
      separatorBuilder: (context, index) => const SizedBox(width: 8),
      itemBuilder: (context, index) {
        final (glyph, label) = _modes[index];
        return _ModeChip(
          glyph: glyph,
          label: label,
          // The space is the desktop's: `> ` is where a query in that mode
          // starts, and the caret lands after it.
          onTap: () => onPick('$glyph '),
        );
      },
    ),
  );
}

class _ModeChip extends StatefulWidget {
  const _ModeChip({
    required this.glyph,
    required this.label,
    required this.onTap,
  });

  final String glyph;
  final String label;
  final VoidCallback onTap;

  @override
  State<_ModeChip> createState() => _ModeChipState();
}

class _ModeChipState extends State<_ModeChip> {
  bool _pressed = false;

  void _press(bool pressed) {
    if (_pressed == pressed) return;
    setState(() => _pressed = pressed);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: '${widget.label} mode',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => _press(true),
        onTapUp: (_) => _press(false),
        onTapCancel: () => _press(false),
        onTap: () {
          HapticFeedback.selectionClick();
          widget.onTap();
        },
        child: AnimatedContainer(
          duration: AppMotion.press,
          curve: AppMotion.curve,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            // The rows' own fill: a chip is a row of the list that happens
            // to be short, not a button of the chrome.
            color: _pressed ? sheetRowPressedFill : sheetRowFill,
            borderRadius: BorderRadius.circular(15),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              // The character in the terminal's face and the accent — it is
              // what gets typed, and it should look like something typed.
              Text(
                widget.glyph,
                style: phoneBoxMonoStyle(
                  size: 13,
                  color: AppPalette.accentOnSurface,
                  weight: FontWeight.w600,
                ).copyWith(height: 1),
              ),
              const SizedBox(width: 6),
              Text(
                widget.label,
                maxLines: 1,
                style: TextStyle(
                  color: AppPalette.textPrimary,
                  fontSize: 13.5,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The sheet's top edge, drawn: a hairline of light round its two corners and
/// across, where the sheet meets the veil.
///
/// ⚠️ **The rim does what the fill cannot.** Two dark surfaces are parted by
/// very little however their fills are chosen, and a veil darkens the page
/// towards the sheet as much as away from it — the rim is the one thing on the
/// edge brighter than both. It is the app's own recipe for anything floating
/// over dark (see [AppMenu]): the fill lifts, the rim draws the edge.
///
/// ⚠️ **The top only.** The sheet runs the full width of the phone and down
/// under the home indicator; a rim all the way round would be a line down
/// each side of the screen.
class _TopRim extends CustomPainter {
  const _TopRim({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    const radius = _TerminalSearchOverlayState._radius;
    // Half the stroke in from the edge, so the whole line lies on the sheet
    // rather than half of it out over the veil.
    const inset = 0.5;
    const corner = Radius.circular(radius - inset);
    final rim = Path()
      ..moveTo(inset, radius)
      ..arcToPoint(const Offset(radius, inset), radius: corner)
      ..lineTo(size.width - radius, inset)
      ..arcToPoint(Offset(size.width - inset, radius), radius: corner);
    canvas.drawPath(
      rim,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = color,
    );
  }

  @override
  bool shouldRepaint(_TopRim old) => old.color != color;
}

/// The bar at the top of the sheet that says it can be pulled down: iOS's
/// grabber, at its size — drawn by hand because this sheet is not a route's.
class _Grip extends StatelessWidget {
  const _Grip();

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SizedBox(
      height: 16,
      child: Center(
        child: Container(
          width: 36,
          height: 5,
          decoration: BoxDecoration(
            color: AppPalette.textFaint,
            borderRadius: BorderRadius.circular(2.5),
          ),
        ),
      ),
    );
  }
}
