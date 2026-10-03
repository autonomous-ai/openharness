import 'package:flutter/material.dart';

import 'find_row.dart';
import 'tty.dart';
import 'tty_controls.dart';

/// One row of a [showNewAgentChooser] list.
class ChooserItem<T> {
  const ChooserItem({
    required this.value,
    required this.title,
    this.subtitle,
    this.icon,
    this.leading,
    this.selected = false,
    this.enabled = true,
    this.warn = false,
  });

  final T value;
  final String title;

  /// Under the title, in the faint face — a folder's machine and path, an engine's "not installed".
  final String? subtitle;

  final IconData? icon;

  /// Drawn in place of [icon] — an engine's own mark.
  final Widget? leading;

  final bool selected;
  final bool enabled;

  /// Drawn in the warning colour: a choice that lets the agent do more than it should by default.
  final bool warn;

  bool matches(String query) {
    if (query.isEmpty) return true;
    final needle = query.toLowerCase();
    return title.toLowerCase().contains(needle) ||
        (subtitle?.toLowerCase().contains(needle) ?? false);
  }
}

/// A chooser for one of New's rows — a sheet sized to its rows that slides UP, since sideways means Find
/// and New: a title, a search field for long lists, the list growing down with `✓` on the
/// current value, and the `+` actions ending it. A tap picks and closes.
///
/// Long lists scroll in full. [autofocusSearch] always shows the search field and opens its keyboard.
Future<T?> showNewAgentChooser<T>(
  BuildContext context, {
  required String hint,
  required List<ChooserItem<T>> items,
  List<ChooserItem<T>> actions = const [],
  String? title,
  bool autofocusSearch = false,
}) => showModalBottomSheet<T>(
  context: context,
  useRootNavigator: true,
  useSafeArea: true,
  isScrollControlled: true,
  showDragHandle: true,
  backgroundColor: Tty.of(context).ground,
  constraints: BoxConstraints(
    maxHeight: MediaQuery.sizeOf(context).height * 0.85,
  ),
  builder: (context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
    child: _Chooser<T>(
      title: title ?? hint.replaceFirst(RegExp(r'^Search '), ''),
      hint: hint,
      items: items,
      actions: actions,
      autofocusSearch: autofocusSearch,
    ),
  ),
);

class _Chooser<T> extends StatefulWidget {
  const _Chooser({
    required this.title,
    required this.hint,
    required this.items,
    required this.actions,
    required this.autofocusSearch,
  });

  final String title;
  final String hint;
  final List<ChooserItem<T>> items;
  final List<ChooserItem<T>> actions;
  final bool autofocusSearch;

  @override
  State<_Chooser<T>> createState() => _ChooserState<T>();
}

class _ChooserState<T> extends State<_Chooser<T>> {
  final _controller = TextEditingController();
  final _focus = FocusNode();
  String _query = '';

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _choose(ChooserItem<T> item) {
    if (!item.enabled) return;
    FocusManager.instance.primaryFocus?.unfocus();
    Navigator.of(context).pop(item.value);
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final media = MediaQuery.of(context);
    final query = _query.trim();
    final matches = [
      for (final item in widget.items)
        if (item.matches(query)) item,
    ];
    final terms = query.isEmpty
        ? const <String>[]
        : query.split(RegExp(r'\s+'));
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(Tty.origin, 0, Tty.origin, 0),
          child: Row(
            children: [
              Expanded(
                child: TtyText(
                  widget.title,
                  size: TtySize.title,
                  weight: FontWeight.w600,
                ),
              ),
              // No Cancel: a tap above the sheet, or a pull down, puts it away.
              const SizedBox(height: 44),
            ],
          ),
        ),
        if (widget.items.length > 8 || widget.autofocusSearch)
          Padding(
            padding: const EdgeInsets.fromLTRB(Tty.origin, 4, Tty.origin, 4),
            child: TtyField(
              controller: _controller,
              focus: _focus,
              autofocus: widget.autofocusSearch,
              hint: widget.hint,
              action: TextInputAction.search,
              onChanged: (value) => setState(() => _query = value),
              onSubmitted: () {
                final first = matches.where((item) => item.enabled).firstOrNull;
                if (first != null) _choose(first);
              },
            ),
          ),
        Flexible(
          child: ListView(
            shrinkWrap: true,
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            padding: EdgeInsets.only(bottom: media.padding.bottom + 16),
            children: [
              for (final item in matches)
                FindRow(
                  title: item.title,
                  detail: item.subtitle,
                  terms: terms,
                  state: item.selected
                      ? '✓'
                      : item.warn
                      ? 'risky'
                      : null,
                  stateColor: item.selected ? tty.green : tty.red,
                  enabled: item.enabled,
                  onTap: () => _choose(item),
                ),
              if (matches.isEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    Tty.origin,
                    16,
                    Tty.origin,
                    8,
                  ),
                  child: TtyText(
                    'No match.',
                    color: tty.faint,
                    size: TtySize.row,
                  ),
                ),
              if (widget.actions.isNotEmpty) const SizedBox(height: 8),
              // An action the computer cannot do is left out, not drawn dead: a greyed row
              // with no reason reads as broken.
              for (final action in widget.actions)
                if (action.enabled)
                  FindAddRow(
                    label: action.title,
                    detail: action.subtitle,
                    onTap: () => _choose(action),
                  ),
            ],
          ),
        ),
      ],
    );
  }
}
