import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_pane_icon.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import 'desktop_chrome.dart';
import 'finger_target.dart';
import 'box_chrome.dart' show ReadlineKeys;
import 'swarm_switcher.dart';
import 'swarm_search_input.dart';
import 'key_hints.dart';
import 'machine_picker_extras.dart';

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
    grid.AppTheme.watch(context);
    // A phone's buttons are a finger's size; a mouse keeps 32. On a phone the
    // three glyphs share one size, and the row's right inset puts Close's glyph
    // as far from the edge as the search glyph is on the left.
    final compact = workspaceIsCompact(context);
    final button = compact ? kFingerTarget : 32.0;
    final glyph = compact ? 20.0 : 18.0;
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
                      if (search.harnessContext == null)
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
                if (_machineHooks(context) case final hooks?)
                  ListenableBuilder(
                    listenable: search,
                    builder: (context, _) => search.isMachineMode
                        ? MachinePickerHeader(search: search, hooks: hooks)
                        : const SizedBox.shrink(),
                  ),
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
                if (_machineHooks(context) case final hooks?)
                  ListenableBuilder(
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
                  ),
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
