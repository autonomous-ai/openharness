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

/// A chooser for one of New's rows — a full-height sheet that slides UP, since sideways means Find
/// and New: a title and Cancel, a search field at the top, the list growing down with `✓` on the
/// current value, and the `+` actions ending it. A tap picks and closes.
///
/// [fold] keeps a long list short: past that many items a `more` row stands in for the rest, until
/// it is tapped or something is typed.
Future<T?> showNewAgentChooser<T>(
  BuildContext context, {
  required String hint,
  required List<ChooserItem<T>> items,
  List<ChooserItem<T>> actions = const [],
  String? title,
  int? fold,
}) => Navigator.of(context, rootNavigator: true).push<T>(
  PageRouteBuilder<T>(
    opaque: false,
    barrierColor: Colors.black54,
    barrierDismissible: true,
    transitionDuration: const Duration(milliseconds: 200),
    reverseTransitionDuration: const Duration(milliseconds: 160),
    pageBuilder: (_, _, _) => _Chooser<T>(
      title: title ?? hint.replaceFirst(RegExp(r'^Search '), ''),
      hint: hint,
      items: items,
      actions: actions,
      fold: fold,
    ),
    transitionsBuilder: (_, animation, _, child) => SlideTransition(
      position: Tween(begin: const Offset(0, 1), end: Offset.zero).animate(
        CurvedAnimation(
          parent: animation,
          curve: Curves.easeOutCubic,
          reverseCurve: Curves.easeInCubic,
        ),
      ),
      child: child,
    ),
  ),
);

class _Chooser<T> extends StatefulWidget {
  const _Chooser({
    required this.title,
    required this.hint,
    required this.items,
    required this.actions,
    this.fold,
  });

  final String title;
  final String hint;
  final List<ChooserItem<T>> items;
  final List<ChooserItem<T>> actions;
  final int? fold;

  @override
  State<_Chooser<T>> createState() => _ChooserState<T>();
}

class _ChooserState<T> extends State<_Chooser<T>> {
  final _controller = TextEditingController();
  final _focus = FocusNode();
  String _query = '';
  bool _unfolded = false;

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
    final fold = widget.fold;
    final folded =
        fold != null && !_unfolded && query.isEmpty && matches.length > fold;
    final shown = folded ? matches.take(fold).toList() : matches;
    final terms = query.isEmpty
        ? const <String>[]
        : query.split(RegExp(r'\s+'));
    // Everything but a strip at the top, where the form it belongs to still shows.
    return Align(
      alignment: Alignment.bottomCenter,
      child: Container(
        // Three quarters of the screen: the dimmed form above it is the way out.
        height: media.size.height * 0.75,
        decoration: BoxDecoration(
          color: tty.ground,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(10)),
          border: Border(
            top: BorderSide(color: tty.dim.withValues(alpha: 0.6)),
          ),
        ),
        child: Material(
          type: MaterialType.transparency,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 4, 0),
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
              // Search where there is something to search: a long list that is not folded.
              if (widget.items.length > 8 && widget.fold == null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    Tty.origin,
                    4,
                    Tty.origin,
                    4,
                  ),
                  child: TtyField(
                    controller: _controller,
                    focus: _focus,
                    hint: widget.hint,
                    action: TextInputAction.search,
                    onChanged: (value) => setState(() => _query = value),
                    onSubmitted: () {
                      final first = matches
                          .where((item) => item.enabled)
                          .firstOrNull;
                      if (first != null) _choose(first);
                    },
                  ),
                ),
              Expanded(
                child: ListView(
                  keyboardDismissBehavior:
                      ScrollViewKeyboardDismissBehavior.onDrag,
                  padding: EdgeInsets.only(bottom: media.padding.bottom + 16),
                  children: [
                    for (final item in shown)
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
                    if (folded)
                      FindRow(
                        title: 'more',
                        detail:
                            '${matches.length - shown.length} others, A to Z',
                        onTap: () => setState(() => _unfolded = true),
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
          ),
        ),
      ),
    );
  }
}
