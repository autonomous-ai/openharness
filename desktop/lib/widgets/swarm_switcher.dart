import 'dart:async';
import 'dart:math' as math;

import 'swarm_search_field.dart';

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollCacheExtent;
import 'package:flutter/services.dart';

import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart';
import '../shortcuts/keymap_keyboard.dart';
import 'box_chrome.dart';
import 'prompt_context.dart';
import '../shared/theme/status_line_style.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'desktop_chrome.dart';
import 'search_result_text.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../state/swarm_navigation.dart';
import '../state/session_content_search.dart';
import '../state/swarm_search.dart';
import '../models/model_search_catalog.dart';
import '../state/harness_sessions.dart' show SessionFilter, harnessActivityAge;
import '../store/store_mark.dart';
import 'engine_identity.dart';
import 'swarm_icon.dart';
import 'swarm_search_preview.dart';
import 'swarm_resource_preview.dart';
import 'key_hints.dart';

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
  void _close() => Navigator.pop(context);

  bool get _composing =>
      _query.value.composing.isValid && !_query.value.composing.isCollapsed;

  @override
  void dispose() {
    _query.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return DesktopChrome(
      child: Dialog(
        alignment: const Alignment(0, -0.5),
        insetPadding: const EdgeInsets.all(20),
        backgroundColor: Colors.transparent,
        elevation: 0,
        child: SizedBox(
          width: 680,
          height: 480,
          child: DesktopDialogSurface(
            child: Actions(
              // EditableText can resolve Escape before the picker shortcuts.
              // A composing editor keeps that key; Close remains available.
              actions: {
                DismissIntent: CallbackAction<DismissIntent>(
                  onInvoke: (_) {
                    if (!_composing) _close();
                    return null;
                  },
                ),
              },
              child: Column(
                children: [
                  DesktopDialogHeader(
                    title: 'History',
                    detail: 'This window',
                    onClose: _close,
                  ),
                  Expanded(
                    // Enter belongs to the focused Close button in the header;
                    // result acceptance only applies within the search area.
                    child: SwarmSearchKeys(
                      desktop: true,
                      search: widget.search,
                      editing: _query,
                      onChoose: _choose,
                      onClose: _close,
                      onRefocus: _focus.requestFocus,
                      child: Column(
                        children: [
                          Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: DesktopChrome.panelPadding,
                            ),
                            child: SwarmSearchField(
                              controller: _query,
                              focusNode: _focus,
                              autofocus: true,
                              hintText: 'Search history',
                              onChanged: widget.search.setQuery,
                            ),
                          ),
                          const SizedBox(height: DesktopChrome.controlGap),
                          Expanded(
                            child: Padding(
                              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                              child: SwarmSearchResults(
                                search: widget.search,
                                onChoose: _choose,
                                onRefocus: _focus.requestFocus,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
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
    this.previewControls,
    this.desktop = false,
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
  final SearchPreviewControls? previewControls;
  final bool desktop;
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
      if (previewControls?.invoke('picker.cancel') == true) return;
      if (search?.back() == true) {
        onRefocus?.call();
      } else {
        onClose();
      }
    }

    void choose(bool add) => run(() {
      if (!add && previewControls?.invoke('picker.accept') == true) return;
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
      if (previewControls?.invoke(
            delta > 0 ? 'picker.next' : 'picker.previous',
          ) ==
          true) {
        return;
      }
      if (search == null) {
        onOpen?.call();
      } else {
        search.moveVisually(delta);
        onRefocus?.call();
      }
    });
    void complete(bool forward) => run(() {
      if (desktop) {
        if (forward) {
          FocusManager.instance.primaryFocus?.nextFocus();
        } else {
          FocusManager.instance.primaryFocus?.previousFocus();
        }
        return;
      }
      if (previewControls?.invoke(
            forward ? 'picker.complete' : 'picker.complete_back',
          ) ==
          true) {
        return;
      }
      if (search?.setupLayout == true) {
        move(forward ? 1 : -1);
      } else if (forward) {
        FocusManager.instance.primaryFocus?.nextFocus();
      } else {
        FocusManager.instance.primaryFocus?.previousFocus();
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
              'picker.page_up': () => run(() => search.pageResults(-1)),
              'picker.page_down': () => run(() => search.pageResults(1)),
              'picker.preview_up': () => run(() => search.scrollPreview(-1)),
              'picker.preview_down': () => run(() => search.scrollPreview(1)),
              'picker.preview_page_up': () => run(() => search.page(-1)),
              'picker.preview_page_down': () => run(() => search.page(1)),
            },
            'picker.cancel': dismiss,
            'picker.complete': () => complete(true),
            'picker.complete_back': () => complete(false),
            if (previewControls != null) ...{
              for (final command in resourcePickerCommands)
                command: () => run(() => previewControls!.invoke(command)),
              'picker.more_options': () =>
                  run(() => previewControls!.invoke('picker.resource_more')),
            },
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
                  text: '>',
                  selection: TextSelection.collapsed(offset: 1),
                );
                if (search == null) {
                  onOpen?.call();
                } else {
                  search.setQuery('>');
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
              if (onCommands != null) ...{
                const SingleActivator(
                  LogicalKeyboardKey.keyP,
                  meta: true,
                  shift: true,
                  includeRepeats: false,
                ): () =>
                    run(onCommands!),
                const SingleActivator(
                  LogicalKeyboardKey.keyP,
                  control: true,
                  shift: true,
                  includeRepeats: false,
                ): () =>
                    run(onCommands!),
              },
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
              if (previewControls != null)
                const SingleActivator(
                  LogicalKeyboardKey.period,
                  meta: true,
                ): () =>
                    run(() => previewControls!.invoke('picker.resource_more')),
              if (previewControls != null || desktop) ...{
                const SingleActivator(LogicalKeyboardKey.tab): () =>
                    complete(true),
                const SingleActivator(
                  LogicalKeyboardKey.tab,
                  shift: true,
                ): () =>
                    complete(false),
              },
              if (search != null) ...{
                const SingleActivator(
                  LogicalKeyboardKey.slash,
                  control: true,
                ): () =>
                    run(search.togglePreview),
                const SingleActivator(LogicalKeyboardKey.pageUp): () =>
                    run(() => search.pageResults(-1)),
                const SingleActivator(LogicalKeyboardKey.pageDown): () =>
                    run(() => search.pageResults(1)),
                const SingleActivator(
                  LogicalKeyboardKey.arrowUp,
                  shift: true,
                ): () =>
                    run(() => search.scrollPreview(-1)),
                const SingleActivator(
                  LogicalKeyboardKey.arrowDown,
                  shift: true,
                ): () =>
                    run(() => search.scrollPreview(1)),
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
      child: previewControls == null
          ? child
          : Focus(
              canRequestFocus: false,
              onKeyEvent: (_, event) {
                if (composing()) return KeyEventResult.ignored;
                final stroke = keyStrokeForEvent(event);
                if (stroke == null) return KeyEventResult.ignored;
                final command = harnessDefaultKeymap.match(
                  KeymapContext.picker,
                  [stroke],
                ).command;
                if (!resourcePickerCommands.contains(command)) {
                  return KeyEventResult.ignored;
                }
                if (event is KeyDownEvent) previewControls!.invoke(command!);
                return KeyEventResult.handled;
              },
              child: child,
            ),
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
          ? scale.scale(grid.AppType.monoSize) * 1.35 +
                scale.scale(grid.AppType.monoSize) * 1.35 +
                8
          : boxRowHeight(scale)
    : (scale.scale(grid.AppType.monoLabelSize) * 1.2 + 14).clamp(
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
    this.bios = false,
    this.header,
    this.previewBuilder,
    this.showPreview = true,
  });
  final SwarmSearchController search;
  final ValueChanged<SwarmSearchSelection> onChoose;
  final VoidCallback onRefocus;
  final double sideBySideMinWidth;

  /// Let the overlay shrink to whole rows after its editor and hints have
  /// taken their actual heights, including larger text and warning messages.
  final bool fitRows;
  final bool terminal;
  final bool bios;
  final Widget? header;
  final Widget Function()? previewBuilder;
  final bool showPreview;
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
  Timer? _activityClock;
  final _resultsKey = GlobalKey();
  double _rowHeight = 56;
  double _modelHeadingHeight = 28;
  bool _desktopRows = false;
  bool _revealScheduled = false;
  bool _createPinned = false;
  int _lastPage = 0;
  (Size, double)? _geometry;
  SwarmSearchController get search => widget.search;

  /// The model list as drawn: each section's heading, then its rows. [key] is the section's own
  /// label, which stays put while a heading such as `Get for this Mac · 64 GB` follows its machine.
  List<({int? index, String? heading, String? key})> get _modelRows {
    if (!search.isModelMode) return const [];
    final items = <({int? index, String? heading, String? key})>[];
    for (final section in ModelSearchSection.values) {
      final indices = [
        for (final (index, row) in search.rows.indexed)
          if (search.modelSection(row) == section) index,
      ];
      // An empty section still says it is there, so there is somewhere to add to — except the
      // downloads, which a machine with the whole catalog, or none, has nothing under, and what is
      // shared with you while Grid is not set up: the Set up row under Your models stands for it.
      if (indices.isEmpty &&
          (search.matchQuery.trim().isNotEmpty ||
              section == ModelSearchSection.catalog ||
              (section == ModelSearchSection.shared &&
                  search.gridSetupOffered))) {
        continue;
      }
      if (items.isNotEmpty) items.add((index: null, heading: null, key: null));
      items.add((
        index: null,
        heading: search.modelSectionLabel(section),
        key: section.label,
      ));
      items.addAll(
        indices.map((index) => (index: index, heading: null, key: null)),
      );
    }
    return items;
  }

  double _modelItemHeight(({int? index, String? heading, String? key}) item) =>
      !_desktopRows || item.index != null
      ? _rowHeight
      : item.heading == null
      ? 8
      : _modelHeadingHeight;

  double _fittedHeight(
    BoxConstraints constraints, {
    required bool sideBySide,
    required bool unavailable,
  }) {
    final hasPreview = widget.showPreview && search.hasPreview;
    final stacked = hasPreview && !sideBySide;
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
    final count = hasPreview
        ? capacity.clamp(1, maxRows)
        : search.rows.length.clamp(1, capacity.clamp(1, maxRows));
    final listHeight = chrome + count * _rowHeight;
    return stacked ? 8 + listHeight * 11 / 5 : listHeight;
  }

  @override
  void initState() {
    super.initState();
    if (widget.bios) {
      _activityClock = Timer.periodic(const Duration(minutes: 1), (_) {
        if (mounted) setState(() {});
      });
    }
    search.addListener(_changed);
    terminalFontStore.addListener(_fontChanged);
    _lastPage = search.resultPage.value;
    search.resultPage.addListener(_pageResults);
  }

  @override
  void didUpdateWidget(SwarmSearchResults oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.search != search) {
      oldWidget.search.removeListener(_changed);
      oldWidget.search.resultPage.removeListener(_pageResults);
      search.addListener(_changed);
      search.resultPage.addListener(_pageResults);
      _lastPage = search.resultPage.value;
      _announced = null;
      _rowWidgets.clear();
      _revealSelection();
    }
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
          '${search.sessionUnavailable(row) ?? search.actionLabel(row)}',
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
      !search.isModelMode &&
      search.resultsFromBottom &&
      search.rows.firstOrNull?.isCreate == true;

  void _scrollToSelection() {
    if (!_scroll.hasClients || search.rows.isEmpty) return;
    final modelRows = _modelRows;
    final index = search.isModelMode
        ? modelRows.indexWhere((item) => item.index == search.cursor)
        : search.cursor - (_createPinned ? 1 : 0);
    if (index < 0) return;
    final top = search.isModelMode
        ? modelRows
              .take(index)
              .fold(0.0, (height, item) => height + _modelItemHeight(item))
        : index * _rowHeight;
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
    _activityClock?.cancel();
    search.removeListener(_changed);
    terminalFontStore.removeListener(_fontChanged);
    search.resultPage.removeListener(_pageResults);
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final scale = MediaQuery.textScalerOf(context);
    final desktop = DesktopChrome.of(context);
    final cell = widget.bios ? terminalCellSizeOf(context) : Size.zero;
    final keyHints = KeyHints.visibleOf(context);
    final acceptKey = keyHints
        ? effectiveCommandHint(
            context,
            'picker.accept',
            contextKind: KeymapContext.picker,
          )
        : null;
    final selected = search.selected;
    final unavailable =
        search.sessionUnavailable(selected) == null &&
        ((selected != null && !search.canSubmit(selected)) ||
            search.adding &&
                !search.canCreate &&
                !search.isCommandMode &&
                !search.isHelpMode &&
                !search.isGroupMode &&
                !search.isModelMode &&
                !search.isStoreMode);
    return LayoutBuilder(
      builder: (context, constraints) {
        final sideBySide = constraints.maxWidth >= widget.sideBySideMinWidth;
        final resultWidth =
            widget.showPreview && search.hasPreview && sideBySide
            ? (constraints.maxWidth - 1) * (desktop ? .44 : .6)
            : constraints.maxWidth;
        final stacked =
            widget.terminal &&
            !search.isCommandMode &&
            !search.isHelpMode &&
            resultWidth <
                700 *
                    scale.scale(grid.AppType.monoSize) /
                    grid.AppType.monoSize;
        final singleLine = search.isCommandMode || search.setupLayout;
        _rowHeight = swarmSearchRowHeight(
          scale,
          commands: search.isCommandMode,
          terminal: widget.terminal,
          stacked: stacked,
        );
        if (widget.bios) {
          // All Cmd-P types put context in the preview and use one row per
          // result. Other pickers retain their descriptions and spacing.
          _rowHeight = cell.height * (singleLine ? 1 : 3);
        }
        if (desktop) {
          // Commands and models are one line a row; everything else carries a second. A model row
          // is still a resource row, and keeps the 44-point target every one of those has — the
          // slot is 4 points taller than the row it holds.
          final oneLine = scale.scale(14) * 1.5 + 16;
          _rowHeight = search.isCommandMode
              ? oneLine
              : search.isModelMode
              ? oneLine.clamp(48, double.infinity)
              : scale.scale(14) * 2.8 + 16;
        }
        _desktopRows = desktop;
        _modelHeadingHeight = scale.scale(12) * 1.45 + 12;
        final height = widget.fitRows
            ? _fittedHeight(
                constraints,
                sideBySide: sideBySide,
                unavailable: unavailable,
              )
            : constraints.maxHeight;
        final compactAction =
            (sideBySide ? constraints.maxWidth / 2 : constraints.maxWidth) <
            380 * scale.scale(grid.AppType.monoSize) / grid.AppType.monoSize;
        final geometry = (Size(constraints.maxWidth, height), _rowHeight);
        if (_geometry != geometry) {
          _geometry = geometry;
          _revealSelection();
        }
        // The create action is outside the scrolling matches. Its location
        // does not change when a query, preview, or selection changes.
        final pinCreate = _createPinned =
            _pinsCreate && constraints.maxHeight >= _rowHeight + 16;
        final modelRows = _modelRows;
        Widget buildRow(BuildContext context, int index) {
          final row = search.rows[index];
          final selected = index == search.cursor;
          final highlighted = selected && !search.managing;
          final canSubmit = search.canSubmit(row);
          final unavailableReason = search.sessionUnavailable(row);
          final alreadyHere = search.alreadyHere(row);
          // As of this opening, like the order: the list does not move while
          // it is open. Under a minute is "now", not "0m".
          final activity = widget.bios ? search.activityOf(row) : null;
          final activityAge = activity == null
              ? null
              : search.openedAt.difference(activity).inMinutes < 1
              ? 'now'
              : harnessActivityAge(activity, search.openedAt);
          final presentation = (
            row,
            selected,
            highlighted,
            canSubmit,
            unavailableReason,
            alreadyHere,
            highlighted ? (search.canAccept, search.actionLabel(row)) : null,
            _rowHeight,
            cell,
            compactAction,
            grid.AppType.monoFamily,
            grid.AppTheme.palette.value,
            desktop ? grid.AppTheme.brightness.value : null,
            widget.bios ? theme : null,
            acceptKey,
            widget.terminal,
            desktop,
            stacked,
            activityAge,
            row.isModel ? search.modelRowAction(row) : null,
            row.isModel ? search.canSelectModel(row) : null,
            row.isModel ? search.canGetModel(row) : null,
          );
          final previous = _rowWidgets.remove(row.id);
          if (previous?.presentation == presentation) {
            _rowWidgets[row.id] = previous!;
            return FocusTraversalOrder(
              order: NumericFocusOrder(index.toDouble()),
              child: previous.child,
            );
          }
          final tile = widget.bios
              ? Semantics(
                  selected: selected,
                  enabled: canSubmit,
                  button: true,
                  child: InkWell(
                    key: ValueKey(row.id),
                    onFocusChange: (focused) {
                      if (focused) _focusResult(row.id);
                    },
                    onTap: canSubmit ? () => _submit(row) : null,
                    hoverColor: Colors.transparent,
                    focusColor: Colors.transparent,
                    highlightColor: Colors.transparent,
                    splashFactory: NoSplash.splashFactory,
                    child: _SearchRowContent(
                      search: search,
                      row: row,
                      terminal: true,
                      stacked: true,
                      bios: true,
                      singleLine: singleLine,
                      highlighted: highlighted,
                      enabled: canSubmit,
                      cellSize: cell,
                      activityAge: activityAge,
                      unavailableReason: unavailableReason,
                    ),
                  ),
                )
              : ListTile(
                  key: ValueKey(row.id),
                  minTileHeight: _rowHeight,
                  enabled: canSubmit,
                  onFocusChange: (focused) {
                    if (focused) _focusResult(row.id);
                  },
                  selected: highlighted,
                  selectedColor: desktop
                      ? DesktopChrome.foreground
                      : boxText(1),
                  hoverColor: desktop
                      ? DesktopChrome.foreground.withValues(alpha: .045)
                      : Colors.transparent,
                  focusColor: desktop
                      ? DesktopChrome.accent.withValues(alpha: .08)
                      : null,
                  // BoxRowHighlight draws the selection, the same
                  // in both modes of the box.
                  selectedTileColor: Colors.transparent,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(
                      widget.terminal && !desktop
                          ? 0
                          : desktop
                          ? 10
                          : 6,
                    ),
                  ),
                  dense: true,
                  visualDensity: VisualDensity.compact,
                  minVerticalPadding: 0,
                  horizontalTitleGap: 10,
                  minLeadingWidth: desktop ? 28 : 20,
                  contentPadding: EdgeInsets.symmetric(
                    horizontal: desktop ? 14 : 10,
                  ),
                  // The dock uses its full-row highlight for
                  // selection; prefixes only appear in the input.
                  // The models list has no icons: its section headings already say what each row
                  // is, and one mark per kind added nothing the text did not.
                  leading:
                      (widget.terminal && !desktop) ||
                          (desktop && search.isModelMode)
                      ? null
                      : desktop
                      ? row.isStore
                            ? StoreMark(size: 28, enabled: canSubmit)
                            : row.isAgentChoice ||
                                  row.agentId != null ||
                                  row.isStoreEntry ||
                                  (row.isSwarm && row.members.length == 1)
                            ? EngineMark(
                                engine: row.storeId ?? row.engine,
                                size: 28,
                                enabled: canSubmit,
                              )
                            : row.isSwarm
                            ? SwarmIcon(
                                size: 26,
                                color: highlighted
                                    ? DesktopChrome.onSelection
                                    : DesktopChrome.muted,
                              )
                            : Icon(
                                row.isProject
                                    ? AppIcons.folder
                                    : row.isMachine
                                    ? AppIcons.laptop
                                    : row.isModel
                                    ? AppIcons.sparkles
                                    : row.isCreate
                                    ? AppIcons.plus
                                    : row.isCommand
                                    ? AppIcons.command
                                    : AppIcons.terminal,
                                size: 22,
                                color: highlighted
                                    ? DesktopChrome.onSelection
                                    : DesktopChrome.muted,
                              )
                      : Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            // Every command wore the same ⌘: a column
                            // of identical marks says nothing. Its
                            // own key, at the right, says something.
                            row.isCommand ||
                                    row.isNote ||
                                    row.pickerQuery != null
                                ? const SizedBox(width: 2)
                                : row.isCreate
                                ? Icon(
                                    AppIcons.plus,
                                    size: 18,
                                    color: boxText(.70),
                                  )
                                : row.isStore
                                ? StoreMark(size: 20, enabled: canSubmit)
                                : row.isAgentChoice ||
                                      row.agentId != null ||
                                      (row.isSwarm && row.members.length == 1)
                                ? EngineMark(
                                    engine: row.engine,
                                    size: 20,
                                    enabled: canSubmit,
                                  )
                                : row.isProject
                                ? Icon(
                                    AppIcons.folderOpen,
                                    size: 18,
                                    color: boxText(.60),
                                  )
                                : row.isMachine
                                ? Icon(
                                    AppIcons.monitor,
                                    size: 18,
                                    color: boxText(.60),
                                  )
                                : SwarmIcon(size: 20, color: boxText(.60)),
                          ],
                        ),
                  title: _SearchRowContent(
                    search: search,
                    row: row,
                    terminal: widget.terminal,
                    stacked: desktop || stacked,
                    highlighted: desktop && highlighted,
                  ),
                  trailing: desktop
                      ? row.shortcut == null
                            ? null
                            : Text(
                                row.shortcut!,
                                style: grid.AppType.monoMeta(
                                  color: highlighted
                                      ? DesktopChrome.selectionDetail
                                      : DesktopChrome.muted,
                                ),
                              )
                      : widget.terminal
                      ? (highlighted
                            ? Text(
                                acceptKey ?? '',
                                key: const ValueKey('swarm-row-action'),
                                style: boxMonoStyle(color: kBoxFaint),
                              )
                            : row.shortcut == null || !keyHints
                            ? null
                            : Text(
                                row.shortcut!,
                                style: boxMonoStyle(color: kBoxFaint),
                              ))
                      : alreadyHere && search.placement == null
                      ? Text(
                          'Already added',
                          style: boxMonoStyle(color: kBoxFaint),
                        )
                      : highlighted
                      ? ConstrainedBox(
                          constraints: BoxConstraints(
                            maxWidth:
                                170 *
                                scale.scale(grid.AppType.bodySize) /
                                grid.AppType.bodySize,
                          ),
                          child: TextButton(
                            key: const ValueKey('swarm-row-action'),
                            onPressed: search.canAccept ? _submit : null,
                            style: TextButton.styleFrom(
                              foregroundColor: boxText(1),
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
                          style: boxMonoStyle(color: boxText(.60)),
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
                if (_pointer.moved(event) && !search.managing) {
                  _focusResult(row.id);
                }
              },
              child: desktop
                  ? Padding(
                      padding: const EdgeInsets.symmetric(vertical: 2),
                      child: Material(
                        key: ValueKey('swarm-search-line:${row.id}'),
                        color: highlighted
                            ? DesktopChrome.activeSelection
                            : Colors.transparent,
                        borderRadius: BorderRadius.circular(10),
                        child: tile,
                      ),
                    )
                  : widget.bios
                  ? tile
                  : BoxRowHighlight(
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
              ?widget.header,
              Expanded(
                child: search.rows.isEmpty
                    ? _SearchInventoryEmptyState(
                        search: search,
                        child: Center(
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 24),
                            child: Text(
                              search.isCommandMode
                                  ? 'No matching commands'
                                  : search.sessionFilter ==
                                        SessionFilter.needsInput
                                  ? search.matchQuery.isEmpty
                                        ? 'No harnesses need your input'
                                        : 'No matching harnesses'
                                  : search.isModelMode
                                  ? 'No matching models'
                                  : search.isStoreMode
                                  ? 'No matching store entries'
                                  : search.isHelpMode
                                  ? 'No matching modes or help'
                                  : search.isProjectMode
                                  ? 'No matching projects'
                                  : search.isMachineMode
                                  ? 'No matching machines'
                                  : search.adding &&
                                        search.query.isEmpty &&
                                        search.capacity <= 0
                                  ? 'This tab is full (${AppNotifier.maxPanes} panes). Open a new tab to add more.'
                                  : search.adding && search.query.isEmpty
                                  ? desktop
                                        ? 'No harnesses yet. Start one with New Harness, or choose Machines to connect a computer.'
                                        : 'No harnesses yet. Start an agent or choose @ machines to connect a machine.'
                                  : search.adding
                                  ? 'No matching harnesses'
                                  : 'No matching results',
                              textAlign: TextAlign.center,
                              style: desktop
                                  ? DesktopChrome.text(
                                      color: DesktopChrome.muted,
                                    )
                                  : widget.bios
                                  ? terminalContentStyle(color: theme.muted)
                                  : grid.AppType.monoLabel(
                                      fontWeight: FontWeight.w400,
                                      color: boxText(.60),
                                    ),
                            ),
                          ),
                        ),
                      )
                    : Padding(
                        padding: EdgeInsets.only(
                          top: widget.bios ? 0 : 8,
                          bottom: pinCreate
                              ? 0
                              : widget.bios
                              ? cell.height
                              : 8,
                        ),
                        child: FocusTraversalOrder(
                          order: const NumericFocusOrder(1),
                          child: FocusTraversalGroup(
                            policy: OrderedTraversalPolicy(),
                            descendantsAreTraversable: !desktop,
                            child: ListView.builder(
                              key: const ValueKey('swarm-search-result-list'),
                              padding: EdgeInsets.symmetric(
                                horizontal: widget.bios ? cell.width : 8,
                              ),
                              controller: _scroll,
                              // The dock only shows a few rows. Building the
                              // default 250 px beyond each edge can do more
                              // work than the visible results on Cmd+O. Keep
                              // one extra row for Tab focus traversal; arrows
                              // and paging reveal targets by their fixed size.
                              scrollCacheExtent: ScrollCacheExtent.pixels(
                                _rowHeight,
                              ),
                              reverse: search.resultsFromBottom,
                              itemCount: search.isModelMode
                                  ? modelRows.length
                                  : search.rows.length - (pinCreate ? 1 : 0),
                              itemExtent: desktop && search.isModelMode
                                  ? null
                                  : _rowHeight,
                              itemExtentBuilder: desktop && search.isModelMode
                                  ? (index, _) =>
                                        _modelItemHeight(modelRows[index])
                                  : null,
                              itemBuilder: (context, index) {
                                if (!search.isModelMode) {
                                  return buildRow(
                                    context,
                                    index + (pinCreate ? 1 : 0),
                                  );
                                }
                                final item = modelRows[index];
                                if (item.index != null) {
                                  return buildRow(context, item.index!);
                                }
                                if (item.heading == null) {
                                  return const SizedBox();
                                }
                                return Semantics(
                                  header: true,
                                  child: Padding(
                                    key: ValueKey('model-section:${item.key}'),
                                    padding: EdgeInsets.symmetric(
                                      horizontal: widget.bios
                                          ? cell.width * 3
                                          : desktop
                                          ? 14
                                          : 10,
                                    ),
                                    child: Align(
                                      alignment: desktop
                                          ? Alignment.centerLeft
                                          : Alignment.topLeft,
                                      child: Text(
                                        item.heading!,
                                        maxLines: 1,
                                        style: desktop
                                            ? DesktopChrome.text(
                                                size: 12,
                                                color: DesktopChrome.muted,
                                              )
                                            : widget.bios
                                            ? terminalContentStyle(
                                                color: theme.muted,
                                              )
                                            : grid.AppType.monoLabel(
                                                color: boxText(.60),
                                              ),
                                      ),
                                    ),
                                  ),
                                );
                              },
                            ),
                          ),
                        ),
                      ),
              ),
              if (unavailable) ...[
                SizedBox(
                  height: widget.bios ? cell.height * 2 : 48,
                  child: Padding(
                    padding: EdgeInsets.symmetric(
                      horizontal: widget.bios ? cell.width * 4 : 12,
                    ),
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
                            style: desktop
                                ? DesktopChrome.text(color: DesktopChrome.muted)
                                : widget.bios
                                ? terminalContentStyle(color: theme.muted)
                                : grid.AppType.monoLabel(
                                    fontWeight: FontWeight.w400,
                                    color: boxText(.60),
                                  ),
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
        final preview =
            widget.showPreview &&
                search.hasPreview &&
                (!widget.bios || sideBySide || widget.previewBuilder != null)
            ? widget.previewBuilder?.call() ??
                  SwarmSearchPreview(
                    key: const ValueKey('swarm-search-preview'),
                    search: search,
                    compactHeader: constraints.maxWidth < 800,
                    terminal: widget.terminal,
                  )
            : null;
        // Side by side, the two columns keep their share whether or not
        // there is anything to preview: a list that widened every time the
        // preview went away made the rows move under the reader's eye.
        final content = sideBySide && (widget.bios || preview != null)
            ? Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // A compact list leaves room to read the selected work.
                  Expanded(flex: desktop ? 11 : 5, child: results),
                  if (desktop)
                    VerticalDivider(
                      width: 1,
                      thickness: 1,
                      color: DesktopChrome.rim,
                    )
                  else if (widget.terminal)
                    VerticalDivider(
                      width: 1,
                      thickness: 1,
                      color: (widget.bios ? theme.foreground : boxInk(1))
                          .withValues(alpha: .16),
                    )
                  else
                    const SizedBox(width: 8),
                  Expanded(
                    flex: desktop ? 14 : 5,
                    child: preview ?? const SizedBox(),
                  ),
                ],
              )
            : preview == null
            ? results
            : desktop
            ? Column(
                children: [
                  SizedBox(
                    height: math.min(
                      height * .45,
                      16 +
                          _rowHeight *
                              (search.isModelMode
                                      ? modelRows.length
                                      : search.rows.length)
                                  .clamp(1, 4),
                    ),
                    child: results,
                  ),
                  Divider(height: 1, color: DesktopChrome.rim),
                  Expanded(child: preview),
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
                    padding: widget.bios
                        ? EdgeInsets.fromLTRB(
                            cell.width,
                            0,
                            cell.width,
                            cell.height,
                          )
                        : const EdgeInsets.fromLTRB(8, 0, 8, 8),
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

/// Inventory refreshes can leave the cached catalog unchanged, so listen to
/// their presentation state directly without changing search ranking or focus.
class _SearchInventoryEmptyState extends StatelessWidget {
  const _SearchInventoryEmptyState({required this.search, required this.child});

  final SwarmSearchController search;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (!DesktopChrome.of(context) ||
        search.history != null ||
        search.isCommandMode ||
        search.isHelpMode ||
        search.isModelMode ||
        search.isStoreMode) {
      return child;
    }
    return ListenableBuilder(
      listenable: search.app,
      builder: (context, _) {
        final app = search.app;
        final pending = app.machinesLoading || app.machinesRefreshing;
        final error = app.machineListError;
        if (!pending && error == null) return child;
        final resource = search.isMachineMode
            ? 'machines'
            : search.isProjectMode
            ? 'projects'
            : 'harnesses';
        void retry() {
          if (!app.machinesLoading && !app.machinesRefreshing) {
            unawaited(app.retryMachines());
          }
        }

        return Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Semantics(
              key: const ValueKey('swarm-search-inventory-state'),
              liveRegion: true,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    pending
                        ? 'Loading $resource…'
                        : 'Couldn’t load your $resource',
                    textAlign: TextAlign.center,
                    style: DesktopChrome.text(color: DesktopChrome.muted),
                  ),
                  if (error != null) ...[
                    if (!pending) ...[
                      const SizedBox(height: 8),
                      Text(
                        error,
                        textAlign: TextAlign.center,
                        style: DesktopChrome.metadata(),
                      ),
                    ],
                    const SizedBox(height: 12),
                    KeymapRegion(
                      contextKind: KeymapContext.picker,
                      composing: KeymapRegion.of(context)?.composing,
                      actions: {
                        ...?KeymapRegion.of(context)?.actions,
                        'picker.accept': retry,
                        'picker.refresh': retry,
                      },
                      child: DesktopPill(
                        key: const ValueKey('swarm-search-inventory-retry'),
                        label: pending ? 'Retrying…' : 'Retry',
                        onPressed: pending ? null : retry,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

// Typing changes the match text even when the row, its controls, and its focus
// state stay the same. Listen here so the cached row can keep that state.
class _SearchRowContent extends StatefulWidget {
  const _SearchRowContent({
    required this.search,
    required this.row,
    required this.terminal,
    required this.stacked,
    this.bios = false,
    this.singleLine = false,
    this.highlighted = false,
    this.enabled = true,
    this.cellSize,
    this.activityAge,
    this.unavailableReason,
  });

  final SwarmSearchController search;
  final SwarmDestination row;
  final bool terminal;
  final bool stacked;
  final bool bios;
  final bool singleLine;
  final bool highlighted;
  final bool enabled;
  final Size? cellSize;
  final String? activityAge;
  final String? unavailableReason;

  @override
  State<_SearchRowContent> createState() => _SearchRowContentState();
}

class _SearchRowContentState extends State<_SearchRowContent> {
  /// The arrow before an API's name, and the gap after it.
  static const _apiMarkerSize = 16.0;
  static const _apiMarkerGap = 4.0;

  /// The widest word a model row of yours ends with (`Downloading`): the column is that wide, so
  /// the size and speed columns ahead of it line up whatever each row says.
  static const _modelWordColumns = 11;

  /// A model row's last word. It is green only while something is live — running, in use, a
  /// download under way; an action (Use, Get) is plain; a failure is a warning; a state is muted.
  /// [row]'s size and speed columns, when a row [width] wide keeps room for the model's name.
  String? _modelFacts(SwarmDestination row, double width, Size cell) =>
      width >= cell.width * 58 ? widget.search.modelRowFacts(row) : null;

  Widget _modelRowWord(
    SwarmDestination row,
    String status, {
    required bool aligned,
    required Color live,
    required Color foreground,
    required Color warning,
    required Color muted,
    required Size cell,
  }) {
    final search = widget.search;
    final color = search.modelRowLive(row)
        ? live
        : search.modelRowFailed(row)
        ? warning
        : status == search.modelRowAction(row)
        ? foreground
        : muted;
    final text = Text(
      status,
      key: ValueKey('model-row-status:${row.id}'),
      maxLines: 1,
      textAlign: TextAlign.right,
      style: terminalContentStyle(color: color),
    );
    return aligned
        ? SizedBox(width: cell.width * _modelWordColumns, child: text)
        : text;
  }

  late (String, bool, SessionContentHit?) _query;

  /// What this row draws from the search: its words, and what a machine's
  /// session index found in its conversation, which can land after the words.
  (String, bool, SessionContentHit?) get _currentQuery => (
    widget.search.wordsQuery,
    widget.search.isHelpMode,
    widget.search.contentHitFor(widget.row.id),
  );

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
    final terms = swarmQueryTerms(_query.$1);
    final matches = searchResultMatches(row, terms);
    // Found in what was said rather than in the row's own name and context:
    // the second line shows where, instead of the context that did not match.
    final hit = widget.search.contentHitFor(row.id);
    final snippet =
        hit != null &&
            hit.snippet.isNotEmpty &&
            hit.field != 'name' &&
            (terms.isEmpty || matches.length < terms.take(12).toSet().length)
        ? hit
        : null;
    if (DesktopChrome.of(context)) {
      final ink = widget.highlighted
          ? DesktopChrome.onSelection
          : DesktopChrome.foreground;
      final muted = widget.highlighted
          ? DesktopChrome.selectionDetail
          : DesktopChrome.muted;
      final title = widget.search.isModelMode && row.isCreate
          ? 'Add API connection'
          : row.isModel
          ? widget.search.modelRowTitle(row)
          : row.title;
      final unavailable = widget.search.sessionUnavailable(row);
      final api = row.isModel ? widget.search.apiRowState(row) : null;
      final underApi = row.isModel && widget.search.isApiModelRow(row);
      final modelStatus = row.isModel
          ? widget.search.modelRowStatus(row)
          : null;
      final status = unavailable ?? api?.hint ?? modelStatus;
      // One line a model: a local model's size and speed sit muted before its word at the right.
      final facts = row.isModel
          ? widget.search
                .modelRowFacts(row)
                ?.trim()
                .replaceAll(RegExp(r' {2,}'), ' · ')
          : null;
      final modelFacts = facts?.isNotEmpty == true ? facts : null;
      final subscription = row.isModel
          ? widget.search.models?.entries[row.modelId]?.subscription
          : null;
      final account = '${subscription?['account'] ?? ''}'.trim();
      final subscriptionAccount = subscription != null && account.isNotEmpty
          ? (
              provider: '${subscription['title'] ?? 'Subscription'}',
              account: account,
            )
          : null;
      final activity = widget.search.activityOf(row);
      final age = activity == null
          ? null
          : widget.search.openedAt.difference(activity).inMinutes < 1
          ? 'now'
          : harnessActivityAge(activity, widget.search.openedAt);
      final detail = row.terminalDetail ?? row.detail;
      Widget trailingLabel(String text) => Text(
        text,
        key: api != null
            ? ValueKey('api-row-hint:${row.id}')
            : row.isModel
            ? ValueKey('model-row-status:${row.id}')
            : null,
        maxLines: 1,
        textAlign: TextAlign.right,
        style: DesktopChrome.metadata(
          color: widget.highlighted
              ? DesktopChrome.selectionDetail
              : row.isModel && widget.search.modelRowLive(row)
              ? grid.AppTheme.pick(
                  const Color(0xFF246C3F),
                  const Color(0xFF86E6A3),
                )
              : row.isModel && widget.search.modelRowFailed(row)
              ? Theme.of(context).colorScheme.error
              : muted,
        ),
      );
      return Semantics(
        label:
            '$title\n$detail${status == null ? '' : ', $status'}'
            '${status == null && activity != null ? ', Last active ${activity.toLocal()}' : ''}'
            '${snippet == null ? '' : ', Found in conversation: ${snippet.plainSnippet}'}',
        excludeSemantics: true,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                if (underApi) const SizedBox(width: 32),
                if (api != null) ...[
                  Icon(
                    key: ValueKey('api-row-marker:${row.id}'),
                    api.open ? AppIcons.chevronDown : AppIcons.chevronRight,
                    size: _apiMarkerSize,
                    color: muted,
                  ),
                  const SizedBox(width: _apiMarkerGap),
                ],
                Expanded(
                  child: subscriptionAccount != null
                      // A subscription names its provider, and the account after it in the quieter
                      // colour: "Anthropic  315df1", not one run of text where the account reads
                      // as part of the name.
                      ? Row(
                          children: [
                            Flexible(
                              child: SearchResultText(
                                subscriptionAccount.provider,
                                matches: matches.where((match) => match.title),
                                style: DesktopChrome.text(
                                  color: unavailable == null ? ink : muted,
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            SearchResultText(
                              subscriptionAccount.account,
                              key: ValueKey('model-row-account:${row.id}'),
                              matches: matches.where((match) => match.title),
                              style: DesktopChrome.text(color: muted),
                            ),
                          ],
                        )
                      : SearchResultText(
                          title,
                          matches: matches.where((match) => match.title),
                          style: DesktopChrome.text(
                            color: unavailable == null ? ink : muted,
                          ),
                        ),
                ),
                if (modelFacts != null) ...[
                  const SizedBox(width: 12),
                  // A fixed column, so size and speed start at the same place on every row.
                  SizedBox(
                    width: MediaQuery.textScalerOf(context).scale(120),
                    child: Text(
                      modelFacts,
                      key: ValueKey('model-row-facts:${row.id}'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.metadata(color: muted),
                    ),
                  ),
                ],
                if (status ?? age case final trailing?) ...[
                  const SizedBox(width: 12),
                  if (status == null && activity != null)
                    Tooltip(
                      message: 'Last active ${activity.toLocal()}',
                      child: trailingLabel(trailing),
                    )
                  else if (row.isModel && api == null)
                    SizedBox(
                      width: MediaQuery.textScalerOf(context).scale(96),
                      child: trailingLabel(trailing),
                    )
                  else
                    trailingLabel(trailing),
                ],
              ],
            ),
            if (!widget.search.isModelMode &&
                !row.isCommand &&
                !underApi &&
                (detail.isNotEmpty || snippet != null)) ...[
              const SizedBox(height: 2),
              snippet != null
                  ? SessionSnippetText(
                      snippet,
                      style: DesktopChrome.text(size: 12, color: muted),
                    )
                  : SearchResultText(
                      detail,
                      matches: matches.where((match) => !match.title),
                      style: DesktopChrome.metadata(color: muted),
                    ),
            ],
          ],
        ),
      );
    }
    if (widget.bios) {
      final theme = terminalThemeFor(
        grid.AppTheme.palette.value,
        terminalThemeStore.value,
      );
      final muted = theme.muted;
      final modelAction = row.isModel
          ? widget.search.modelRowAction(row)
          : null;
      // A saved API heads its models: a marker says whether they are listed under it, and the end
      // of its row how many there are. Its models sit one step in, under its name.
      final apiRow = row.isModel ? widget.search.apiRowState(row) : null;
      final underApi = row.isModel && widget.search.isApiModelRow(row);
      final style = terminalContentStyle(
        color: row.isNote
            ? muted
            : !widget.enabled ||
                  (row.isModel &&
                      !widget.search.isModelDownloadsRow(row) &&
                      !widget.search.isGridSetupRow(row) &&
                      !widget.search.canExpandApi(row) &&
                      !widget.search.canSelectModel(row) &&
                      !widget.search.canGetModel(row))
            ? theme.foreground.withValues(alpha: .28)
            : row.isCreate ||
                  widget.search.isModelDownloadsRow(row) ||
                  widget.search.isGridSetupRow(row)
            ? theme.cursor
            : theme.foreground,
      );
      final cell = widget.cellSize!;
      final data = row.promptContext;
      final detail = data == null
          ? row.terminalDetail ?? row.detail
          : [
              statusLineParts(
                provider: '',
                machine: data.machine ?? '',
                project: data.project ?? '',
                branch: data.branch,
              ).text,
              if (data.leading?.isNotEmpty == true) data.leading!,
            ].where((part) => part.isNotEmpty).join('  ');
      return Semantics(
        label: row.isCreate
            ? '${row.title}\n$detail'
            : '${row.title}\n${row.terminalDetail ?? row.detail}'
                  '${snippet == null ? '' : ', Found in conversation: ${snippet.plainSnippet}'}'
                  '${modelAction == null ? '' : ', $modelAction'}'
                  '${widget.unavailableReason == null ? '' : ', ${widget.unavailableReason}'}'
                  '${row.shortcut == null ? '' : ', Shortcut ${row.shortcut}'}'
                  '${widget.activityAge == null ? '' : ', Last used ${widget.activityAge} ago'}',
        excludeSemantics: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              key: ValueKey('swarm-search-line:${row.id}'),
              height: cell.height,
              color: widget.highlighted ? theme.selection : Colors.transparent,
              padding: EdgeInsets.symmetric(horizontal: cell.width),
              child: LayoutBuilder(
                builder: (context, constraints) => Row(
                  children: [
                    // Match Cmd-N's empty two-cell gutter.
                    SizedBox(width: cell.width * 2),
                    if (apiRow != null)
                      SizedBox(
                        width: cell.width * 2,
                        child: Text(
                          apiRow.hint == 'Tools'
                              ? ''
                              : apiRow.open
                              ? '▾'
                              : '▸',
                          key: ValueKey('api-row-marker:${row.id}'),
                          style: style,
                        ),
                      )
                    else if (underApi)
                      SizedBox(width: cell.width * 4),
                    if (widget.singleLine && snippet != null) ...[
                      // One line per result: the name, then where the words
                      // were said, the way fzf shows the matching line.
                      ConstrainedBox(
                        constraints: BoxConstraints(
                          maxWidth: constraints.maxWidth * .4,
                        ),
                        child: SearchResultText(
                          row.title,
                          matches: matches.where((match) => match.title),
                          style: style,
                        ),
                      ),
                      SizedBox(width: cell.width * 2),
                      Expanded(
                        child: SessionSnippetText(
                          snippet,
                          style: terminalContentStyle(color: muted),
                        ),
                      ),
                    ] else
                      Expanded(
                        child: row.isCreate
                            ? Text(row.title, style: style, maxLines: 1)
                            : SearchResultText(
                                row.title,
                                matches: matches.where((match) => match.title),
                                style: style,
                              ),
                      ),
                    if (apiRow != null) ...[
                      SizedBox(width: cell.width * 2),
                      Text(
                        apiRow.hint,
                        key: ValueKey('api-row-hint:${row.id}'),
                        maxLines: 1,
                        style: terminalContentStyle(color: muted),
                      ),
                    ] else if (row.isModel) ...[
                      // A model of yours: its size and speed, in columns that line up down the list —
                      // when the list is wide enough to keep its name readable beside them.
                      if (_modelFacts(row, constraints.maxWidth, cell)
                          case final facts?) ...[
                        SizedBox(width: cell.width * 2),
                        Text(
                          facts,
                          key: ValueKey('model-row-facts:${row.id}'),
                          maxLines: 1,
                          style: terminalContentStyle(color: muted),
                        ),
                      ],
                      if (widget.search.modelRowStatus(row)
                          case final status?) ...[
                        SizedBox(width: cell.width * 2),
                        _modelRowWord(
                          row,
                          status,
                          aligned:
                              _modelFacts(row, constraints.maxWidth, cell) !=
                              null,
                          // Pale green reads on a dark ground only; a light one
                          // takes its scheme's own green.
                          live: theme.background.computeLuminance() > .5
                              ? theme.green
                              : const Color(0xFF86E6A3),
                          foreground: theme.foreground,
                          warning: theme.yellow,
                          muted: muted,
                          cell: cell,
                        ),
                      ] else if (_modelFacts(row, constraints.maxWidth, cell) !=
                          null)
                        SizedBox(width: cell.width * (2 + _modelWordColumns)),
                    ],
                    if (widget.unavailableReason case final reason?) ...[
                      SizedBox(width: cell.width * 2),
                      ConstrainedBox(
                        constraints: BoxConstraints(
                          maxWidth: constraints.maxWidth * .4,
                        ),
                        child: Text(
                          reason,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: terminalContentStyle(color: muted),
                        ),
                      ),
                    ] else if (row.shortcut case final shortcut?) ...[
                      SizedBox(width: cell.width * 2),
                      ConstrainedBox(
                        constraints: BoxConstraints(
                          maxWidth: constraints.maxWidth * .4,
                        ),
                        child: Text(
                          shortcut,
                          key: ValueKey('swarm-search-shortcut:${row.id}'),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: terminalContentStyle(color: muted),
                        ),
                      ),
                    ] else if (widget.activityAge case final age?) ...[
                      SizedBox(width: cell.width * 2),
                      Tooltip(
                        message: 'Last active ${row.lastActivityAt!.toLocal()}',
                        child: Text(
                          age,
                          maxLines: 1,
                          style: terminalContentStyle(
                            color: theme.foreground.withValues(alpha: .38),
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            if (!widget.singleLine &&
                !row.isCommand &&
                (detail.isNotEmpty || snippet != null))
              Padding(
                padding: EdgeInsets.only(
                  left: cell.width * 3,
                  right: cell.width,
                ),
                child: SizedBox(
                  height: cell.height,
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: snippet != null
                        ? SessionSnippetText(
                            snippet,
                            style: terminalContentStyle(color: muted),
                          )
                        : SearchResultText(
                            detail,
                            matches: matches.where((match) => !match.title),
                            style: terminalContentStyle(color: muted),
                          ),
                  ),
                ),
              ),
          ],
        ),
      );
    }
    final title = SearchResultText(
      row.title,
      matches: matches.where((match) => match.title),
      style: widget.terminal ? boxMonoStyle() : grid.AppType.monoLabel(),
    );
    final detailText = widget.terminal
        ? row.terminalDetail ?? row.detail
        : row.detail;
    final detail = snippet != null
        ? SessionSnippetText(
            snippet,
            style: widget.terminal
                ? boxMonoStyle(color: kBoxFaint)
                : boxMonoStyle(color: kBoxFaint),
          )
        : widget.terminal && row.promptContext != null
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
                : Icon(AppIcons.gitBranch, size: 12, color: boxText(.60)),
            matches: matches.where((match) => !match.title),
            style: widget.terminal
                ? boxMonoStyle(color: kBoxFaint)
                : boxMonoStyle(color: kBoxFaint),
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
                style: grid.AppType.label(),
              ),
            ),
          if (hint != null) ...[
            if (!compact) const SizedBox(width: 8),
            if (_returnChord.hasMatch(hint)) ...[
              if (hint.length > 1)
                Text(hint.substring(0, hint.length - 1), style: boxMonoStyle()),
              const Icon(AppIcons.cornerDownLeft, size: 14),
            ] else
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 96),
                child: Text(
                  hint.replaceAll('↵', 'Return').replaceAll('⇥', 'Tab'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: boxMonoStyle(),
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
                  onTap: onQuery == null ? null : () => onQuery!('>'),
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
              BoxHint(
                ':',
                'models',
                onTap: onQuery == null ? null : () => onQuery!(': '),
              ),
              BoxHint(
                '*',
                'store',
                onTap: onQuery == null ? null : () => onQuery!('* '),
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
                : boxMonoStyle(color: kBoxFaint),
          ),
        );
      },
    );
  }
}
