// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../shared/theme/color_palette.dart';
import '../state/attention_state.dart';
import '../shared/theme/app_theme.dart' as grid;

/// The neon every animated surface in the app draws with (design/attention-motion.md, "the language").
///
/// Accent comes from the app palette (the Omarchy palette follows the live theme). Yellow, red and
/// green come from the Omarchy theme file when the theme's colour still reads as that colour, else
/// from fixed fallbacks: a theme that maps `red` to a green (some do) would otherwise make a
/// permission request look like a working agent, and the colour is the state.
@immutable
class Neon {
  const Neon({required this.accent, required this.yellow, required this.red, required this.green, required this.foreground, required this.background});

  final Color accent, yellow, red, green, foreground, background;

  static const fallbackYellow = Color(0xFFEAB308);
  static const fallbackRed = Color(0xFFEF4444);
  static const fallbackGreen = Color(0xFF22C55E);

  static Neon current() {
    final p = grid.AppTheme.palette.value;
    return Neon(
      accent: p.accent,
      yellow: themed('yellow', fallbackYellow, 35, 70),
      red: themed('red', fallbackRed, 335, 20),
      green: themed('green', fallbackGreen, 90, 170),
      foreground: p.foreground,
      background: p.background,
    );
  }

  /// The theme's [key] colour when its hue sits in [lo]..[hi] degrees (wrapping) and it is not grey.
  @visibleForTesting
  static Color themed(String key, Color fallback, double lo, double hi, {Color? Function(String)? read}) {
    final c = (read ?? OmarchyLivePalette.color)(key);
    if (c == null) return fallback;
    final hsv = HSVColor.fromColor(c);
    if (hsv.saturation < 0.35) return fallback;
    final h = hsv.hue;
    final inRange = lo <= hi ? (h >= lo && h <= hi) : (h >= lo || h <= hi);
    return inRange ? c : fallback;
  }

  /// The one colour per attention state, shared by pane borders, rings and the fleet graph.
  Color of(AgentAttention s) => switch (s) {
        AgentAttention.working => accent,
        AgentAttention.waiting => yellow,
        AgentAttention.permission || AgentAttention.failed => red,
        AgentAttention.done => green,
        AgentAttention.idle => foreground.withValues(alpha: 0.35),
        AgentAttention.offline => foreground.withValues(alpha: 0.15),
      };

  /// Spend arc colour: accent, amber from 80 percent, red at the cap (design/attention-motion.md "arcs are quantities").
  Color spend(double fraction) => fraction >= 1 ? red : fraction >= 0.8 ? yellow : accent;

  @override
  bool operator ==(Object other) =>
      other is Neon && other.accent == accent && other.yellow == yellow && other.red == red && other.green == green && other.foreground == foreground && other.background == background;

  @override
  int get hashCode => Object.hash(accent, yellow, red, green, foreground, background);
}

/// The one reduced-motion switch (design/attention-motion.md: "every animation sits behind one switch").
/// On when the platform asks for no animations, or when `HARNESS_REDUCED_MOTION=1` is set in the
/// environment or at build time. Tests set [override].
abstract final class Motion {
  static bool? override;
  static final bool _env = const bool.fromEnvironment('HARNESS_REDUCED_MOTION') || (!kIsWeb && Platform.environment['HARNESS_REDUCED_MOTION'] == '1');

  static bool reducedOf(BuildContext context) => override ?? (_env || (MediaQuery.maybeDisableAnimationsOf(context) ?? false));
}

/// Whether the window has focus, so looping animations can stop while nobody is looking.
/// Driven by the app lifecycle (desktop embedders report focus loss as `inactive`). Starts true.
class WindowFocus extends ValueNotifier<bool> with WidgetsBindingObserver {
  WindowFocus._() : super(true) {
    WidgetsBinding.instance.addObserver(this);
    final s = WidgetsBinding.instance.lifecycleState;
    if (s != null) value = s == AppLifecycleState.resumed;
  }

  static WindowFocus? _instance;
  static WindowFocus get instance => _instance ??= WindowFocus._();

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => value = state == AppLifecycleState.resumed;
}

/// The Omarchy chamfer (two-step bevel on the top-left and bottom-right corners) as a path, the shape
/// the wordmark's letters carry. Used for hexagon-free tiles and the splash frame.
Path chamferPath(Rect r, double c) => Path()
  ..moveTo(r.left + c, r.top)
  ..lineTo(r.right, r.top)
  ..lineTo(r.right, r.bottom - c)
  ..lineTo(r.right - c, r.bottom)
  ..lineTo(r.left, r.bottom)
  ..lineTo(r.left, r.top + c)
  ..close();
