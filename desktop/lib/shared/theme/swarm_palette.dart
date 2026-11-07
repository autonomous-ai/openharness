import 'package:flutter/painting.dart';

/// The Swarm's identity artwork colours (desktop-design-system.md, Swarm elements): an agent's face and a Lead's
/// ring. Artwork, so the same in light and dark.
abstract final class SwarmPalette {
  /// An agent's face fills, top to bottom; its name's hash % 8 picks one.
  static final faces = <(Color, Color)>[
    (_hsl(14, 86, 72), _hsl(10, 76, 62)), // coral
    (_hsl(38, 92, 70), _hsl(32, 84, 59)), // apricot
    (_hsl(146, 46, 64), _hsl(150, 42, 52)), // sage
    (_hsl(178, 44, 60), _hsl(182, 48, 48)), // teal
    (_hsl(206, 82, 70), _hsl(212, 72, 59)), // sky
    (_hsl(238, 72, 76), _hsl(242, 60, 65)), // periwinkle
    (_hsl(274, 60, 76), _hsl(278, 48, 64)), // lilac
    (_hsl(334, 76, 76), _hsl(338, 66, 65)), // rose
  ];

  /// The eyes and smile on every face.
  static const faceInk = Color(0xFF221F29);

  /// The thin ring a Lead wears around its avatar.
  static final leadRing = _hsl(42, 92, 58);
}

Color _hsl(double hue, double saturation, double lightness) =>
    HSLColor.fromAHSL(1, hue, saturation / 100, lightness / 100).toColor();
