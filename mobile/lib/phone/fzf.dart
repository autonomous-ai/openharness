import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/core/fuzzy_match.dart';

import 'composing_keyboard.dart';
import 'tty.dart';

/// fzf, drawn for a thumb: one-line rows over a `> ` prompt, the best match next to the prompt,
/// matched letters in fzf's green, `3/14` above the prompt. Find is built from these, and so is
/// every chooser New opens — the same list everywhere, the one a terminal user already reads
/// without thinking.

/// One row: an optional mark in fzf's gutter, the name with its matched letters lit, the detail
/// in the dim face after it, and one word at the right edge (an age, or a state).
class FzfRow extends StatelessWidget {
  const FzfRow({
    super.key,
    required this.title,
    this.detail,
    this.trailing,
    this.trailingColor,
    this.terms = const [],
    this.mark,
    this.markColor,
    this.enabled = true,
    this.cursor = false,
    this.onTap,
  });

  /// fzf's cursor row — the one Enter takes: `▌` in red in the gutter, the selection ground behind,
  /// the name in bold.
  final bool cursor;

  final String title;
  final String? detail;
  final String? trailing;
  final Color? trailingColor;

  /// What was typed, to light in [title] — fzf's `hl`.
  final List<String> terms;

  /// One character in the gutter: `*` for the agent on screen, `✓` for a chosen value.
  final String? mark;
  final Color? markColor;

  final bool enabled;
  final VoidCallback? onTap;

  static const double height = 40;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final ink = enabled ? tty.text : tty.dim;
    final row = TtyTap(
      minHeight: height,
      onTap: enabled && onTap != null
          ? () {
              HapticFeedback.selectionClick();
              onTap!();
            }
          : null,
      child: Row(
        children: [
          SizedBox(
            width: 24,
            child: Center(
              child: TtyText(
                cursor ? '▌' : (mark ?? ' '),
                color: cursor ? tty.red : (markColor ?? tty.red),
                weight: FontWeight.w600,
              ),
            ),
          ),
          Expanded(
            child: Text.rich(
              TextSpan(
                children: [
                  ...fzfHighlight(
                    title,
                    terms,
                    base: tty.style(
                      color: ink,
                      weight: cursor ? FontWeight.w600 : FontWeight.w400,
                    ),
                    hit: tty.style(color: tty.green, weight: FontWeight.w600),
                  ),
                  if (detail case final detail? when detail.isNotEmpty)
                    TextSpan(
                      text: '  $detail',
                      style: tty.style(color: tty.faint),
                    ),
                ],
              ),
              maxLines: 1,
              softWrap: false,
              overflow: TextOverflow.clip,
            ),
          ),
          if (trailing case final trailing?)
            Padding(
              padding: const EdgeInsets.only(left: 8, right: 12),
              child: TtyText(trailing, color: trailingColor ?? tty.dim),
            ),
        ],
      ),
    );
    return cursor ? ColoredBox(color: tty.selected, child: row) : row;
  }
}

/// [text] as spans with each typed term lit — a substring where there is one (one that starts a
/// word first: "port" lights "windows port", not "support"), else scattered letters in order.
///
/// [strict] lights scattered letters the way a harness row matched them (see
/// `phoneFieldMatchScore`): starting a word and close together, or two letters as initials — so
/// what is lit is what earned the row its place.
List<TextSpan> fzfHighlight(
  String text,
  List<String> terms, {
  required TextStyle base,
  required TextStyle hit,
  bool strict = false,
}) {
  final lit = List<bool>.filled(text.length, false);
  final lower = text.toLowerCase();
  // Case folding that changes the length would shift every index: leave such text plain.
  if (lower.length != text.length) return [TextSpan(text: text, style: base)];
  for (final raw in terms) {
    final term = raw.toLowerCase();
    if (term.isEmpty) continue;
    var at = wordStartIndexOf(lower, term);
    if (at < 0) at = lower.indexOf(term);
    if (at >= 0) {
      for (var i = at; i < at + term.length; i++) {
        lit[i] = true;
      }
      continue;
    }
    if (strict) {
      wordSubsequenceSpread(
        lower,
        term,
        onMatch: (start, end) {
          for (var i = start; i < end; i++) {
            lit[i] = true;
          }
        },
      );
      continue;
    }
    var from = 0;
    final marks = <int>[];
    for (final unit in term.split('')) {
      final found = lower.indexOf(unit, from);
      if (found < 0) {
        marks.clear();
        break;
      }
      marks.add(found);
      from = found + 1;
    }
    for (final i in marks) {
      lit[i] = true;
    }
  }
  final spans = <TextSpan>[];
  var start = 0;
  for (var i = 1; i <= text.length; i++) {
    if (i == text.length || lit[i] != lit[start]) {
      spans.add(
        TextSpan(
          text: text.substring(start, i),
          style: lit[start] ? hit : base,
        ),
      );
      start = i;
    }
  }
  return spans;
}

/// fzf's info line: `  3/14 ──────` and, at its right edge, the words that act — `+new`, `esc`.
class FzfInfoLine extends StatelessWidget {
  const FzfInfoLine({
    super.key,
    required this.matched,
    required this.total,
    this.actions = const [],
    this.label,
  });

  final int matched;
  final int total;

  /// A word in place of the count, for a list that counts itself elsewhere — `:`'s models.
  final String? label;
  final List<({String label, VoidCallback onTap})> actions;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return SizedBox(
      height: 36,
      child: Row(
        children: [
          const SizedBox(width: 24),
          // fzf's info line: always `matched/total`, then its rule drawn in `─`, not a hairline.
          TtyText(label ?? '$matched/$total', color: tty.yellow),
          const SizedBox(width: 8),
          Expanded(
            child: ClipRect(child: TtyText('─' * 80, color: tty.dim)),
          ),
          for (final action in actions)
            TtyTap(
              onTap: action.onTap,
              minHeight: 36,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 10),
                child: TtyText(action.label, color: tty.cyan),
              ),
            ),
          const SizedBox(width: 4),
        ],
      ),
    );
  }
}

/// fzf's prompt: `> ` and the query, on the terminal's ground — no box, no border, no magnifier.
class FzfPrompt extends StatelessWidget {
  const FzfPrompt({
    super.key,
    required this.controller,
    required this.focus,
    required this.onChanged,
    this.hint,
    this.onSubmitted,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final ValueChanged<String> onChanged;
  final String? hint;
  final VoidCallback? onSubmitted;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return SizedBox(
      height: 48,
      child: Row(
        // ⚠️ On the text's baseline, not centred: a field and a glyph centred separately sat the
        // query ~9pt above its `>`.
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          SizedBox(
            width: 24,
            child: Center(
              child: TtyText('>', color: tty.blue, weight: FontWeight.w600),
            ),
          ),
          Expanded(
            child: TextField(
              textAlignVertical: TextAlignVertical.center,
              controller: controller,
              focusNode: focus,
              onChanged: onChanged,
              onSubmitted: (_) => onSubmitted?.call(),
              // ⚠️ The keyboard's own composing, left on: Vietnamese Telex on iOS rides on
              // autocorrection, and a prompt that turned it off could not be typed in. Dashes and
              // quotes stay straight — they are search text, not prose. See [ComposingKeyboard].
              autocorrect: ComposingKeyboard.autocorrect,
              enableSuggestions: ComposingKeyboard.enableSuggestions,
              smartDashesType: SmartDashesType.disabled,
              smartQuotesType: SmartQuotesType.disabled,
              textCapitalization: TextCapitalization.none,
              textInputAction: TextInputAction.search,
              cursorColor: tty.text,
              cursorWidth: 2,
              style: tty.style(),
              // Bare: the app theme fills and rounds every field, and a prompt has neither.
              decoration: InputDecoration(
                isCollapsed: true,
                // The app theme gives every field a minimum height, which floated the text to the
                // top of a taller box.
                constraints: const BoxConstraints(),
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                disabledBorder: InputBorder.none,
                contentPadding: EdgeInsets.zero,
                hintText: hint,
                hintStyle: tty.style(color: tty.faint),
              ),
            ),
          ),
          const SizedBox(width: 12),
        ],
      ),
    );
  }
}

/// How long ago, the way a terminal would say it: `now`, `3m`, `2h`, `5d`.
String fzfAge(DateTime? at, DateTime now) {
  if (at == null) return '';
  final gone = now.difference(at);
  if (gone.inMinutes < 1) return 'now';
  if (gone.inHours < 1) return '${gone.inMinutes}m';
  if (gone.inDays < 1) return '${gone.inHours}h';
  return '${gone.inDays}d';
}
