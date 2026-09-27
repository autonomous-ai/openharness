import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

/// The resting fill of the terminal's floating buttons — the mic, and Find while the keyboard is up.
///
/// ⚠️ **Solid, not see-through.** Over a terminal every button needs its own ground for its glyph to
/// read, and a near-opaque fill gives it one for nothing — the frosted blur that did the same job
/// read the whole backdrop through a GPU filter on every frame the output moved under it.
Color get floatingButtonFill =>
    AppTheme.pick(const Color(0xF2FFFFFF), const Color(0xF22A2A2F));
/// The rim that draws the circle's edge over whatever runs under it.
Color get floatingButtonRim =>
    AppTheme.pick(const Color(0x29000000), const Color(0x59FFFFFF));

/// The resting shadow under those buttons: enough to lift the edge off a bright
/// line of output.
List<BoxShadow> get floatingButtonShadow => [
  BoxShadow(
    color: Colors.black.withValues(alpha: 0.3),
    blurRadius: 10,
    offset: const Offset(0, 3),
  ),
];

/// What stood under a floating button to frost the output behind it — now nothing: the fill is
/// solid ([floatingButtonFill]). Kept as a pass-through so the buttons keep one shape to change.
///
/// ⚠️ **The blur went for speed.** A `BackdropFilter` re-reads and blurs what is under it every time
/// that changes, and under a streaming terminal it changes every frame — the one control that is
/// always on screen was the costliest thing on it.
class FloatingGlass extends StatelessWidget {
  const FloatingGlass({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => child;
}
