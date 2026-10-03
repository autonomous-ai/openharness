import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'fzf.dart' show fzfHighlight;
import 'tty.dart';
import 'tty_controls.dart';

/// One of Find's rows: two lines, 60pt — the name at 17 with its state word at the right edge, and
/// under it where the harness works (or, while it asks, its question).
///
/// ```
/// api-fix                               asking
/// "Run the migration on the test db?"
/// docs-rewrite                         working
/// M2:site ⑂ docs-v2 · 2m
/// ```
class FindRow extends StatelessWidget {
  const FindRow({
    super.key,
    required this.title,
    this.detail,
    this.detailColor,
    this.branch,
    this.tail,
    this.state,
    this.stateColor,
    this.terms = const [],
    this.selected = false,
    this.enabled = true,
    this.onTap,
    this.strict = false,
    this.said,
  });

  final String title;

  /// A harness row: its title's letters are lit the way harness rows match — see [fzfHighlight].
  final bool strict;

  /// Where the machine's session index found the words, in place of [detail]: what was asked
  /// (`> …`), a command (`$ …`) or the answer, the matched words lit — fzf's preview line.
  final ({String lead, List<({String text, bool matched})> runs})? said;

  /// Line 2: `machine:folder`, or a quoted question.
  final String? detail;
  final Color? detailColor;

  /// After [detail], behind the branch icon — see [ttyBranchMark].
  final String? branch;

  /// Last on line 2, after a `·`: the age, or `current`.
  final String? tail;

  /// `asking`, `working`, `idle`, `exited` — one word, right-aligned on line 1.
  final String? state;
  final Color? stateColor;

  /// What was typed, lit green in [title] and [detail].
  final List<String> terms;

  /// The row Return opens: the raised ground behind it.
  final bool selected;
  final bool enabled;
  final VoidCallback? onTap;

  static const double height = 60;

  TextStyle _base(Tty tty) =>
      tty.style(color: detailColor ?? tty.faint, size: TtySize.meta);

  /// [text] with the typed words lit — only where they are there as typed: fzf's scattered
  /// letters inside a question or a path read as noise.
  List<InlineSpan> _lit(String text, Tty tty) => fzfHighlight(
    text,
    [
      for (final term in terms)
        if (text.toLowerCase().contains(term.toLowerCase())) term,
    ],
    base: _base(tty),
    hit: tty.style(color: tty.green, size: TtySize.meta),
  );

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final ink = enabled ? tty.text : tty.faint;
    return TtyTap(
      minHeight: height,
      onTap: enabled && onTap != null
          ? () {
              HapticFeedback.selectionClick();
              onTap!();
            }
          : null,
      child: ColoredBox(
        color: selected ? ttyRaised(tty) : Colors.transparent,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(Tty.origin, 9, Tty.origin, 9),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  Expanded(
                    child: Text.rich(
                      TextSpan(
                        children: fzfHighlight(
                          title,
                          terms,
                          strict: strict,
                          base: tty.style(
                            color: ink,
                            size: TtySize.row,
                            weight: FontWeight.w600,
                          ),
                          hit: tty.style(
                            color: tty.green,
                            size: TtySize.row,
                            weight: FontWeight.w600,
                          ),
                        ),
                      ),
                      maxLines: 1,
                      softWrap: false,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (state case final state?) ...[
                    const SizedBox(width: 12),
                    TtyText(
                      state,
                      color: stateColor ?? tty.faint,
                      size: TtySize.meta,
                    ),
                  ],
                ],
              ),
              if (said case final said?) ...[
                const SizedBox(height: 3),
                Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(text: said.lead, style: _base(tty)),
                      for (final run in said.runs)
                        TextSpan(
                          text: run.text,
                          style: run.matched
                              ? tty.style(color: tty.green, size: TtySize.meta)
                              : _base(tty),
                        ),
                    ],
                  ),
                  maxLines: 1,
                  softWrap: false,
                  overflow: TextOverflow.ellipsis,
                ),
              ] else if (detail case final detail? when detail.isNotEmpty) ...[
                const SizedBox(height: 3),
                Text.rich(
                  TextSpan(
                    children: [
                      ..._lit(detail, tty),
                      if (branch case final branch? when branch.isNotEmpty) ...[
                        ttyBranchMark(tty, color: detailColor ?? tty.faint),
                        ..._lit(branch, tty),
                      ],
                      if (tail case final tail? when tail.isNotEmpty)
                        TextSpan(text: ' · $tail', style: _base(tty)),
                    ],
                  ),
                  maxLines: 1,
                  softWrap: false,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The `+` row that ends a list: `+ New Harness`, `+ Open Folder`. Cyan, the colour of what can be
/// tapped; an optional faint second line says where.
class FindAddRow extends StatelessWidget {
  const FindAddRow({
    super.key,
    required this.label,
    required this.onTap,
    this.detail,
  });

  final String label;
  final String? detail;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return TtyTap(
      minHeight: detail == null ? 52 : FindRow.height,
      semanticsLabel: label,
      onTap: onTap == null
          ? null
          : () {
              HapticFeedback.selectionClick();
              onTap!();
            },
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Tty.origin, 9, Tty.origin, 9),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            TtyText(
              '+ $label',
              color: onTap == null ? tty.faint : tty.text,
              size: TtySize.row,
              weight: FontWeight.w600,
            ),
            if (detail case final detail?) ...[
              const SizedBox(height: 3),
              TtyText(detail, color: tty.faint, size: TtySize.meta),
            ],
          ],
        ),
      ),
    );
  }
}

/// Find's section header — `needs you`, `recent`, `commands`: 13pt, faint, 28pt tall.
class FindHeader extends StatelessWidget {
  const FindHeader(this.text, {super.key, this.color});

  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return SizedBox(
      height: 36,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Tty.origin, 12, Tty.origin, 0),
        child: TtyText(text, color: color ?? tty.faint, size: TtySize.meta),
      ),
    );
  }
}
