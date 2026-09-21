import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../terminal/terminal_search.dart';

class TerminalFindBar extends StatefulWidget {
  const TerminalFindBar({
    super.key,
    required this.search,
    required this.onQuery,
    required this.onStep,
    required this.onClose,
    required this.onFocus,
    this.initialQuery = '',
    this.initialCaseSensitive = false,
    this.readOnly = false,
  });

  /// Null while the focused pane keeps its input ready without a search index.
  final TerminalSearch? search;
  final String initialQuery;
  final bool initialCaseSensitive;
  final void Function(String query, bool caseSensitive) onQuery;
  final ValueChanged<int> onStep;
  final VoidCallback onClose;
  final VoidCallback onFocus;
  final bool readOnly;

  @override
  State<TerminalFindBar> createState() => TerminalFindBarState();
}

class TerminalFindBarState extends State<TerminalFindBar> {
  static final _idle = Listenable.merge(const []);
  final _scope = FocusScopeNode(debugLabel: 'Terminal Find');
  final _focus = FocusNode(debugLabel: 'Find in terminal');
  late final _text = TextEditingController(
    text: widget.search?.query ?? widget.initialQuery,
  );
  // Keys can arrive before the widget receives the newly opened search.
  TerminalSearch? _activeSearch;

  @override
  void initState() {
    super.initState();
    _activeSearch = widget.search;
    _setActive(widget.search != null);
    _focus.addListener(_onFocus);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.search != null) focusSearch();
    });
  }

  @override
  void didUpdateWidget(TerminalFindBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    _activeSearch = widget.search;
    _setActive(widget.search != null);
    if (widget.search == null && _text.text != widget.initialQuery) {
      _text.text = widget.initialQuery;
    }
  }

  void _setActive(bool active) {
    _scope.canRequestFocus = active;
    _scope.descendantsAreFocusable = active;
    _scope.descendantsAreTraversable = active;
  }

  void releaseSearchFocus() {
    _activeSearch = null;
    _setActive(false);
  }

  void _onFocus() {
    if (_focus.hasFocus) widget.onFocus();
  }

  void focusSearch({bool selectAll = true, TerminalSearch? search}) {
    _activeSearch = search ?? widget.search ?? _activeSearch;
    _setActive(true);
    _focus.requestFocus();
    if (selectAll) {
      _text.selection = TextSelection(
        baseOffset: 0,
        extentOffset: _text.text.length,
      );
    }
  }

  KeyEventResult _onKeyEvent(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isMetaPressed ||
        keyboard.isControlPressed ||
        keyboard.isAltPressed) {
      return KeyEventResult.ignored;
    }
    final enter =
        event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter;
    final escape =
        event.logicalKey == LogicalKeyboardKey.escape &&
        !keyboard.isShiftPressed;
    if (!enter && !escape) return KeyEventResult.ignored;
    final composing = _text.value.composing;
    if (composing.isValid && !composing.isCollapsed) {
      // Let the platform commit/cancel composition without a later shortcut
      // submitting the editor or closing Find instead.
      return KeyEventResult.skipRemainingHandlers;
    }
    if (escape) {
      widget.onClose();
    } else {
      widget.onStep(keyboard.isShiftPressed ? -1 : 1);
    }
    return KeyEventResult.handled;
  }

  @override
  void dispose() {
    _focus.removeListener(_onFocus);
    _focus.dispose();
    _scope.dispose();
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FocusScope(
    node: _scope,
    onKeyEvent: _onKeyEvent,
    child: Material(
      color: const Color(0xff272727),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: const BorderSide(color: Colors.white24),
      ),
      child: Padding(
        padding: const EdgeInsets.only(left: 10, right: 4, top: 2, bottom: 2),
        child: ListenableBuilder(
          listenable: widget.search ?? _idle,
          // Live output and result navigation update the controls, not the
          // editor. Keep its widget stable while the search index refreshes.
          child: Expanded(
            key: const ValueKey('terminal-find-editor'),
            child: TextField(
              controller: _text,
              focusNode: _focus,
              autofocus: widget.search != null,
              textAlignVertical: TextAlignVertical.center,
              style: const TextStyle(
                fontSize: 13,
                height: 1,
                color: Colors.white,
              ),
              decoration: const InputDecoration(
                hintText: 'Find in terminal…',
                hintStyle: TextStyle(color: Colors.white54),
                isDense: true,
                isCollapsed: true,
                constraints: BoxConstraints(),
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                filled: false,
                contentPadding: EdgeInsets.zero,
              ),
              onChanged: (value) => widget.onQuery(
                value,
                _activeSearch?.caseSensitive ?? widget.initialCaseSensitive,
              ),
            ),
          ),
          builder: (context, editor) {
            final search = widget.search;
            final query = search?.query ?? '';
            final searching = search?.searching ?? false;
            final hasSnapshot = search?.hasSnapshot ?? false;
            final count = search?.count ?? 0;
            final selected = (search?.selected ?? -1) + 1;
            final sensitive =
                search?.caseSensitive ?? widget.initialCaseSensitive;
            final status = query.isEmpty
                ? ''
                : searching && !hasSnapshot
                ? '…'
                : '$selected/$count';
            Widget button(
              String label,
              Widget icon,
              VoidCallback? action, {
              bool selected = false,
            }) => SizedBox(
              width: 28,
              height: 30,
              child: IconButton(
                tooltip: label,
                onPressed: action,
                isSelected: selected,
                constraints: const BoxConstraints.tightFor(
                  width: 28,
                  height: 30,
                ),
                padding: EdgeInsets.zero,
                visualDensity: VisualDensity.compact,
                iconSize: 17,
                color: selected ? Colors.white : Colors.white60,
                icon: icon,
              ),
            );
            return Row(
              children: [
                if (widget.readOnly) ...[
                  const Tooltip(
                    message: 'This terminal is read only',
                    child: Icon(
                      Icons.lock_outline,
                      size: 14,
                      color: Colors.white54,
                    ),
                  ),
                  const SizedBox(width: 6),
                ],
                editor!,
                const SizedBox(width: 6),
                Semantics(
                  liveRegion: true,
                  label: searching && !hasSnapshot
                      ? 'Searching terminal'
                      : query.isEmpty
                      ? 'Find in terminal'
                      : count == 0
                      ? 'No matches'
                      : 'Match $selected of $count',
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 56),
                    child: ExcludeSemantics(
                      child: Text(
                        status,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11,
                          height: 1,
                          color: count == 0 && query.isNotEmpty && !searching
                              ? const Color(0xffffb4a9)
                              : Colors.white54,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 4),
                button(
                  'Match case',
                  Text(
                    'Aa',
                    style: TextStyle(
                      fontSize: 12,
                      height: 1,
                      color: sensitive ? Colors.white : Colors.white54,
                      fontWeight: sensitive
                          ? FontWeight.w700
                          : FontWeight.normal,
                    ),
                  ),
                  () {
                    widget.onQuery(
                      _text.text,
                      !(_activeSearch?.caseSensitive ??
                          widget.initialCaseSensitive),
                    );
                    _focus.requestFocus();
                  },
                  selected: sensitive,
                ),
                button(
                  'Previous match (⇧⌘G)',
                  const Icon(Icons.keyboard_arrow_up),
                  count > 0
                      ? () {
                          widget.onStep(-1);
                          _focus.requestFocus();
                        }
                      : null,
                ),
                button(
                  'Next match (⌘G)',
                  const Icon(Icons.keyboard_arrow_down),
                  count > 0
                      ? () {
                          widget.onStep(1);
                          _focus.requestFocus();
                        }
                      : null,
                ),
                button(
                  'Close find (Esc)',
                  const Icon(Icons.close),
                  widget.onClose,
                ),
              ],
            );
          },
        ),
      ),
    ),
  );
}
