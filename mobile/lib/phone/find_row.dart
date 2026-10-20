import 'dart:math' as math;

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
/// docs-rewrite                      working · 2m
/// M2:site ⑂ docs-v2
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
    this.stateTail,
    this.terms = const [],
    this.selected = false,
    this.enabled = true,
    this.onTap,
    this.onLongPress,
    this.strict = false,
    this.said,
    this.accessory,
    this.accessoryRoom = 0,
    this.minHeight = FindRow.height,
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

  /// `asking`, `working`, `exited` — one word, right-aligned on line 1. Null for a harness with
  /// nothing to say (idle), whose line 1 then ends in [stateTail] alone.
  final String? state;
  final Color? stateColor;

  /// After [state] on line 1, behind a `·`: the age, or `current` — or on its own where there is
  /// no [state]. On line 1 rather than as [tail], where a long folder and branch cut it off.
  final String? stateTail;

  /// A control at the end of line 1, beside [state], centred on that line. No row passes one today
  /// — Find's recap toggle, its one user, was removed (2026-09-30) — but the slot stays for the next.
  ///
  /// ⚠️ **Over the row, not inside it.** The row lights the moment a finger rests on it
  /// ([TtyTap]), and a control nested in it would light the whole row as though it were about to
  /// open. Drawn above it in a [Stack] instead, the control takes its own taps and the row never
  /// sees them. It is given a band centred on line 1 and whatever width it takes, flush with the
  /// row's right edge; [accessoryRoom] keeps the words clear of it.
  final Widget? accessory;

  /// Room kept at the end of line 1 for [accessory]. Keep it on rows without one too, so a list's
  /// state words stand in one column.
  final double accessoryRoom;

  /// What was typed, lit green in [title] and [detail].
  final List<String> terms;

  /// The row Return opens: the raised ground behind it.
  final bool selected;
  final bool enabled;
  final VoidCallback? onTap;

  /// Holding the row: its actions — taken even while [enabled] is false, which is when a harness
  /// on a computer that does not answer most needs one (Remove from this list).
  final VoidCallback? onLongPress;

  static const double height = 60;

  /// [height], or less for a row of one line where its second has been said once for a group of
  /// them — Computers' offline ones. Never under a thumb's 44.
  final double minHeight;

  /// Above line 1 and below line 2.
  static const double _pad = 9;

  /// Between line 1 and line 2.
  static const double _gap = 3;

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
    final held = onLongPress;
    final tapped = TtyTap(
      minHeight: minHeight,
      onTap: enabled && onTap != null
          ? () {
              HapticFeedback.selectionClick();
              onTap!();
            }
          : null,
      child: ColoredBox(
        color: selected ? ttyRaised(tty) : Colors.transparent,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            Tty.origin,
            _pad,
            Tty.origin,
            _pad,
          ),
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
                  if (state != null || (stateTail ?? '').isNotEmpty) ...[
                    const SizedBox(width: 12),
                    Text.rich(
                      TextSpan(
                        children: [
                          if (state case final state?)
                            TextSpan(
                              text: state,
                              style: tty.style(
                                color: stateColor ?? tty.faint,
                                size: TtySize.meta,
                              ),
                            ),
                          if (stateTail case final tail? when tail.isNotEmpty)
                            TextSpan(
                              // Alone, without the `·` that joins it to a word — see [state].
                              text: state == null ? tail : ' · $tail',
                              style: tty.style(
                                color: tty.faint,
                                size: TtySize.meta,
                              ),
                            ),
                        ],
                      ),
                      maxLines: 1,
                      softWrap: false,
                      overflow: TextOverflow.clip,
                    ),
                  ],
                  if (accessoryRoom > 0) SizedBox(width: accessoryRoom),
                ],
              ),
              if (said case final said?) ...[
                const SizedBox(height: _gap),
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
                const SizedBox(height: _gap),
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
    final row = held == null
        ? tapped
        : GestureDetector(
            behavior: HitTestBehavior.opaque,
            onLongPress: () {
              HapticFeedback.mediumImpact();
              held();
            },
            child: tapped,
          );
    final accessory = this.accessory;
    if (accessory == null) return row;
    final center = _lineOneCenter(context, tty);
    return Stack(
      // The row sized exactly as it would be alone: a loose width would let it shrink to its words.
      fit: StackFit.passthrough,
      children: [
        row,
        Positioned(
          top: 0,
          right: 0,
          // Line 1's centre, and as much height around it as the row has above it: the control
          // centres on the name without reaching past the row's top.
          height: center * 2,
          child: accessory,
        ),
      ],
    );
  }

  /// How far below the row's top the middle of line 1 is.
  ///
  /// Arithmetic, not a measurement: [Tty.style] pins every line to its size × its `height`, and
  /// [TtyTap] centres content shorter than [minHeight] — which a row of two lines at the default
  /// text size is.
  double _lineOneCenter(BuildContext context, Tty tty) {
    final scaler = MediaQuery.textScalerOf(context);
    double line(double size) {
      final style = tty.style(size: size);
      return scaler.scale(size) * (style.height ?? 1);
    }

    final one = line(TtySize.row);
    final two = said != null || (detail?.isNotEmpty ?? false)
        ? _gap + line(TtySize.meta)
        : 0.0;
    final content = _pad * 2 + one + two;
    return math.max(0.0, (minHeight - content) / 2) + _pad + one / 2;
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
