part of 'desktop_search_panel.dart';

/// A phone's search as two pages, as an iPhone app's list and its detail: the
/// results alone, then the selected row's preview with a Back (owner,
/// 2026-10-27, on '@' Machines at 390 px: "split it into slides instead of
/// stacking two blocks"). Which rows drill in and which act at once is
/// [swarmSearchRowSelectsOnly]'s rule.
///
/// The details page is a view of the search's selected row, not a second
/// selection: it remembers only which row it was opened on, and goes back to
/// the list when the query or the selection moves on. Both pages stay built —
/// the list keeps its scroll, the preview keeps answering its commands — and
/// the one out of sight is offstage, out of focus and of the pointer's way.
///
/// A wider window builds the panel through here too, so that crossing the
/// width keeps the search field; it pages nothing and keys behave as before.
class _SearchPages extends StatefulWidget {
  const _SearchPages({
    required this.search,
    required this.onChoose,
    required this.onRefocus,
    required this.builder,
  });

  final SwarmSearchController search;
  final ValueChanged<SwarmSearchSelection> onChoose;
  final VoidCallback onRefocus;
  final Widget Function(BuildContext context, _SearchPagesState? pages) builder;

  @override
  State<_SearchPages> createState() => _SearchPagesState();
}

class _SearchPagesState extends State<_SearchPages>
    with SingleTickerProviderStateMixin {
  static const _duration = Duration(milliseconds: 250);

  /// How far in from the page's left edge a swipe back may start.
  static const _edge = 20.0;

  // 0 shows the list, 1 the details.
  late final _slide = AnimationController(vsync: this, duration: _duration);

  /// The row and query the details page was opened on; null on the list.
  ({String row, String query})? _opened;

  /// Where a tap back to the list leaves the keys: in the search, out of its
  /// field, so a phone's keyboard does not rise over the list.
  final _keys = FocusNode(debugLabel: 'Search pages', skipTraversal: true);
  bool _phone = false;

  SwarmSearchController get search => widget.search;

  @override
  void initState() {
    super.initState();
    search.addListener(_searchChanged);
  }

  @override
  void didUpdateWidget(_SearchPages oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.search != search) {
      oldWidget.search.removeListener(_searchChanged);
      search.addListener(_searchChanged);
      _leave(animate: false, focus: _Return.stay);
    }
  }

  @override
  void dispose() {
    search.removeListener(_searchChanged);
    _keys.dispose();
    _slide.dispose();
    super.dispose();
  }

  // Typing, a scope, or a selection that moved on (a removed machine, an
  // arrow key) is the list's again.
  void _searchChanged() {
    final opened = _opened;
    if (opened == null) return;
    if (search.query != opened.query || search.selected?.id != opened.row) {
      _leave(animate: false, focus: _Return.stay);
    }
  }

  void _go(double page, {bool animate = true}) {
    if (!animate || MediaQuery.disableAnimationsOf(context)) {
      _slide.value = page;
    } else {
      _slide.animateTo(page, curve: Curves.easeOutCubic);
    }
  }

  /// Opens [row]'s details: the search's selection, which the caller has
  /// already moved there.
  void show(SwarmDestination row) {
    if (!mounted || !_phone) return;
    setState(() => _opened = (row: row.id, query: search.query));
    _go(1);
  }

  /// A row's tap or Return: what it does anywhere, then, on a phone, its
  /// details when it is a row that drills in.
  void choose(SwarmSearchSelection choice) {
    // The choice moves the selection to the row before it returns.
    widget.onChoose(choice);
    if (swarmSearchRowSelectsOnly(search, choice.destination)) {
      show(choice.destination);
    }
  }

  void _leave({bool animate = true, _Return focus = _Return.list}) {
    if (_opened == null) return;
    setState(() => _opened = null);
    _go(0, animate: animate);
    switch (focus) {
      case _Return.field:
        widget.onRefocus();
      case _Return.list:
        _keys.requestFocus();
      case _Return.stay:
        break;
    }
  }

  void _swipe(DragUpdateDetails details, double width) {
    if (_opened == null || width <= 0) return;
    _slide.value -= (details.primaryDelta ?? 0) / width;
  }

  void _swipeEnd(DragEndDetails details) {
    if (_opened == null) return;
    if ((details.primaryVelocity ?? 0) > 300 || _slide.value < .6) {
      _leave();
    } else {
      _go(1);
    }
  }

  /// The two pages, sliding as one: [list], and the details page around
  /// [preview] — built only while the search has a preview to show, as the
  /// side-by-side panel builds it, since the workspace keeps an offstage one
  /// otherwise.
  Widget view({required Widget list, required Widget Function() preview}) {
    final details = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _DetailsBar(search: search, onBack: _leave),
        Divider(height: 1, color: DesktopChrome.rim),
        Expanded(
          child: ListenableBuilder(
            listenable: search,
            builder: (context, _) => search.hasPreview && !search.showsTypeHints
                ? preview()
                : const SizedBox.shrink(),
          ),
        ),
      ],
    );
    return LayoutBuilder(
      builder: (context, constraints) => ClipRect(
        child: AnimatedBuilder(
          animation: _slide,
          builder: (context, _) {
            final page = _slide.value;
            final opened = _opened != null;
            return Stack(
              children: [
                _page(
                  list,
                  offset: -page * .3,
                  shown: page < 1 || !opened,
                  on: !opened,
                ),
                _page(
                  Stack(
                    children: [
                      Positioned.fill(child: details),
                      // A right swipe from the left edge goes back. Only the
                      // edge: the preview's own drags stay its own.
                      Positioned(
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: _edge,
                        child: GestureDetector(
                          key: const ValueKey('search-details-edge'),
                          behavior: HitTestBehavior.translucent,
                          onHorizontalDragUpdate: (details) =>
                              _swipe(details, constraints.maxWidth),
                          onHorizontalDragEnd: _swipeEnd,
                        ),
                      ),
                    ],
                  ),
                  offset: 1 - page,
                  shown: page > 0 || opened,
                  on: opened,
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _page(
    Widget child, {
    required double offset,
    required bool shown,
    required bool on,
  }) => Positioned.fill(
    child: Offstage(
      offstage: !shown,
      child: TickerMode(
        enabled: shown,
        child: IgnorePointer(
          ignoring: !on,
          child: ExcludeSemantics(
            excluding: !on,
            child: ExcludeFocus(
              excluding: !on,
              child: FractionalTranslation(
                translation: Offset(offset, 0),
                child: child,
              ),
            ),
          ),
        ),
      ),
    ),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final phone = workspaceIsCompact(context);
    if (phone == _phone) return;
    _phone = phone;
    if (!phone) {
      // Crossing to a wider window shows the list and preview together again.
      _opened = null;
      _slide.value = 0;
    } else if (!search.previewVisible) {
      // A phone's preview is a page with no toggle: a preview hidden on a
      // wider window would leave every details page blank.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _phone && !search.previewVisible) search.togglePreview();
      });
    }
  }

  /// After a key chose [row] the way a tap does, shows its page when it is a
  /// row that drills in.
  void _chose(SwarmDestination? row) {
    if (row != null &&
        search.selected?.id == row.id &&
        swarmSearchRowSelectsOnly(search, row)) {
      show(row);
    }
  }

  @override
  Widget build(BuildContext context) {
    final parent = KeymapRegion.of(context);
    // Keys only: it adds nothing to the accessibility tree.
    final panel = Focus(
      focusNode: _keys,
      includeSemantics: false,
      child: widget.builder(context, _phone ? this : null),
    );
    if (parent == null) return panel;
    final actions = parent.actions ?? const <String, VoidCallback>{};
    return KeymapRegion(
      contextKind: parent.contextKind,
      composing: parent.composing,
      actions: {
        ...actions,
        // Escape on the details page goes back to the list; a form open
        // in the preview (Rename…) still takes it first.
        'picker.cancel': () {
          if (_opened != null && !resourcePreviewFormFocused()) {
            _leave(focus: _Return.field);
          } else {
            actions['picker.cancel']?.call();
          }
        },
        // Return and a row's number choose as before; on a phone, a row
        // that drills in then shows its details, as its tap does.
        'picker.accept': () {
          final row = _opened == null ? search.selected : null;
          actions['picker.accept']?.call();
          _chose(row);
        },
        for (var number = 1; number <= 9; number++)
          if (actions['picker.pick_$number'] case final pick?)
            'picker.pick_$number': () {
              final rows = search.rows;
              pick();
              _chose(number <= rows.length ? rows[number - 1] : null);
            },
        // A phone's preview stays on: it is the details page.
        if (actions['picker.toggle_preview'] case final toggle?)
          'picker.toggle_preview': () {
            if (!_phone) toggle();
          },
      },
      child: panel,
    );
  }
}

/// Where focus goes when the details page goes back to the list.
enum _Return {
  /// The search field: Escape, a key path, goes on typing.
  field,

  /// The search, out of its field: a tap or a swipe.
  list,

  /// Nowhere new: the query or selection that closed the page has it.
  stay,
}

/// The details page's top: a finger-sized Back, and the row it shows.
class _DetailsBar extends StatelessWidget {
  const _DetailsBar({required this.search, required this.onBack});

  final SwarmSearchController search;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(8, 0, 20, 6),
    child: Row(
      children: [
        TextButton.icon(
          key: const ValueKey('search-details-back'),
          onPressed: onBack,
          style: TextButton.styleFrom(
            minimumSize: const Size(kFingerTarget, kFingerTarget),
            padding: const EdgeInsets.fromLTRB(6, 0, 12, 0),
            foregroundColor: DesktopChrome.foreground,
          ),
          icon: const Icon(AppIcons.chevronLeft, size: 20),
          label: Text(
            'Back',
            style: DesktopChrome.text(size: 14, medium: true),
          ),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: ListenableBuilder(
            listenable: search,
            builder: (context, _) => Semantics(
              header: true,
              child: Text(
                search.selected?.title ?? '',
                key: const ValueKey('search-details-title'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.text(size: 15, medium: true),
              ),
            ),
          ),
        ),
      ],
    ),
  );
}
