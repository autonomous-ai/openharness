import 'package:flutter/painting.dart';

/// Ink that sits on a colour of its own rather than on a surface.
abstract final class AppInk {
  /// A letter or glyph on a solid fill: the accent, an avatar's disc, a
  /// count's badge. Every fill it goes on is measured for white
  /// (`AppPalette.accent`, `avatarFill`, `avatarPalette`), in both themes.
  static const Color onFill = Color(0xFFFFFFFF);
}
