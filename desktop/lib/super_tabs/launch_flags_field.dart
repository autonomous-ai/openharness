import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'buddy_restart.dart' show splitLaunchArgs;

/// A Buddy's launch flags as chips (spec 2026-11-06-board-buddy-card): each
/// word a monospace chip with a ×, then an input. Enter or Space turns the
/// typed text into chips, split as a shell would; an unclosed quote waits for
/// more typing; Backspace in the empty input removes the last chip.
class LaunchFlagsField extends StatefulWidget {
  const LaunchFlagsField({
    super.key,
    required this.words,
    required this.onChanged,
    this.readOnly = false,
    this.marked,
    this.onSubmitted,
    this.onFocusChanged,
  });

  final List<String> words;
  final ValueChanged<List<String>> onChanged;
  final bool readOnly;

  /// The word to show in the error style.
  final String? marked;

  /// Enter with nothing typed.
  final VoidCallback? onSubmitted;

  /// The input gained or lost focus, for the help line under the field.
  final ValueChanged<bool>? onFocusChanged;

  @override
  State<LaunchFlagsField> createState() => _LaunchFlagsFieldState();
}

class _LaunchFlagsFieldState extends State<LaunchFlagsField> {
  final _text = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Launch flag input');

  @override
  void initState() {
    super.initState();
    _focus.addListener(_focusMoved);
  }

  @override
  void dispose() {
    _focus
      ..removeListener(_focusMoved)
      ..dispose();
    _text.dispose();
    super.dispose();
  }

  void _focusMoved() {
    widget.onFocusChanged?.call(_focus.hasFocus);
    if (mounted) setState(() {});
  }

  /// Turn the typed text into chips. False when it is empty or holds an
  /// unclosed quote, which is left as typed.
  bool _commit() {
    final words = splitLaunchArgs(_text.text);
    if (words == null || words.isEmpty) return false;
    _text.clear();
    widget.onChanged([...widget.words, ...words]);
    return true;
  }

  void _typed(String value) {
    if (value.isNotEmpty && RegExp(r'\s$').hasMatch(value)) {
      if (!_commit() && value.trim().isEmpty) _text.clear();
    }
  }

  void _submitted() {
    if (_text.text.trim().isEmpty) {
      widget.onSubmitted?.call();
    } else {
      _commit();
    }
    // Enter would drop the focus; the next flag is typed straight away.
    if (!widget.readOnly) _focus.requestFocus();
  }

  KeyEventResult _key(FocusNode _, KeyEvent event) {
    if (event is KeyDownEvent &&
        event.logicalKey == LogicalKeyboardKey.backspace &&
        _text.text.isEmpty &&
        widget.words.isNotEmpty &&
        !widget.readOnly) {
      widget.onChanged(widget.words.sublist(0, widget.words.length - 1));
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.readOnly ? null : _focus.requestFocus,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: DesktopChrome.field,
          borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
          border: Border.all(
            color: _focus.hasFocus
                ? DesktopChrome.foreground
                : DesktopChrome.rim,
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.all(grid.AppDesktop.controlGap),
          child: Wrap(
            spacing: grid.AppDesktop.menuInset,
            runSpacing: grid.AppDesktop.menuInset,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              for (final (i, word) in widget.words.indexed)
                KeyedSubtree(
                  key: ValueKey('launch-flag-chip-$i'),
                  child: _Chip(
                    word: word,
                    marked: widget.marked != null && word == widget.marked,
                    removeKey: ValueKey('launch-flag-remove-$i'),
                    onRemove: widget.readOnly
                        ? null
                        : () => widget.onChanged([
                            for (final (j, w) in widget.words.indexed)
                              if (j != i) w,
                          ]),
                  ),
                ),
              ConstrainedBox(
                constraints: const BoxConstraints(
                  minWidth: grid.AppControl.heightField * 3,
                  maxWidth: grid.AppControl.heightField * 5,
                ),
                child: IntrinsicWidth(
                  child: Focus(
                    onKeyEvent: _key,
                    child: TextField(
                      key: const ValueKey('launch-flag-input'),
                      controller: _text,
                      focusNode: _focus,
                      enabled: !widget.readOnly,
                      style: grid.AppType.mono(color: DesktopChrome.foreground),
                      cursorColor: DesktopChrome.foreground,
                      decoration: InputDecoration(
                        isDense: true,
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        disabledBorder: InputBorder.none,
                        filled: false,
                        contentPadding: EdgeInsets.zero,
                        hintText: 'add a flag…',
                        hintStyle: grid.AppType.mono(color: DesktopChrome.hint),
                      ),
                      onChanged: _typed,
                      onSubmitted: (_) => _submitted(),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({
    required this.word,
    required this.marked,
    required this.removeKey,
    required this.onRemove,
  });

  final String word;
  final bool marked;
  final Key removeKey;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final ink = marked ? grid.AppPalette.dangerFill : DesktopChrome.foreground;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: marked
            ? grid.AppPalette.dangerFill.withValues(alpha: .12)
            : DesktopChrome.selection,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        border: Border.all(
          color: marked ? grid.AppPalette.dangerFill : DesktopChrome.rim,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: grid.AppDesktop.controlGap),
            child: Text(word, style: grid.AppType.mono(color: ink)),
          ),
          InkResponse(
            key: removeKey,
            onTap: onRemove,
            radius: AppIcons.inlineSize,
            child: Padding(
              padding: const EdgeInsets.all(grid.AppDesktop.menuInset),
              child: Icon(
                AppIcons.close,
                size: AppIcons.closeSize,
                color: marked ? ink : DesktopChrome.muted,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
