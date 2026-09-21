import 'swarm_search_field.dart';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:flutter/services.dart';

import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import 'box_chrome.dart';
import 'prompt_context.dart';
import '../terminal/terminal_text.dart';
import 'search_result_text.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import '../store/store_mark.dart';
import 'engine_identity.dart';
import 'swarm_icon.dart';
import 'swarm_search_preview.dart';

Future<SwarmSearchSelection?> showSwarmHistory(
  BuildContext context,
  AppNotifier app,
  SwarmNavigationHistory history,
) async {
  final search = SwarmSearchController(app, history.recent, history: history);
  try {
    return await showAppDialog<SwarmSearchSelection>(
      context: context,
      transitionDuration: Duration.zero,
      veilBlur: 0,
      builder: (_) => _SwarmHistory(search: search),
    );
  } finally {
    search.dispose();
  }
}

class _SwarmHistory extends StatefulWidget {
  const _SwarmHistory({required this.search});
  final SwarmSearchController search;
  @override
  State<_SwarmHistory> createState() => _SwarmHistoryState();
}

class _SwarmHistoryState extends State<_SwarmHistory> {
  final _query = TextEditingController();
  final _focus = FocusNode(debugLabel: 'History search');
  void _choose(SwarmSearchSelection choice) => Navigator.pop(context, choice);
  @override
  void dispose() {
    _query.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return Dialog(
      alignment: const Alignment(0, -0.5),
      insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 48),
      child: SizedBox(
        width: 680,
        height: 480,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: SwarmSearchKeys(
            search: widget.search,
            editing: _query,
            onChoose: _choose,
            onClose: () => Navigator.pop(context),
            onRefocus: _focus.requestFocus,
            child: Column(
              children: [
                Row(
                  children: [
                    Text(
                      'History',
                      style: terminalTextStyle(fontWeight: FontWeight.w500),
                    ),
                    Spacer(),
                    Text(
                      'This session',
                      style: terminalTextStyle(color: Colors.white54),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                SwarmSearchField(
                  controller: _query,
                  focusNode: _focus,
                  autofocus: true,
                  hintText: 'Search history…',
                  onChanged: widget.search.setQuery,
                ),
                const SizedBox(height: 8),
                Expanded(
                  child: SwarmSearchResults(
                    search: widget.search,
                    onChoose: _choose,
                    onRefocus: _focus.requestFocus,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Search and History share editing and navigation keys.
class SwarmSearchKeys extends StatelessWidget {
  const SwarmSearchKeys({
    super.key,
    required this.search,
    required this.editing,
    required this.onChoose,
    required this.onClose,
    this.onOpen,
    this.onNewAgent,
    this.onCommands,
    this.onRefocus,
    required this.child,
  });
  final SwarmSearchController? search;
  final TextEditingController editing;
  final ValueChanged<SwarmSearchSelection> onChoose;
  final VoidCallback onClose;

  /// A focused field may be ready for typing while its suggestions are closed.
  /// The first navigation/accept key reveals them without choosing unseen work.
  final VoidCallback? onOpen;
  final VoidCallback? onNewAgent;
  final VoidCallback? onCommands;
  final VoidCallback? onRefocus;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final search = this.search;
    bool composing() =>
        editing.value.composing.isValid && !editing.value.composing.isCollapsed;
    void run(VoidCallback action) {
      if (!composing()) action();
    }

    void dismiss() {
      if (search?.back() == true) {
        onRefocus?.call();
      } else {
        onClose();
      }
    }

    void choose(bool add) => run(() {
      if (search == null) {
        onOpen?.call();
        return;
      }
      final switchingMode =
          !add && (search.selected?.pickerQuery != null || search.isGroupMode);
      final choice = add ? search.addHere() : search.submit();
      if (choice != null) onChoose(choice);
      if (switchingMode) onRefocus?.call();
    });
    void move(int delta) => run(() {
      if (search == null) {
        onOpen?.call();
      } else {
        search.moveVisually(delta);
        onRefocus?.call();
      }
    });
    if (KeymapTheme.of(context) != null) {
      return KeymapRegion(
        contextKind: KeymapContext.picker,
        composing: composing,
        actions: {
          if (onNewAgent != null) 'agent.new': () => run(onNewAgent!),
          if (search != null || onOpen != null) ...{
            'picker.accept': () => choose(false),
            'picker.add_here': () => choose(true),
            'picker.next': () => move(1),
            'picker.previous': () => move(-1),
            if (search != null) ...{
              'picker.toggle_preview': () => run(search.togglePreview),
              'picker.preview_page_up': () => run(() => search.page(-1)),
              'picker.preview_page_down': () => run(() => search.page(1)),
            },
            'picker.cancel': dismiss,
            // Tab is a picker command now (New Harness completes paths with
            // it); a matched key is consumed, so here it still walks the focus.
            'picker.complete': () =>
                FocusManager.instance.primaryFocus?.nextFocus(),
            'picker.complete_back': () =>
                FocusManager.instance.primaryFocus?.previousFocus(),
            if (search != null)
              for (var row = 1; row <= 9; row++)
                'picker.pick_$row': () => run(() {
                  if (row > search.rows.length) return;
                  final destination = search.rows[row - 1];
                  final switchingMode =
                      destination.pickerQuery != null || search.isGroupMode;
                  final choice = search.submit(destination);
                  if (choice != null) onChoose(choice);
                  if (switchingMode) onRefocus?.call();
                }),
            if (onCommands != null)
              'navigation.commands': () => run(onCommands!)
            else if (search == null || search.allowsCommands)
              'navigation.commands': () {
                editing.value = const TextEditingValue(
                  text: '> ',
                  selection: TextSelection.collapsed(offset: 2),
                );
                if (search == null) {
                  onOpen?.call();
                } else {
                  search.setQuery('> ');
                  onRefocus?.call();
                }
              },
          },
        },
        child: Actions(
          // EditableText's Escape action has no route-level handler when the
          // picker lives in an overlay. The keymap owns dismissal; composition
          // and user-unbound Escape must stay with the text editor.
          actions: {
            DismissIntent: CallbackAction<DismissIntent>(onInvoke: (_) => null),
          },
          child: child,
        ),
      );
    }
    return CallbackShortcuts(
      bindings: search == null && onOpen == null
          ? {}
          : {
              if (onNewAgent != null)
                const SingleActivator(
                  LogicalKeyboardKey.keyN,
                  meta: true,
                  shift: true,
                  includeRepeats: false,
                ): () =>
                    run(onNewAgent!),
              const SingleActivator(
                LogicalKeyboardKey.enter,
                includeRepeats: false,
              ): () =>
                  choose(false),
              const SingleActivator(
                LogicalKeyboardKey.numpadEnter,
                includeRepeats: false,
              ): () =>
                  choose(false),
              const SingleActivator(
                LogicalKeyboardKey.enter,
                meta: true,
                includeRepeats: false,
              ): () =>
                  choose(true),
              const SingleActivator(
                LogicalKeyboardKey.numpadEnter,
                meta: true,
                includeRepeats: false,
              ): () =>
                  choose(true),
              const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
                  move(1),
              const SingleActivator(LogicalKeyboardKey.arrowUp): () => move(-1),
              if (search != null) ...{
                const SingleActivator(
                  LogicalKeyboardKey.slash,
                  control: true,
                ): () =>
                    run(search.togglePreview),
                const SingleActivator(LogicalKeyboardKey.pageUp): () =>
                    run(() => search.page(-1)),
                const SingleActivator(LogicalKeyboardKey.pageDown): () =>
                    run(() => search.page(1)),
              },
              const SingleActivator(
                LogicalKeyboardKey.keyN,
                control: true,
              ): () =>
                  move(1),
              const SingleActivator(
                LogicalKeyboardKey.keyP,
                control: true,
              ): () =>
                  move(-1),
              const SingleActivator(
                LogicalKeyboardKey.keyJ,
                control: true,
              ): () =>
                  move(1),
              const SingleActivator(
                LogicalKeyboardKey.keyK,
                control: true,
              ): () =>
                  move(-1),
              const SingleActivator(LogicalKeyboardKey.escape): () =>
                  run(dismiss),
              const SingleActivator(
                LogicalKeyboardKey.keyC,
                control: true,
              ): () =>
                  run(onClose),
              const SingleActivator(
                LogicalKeyboardKey.keyG,
                control: true,
              ): () =>
                  run(onClose),
            },
      child: child,
    );
  }
}

/// One line a row, commands and results alike: the name, then what it is, the
/// way an editor's quick-open lists things. Narrow terminal results put their
/// metadata below the title so both identity and task remain readable.
double swarmSearchRowHeight(
  TextScaler scale, {
  required bool commands,
  bool terminal = false,
  bool stacked = false,
}) => terminal
    ? stacked
          ? scale.scale(terminalFontStore.size) * 1.35 +
                scale.scale(terminalFontStore.size) * 1.35 +
                8
          : boxRowHeight(scale)
    : (scale.scale(terminalFontStore.size) * 1.2 + 14).clamp(
        34,
        double.infinity,
      );

double swarmSearchResultsHeight(
  SwarmSearchController search,
  TextScaler scale,
) =>
    search.rows.length.clamp(4, 7) *
        swarmSearchRowHeight(scale, commands: search.isCommandMode) +
    (search.selected != null && !search.canAccept ? 48 : 0);

/// Shared harness search results, also used for commands and History.
class SwarmSearchResults extends StatefulWidget {
  const SwarmSearchResults({
    super.key,
    required this.search,
    required this.onChoose,
    required this.onRefocus,
    this.sideBySideMinWidth = 800,
    this.fitRows = false,
    this.terminal = false,
  });
  final SwarmSearchController search;
  final ValueChanged<SwarmSearchSelection> onChoose;
  final VoidCallback onRefocus;
  final double sideBySideMinWidth;

  /// Let the overlay shrink to whole rows after its editor and hints have
  /// taken their actual heights, including larger text and warning messages.
  final bool fitRows;
  final bool terminal;
  @override
  State<SwarmSearchResults> createState() => _SwarmSearchResultsState();
}

class _SwarmSearchResultsState extends State<SwarmSearchResults> {
  // Keep a small set of recently built rows, not the whole search catalog.
  // A new highlight only changes two rows; their neighbors keep their widgets.
  // Query highlights listen within the text, leaving these controls intact.
  final _rowWidgets = <String, ({Object presentation, Widget child})>{};
  final _pointer = BoxPointerGate();
  final _announcer = BoxAnnouncer();
  String? _announced;
  final _scroll = ScrollController();
  final _resultsKey = GlobalKey();
  double _rowHeight = 56;
  bool _revealScheduled = false;
  bool _createPinned = false;
  int _lastPage = 0;
  (Size, double)? _geometry;
  SwarmSearchController get search => widget.search;

  double _fittedHeight(
    BoxConstraints constraints, {
    required bool sideBySide,
    required bool unavailable,
  }) {
    final stacked = search.hasPreview && !sideBySide;
    if (stacked && search.resultsFromBottom) return constraints.maxHeight;
    final available = stacked
        ? (constraints.maxHeight - 8) * 5 / 11
        : constraints.maxHeight;
    final chrome = 16.0 + (unavailable ? 48 : 0);
    final capacity = ((available - chrome) / _rowHeight).floor();
    // A window too short for one row can only scroll a partial row.
    if (capacity < 1) return constraints.maxHeight;
    // Ten recent sessions plus the pinned New Harness row on a roomy screen.
    // The measured capacity below still reduces this for smaller windows.
    final maxRows = search.resultsFromBottom
        ? 11
        : widget.terminal
        ? 9
        : 12;
    final count = search.hasPreview
        ? capacity.clamp(1, maxRows)
        : search.rows.length.clamp(1, capacity.clamp(1, maxRows));
    final listHeight = chrome + count * _rowHeight;
    return stacked ? 8 + listHeight * 11 / 5 : listHeight;
  }

  @override
  void initState() {
    super.initState();
    search.addListener(_changed);
    terminalFontStore.addListener(_fontChanged);
    _lastPage = search.resultPage.value;
    search.resultPage.addListener(_pageResults);
  }

  void _pageResults() {
    final pages = search.resultPage.value - _lastPage;
    _lastPage = search.resultPage.value;
    if (!_scroll.hasClients || search.rows.isEmpty) return;
    final count = (_scroll.position.viewportDimension / _rowHeight)
        .floor()
        .clamp(1, 50);
    final direction = search.resultsFromBottom ? -pages : pages;
    final next = (search.cursor + direction * count).clamp(
      0,
      search.rows.length - 1,
    );
    search.move(next - search.cursor);
    widget.onRefocus();
  }

  void _fontChanged() {
    _rowWidgets.clear();
    setState(() {});
  }

  void _changed() {
    setState(() {});
    _scrollToSelection();
    _revealSelection();
    // Focus stays in the input while the arrows move a highlight the screen
    // reader never visits; say the row it landed on.
    final row = search.selected;
    if (row != null && row.id != _announced) {
      _announced = row.id;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        final detail = widget.terminal
            ? row.terminalDetail ?? row.detail
            : row.detail;
        _announcer.row(
          context,
          '${row.title}${detail.isEmpty ? '' : ', $detail'}, '
          '${search.actionLabel(row)}',
        );
      });
    }
  }

  void _revealSelection() {
    if (_revealScheduled) return;
    _revealScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _revealScheduled = false;
      if (mounted) _scrollToSelection();
    });
  }

  bool get _pinsCreate =>
      search.resultsFromBottom && search.rows.firstOrNull?.isCreate == true;

  void _scrollToSelection() {
    if (!_scroll.hasClients || search.rows.isEmpty) return;
    final index = search.cursor - (_createPinned ? 1 : 0);
    if (index < 0) return;
    final top = index * _rowHeight;
    final bottom = top + _rowHeight;
    final position = _scroll.position;
    final offset = top < position.pixels
        ? top
        : bottom > position.pixels + position.viewportDimension
        ? bottom - position.viewportDimension
        : position.pixels;
    final target = offset.clamp(0.0, position.maxScrollExtent);
    if (target != position.pixels) _scroll.jumpTo(target);
  }

  void _submit([SwarmDestination? row]) {
    final choice = search.submit(row);
    if (choice != null) {
      widget.onChoose(choice);
    } else {
      widget.onRefocus();
    }
  }

  void _focusResult(String id) {
    // Tab focus must highlight the same row Enter will open.
    // Look up the current position because cached rows can move after discovery.
    final index = search.rows.indexWhere((row) => row.id == id);
    if (index >= 0 && index != search.cursor) {
      search.move(index - search.cursor);
    }
  }

  @override
  void dispose() {
    search.removeListener(_changed);
    terminalFontStore.removeListener(_fontChanged);
    search.resultPage.removeListener(_pageResults);
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final scale = MediaQuery.textScalerOf(context);
    final acceptKey = effectiveCommandHint(
      context,
      'picker.accept',
      contextKind: KeymapContext.picker,
    );
    final selected = search.selected;
    final unavailable =
        (selected != null && !search.canSubmit(selected)) ||
        search.adding &&
            !search.canCreate &&
            !search.isCommandMode &&
            !search.isHelpMode;
    return LayoutBuilder(
      builder: (context, constraints) {
        final sideBySide = constraints.maxWidth >= widget.sideBySideMinWidth;
        final resultWidth = search.hasPreview && sideBySide
            ? (constraints.maxWidth - 1) * .6
            : constraints.maxWidth;
        final stacked =
            widget.terminal &&
            !search.isCommandMode &&
            !search.isHelpMode &&
            resultWidth < 700 * scale.scale(terminalFontStore.size) / 13;
        _rowHeight = swarmSearchRowHeight(
          scale,
          commands: search.isCommandMode,
          terminal: widget.terminal,
          stacked: stacked,
        );
        final height = widget.fitRows
            ? _fittedHeight(
                constraints,
                sideBySide: sideBySide,
                unavailable: unavailable,
              )
            : constraints.maxHeight;
        final compactAction =
            (sideBySide ? constraints.maxWidth / 2 : constraints.maxWidth) <
            380 * scale.scale(terminalFontStore.size) / terminalFontSize;
        final geometry = (Size(constraints.maxWidth, height), _rowHeight);
        if (_geometry != geometry) {
          _geometry = geometry;
          _revealSelection();
        }
        // The create action is outside the scrolling matches. Its location
        // does not change when a query, preview, or selection changes.
        final pinCreate = _createPinned =
            _pinsCreate && constraints.maxHeight >= _rowHeight + 16;
        Widget buildRow(BuildContext context, int index) {
          final row = search.rows[index];
          final highlighted = index == search.cursor;
          final canSubmit = search.canSubmit(row);
          final alreadyHere = search.alreadyHere(row);
          final presentation = (
            row,
            highlighted,
            canSubmit,
            alreadyHere,
            highlighted ? (search.canAccept, search.actionLabel(row)) : null,
            _rowHeight,
            compactAction,
            scale.scale(terminalFontStore.size),
            grid.AppTheme.palette.value,
            acceptKey,
            widget.terminal,
            stacked,
          );
          final previous = _rowWidgets.remove(row.id);
          if (previous?.presentation == presentation) {
            _rowWidgets[row.id] = previous!;
            return FocusTraversalOrder(
              order: NumericFocusOrder(index.toDouble()),
              child: previous.child,
            );
          }
          final tile = ListTile(
            key: ValueKey(row.id),
            minTileHeight: _rowHeight,
            enabled: canSubmit,
            onFocusChange: (focused) {
              if (focused) _focusResult(row.id);
            },
            selected: highlighted,
            selectedColor: Colors.white,
            hoverColor: Colors.transparent,
            // BoxRowHighlight draws the selection, the same
            // in both modes of the box.
            selectedTileColor: Colors.transparent,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(widget.terminal ? 0 : 6),
            ),
            dense: true,
            visualDensity: VisualDensity.compact,
            minVerticalPadding: 0,
            horizontalTitleGap: 10,
            minLeadingWidth: 20,
            contentPadding: const EdgeInsets.symmetric(horizontal: 10),
            // The dock uses its full-row highlight for
            // selection; prefixes only appear in the input.
            leading: widget.terminal
                ? null
                : Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      // Every command wore the same ⌘: a column
                      // of identical marks says nothing. Its
                      // own key, at the right, says something.
                      row.isCommand || row.pickerQuery != null
                          ? const SizedBox(width: 2)
                          : row.isCreate
                          ? const Icon(
                              LucideIcons.plus300,
                              size: 18,
                              color: Colors.white70,
                            )
                          : row.isStore
                          ? StoreMark(size: 20, enabled: canSubmit)
                          : row.agentId != null ||
                                (row.isSwarm && row.members.length == 1)
                          ? EngineMark(
                              engine: row.engine,
                              size: 20,
                              enabled: canSubmit,
                            )
                          : row.isProject
                          ? const Icon(
                              LucideIcons.folderOpen,
                              size: 18,
                              color: Colors.white60,
                            )
                          : row.isMachine
                          ? const Icon(
                              LucideIcons.monitor300,
                              size: 18,
                              color: Colors.white60,
                            )
                          : const SwarmIcon(size: 20, color: Colors.white60),
                    ],
                  ),
            title: _SearchRowContent(
              search: search,
              row: row,
              terminal: widget.terminal,
              stacked: stacked,
            ),
            trailing: widget.terminal
                ? (highlighted
                      ? Text(
                          acceptKey ?? '',
                          key: const ValueKey('swarm-row-action'),
                          style: boxMonoStyle(color: kBoxFaint),
                        )
                      : row.shortcut == null
                      ? null
                      : Text(
                          row.shortcut!,
                          style: boxMonoStyle(color: kBoxFaint),
                        ))
                : alreadyHere && search.placement == null
                ? Text(
                    'Already added',
                    style: terminalTextStyle(color: Colors.white54),
                  )
                : highlighted
                ? ConstrainedBox(
                    constraints: BoxConstraints(
                      maxWidth:
                          170 *
                          scale.scale(terminalFontStore.size) /
                          terminalFontSize,
                    ),
                    child: TextButton(
                      key: const ValueKey('swarm-row-action'),
                      onPressed: search.canAccept ? _submit : null,
                      style: TextButton.styleFrom(
                        foregroundColor: Colors.white,
                      ),
                      child: SwarmSearchActionLabel(
                        search.actionLabel(row),
                        compact: compactAction,
                      ),
                    ),
                  )
                : row.shortcut == null
                ? null
                : Text(
                    row.shortcut!,
                    style: terminalTextStyle(color: Colors.white60),
                  ),
            onTap: canSubmit ? () => _submit(row) : null,
          );
          _rowWidgets[row.id] = (
            presentation: presentation,
            child: MouseRegion(
              // The pointer moving onto a row, never a row
              // arriving under a parked pointer: that took the
              // highlight from the keyboard untouched.
              onHover: (event) {
                if (_pointer.moved(event)) {
                  _focusResult(row.id);
                }
              },
              child: BoxRowHighlight(
                terminal: widget.terminal,
                highlighted: highlighted,
                accent: grid.AppPalette.swarmAccent,
                child: tile,
              ),
            ),
          );
          if (_rowWidgets.length > 48) {
            _rowWidgets.remove(_rowWidgets.keys.first);
          }
          return FocusTraversalOrder(
            order: NumericFocusOrder(index.toDouble()),
            child: _rowWidgets[row.id]!.child,
          );
        }

        final results = Semantics(
          key: _resultsKey,
          container: true,
          label: 'Search results',
          child: Column(
            children: [
              Expanded(
                child: search.rows.isEmpty
                    ? Center(
                        child: Text(
                          search.isCommandMode
                              ? 'No matching commands'
                              : search.isHelpMode
                              ? 'No matching modes or help'
                              : search.isProjectMode
                              ? 'No matching projects'
                              : search.isMachineMode
                              ? 'No matching machines'
                              : search.adding && search.query.isEmpty
                              ? 'This tab is full (${AppNotifier.maxPanes} panes). Open a new tab to add more.'
                              : search.adding
                              ? 'No matching harnesses'
                              : 'No matching results',
                          style: terminalTextStyle(color: Colors.white60),
                        ),
                      )
                    : Padding(
                        padding: EdgeInsets.only(
                          top: 8,
                          bottom: pinCreate ? 0 : 8,
                        ),
                        child: FocusTraversalOrder(
                          order: const NumericFocusOrder(1),
                          child: FocusTraversalGroup(
                            policy: OrderedTraversalPolicy(),
                            child: ListView.builder(
                              key: const ValueKey('swarm-search-result-list'),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                              ),
                              controller: _scroll,
                              reverse: search.resultsFromBottom,
                              itemCount:
                                  search.rows.length - (pinCreate ? 1 : 0),
                              itemExtent: _rowHeight,
                              itemBuilder: (context, index) => buildRow(
                                context,
                                index + (pinCreate ? 1 : 0),
                              ),
                            ),
                          ),
                        ),
                      ),
              ),
              if (unavailable) ...[
                SizedBox(
                  height: 48,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            search.adding
                                ? search.unavailableMessage
                                : selected!.isGroup &&
                                      selected.members.length >
                                          AppNotifier.maxPanes
                                ? 'Open up to ${AppNotifier.maxPanes} harnesses at once'
                                : 'No room to open this ${selected.isSwarm || selected.isGroup ? 'group' : 'harness'}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: terminalTextStyle(color: Colors.white60),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ],
          ),
        );
        final preview = search.hasPreview
            ? SwarmSearchPreview(
                key: const ValueKey('swarm-search-preview'),
                search: search,
                compactHeader: constraints.maxWidth < 800,
                terminal: widget.terminal,
              )
            : null;
        final content = preview == null
            ? results
            : sideBySide
            ? Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // The list is what is being read; the preview confirms it.
                  Expanded(flex: 6, child: results),
                  if (widget.terminal)
                    VerticalDivider(
                      width: 1,
                      thickness: 1,
                      color: Colors.white.withValues(alpha: .16),
                    )
                  else
                    const SizedBox(width: 8),
                  Expanded(flex: 4, child: preview),
                ],
              )
            : search.resultsFromBottom
            ? Column(
                children: [
                  Expanded(child: preview),
                  const SizedBox(height: 8),
                  SizedBox(
                    // Reserve whole rows next to the prompt; preview gets the
                    // remaining space above, never between query and matches.
                    height: _bottomListHeight(
                      height - (pinCreate ? _rowHeight + 8 : 0),
                      unavailable,
                    ),
                    child: results,
                  ),
                ],
              )
            : Column(
                children: [
                  Expanded(flex: 5, child: results),
                  const SizedBox(height: 8),
                  Expanded(flex: 6, child: preview),
                ],
              );
        final withAction = pinCreate
            ? Column(
                children: [
                  Expanded(child: content),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                    child: SizedBox(
                      height: _rowHeight,
                      child: buildRow(context, 0),
                    ),
                  ),
                ],
              )
            : content;
        final sized = widget.fitRows
            ? SizedBox(height: height, child: withAction)
            : withAction;
        final fitted = FocusTraversalGroup(
          policy: OrderedTraversalPolicy(),
          child: sized,
        );
        if (KeymapTheme.of(context) == null) return fitted;
        // The early keymap handler owns these keys across the whole picker.
        // If unbound, do not fall through to ListTile's default activation or
        // directional focus traversal and silently perform the removed action.
        return Shortcuts(
          shortcuts: const {
            SingleActivator(LogicalKeyboardKey.enter): DoNothingIntent(),
            SingleActivator(LogicalKeyboardKey.numpadEnter): DoNothingIntent(),
            SingleActivator(LogicalKeyboardKey.arrowDown): DoNothingIntent(),
            SingleActivator(LogicalKeyboardKey.arrowUp): DoNothingIntent(),
          },
          child: fitted,
        );
      },
    );
  }

  double _bottomListHeight(double height, bool unavailable) {
    final available = (height - 8).clamp(0.0, double.infinity);
    final chrome = 16.0 + (unavailable ? 48 : 0);
    final rows = ((available * .6 - chrome) / _rowHeight).floor().clamp(1, 6);
    return (chrome + rows * _rowHeight).clamp(0.0, available);
  }
}

// Typing changes the match text even when the row, its controls, and its focus
// state stay the same. Listen here so the cached ListTile can keep that state.
class _SearchRowContent extends StatefulWidget {
  const _SearchRowContent({
    required this.search,
    required this.row,
    required this.terminal,
    required this.stacked,
  });

  final SwarmSearchController search;
  final SwarmDestination row;
  final bool terminal;
  final bool stacked;

  @override
  State<_SearchRowContent> createState() => _SearchRowContentState();
}

class _SearchRowContentState extends State<_SearchRowContent> {
  late (String, bool) _query;

  (String, bool) get _currentQuery =>
      (widget.search.matchQuery, widget.search.isHelpMode);

  @override
  void initState() {
    super.initState();
    _query = _currentQuery;
    widget.search.addListener(_changed);
  }

  @override
  void didUpdateWidget(_SearchRowContent oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.search != widget.search) {
      oldWidget.search.removeListener(_changed);
      widget.search.addListener(_changed);
    }
    _query = _currentQuery;
  }

  void _changed() {
    final query = _currentQuery;
    if (_query != query) setState(() => _query = query);
  }

  @override
  void dispose() {
    widget.search.removeListener(_changed);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final row = widget.row;
    final matches = searchResultMatches(row, swarmQueryTerms(_query.$1));
    final title = SearchResultText(
      row.title,
      matches: matches.where((match) => match.title),
      style: widget.terminal ? boxMonoStyle() : terminalTextStyle(),
    );
    final detailText = widget.terminal
        ? row.terminalDetail ?? row.detail
        : row.detail;
    final detail = widget.terminal && row.promptContext != null
        ? PromptContextView(
            contextData: row.promptContext!,
            matches: matches.where((match) => !match.title),
          )
        : (!row.isCommand || _query.$2) && detailText.isNotEmpty
        ? SearchResultText(
            detailText,
            iconOffset: row.detailBranchOffset ?? 0,
            inlineIcon: widget.terminal || row.detailBranchOffset == null
                ? null
                : const Icon(
                    LucideIcons.gitBranch300,
                    size: 12,
                    color: Colors.white60,
                  ),
            matches: matches.where((match) => !match.title),
            style: widget.terminal
                ? boxMonoStyle(color: kBoxFaint)
                : terminalTextStyle(color: Colors.white54),
          )
        : null;
    return widget.stacked
        ? Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [title, ?detail],
          )
        : Row(
            children: [
              Flexible(flex: 3, child: title),
              if (detail != null) ...[
                const SizedBox(width: 10),
                Flexible(flex: 4, child: detail),
              ],
            ],
          );
  }
}

// Compiled once: this runs in the build of the highlighted row, every arrow key.
final _returnChord = RegExp(r'^[⌃⌥⇧⌘]*↵$');

class SwarmSearchActionLabel extends StatelessWidget {
  const SwarmSearchActionLabel(
    this.label, {
    super.key,
    this.command = 'picker.accept',
    this.compact = false,
  });
  final String label;
  final String command;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final hint = effectiveCommandHint(
      context,
      command,
      contextKind: KeymapContext.picker,
    );
    return Semantics(
      label: compact ? label : null,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (!compact || hint == null)
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: terminalTextStyle(),
              ),
            ),
          if (hint != null) ...[
            if (!compact) const SizedBox(width: 8),
            if (_returnChord.hasMatch(hint)) ...[
              if (hint.length > 1)
                Text(
                  hint.substring(0, hint.length - 1),
                  style: terminalTextStyle(),
                ),
              const Icon(Icons.keyboard_return, size: 14),
            ] else
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 96),
                child: Text(
                  hint.replaceAll('↵', 'Return').replaceAll('⇥', 'Tab'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: terminalTextStyle(),
                ),
              ),
          ],
        ],
      ),
    );
  }
}

/// The box's bottom line: what the keys do here. Read off the live keymap, so
/// a remapped key shows as the key it now is, and only the actions this
/// opening of the box can take. A key nobody told you about is a key you never
/// press; a line in the corner of the eye teaches it without a manual.
///
/// Every entry is also a button: [onSubmit], [onAddHere], [onClose] and
/// [onQuery] are what the keys do, handed in so a click does the same.
class SwarmSearchHints extends StatelessWidget {
  const SwarmSearchHints({
    super.key,
    required this.search,
    this.onSubmit,
    this.onAddHere,
    this.onClose,
    this.onQuery,
  });
  final SwarmSearchController search;
  final VoidCallback? onSubmit, onAddHere, onClose;

  /// Put this text in the input: `>` commands, `#` projects, `@` machines, `?` help.
  final ValueChanged<String>? onQuery;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ListenableBuilder(
      listenable: search,
      builder: (context, _) {
        String? key(
          String command, [
          KeymapContext kind = KeymapContext.picker,
        ]) => effectiveCommandHint(context, command, contextKind: kind);
        final selected = search.selected;
        final action = search.actionLabel(selected);
        // `>` and `?` only mean something at the start of an ordinary search: a
        // hint for a key that does nothing here is worse than no hint.
        final prefixes =
            search.allowsCommands &&
            !search.isCommandMode &&
            !search.isHelpMode;
        return BoxHintStrip(
          key: const ValueKey('swarm-search-hints'),
          hints: [
            if (search.resultsFromBottom)
              if ((key('picker.previous'), key('picker.next')) case (
                final String previous,
                final String next,
              ))
                BoxHint('$previous/$next', 'select'),
            if (key('picker.accept') case final accept?)
              BoxHint(
                accept,
                selected?.isCreate == true
                    ? 'new harness'
                    // Keep this hint short so filtering does not wrap the
                    // footer and move the input above it on narrow windows.
                    : search.placement != null && action == search.primaryAction
                    ? 'open'
                    : action.toLowerCase(),
                onTap: onSubmit,
                reserveLabel: search.resultsFromBottom ? 'focus pane' : null,
              ),
            if (!search.adding && search.canAdd(selected))
              if (key('picker.add_here') case final add?)
                BoxHint(add, 'add here', onTap: onAddHere),
            if (search.supportsPreview)
              if (key('picker.toggle_preview') case final toggle?)
                BoxHint(
                  toggle,
                  search.previewVisible ? 'preview on' : 'preview off',
                  onTap: search.togglePreview,
                  reserveLabel: search.resultsFromBottom ? 'preview off' : null,
                ),
            if (prefixes) ...[
              if (search.commands != null)
                BoxHint(
                  '>',
                  'commands',
                  onTap: onQuery == null ? null : () => onQuery!('> '),
                ),
              BoxHint(
                '@',
                'machines',
                onTap: onQuery == null ? null : () => onQuery!('@ '),
              ),
              BoxHint(
                '#',
                'projects',
                onTap: onQuery == null ? null : () => onQuery!('# '),
              ),
            ],
            if (prefixes && search.modes != null && !search.commandsOnly)
              BoxHint(
                '?',
                'help',
                onTap: onQuery == null ? null : () => onQuery!('?'),
              ),
            if (key('picker.cancel') case final cancel?)
              BoxHint(
                cancel,
                search.canGoBack ? 'back' : 'close',
                onTap: () {
                  if (search.back()) {
                    onQuery?.call(search.query);
                  } else {
                    onClose?.call();
                  }
                },
              ),
          ],
        );
      },
    );
  }
}

/// fzf's `4/7`, in the input: how many of what could match do. It answers, at
/// a glance and without reading the list, whether the query narrowed anything
/// or the thing is simply not here. Shown only while filtering, so an empty
/// box stays empty.
class SwarmSearchCount extends StatelessWidget {
  const SwarmSearchCount({
    super.key,
    required this.search,
    this.terminal = false,
  });
  final SwarmSearchController search;
  final bool terminal;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ListenableBuilder(
      listenable: search,
      builder: (context, _) {
        final typed = search.matchQuery;
        // "0 of 71" beside a row that offers to make the thing reads as a bug.
        if (!terminal && (typed.trim().isEmpty || search.matchCount == 0)) {
          return const SizedBox.shrink();
        }
        return Padding(
          padding: const EdgeInsets.only(right: 4),
          child: Text(
            terminal
                ? '${search.matchCount}/${search.total}'
                : '${search.matchCount} of ${search.total}',
            key: const ValueKey('swarm-search-count'),
            style: terminal
                ? boxMonoStyle(color: kBoxFaint)
                : terminalTextStyle(
                    color: Colors.white54,
                    fontFeatures: [FontFeature.tabularFigures()],
                  ),
          ),
        );
      },
    );
  }
}
