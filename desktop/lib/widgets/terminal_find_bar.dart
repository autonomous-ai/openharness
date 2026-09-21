import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../terminal/terminal_text.dart';
import '../terminal/terminal_search.dart';
import 'box_chrome.dart';
import 'pane_menu.dart';

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
  VoidCallback? _closeMenu;

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
    _closeMenu?.call();
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
    // Enter on a keyboard-focused control activates that control. It steps
    // through matches only while the query editor owns focus.
    if (enter && !_focus.hasFocus) return KeyEventResult.ignored;
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
    _closeMenu?.call();
    _focus.removeListener(_onFocus);
    _focus.dispose();
    _scope.dispose();
    _text.dispose();
    super.dispose();
  }

  void _toggleCase() {
    widget.onQuery(
      _text.text,
      !(_activeSearch?.caseSensitive ?? widget.initialCaseSensitive),
    );
    _focus.requestFocus();
  }

  Future<void> _openOptions(BuildContext context) async {
    final anchor = context.findRenderObject()! as RenderBox;
    final overlay =
        Overlay.of(context).context.findRenderObject()! as RenderBox;
    final rect =
        anchor.localToGlobal(Offset.zero, ancestor: overlay) & anchor.size;
    final choice = await showPaneMenu<VoidCallback>(
      context: context,
      position: RelativeRect.fromRect(
        Rect.fromLTWH(rect.left, rect.bottom + 4, rect.width, 0),
        Offset.zero & overlay.size,
      ),
      minWidth: 230,
      maxWidth: 360,
      onOpen: (_, close) => _closeMenu = close,
      onClose: () => _closeMenu = null,
      children: (close) {
        Widget option(String label, String hint, VoidCallback action) =>
            paneMenuItem(
              onTap: () => close(action),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 8,
                ),
                child: Row(
                  children: [
                    Expanded(child: Text(label, style: boxMonoStyle())),
                    const SizedBox(width: 16),
                    Text(hint, style: boxMonoStyle(color: kBoxFaint)),
                  ],
                ),
              ),
            );
        return [
          option(
            'Match case',
            _activeSearch?.caseSensitive == true ? 'on' : 'off',
            _toggleCase,
          ),
          if ((_activeSearch?.count ?? 0) > 0) ...[
            option('Next match', 'enter', () => widget.onStep(1)),
            option('Previous match', 'shift-enter', () => widget.onStep(-1)),
          ],
        ];
      },
    );
    if (choice != null && mounted && _activeSearch != null) {
      choice();
      _focus.requestFocus();
    }
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ListenableBuilder(
      listenable: terminalFontStore,
      builder: (context, _) => _buildBar(context),
    );
  }

  Widget _buildBar(BuildContext context) => FocusScope(
    node: _scope,
    onKeyEvent: _onKeyEvent,
    child: TerminalBox(
      child: Padding(
        padding: const EdgeInsets.only(left: 10, right: 4, top: 2, bottom: 2),
        child: ListenableBuilder(
          listenable: widget.search ?? _idle,
          // Live output and result navigation update the controls, not the
          // editor. Keep its widget stable while the search index refreshes.
          child: Expanded(
            key: const ValueKey('terminal-find-editor'),
            child: ReadlineKeys(
              controller: _text,
              onChanged: (value) => widget.onQuery(
                value,
                _activeSearch?.caseSensitive ?? widget.initialCaseSensitive,
              ),
              child: TextField(
                controller: _text,
                focusNode: _focus,
                autofocus: widget.search != null,
                textAlignVertical: TextAlignVertical.center,
                style: boxMonoStyle().copyWith(height: 1),
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
            return LayoutBuilder(
              builder: (context, constraints) {
                // Keep room to edit at narrow pane widths and larger text sizes.
                // The same actions remain available in a small keyboard menu.
                final compact =
                    constraints.maxWidth <
                    200 + MediaQuery.textScalerOf(context).scale(120);
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
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ExcludeSemantics(
                        child: Text(
                          '/',
                          style: boxMonoStyle(color: Colors.white70),
                        ),
                      ),
                    ),
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
                            style: boxMonoStyle(
                              color:
                                  count == 0 && query.isNotEmpty && !searching
                                  ? const Color(0xffffb4a9)
                                  : Colors.white54,
                            ).copyWith(height: 1),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 4),
                    if (compact)
                      Builder(
                        builder: (context) => button(
                          'Find options',
                          const Icon(Icons.more_horiz),
                          () => _openOptions(context),
                        ),
                      )
                    else ...[
                      button(
                        'Match case',
                        Text(
                          'Aa',
                          style: boxMonoStyle(
                            color: sensitive ? Colors.white : Colors.white54,
                            weight: sensitive
                                ? FontWeight.w700
                                : FontWeight.normal,
                          ).copyWith(height: 1),
                        ),
                        _toggleCase,
                        selected: sensitive,
                      ),
                      button(
                        'Previous match (Shift-Enter)',
                        const Icon(Icons.keyboard_arrow_up),
                        count > 0
                            ? () {
                                widget.onStep(-1);
                                _focus.requestFocus();
                              }
                            : null,
                      ),
                      button(
                        'Next match (Enter)',
                        const Icon(Icons.keyboard_arrow_down),
                        count > 0
                            ? () {
                                widget.onStep(1);
                                _focus.requestFocus();
                              }
                            : null,
                      ),
                    ],
                    button(
                      'Close find (Esc)',
                      const Icon(Icons.close),
                      widget.onClose,
                    ),
                  ],
                );
              },
            );
          },
        ),
      ),
    ),
  );
}
