import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_text.dart';
import 'app_keymap.dart';
import 'key_cap.dart';
import 'keymap_commands.dart';
import 'keymap_settings.dart';
import 'keyboard_practice.dart';

/// Searchable help built from the same resolved bindings that handle input.
/// Shared by the shortcut dialog and Settings; no separate shortcut catalog.
class ShortcutsBrowser extends StatefulWidget {
  const ShortcutsBrowser({super.key, this.onClose, this.autofocus = false});
  final VoidCallback? onClose;
  final bool autofocus;

  @override
  State<ShortcutsBrowser> createState() => _ShortcutsBrowserState();
}

class _ShortcutsBrowserState extends State<ShortcutsBrowser> {
  final _fallback = AppKeymap();
  final _query = TextEditingController();
  final _scroll = ScrollController();
  late final _input = FocusNode(
    debugLabel: 'Search keyboard shortcuts',
    onKeyEvent: _onKey,
  );
  final _rowKeys = <String, GlobalKey>{};
  List<KeyboardLesson> _visible = [];
  int _cursor = -1;
  int _revealRequest = 0;

  AppKeymap get _keymap => KeymapTheme.of(context, listen: false) ?? _fallback;

  @override
  void dispose() {
    _fallback.dispose();
    _query.dispose();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is KeyUpEvent ||
        HardwareKeyboard.instance.isMetaPressed ||
        HardwareKeyboard.instance.isControlPressed ||
        HardwareKeyboard.instance.isAltPressed ||
        !_query.value.composing.isCollapsed) {
      return KeyEventResult.ignored;
    }
    final delta = switch (event.logicalKey) {
      LogicalKeyboardKey.arrowDown => 1,
      LogicalKeyboardKey.arrowUp => -1,
      LogicalKeyboardKey.pageDown => 10,
      LogicalKeyboardKey.pageUp => -10,
      _ => null,
    };
    if (delta != null) {
      if (_visible.isNotEmpty) {
        setState(
          () => _cursor = (_cursor + delta).clamp(0, _visible.length - 1),
        );
        final request = ++_revealRequest;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          unawaited(_revealCursor(request));
        });
      }
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter &&
        event is KeyDownEvent &&
        _visible.isNotEmpty) {
      _practice(_visible[_cursor.clamp(0, _visible.length - 1)]);
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  Future<void> _revealCursor(int request) async {
    // Adjacent rows are normally in the viewport/cache already. A page jump
    // can cross unbuilt rows, especially with large text: advance by a viewport
    // until the target is laid out, then reveal its exact bounds. No guessed
    // fixed row height, and a newer key/filter cancels the pending reveal.
    while (mounted &&
        request == _revealRequest &&
        _cursor >= 0 &&
        _cursor < _visible.length &&
        _scroll.hasClients) {
      final target = _rowKeys[_visible[_cursor].id]?.currentContext;
      if (target != null && target.mounted) {
        await Scrollable.ensureVisible(target, alignment: .5);
        return;
      }
      final firstBuilt = _visible.indexWhere(
        (lesson) => _rowKeys[lesson.id]?.currentContext != null,
      );
      final position = _scroll.position;
      final direction = firstBuilt >= 0 && _cursor < firstBuilt ? -1 : 1;
      final next = (position.pixels + direction * position.viewportDimension)
          .clamp(position.minScrollExtent, position.maxScrollExtent);
      if (next == position.pixels) return;
      _scroll.jumpTo(next);
      await WidgetsBinding.instance.endOfFrame;
    }
  }

  Future<void> _practice(KeyboardLesson lesson) async {
    await showKeyboardPractice(context, keymap: _keymap, initialLesson: lesson);
    if (mounted) _input.requestFocus();
  }

  void _filterChanged(String _) {
    _revealRequest++;
    setState(() => _cursor = -1);
    if (_scroll.hasClients) _scroll.jumpTo(0);
  }

  Widget _lessonRow(KeyboardLesson lesson) => _ShortcutBrowserRow(
    key: _rowKeys.putIfAbsent(lesson.id, GlobalKey.new),
    lesson: lesson,
    selected: _cursor >= 0 && _visible[_cursor].id == lesson.id,
    onTap: () => _practice(lesson),
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    TerminalFontScope.watch(context);
    final keymap = KeymapTheme.of(context) ?? _fallback;
    return ListenableBuilder(
      listenable: Listenable.merge([keymap, terminalFontStore]),
      builder: (context, _) {
        final query = _query.text.trim().toLowerCase();
        final groups = <String, List<KeyboardLesson>>{};
        for (final lesson in keyboardLessons(keymap)) {
          if (lesson.bindings.isEmpty) continue;
          final searchable =
              '${lesson.label} ${lesson.group} ${lesson.keys} ${lesson.bindings.map((b) => b.sequence).join(' ')}'
                  .toLowerCase();
          if (!query.split(RegExp(r'\s+')).every(searchable.contains)) continue;
          groups.putIfAbsent(lesson.group, () => []).add(lesson);
        }
        final names = groups.keys.toList()
          ..sort((a, b) {
            const order = [
              'Essentials',
              'Workspace',
              'Panes',
              'Actions',
              'Search & creation',
              'Agent input overrides',
            ];
            int rank(String name) =>
                order.contains(name) ? order.indexOf(name) : order.length;
            return rank(a).compareTo(rank(b));
          });
        for (final rows in groups.values) {
          rows.sort((a, b) => a.label.compareTo(b.label));
        }
        _visible = [for (final name in names) ...groups[name]!];
        if (_cursor >= _visible.length) _cursor = _visible.length - 1;
        final scale = terminalTextScaleOf(context);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
              child: Row(
                children: [
                  if (widget.onClose != null)
                    IconButton(
                      onPressed: widget.onClose,
                      tooltip: 'Close keyboard shortcuts',
                      icon: Icon(Icons.arrow_back, size: 20 * scale),
                    )
                  else
                    Padding(
                      padding: const EdgeInsets.only(right: 12),
                      child: Icon(
                        Icons.search,
                        size: 20 * scale,
                        color: grid.AppPalette.textSecondary,
                      ),
                    ),
                  Expanded(
                    child: TextField(
                      key: const ValueKey('shortcuts-search'),
                      controller: _query,
                      focusNode: _input,
                      autofocus: widget.autofocus,
                      style: terminalTextStyle(
                        color: grid.AppPalette.textPrimary,
                      ),
                      onChanged: _filterChanged,
                      decoration: InputDecoration(
                        hintText: 'Search keyboard shortcuts…',
                        hintStyle: terminalTextStyle(
                          color: grid.AppPalette.textFaint,
                        ),
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        filled: false,
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          vertical: 12,
                        ),
                      ),
                    ),
                  ),
                  if (_query.text.isNotEmpty)
                    IconButton(
                      tooltip: 'Clear search',
                      icon: Icon(Icons.close, size: 18 * scale),
                      onPressed: () {
                        _query.clear();
                        _filterChanged('');
                        _input.requestFocus();
                      },
                    ),
                  if (keymap.store != null)
                    IconButton(
                      tooltip: 'Edit keyboard shortcuts',
                      icon: Icon(Icons.tune, size: 20 * scale),
                      onPressed: () => openKeyboardConfig(context),
                    ),
                ],
              ),
            ),
            Divider(height: 1, color: grid.AppGlass.hair),
            if (keymap.error != null)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  keymap.error!,
                  style: terminalTextStyle(
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
              ),
            Expanded(
              child: _visible.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(
                          'No shortcuts found. Try an action or a key.',
                          style: terminalTextStyle(
                            color: grid.AppPalette.textSecondary,
                          ),
                        ),
                      ),
                    )
                  : LayoutBuilder(
                      builder: (context, constraints) {
                        final columns =
                            constraints.maxWidth >= 760 * math.max(1, scale)
                            ? 2
                            : 1;
                        return Scrollbar(
                          controller: _scroll,
                          child: ListView(
                            controller: _scroll,
                            padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                            children: [
                              for (final name in names) ...[
                                Padding(
                                  padding: const EdgeInsets.fromLTRB(
                                    12,
                                    20,
                                    12,
                                    10,
                                  ),
                                  child: Text(
                                    name == 'Essentials' ? 'General' : name,
                                    style: terminalTextStyle(
                                      color: grid.AppPalette.textSecondary,
                                    ),
                                  ),
                                ),
                                for (
                                  var row = 0;
                                  row < groups[name]!.length;
                                  row += columns
                                )
                                  Padding(
                                    padding: EdgeInsets.only(
                                      bottom:
                                          row + columns < groups[name]!.length
                                          ? 4
                                          : 0,
                                    ),
                                    child: Row(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        for (
                                          var column = 0;
                                          column < columns;
                                          column++
                                        ) ...[
                                          if (column > 0)
                                            const SizedBox(width: 20),
                                          if (row + column >=
                                              groups[name]!.length)
                                            const Expanded(child: SizedBox())
                                          else
                                            Expanded(
                                              child: _lessonRow(
                                                groups[name]![row + column],
                                              ),
                                            ),
                                        ],
                                      ],
                                    ),
                                  ),
                              ],
                            ],
                          ),
                        );
                      },
                    ),
            ),
            Divider(height: 1, color: grid.AppGlass.hair),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
              child: Wrap(
                spacing: 24,
                runSpacing: 8,
                children: [
                  Text(
                    '↑↓ select',
                    style: terminalTextStyle(
                      color: grid.AppPalette.textSecondary,
                    ),
                  ),
                  Text(
                    '↵ practice',
                    style: terminalTextStyle(
                      color: grid.AppPalette.textSecondary,
                    ),
                  ),
                  if (widget.onClose != null)
                    Text(
                      'esc close',
                      style: terminalTextStyle(
                        color: grid.AppPalette.textSecondary,
                      ),
                    ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

class _ShortcutBrowserRow extends StatelessWidget {
  const _ShortcutBrowserRow({
    super.key,
    required this.lesson,
    required this.selected,
    required this.onTap,
  });
  final KeyboardLesson lesson;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final chords = [
      for (final binding in lesson.bindings)
        binding.keys.length == 1
            ? describeKeyStrokeKeys(binding.keys.single)
            : [describeKeyBinding(binding)],
    ];
    return Semantics(
      button: true,
      selected: selected,
      label: '${lesson.label}, ${lesson.keys}. Practice shortcut',
      child: Material(
        animationDuration: Duration.zero,
        color: selected ? grid.AppSurface.selectedFill : Colors.transparent,
        borderRadius: BorderRadius.circular(6),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(6),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final keys = KeyChordView(
                  chords: chords,
                  textStyle: terminalTextStyle(),
                );
                final label = Text(
                  lesson.label,
                  style: terminalTextStyle(color: grid.AppPalette.textPrimary),
                );
                if (constraints.maxWidth < 330 * terminalTextScaleOf(context)) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [label, const SizedBox(height: 8), keys],
                  );
                }
                return Row(
                  children: [
                    Expanded(child: label),
                    const SizedBox(width: 16),
                    ConstrainedBox(
                      constraints: BoxConstraints(
                        maxWidth: constraints.maxWidth * .48,
                      ),
                      child: keys,
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}
