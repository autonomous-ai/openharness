import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

/// The daemon's world on the phone: a terminal at night, whatever the app's
/// theme (`daemons/lookbook.html`). The chip, the sheet and the reveal all sit
/// on these grounds, which is what lets each daemon keep its one xterm colour:
/// the contract puts daemon colours only on a terminal background, and on the
/// app's white page `#ffd75f` would not be read at all.
///
/// The colours are the lookbook's, named the way tmux spells them.
abstract final class DaemonInk {
  static const deep = Color(0xFF0C0C0C);
  static const ground = Color(0xFF1C1C1C); // colour234
  static const panel = Color(0xFF262626); // colour235
  static const line = Color(0xFF3A3A3A); // colour237
  static const faint = Color(0xFF626262); // colour241
  static const dim = Color(0xFF949494); // colour246
  static const ink = Color(0xFFD0D0D0); // colour252
  static const bright = Color(0xFFEEEEEE); // colour255
  static const green = Color(0xFF5FAF5F); // colour71, tmux's status line
  static const yellow = Color(0xFFD7AF5F); // colour179, tmux's message line
  static const cyan = Color(0xFF5FAFAF);
  static const magenta = Color(0xFFAF87AF);
  static const pitch = Color(0xFF000000);

  /// The rarity's colour on the stamp and the card's head.
  static Color rarity(String rarity) => switch (rarity) {
    'rare' => cyan,
    'legendary' => yellow,
    'secret' => magenta,
    _ => ink,
  };

  /// Ligatures off: `->` and `==` would merge into one glyph in a font that
  /// has them, and the art would lose a cell.
  static const noLigatures = [
    FontFeature.disable('liga'),
    FontFeature.disable('calt'),
    FontFeature.disable('dlig'),
  ];

  /// Monospace for anything drawn in cells.
  static TextStyle mono({
    double size = 13,
    Color color = ink,
    FontWeight weight = FontWeight.w400,
    double height = 1.25,
  }) => TextStyle(
    fontFamily: AppFont.mono,
    fontFamilyFallback: AppFont.monoFallback,
    fontSize: size,
    height: height,
    color: color,
    fontWeight: weight,
    fontFeatures: noLigatures,
    letterSpacing: 0,
  );

  /// Words to read, on the night ground.
  static TextStyle sans({
    double size = 14,
    Color color = ink,
    FontWeight weight = FontWeight.w400,
    double height = 1.4,
  }) => TextStyle(
    fontFamily: AppFont.sans,
    fontSize: size,
    height: height,
    color: color,
    fontWeight: weight,
  );
}

/// A button on the night ground: [filled] is the one thing to do (dark on
/// tmux's yellow), the rest are outlined. 44pt tall, whatever the label.
class DaemonButton extends StatelessWidget {
  const DaemonButton(
    this.label,
    this.onPressed, {
    super.key,
    this.hint,
    this.filled = false,
  });

  final String label;
  final VoidCallback onPressed;
  final String? hint;
  final bool filled;

  @override
  Widget build(BuildContext context) => Semantics(
    hint: hint,
    child: TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        minimumSize: const Size(96, 44),
        padding: const EdgeInsets.symmetric(horizontal: 18),
        foregroundColor: filled ? DaemonInk.pitch : DaemonInk.ink,
        backgroundColor: filled ? DaemonInk.yellow : Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
          side: filled
              ? BorderSide.none
              : const BorderSide(color: DaemonInk.line),
        ),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontFamily: AppFont.sans,
          fontSize: 15,
          fontWeight: FontWeight.w600,
        ),
      ),
    ),
  );
}
