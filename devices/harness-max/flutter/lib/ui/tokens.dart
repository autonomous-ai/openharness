// The mockup's tokens (Diego's "Harness bar" in the dial's look, tab 9 "Diego + 1 chạm"): colours, faces, the canvas.
import 'package:flutter/widgets.dart';

/// The canvas the pages are laid out on: the mockup's pixels, the Orange Pi bar's own (1480 x 320). BarFrame scales
/// it to any glass of the same shape (1920 x 415 is 1.297 times it).
const Size kCanvas = Size(1480, 320);

abstract final class Ink {
  static const bg = Color(0xFF000000);
  static const fg = Color(0xFFEAEAF0);
  static const words = Color(0xFFEFE7DE); // --ink
  static const recap = Color(0xFFD6D6D2);
  static const dim = Color(0xFFADA6AD);
  static const rest = Color(0xFF9A9AA6);
  static const faint = Color(0xFF585863);
  static const card = Color(0xFF1C1E26);
  static const rim = Color(0xFF3D3F47);
  static const sel = Color(0xFF392C4A);
  static const line = Color(0xFF16161C);
  static const accent = Color(0xFFC6AAEF); // lavender: working
  static const done = Color(0xFF0DBC79);
  static const ask = Color(0xFFE5E510); // waiting
  static const fail = Color(0xFFCD3131); // the failed rail and edge
  static const failText = Color(0xFFFF6B6B);
  static const voice = Color(0xFF00FF2F);
  static const claude = Color(0xFFFF9E64);
  static const codex = Color(0xFF8FB4FF);
  static const muse = Color(0xFFF2DCB8);
}

/// The mockup's --sans (Inter) and --num (Chakra Petch) faces, and the mono for a permission's command.
abstract final class Face {
  static const sans = 'Inter';
  static const num = 'ChakraPetch';
  static const mono = 'JetBrainsMono';

  static TextStyle s(double size, {FontWeight weight = FontWeight.w400, Color color = Ink.fg, double? height,
          double? spacing}) =>
      TextStyle(
          fontFamily: sans, fontSize: size, fontWeight: weight, color: color, height: height, letterSpacing: spacing);

  static TextStyle n(double size, {FontWeight weight = FontWeight.w500, Color color = Ink.fg, double? height,
          double? spacing}) =>
      TextStyle(
          fontFamily: num,
          fontSize: size,
          fontWeight: weight,
          color: color,
          height: height,
          letterSpacing: spacing,
          fontFeatures: const [FontFeature.tabularFigures()]);
}

/// The engine's label and ink, as the mockup's ENG.
({String label, Color ink}) engineOf(String engine) => switch (engine) {
      'claude' => (label: 'Claude Code', ink: Ink.claude),
      'codex' => (label: 'Codex', ink: Ink.codex),
      '' || 'muse' => (label: 'Muse', ink: Ink.muse),
      _ => (label: engine[0].toUpperCase() + engine.substring(1), ink: Ink.muse),
    };

/// The pet art an engine plays: claude and codex have their own, every other engine the Muse.
String petEngineOf(String engine) => engine == 'claude' || engine == 'codex' ? engine : 'muse';
