import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'phone_status.dart';

/// The palette colour a [PhoneTone] draws in.
Color phoneToneColor(PhoneTone tone) => switch (tone) {
  PhoneTone.good => AppPalette.online,
  PhoneTone.busy => AppPalette.accent,
  PhoneTone.attention => AppPalette.warn,
  PhoneTone.bad => AppPalette.offline,
  PhoneTone.quiet => AppPalette.textFaint,
};

/// A status line: a dot — a small spinner while something is under way — and its label.
class StatusPill extends StatelessWidget {
  const StatusPill({
    super.key,
    required this.summary,
    this.fontSize = 13,
    this.dotSize = StatusDot.defaultSize,
    this.gap = 7,
  });

  final PhoneSummary summary;
  final double fontSize;

  /// The dot's box. Defaulted rather than derived from [fontSize]: every screen
  /// but one wants the full-size dot, and tying the two would have shrunk them
  /// all the day the terminal's foot row asked for a smaller one.
  final double dotSize;

  /// Between the dot and its label, which narrows with the dot.
  final double gap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final color = phoneToneColor(summary.tone);
    final quiet = summary.tone == PhoneTone.quiet;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        StatusDot(summary: summary, size: dotSize),
        SizedBox(width: gap),
        Flexible(
          child: Text(
            summary.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: quiet ? AppPalette.textSecondary : color,
              fontSize: fontSize,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
      ],
    );
  }
}

/// The status without its words: a dot in the tone's colour, or a small spinner while something is
/// under way. For a place with no room for a label — the terminal header, beside the agent's name.
///
/// The label is still there for a screen reader, and as a long-press tooltip, so a colour is never
/// the only way to learn what it means.
class StatusDot extends StatelessWidget {
  const StatusDot({
    super.key,
    required this.summary,
    this.ring,
    this.size = defaultSize,
  });

  /// The box every screen but the terminal's foot row draws it at.
  static const double defaultSize = 10;

  final PhoneSummary summary;

  /// The dot's box. The filled circle inside it keeps the same proportion, and
  /// the spinner's stroke thins with it — a 1.6pt stroke on an 8pt box reads as
  /// a solid ring rather than as something turning.
  final double size;

  /// A cut-out ring in this colour around the dot, for a dot laid OVER something — a badge on a
  /// mark, the way presence sits on an avatar. It should be the colour behind the mark, so the dot
  /// reads as notched into it rather than stuck on top.
  final Color? ring;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final color = phoneToneColor(summary.tone);
    final ring = this.ring;
    Widget dot = SizedBox.square(
      dimension: size,
      child: summary.tone == PhoneTone.busy
          ? CircularProgressIndicator(
              strokeWidth: 1.6 * size / defaultSize,
              color: color,
            )
          : Center(
              child: DecoratedBox(
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                child: SizedBox.square(dimension: size * 0.8),
              ),
            ),
    );
    if (ring != null) {
      dot = DecoratedBox(
        decoration: BoxDecoration(color: ring, shape: BoxShape.circle),
        child: Padding(padding: const EdgeInsets.all(2), child: dot),
      );
    }
    return Tooltip(
      message: summary.label,
      child: Semantics(label: summary.label, child: dot),
    );
  }
}
