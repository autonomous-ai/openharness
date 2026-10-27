import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_pane_icon.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import '../state/workspace_chrome.dart';
import 'desktop_chrome.dart';
import 'finger_target.dart';
import 'box_chrome.dart' show ReadlineKeys;
import 'swarm_switcher.dart';
import 'swarm_search_input.dart';
import 'key_hints.dart';
import 'machine_picker_extras.dart';
import 'swarm_resource_preview.dart' show resourcePreviewFormFocused;

/// A desktop command palette over the existing search and activation pipeline.
/// Category buttons edit the same query as keyboard prefixes; no second index.
class DesktopSearchPanel extends StatelessWidget {
  const DesktopSearchPanel({
    super.key,
    required this.search,
    required this.editing,
    required this.focusNode,
    required this.onChoose,
    required this.onClose,
    required this.onRefocus,
    required this.previewBuilder,
    this.showsBack = false,
    this.machineHooks,
  });

  final SwarmSearchController search;
  final TextEditingController editing;
  final FocusNode focusNode;
  final ValueChanged<SwarmSearchSelection> onChoose;
  final VoidCallback onClose, onRefocus;
  final Widget Function() previewBuilder;

  /// True puts a clickable Back before the scopes while a machine or project
  /// is open — the click for what Escape does.
  final bool showsBack;

  /// What Machines needs beyond its rows: which computer this window shows, the account's device
  /// notices, and Add machine · Add phone · History… under the list. Null leaves Machines its rows.
  final MachinePickerHooks? machineHooks;

  /// The least height the window needs for Machines' extras above and below its list: a window
  /// too short for both keeps the list, and the extras come back with the room.
  static const machineExtrasMinHeight = 560.0;

  MachinePickerHooks? _machineHooks(BuildContext context) =>
      MediaQuery.sizeOf(context).height >=
          MediaQuery.textScalerOf(context).scale(machineExtrasMinHeight)
      ? machineHooks
      : null;

  void _addMachine() {
    search.setQuery('@');
    final index = search.rows.indexWhere((row) => row.isCreate);
    if (index >= 0) search.move(index - search.cursor);
    onRefocus();
  }

  static const maxWidth = 1120.0;
  static const maxHeight = 680.0;

  static const categories = [
    ('Harnesses', ''),
    ('Machines', '@'),
    ('Projects', '#'),
    ('Agents', '&'),
    ('Models', ':'),
    ('Store', '*'),
    ('Commands', '>'),
  ];

  String get _prefix => search.isAgentMode
      ? '&'
      : search.isProjectMode
      ? '#'
      : search.isMachineMode
      ? '@'
      : search.isModelMode
      ? ':'
      : search.isStoreMode
      ? '*'
      : search.isCommandMode
      ? '>'
      : '';

  @override
  Widget build(BuildContext context) {
    // Only a host that can go compact (the web) pages its results; Desktop,
    // which sets no compactBelow, builds the panel as it always has.
    if (search.harnessContext != null ||
        WorkspaceChrome.of(context).compactBelow <= 0) {
      return _panel(context, null);
    }
    return _SearchPages(
      search: search,
      onChoose: onChoose,
      onRefocus: onRefocus,
      builder: _panel,
    );
  }

  /// The panel; [pages] is non-null on a phone, where the results and a row's
  /// details are two pages under the search field and its scopes.
  Widget _panel(BuildContext context, _SearchPagesState? pages) {
    grid.AppTheme.watch(context);
    // A phone's buttons are a finger's size; a mouse keeps 32. On a phone the
    // three glyphs share one size, and the row's right inset puts Close's glyph
    // as far from the edge as the search glyph is on the left.
    final compact = workspaceIsCompact(context);
    final button = compact ? kFingerTarget : 32.0;
    final glyph = compact ? 20.0 : 18.0;
    final hooks = _machineHooks(context);
    Widget machineHeader(MachinePickerHooks hooks) => ListenableBuilder(
      listenable: search,
      builder: (context, _) => search.isMachineMode
          ? MachinePickerHeader(search: search, hooks: hooks)
          : const SizedBox.shrink(),
    );
    Widget machineFooter(MachinePickerHooks hooks) => ListenableBuilder(
      listenable: search,
      builder: (context, _) => search.isMachineMode
          ? Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Divider(height: 1, color: DesktopChrome.rim),
                MachinePickerFooter(
                  search: search,
                  hooks: hooks,
                  onAddMachine: _addMachine,
                ),
              ],
            )
          : const SizedBox.shrink(),
    );
    return DesktopChrome(
      child: Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: search.harnessContext == null ? maxWidth : 680,
            maxHeight: maxHeight,
          ),
          child: DesktopDialogSurface(
            key: const ValueKey('swarm-search-results'),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (search.harnessContext case final purpose?)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(24, 20, 24, 4),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Tooltip(
                          message: purpose.title,
                          child: Text(
                            purpose.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: DesktopChrome.heading(),
                          ),
                        ),
                        const SizedBox(height: 4),
                        Tooltip(
                          message: purpose.description,
                          child: Text(
                            purpose.description,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: DesktopChrome.text(
                              size: 13,
                              color: DesktopChrome.muted,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                if (search.split != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
                    child: Text(
                      search.title,
                      style: DesktopChrome.text(size: 13, medium: true),
                    ),
                  ),
                Padding(
                  padding: EdgeInsets.fromLTRB(
                    24,
                    12,
                    compact ? 24 - (kFingerTarget - glyph) / 2 : 16,
                    8,
                  ),
                  child: Row(
                    children: [
                      Icon(
                        AppIcons.search,
                        size: 20,
                        color: DesktopChrome.muted,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: ReadlineKeys(
                          controller: editing,
                          onChanged: search.setQuery,
                          child: SwarmSearchInput(
                            inputKey: const ValueKey('swarm-search-input'),
                            controller: editing,
                            focusNode: focusNode,
                            search: search,
                            onClose: onClose,
                            onChanged: search.setQuery,
                            onOpen: onRefocus,
                            hintText: search.hint,
                          ),
                        ),
                      ),
                      ValueListenableBuilder<TextEditingValue>(
                        valueListenable: editing,
                        builder: (context, value, _) => value.text.isEmpty
                            ? SizedBox.square(dimension: button)
                            : _toolbarButton(
                                context,
                                key: const ValueKey('search-clear-query'),
                                tooltip: 'Clear search',
                                onPressed: () {
                                  editing.clear();
                                  search.setQuery('');
                                  onRefocus();
                                },
                                icon: Icon(
                                  AppIcons.circleX,
                                  size: compact ? glyph : 16,
                                  color: DesktopChrome.muted,
                                ),
                              ),
                      ),
                      // A phone's preview is a page of its own: nothing to
                      // show or hide beside the list.
                      if (search.harnessContext == null && pages == null)
                        ListenableBuilder(
                          listenable: search,
                          builder: (context, _) => _toolbarButton(
                            context,
                            key: const ValueKey('search-toggle-preview'),
                            tooltip: search.previewVisible
                                ? 'Hide preview'
                                : 'Show preview',
                            isSelected: search.previewVisible,
                            onPressed: search.supportsPreview
                                ? () {
                                    search.togglePreview();
                                    onRefocus();
                                  }
                                : null,
                            icon: AppPaneIcon(
                              AppPaneSymbol.splitRight,
                              size: glyph,
                            ),
                          ),
                        ),
                      _toolbarButton(
                        context,
                        key: const ValueKey('search-close'),
                        tooltip: 'Close search',
                        onPressed: onClose,
                        icon: Icon(AppIcons.close, size: glyph),
                      ),
                    ],
                  ),
                ),
                if (search.harnessContext == null)
                  ListenableBuilder(
                    listenable: search,
                    builder: (context, _) => SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.fromLTRB(20, 2, 20, 14),
                      child: Row(
                        spacing: 6,
                        children: [
                          if (showsBack && search.canGoBack)
                            DesktopPill(
                              key: const ValueKey('search-back'),
                              label: 'Back',
                              leading: const Icon(
                                AppIcons.chevronLeft,
                                size: 14,
                              ),
                              capsule: true,
                              quiet: true,
                              onPressed: () {
                                if (search.back()) onRefocus();
                              },
                            ),
                          _SearchScopes(
                            selected: _prefix,
                            onRefocus: onRefocus,
                            onChanged: (prefix) {
                              final words = search.wordsQuery;
                              search.setQuery(
                                prefix.isEmpty
                                    ? words
                                    : '$prefix $words'.trimRight(),
                              );
                            },
                          ),
                        ],
                      ),
                    ),
                  ),
                if (pages != null)
                  Flexible(
                    child: pages.view(
                      list: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (hooks != null) machineHeader(hooks),
                          Expanded(
                            child: ListenableBuilder(
                              listenable: search,
                              builder: (context, _) => SwarmSearchResults(
                                search: search,
                                onChoose: pages.choose,
                                onRefocus: onRefocus,
                                showPreview: false,
                                onShowDetails: pages.show,
                              ),
                            ),
                          ),
                          if (hooks != null) machineFooter(hooks),
                        ],
                      ),
                      preview: previewBuilder,
                    ),
                  )
                else ...[
                  if (hooks != null) machineHeader(hooks),
                  Flexible(
                    child: ListenableBuilder(
                      listenable: search,
                      builder: (context, _) => SwarmSearchResults(
                        search: search,
                        onChoose: onChoose,
                        onRefocus: onRefocus,
                        // Keep the dialog, editor, and footer stationary while a
                        // query gains a preview or changes to an empty result.
                        fitRows: search.harnessContext != null,
                        // The scope control already explains the empty search.
                        // Give results the full width until there is a preview.
                        showPreview: !search.showsTypeHints,
                        sideBySideMinWidth: 800,
                        previewBuilder: previewBuilder,
                      ),
                    ),
                  ),
                  if (hooks != null) machineFooter(hooks),
                ],
                if (search.harnessContext != null) ...[
                  Divider(height: 1, color: DesktopChrome.rim),
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 24,
                      vertical: 12,
                    ),
                    child: Row(
                      children: [
                        if (KeyHints.visibleOf(context))
                          _hint(context, 'picker.cancel', 'Close'),
                        const Spacer(),
                        ListenableBuilder(
                          listenable: search,
                          builder: (context, _) => FilledButton(
                            onPressed: search.canAccept
                                ? () {
                                    final choice = search.submit();
                                    if (choice != null) onChoose(choice);
                                  }
                                : null,
                            child: Text(search.actionLabel(search.selected)),
                          ),
                        ),
                      ],
                    ),
                  ),
                ] else if (KeyHints.visibleOf(context)) ...[
                  Divider(height: 1, color: DesktopChrome.rim),
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 18,
                      vertical: 11,
                    ),
                    child: ListenableBuilder(
                      listenable: search,
                      builder: (context, _) => Wrap(
                        spacing: 20,
                        runSpacing: 8,
                        children: [
                          _hint(context, 'picker.next', 'Browse'),
                          _hint(
                            context,
                            'picker.accept',
                            search.selected == null
                                ? 'Open'
                                : search.actionLabel(search.selected!),
                          ),
                          _hint(context, 'picker.cancel', 'Close'),
                        ],
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _toolbarButton(
    BuildContext context, {
    required Key key,
    required String tooltip,
    required VoidCallback? onPressed,
    required Widget icon,
    bool? isSelected,
  }) {
    final parent = KeymapRegion.of(context);
    void activate() => onPressed?.call();
    final side = workspaceIsCompact(context) ? kFingerTarget : 32.0;
    final button = SizedBox.square(
      dimension: side,
      child: IconButton(
        key: key,
        tooltip: tooltip,
        onPressed: onPressed,
        isSelected: isSelected,
        constraints: BoxConstraints.tightFor(width: side, height: side),
        padding: const EdgeInsets.all(7),
        visualDensity: VisualDensity.standard,
        mouseCursor: onPressed == null
            ? SystemMouseCursors.basic
            : SystemMouseCursors.click,
        icon: icon,
      ),
    );
    return KeymapRegion(
      contextKind: KeymapContext.picker,
      composing: parent?.composing,
      actions: {
        ...?parent?.actions,
        'picker.accept': activate,
        'picker.complete': () =>
            FocusManager.instance.primaryFocus?.nextFocus(),
        'picker.complete_back': () =>
            FocusManager.instance.primaryFocus?.previousFocus(),
      },
      child: KeymapTheme.of(context) == null
          ? CallbackShortcuts(
              bindings: {
                const SingleActivator(LogicalKeyboardKey.enter): activate,
                const SingleActivator(LogicalKeyboardKey.numpadEnter): activate,
              },
              child: button,
            )
          : Shortcuts(
              shortcuts: const {
                SingleActivator(LogicalKeyboardKey.enter): DoNothingIntent(),
                SingleActivator(LogicalKeyboardKey.numpadEnter):
                    DoNothingIntent(),
              },
              child: button,
            ),
    );
  }

  Widget _hint(BuildContext context, String command, String label) {
    final key = effectiveCommandHint(
      context,
      command,
      contextKind: KeymapContext.picker,
    );
    if (key == null) return const SizedBox.shrink();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(key, style: grid.AppType.monoMeta(color: DesktopChrome.muted)),
        const SizedBox(width: 7),
        Text(
          label,
          style: DesktopChrome.text(size: 12, color: DesktopChrome.muted),
        ),
      ],
    );
  }
}

/// Arrow navigation stays inside the scope group, with one tab stop.
/// Pointer selection returns directly to typing; Return does the same for keys.
class _SearchScopes extends StatefulWidget {
  const _SearchScopes({
    required this.selected,
    required this.onChanged,
    required this.onRefocus,
  });

  final String selected;
  final ValueChanged<String> onChanged;
  final VoidCallback onRefocus;

  @override
  State<_SearchScopes> createState() => _SearchScopesState();
}

class _SearchScopesState extends State<_SearchScopes> {
  var _focused = false;
  final _focus = FocusNode(debugLabel: 'Search scopes');
  var _revealScheduled = false;
  BuildContext? _selectedContext;

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // A resize or larger system text can put the active scope outside the
    // horizontal viewport even when its selection did not change.
    MediaQuery.sizeOf(context);
    MediaQuery.textScalerOf(context);
    _revealSelection();
  }

  @override
  void didUpdateWidget(covariant _SearchScopes oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.selected != widget.selected) _revealSelection();
  }

  void _revealSelection() {
    if (_revealScheduled) return;
    _revealScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _revealScheduled = false;
      if (!mounted) return;
      final selected = _selectedContext;
      if (selected != null && selected.mounted) {
        Scrollable.ensureVisible(selected, alignment: .5);
      }
    });
  }

  void _move(int delta) {
    final scopes = DesktopSearchPanel.categories;
    final index = scopes.indexWhere((scope) => scope.$2 == widget.selected);
    widget.onChanged(scopes[(index + delta) % scopes.length].$2);
  }

  @override
  Widget build(BuildContext context) {
    final parent = KeymapRegion.of(context);
    return KeymapRegion(
      contextKind: KeymapContext.picker,
      composing: parent?.composing,
      actions: {
        ...?parent?.actions,
        'picker.accept': widget.onRefocus,
        'picker.next': () => _move(1),
        'picker.previous': () => _move(-1),
        'picker.control_next': () => _move(1),
        'picker.control_previous': () => _move(-1),
        'picker.complete': () =>
            FocusManager.instance.primaryFocus?.nextFocus(),
        'picker.complete_back': () =>
            FocusManager.instance.primaryFocus?.previousFocus(),
      },
      child: Focus(
        key: const ValueKey('search-scopes'),
        focusNode: _focus,
        onFocusChange: (focused) => setState(() => _focused = focused),
        onKeyEvent: (_, event) {
          if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
            return KeyEventResult.ignored;
          }
          final key = event.logicalKey;
          if (key == LogicalKeyboardKey.arrowLeft ||
              key == LogicalKeyboardKey.arrowRight ||
              parent == null &&
                  (key == LogicalKeyboardKey.arrowUp ||
                      key == LogicalKeyboardKey.arrowDown)) {
            _move(
              key == LogicalKeyboardKey.arrowLeft ||
                      key == LogicalKeyboardKey.arrowUp
                  ? -1
                  : 1,
            );
            return KeyEventResult.handled;
          }
          if (key == LogicalKeyboardKey.space ||
              parent == null &&
                  (key == LogicalKeyboardKey.enter ||
                      key == LogicalKeyboardKey.numpadEnter)) {
            widget.onRefocus();
            return KeyEventResult.handled;
          }
          return KeyEventResult.ignored;
        },
        child: ExcludeFocus(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            spacing: 6,
            children: [
              for (final (label, prefix) in DesktopSearchPanel.categories)
                Builder(
                  builder: (segmentContext) {
                    final selected = widget.selected == prefix;
                    if (selected) _selectedContext = segmentContext;
                    // A phone's chip is a finger tall.
                    return fingerTarget(
                      enabled: workspaceIsCompact(context),
                      DesktopPill(
                        key: ValueKey('search-category-$label'),
                        label: label,
                        capsule: true,
                        selected: selected,
                        highlightFocus: selected && _focused,
                        foregroundColor: selected
                            ? DesktopChrome.foreground
                            : DesktopChrome.muted,
                        tooltip: prefix.isEmpty
                            ? 'Search harnesses'
                            : 'Type $prefix to search ${label.toLowerCase()}',
                        onPressed: () {
                          widget.onChanged(prefix);
                          widget.onRefocus();
                        },
                      ),
                    );
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A phone's search as two pages, as an iPhone app's list and its detail: the
/// results alone, then the selected row's preview with a Back (owner,
/// 2026-10-27, on '@' Machines at 390 px: "split it into slides instead of
/// stacking two blocks"). Which rows drill in and which act at once is
/// [swarmSearchRowDrillsIn]'s rule.
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
    if (swarmSearchRowDrillsIn(search, choice.destination)) {
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
  Widget build(BuildContext context) {
    _phone = workspaceIsCompact(context);
    // Crossing to a wider window shows the list and preview together again.
    if (!_phone && _opened != null) {
      _opened = null;
      _slide.value = 0;
    }
    final parent = KeymapRegion.of(context);
    final panel = Focus(
      focusNode: _keys,
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
        // Return chooses as before; on a phone, a row that drills in then
        // shows its details, as its tap does.
        'picker.accept': () {
          final row = _opened == null ? search.selected : null;
          actions['picker.accept']?.call();
          if (row != null &&
              search.selected?.id == row.id &&
              swarmSearchRowDrillsIn(search, row)) {
            show(row);
          }
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
