import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'composing_keyboard.dart';
import 'tty.dart';

/// The phone's controls, drawn in the terminal's face — the pieces that make a screen read as a
/// phone app at a glance while still looking like it lives in a terminal.
///
/// ⚠️ **Structure from iOS, surface from the terminal.** A search field at the top, rows in groups,
/// one filled button at the foot: those are what a phone user reads without thinking. SF Mono, the
/// terminal's own colours, 1px rules and square-ish corners are what keep it at home beside vim
/// and tmux. Plain words everywhere — never `esc`, `⏎` or a counter — since chrome is not a
/// keyboard.

/// The type scale: two sizes, one face. 17 for what you decide on or tap — names, values, fields,
/// the button, titles, Cancel; 13 for everything else, and nothing smaller. The terminal keeps its
/// own size.
abstract final class TtySize {
  /// Page titles.
  static const double display = 28;

  /// Fields, values, the button, sheet titles.
  static const double title = 17;

  /// A row's name.
  static const double row = 15;

  /// Everything secondary — and nothing smaller.
  static const double meta = 13;
}

/// A raised ground, one step up from the terminal's: fields, the pressed row.
Color ttyRaised(Tty tty) =>
    Color.alphaBlend(tty.text.withValues(alpha: 0.09), tty.ground);

/// The one filled button on a screen — Start, Sign in, Continue: full width, the terminal's green,
/// a dark bold label. Pressed, it darkens on the finger's way DOWN.
class TtyPrimaryButton extends StatefulWidget {
  const TtyPrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.busy = false,
    this.busyLabel,
  });

  final String label;

  /// Null draws it disabled.
  final VoidCallback? onPressed;

  /// Working: the label becomes [busyLabel] and the button takes no taps.
  final bool busy;
  final String? busyLabel;

  static const double height = 52;

  @override
  State<TtyPrimaryButton> createState() => _TtyPrimaryButtonState();
}

class _TtyPrimaryButtonState extends State<TtyPrimaryButton> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final enabled = widget.onPressed != null && !widget.busy;
    final fill = !enabled && !widget.busy
        ? tty.selected
        : _down
        ? Color.alphaBlend(Colors.black.withValues(alpha: 0.18), tty.green)
        : tty.green;
    final ink = !enabled && !widget.busy
        ? tty.faint
        : tty.onFill(tty.theme.black);
    return Semantics(
      button: true,
      enabled: enabled,
      label: widget.label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: enabled ? (_) => setState(() => _down = true) : null,
        onTapCancel: enabled ? () => setState(() => _down = false) : null,
        onTapUp: enabled ? (_) => setState(() => _down = false) : null,
        onTap: enabled
            ? () {
                HapticFeedback.lightImpact();
                widget.onPressed!();
              }
            : null,
        child: Container(
          // At least this tall, and taller when the text is larger — never clipped.
          constraints: const BoxConstraints(minHeight: TtyPrimaryButton.height),
          padding: const EdgeInsets.symmetric(
            horizontal: Tty.origin,
            vertical: 10,
          ),
          decoration: BoxDecoration(
            color: fill,
            borderRadius: BorderRadius.circular(6),
          ),
          alignment: Alignment.center,
          child: TtyText(
            widget.busy ? (widget.busyLabel ?? widget.label) : widget.label,
            color: ink,
            weight: FontWeight.w600,
            size: TtySize.title,
          ),
        ),
      ),
    );
  }
}

/// A plain text button: Try again, Try it first. Text colour: the chrome keeps one accent, green.
class TtyTextButton extends StatelessWidget {
  const TtyTextButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.color,
    this.weight = FontWeight.w500,
  });

  final String label;
  final VoidCallback? onPressed;
  final Color? color;
  final FontWeight weight;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onPressed == null
            ? null
            : () {
                HapticFeedback.selectionClick();
                onPressed!();
              },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44, minWidth: 44),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Center(
              widthFactor: 1,
              child: TtyText(
                label,
                color: onPressed == null ? tty.dim : (color ?? tty.text),
                weight: weight,
                size: TtySize.row,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A branch, the one way it is written everywhere: the branch icon, then its name — never a `·`
/// before it. The icon because `main` alone reads as a folder; the same glyph as Focus's title and
/// the desktop's header. [lead] is the gap before it, when it follows something on its line.
WidgetSpan ttyBranchMark(
  Tty tty, {
  Color? color,
  double size = 12,
  double lead = 8,
}) => WidgetSpan(
  alignment: PlaceholderAlignment.middle,
  child: Padding(
    padding: EdgeInsets.only(left: lead, right: 4),
    child: Icon(
      LucideIcons.gitBranch300,
      size: size,
      color: color ?? tty.faint,
    ),
  ),
);

/// Back, as iOS draws it on a pushed screen: a chevron and no word. A 44pt target whose glyph sits
/// on the gutter, so it lines up with the title under it.
class TtyBackButton extends StatelessWidget {
  const TtyBackButton({super.key, required this.onPressed});

  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: 'Back',
      excludeSemantics: true,
      child: GestureDetector(
        key: const ValueKey('tty-back'),
        behavior: HitTestBehavior.opaque,
        onTap: onPressed == null
            ? null
            : () {
                HapticFeedback.selectionClick();
                onPressed!();
              },
        child: SizedBox(
          width: 52,
          height: 44,
          child: Padding(
            padding: const EdgeInsets.only(left: Tty.origin - 5),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Icon(
                LucideIcons.chevronLeft300,
                size: 26,
                color: onPressed == null ? tty.dim : tty.text,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A form row: a faint label, its value, and `›` — tapped to change the value.
class TtyFormRow extends StatelessWidget {
  const TtyFormRow({
    super.key,
    required this.label,
    required this.value,
    this.detail,
    this.onTap,
    this.valueColor,
    this.chevron = true,
  });

  final String label;
  final String value;

  /// A second, faint line under the value — a path, a note.
  final String? detail;
  final VoidCallback? onTap;
  final Color? valueColor;
  final bool chevron;

  static const double labelWidth = 92;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return TtyTap(
      onTap: onTap,
      semanticsLabel: '$label, $value',
      minHeight: 56,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Tty.origin, 10, Tty.origin, 10),
        child: Row(
          children: [
            // The label on the value's FIRST line: centred on a value with a note under it, it
            // sat beside the note and read as that note's label.
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  SizedBox(
                    width: labelWidth,
                    child: TtyText(label, color: tty.faint, size: TtySize.meta),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          value,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: tty.style(
                            color: valueColor ?? tty.text,
                            size: TtySize.row,
                            weight: FontWeight.w600,
                          ),
                        ),
                        if (detail case final detail?
                            when detail.isNotEmpty) ...[
                          const SizedBox(height: 2),
                          // Two lines, then an ellipsis: a note like approvals' meaning is a sentence.
                          Text(
                            detail,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: tty.style(
                              color: tty.faint,
                              size: TtySize.meta,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
            if (chevron && onTap != null)
              Padding(
                padding: const EdgeInsets.only(left: 8),
                child: TtyText('›', color: tty.faint, size: TtySize.title),
              ),
          ],
        ),
      ),
    );
  }
}

/// A text field in the terminal's face: a raised ground, a green cursor, a faint placeholder, and
/// room at the end for a mic or a clear button. One line for search, a few for a task.
class TtyField extends StatefulWidget {
  const TtyField({
    super.key,
    required this.controller,
    required this.hint,
    this.focus,
    this.onChanged,
    this.onSubmitted,
    this.lines = 1,
    this.leading,
    this.trailing = const [],
    this.action = TextInputAction.done,
    this.maxLength,
    this.autofocus = false,
    this.keyboardType,
    this.autofillHints,
  });

  final TextInputType? keyboardType;
  final Iterable<String>? autofillHints;

  final TextEditingController controller;
  final FocusNode? focus;
  final String hint;
  final ValueChanged<String>? onChanged;
  final VoidCallback? onSubmitted;

  /// How many lines tall; more than one wraps and grows up to it.
  final int lines;

  /// Drawn before the text — the search field's `>`.
  final Widget? leading;

  /// Drawn after the text: a mic, a clear button.
  final List<Widget> trailing;
  final TextInputAction action;
  final int? maxLength;
  final bool autofocus;

  @override
  State<TtyField> createState() => _TtyFieldState();
}

class _TtyFieldState extends State<TtyField> {
  late final FocusNode _focus = widget.focus ?? FocusNode();

  @override
  void initState() {
    super.initState();
    _focus.addListener(_onFocus);
  }

  @override
  void dispose() {
    _focus.removeListener(_onFocus);
    if (widget.focus == null) _focus.dispose();
    super.dispose();
  }

  void _onFocus() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final multi = widget.lines > 1;
    final field = TextSelectionTheme(
      // The terminal's green for the cursor, the handles and the selection — not Material blue.
      data: TextSelectionThemeData(
        cursorColor: tty.green,
        selectionColor: tty.green.withValues(alpha: 0.3),
        selectionHandleColor: tty.green,
      ),
      child: TextField(
        controller: widget.controller,
        focusNode: _focus,
        autofocus: widget.autofocus,
        onChanged: widget.onChanged,
        onSubmitted: (_) => widget.onSubmitted?.call(),
        minLines: multi ? 3 : 1,
        maxLines: multi ? widget.lines : 1,
        maxLength: widget.maxLength,
        maxLengthEnforcement: MaxLengthEnforcement.enforced,
        keyboardType:
            widget.keyboardType ?? (multi ? TextInputType.multiline : null),
        autofillHints: widget.autofillHints,
        textInputAction: widget.action,
        // The keyboard's own composing, left on: Vietnamese Telex on iOS rides on
        // autocorrection. See `ComposingKeyboard`.
        autocorrect: ComposingKeyboard.autocorrect,
        enableSuggestions: ComposingKeyboard.enableSuggestions,
        smartDashesType: SmartDashesType.disabled,
        smartQuotesType: SmartQuotesType.disabled,
        textCapitalization: multi
            ? TextCapitalization.sentences
            : TextCapitalization.none,
        cursorColor: tty.green,
        cursorWidth: 2,
        style: tty.style(size: multi ? TtySize.row : TtySize.title),
        decoration: InputDecoration(
          isCollapsed: true,
          constraints: const BoxConstraints(),
          filled: false,
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          disabledBorder: InputBorder.none,
          contentPadding: EdgeInsets.zero,
          counterText: '',
          hintText: widget.hint,
          hintMaxLines: multi ? 3 : 1,
          hintStyle: tty.style(
            color: tty.placeholder,
            size: multi ? TtySize.row : TtySize.title,
          ),
        ),
      ),
    );
    return GestureDetector(
      // A tap anywhere in the box — not only on the text — takes the keyboard.
      behavior: HitTestBehavior.opaque,
      onTap: _focus.requestFocus,
      child: Container(
        constraints: BoxConstraints(minHeight: multi ? 96 : 44),
        decoration: BoxDecoration(
          color: ttyRaised(tty),
          borderRadius: BorderRadius.circular(6),
        ),
        padding: EdgeInsets.fromLTRB(12, multi ? 10 : 0, 4, multi ? 6 : 0),
        child: multi
            // Multi-line: the text starts at the top; what trails it (the mic) sits in the bottom
            // corner, under the thumb, and the text keeps clear of it.
            ? Stack(
                children: [
                  Padding(
                    padding: EdgeInsets.only(
                      right: widget.trailing.isEmpty ? 8 : 44,
                    ),
                    child: field,
                  ),
                  if (widget.trailing.isNotEmpty)
                    Positioned(
                      right: 0,
                      bottom: 0,
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: widget.trailing,
                      ),
                    ),
                ],
              )
            : Row(
                children: [
                  if (widget.leading case final leading?) ...[
                    leading,
                    const SizedBox(width: 8),
                  ],
                  Expanded(child: field),
                  ...widget.trailing,
                ],
              ),
      ),
    );
  }
}

/// A small round mic for inside a field — tap to talk into it.
class TtyFieldMic extends StatelessWidget {
  const TtyFieldMic({super.key, required this.onTap, this.live = false});

  final VoidCallback? onTap;

  /// Recording: drawn red.
  final bool live;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: live ? 'Stop and use what was said' : 'Say it',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap == null
            ? null
            : () {
                HapticFeedback.lightImpact();
                onTap!();
              },
        child: SizedBox(
          width: 44,
          height: 44,
          child: Center(
            child: Container(
              width: 32,
              height: 32,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: live ? tty.red : Colors.transparent,
                border: live ? null : Border.all(color: tty.dim),
              ),
              child: Icon(
                live ? LucideIcons.arrowUp300 : LucideIcons.mic300,
                size: 18,
                color: live ? tty.onFill(tty.theme.brightWhite) : tty.text,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
