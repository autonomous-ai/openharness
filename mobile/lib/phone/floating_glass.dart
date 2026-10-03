import 'package:flutter/widgets.dart';

/// What stood under a floating button to frost the output behind it — now nothing: the fill is
/// solid, which gives a glyph over a terminal its own ground for nothing. Kept as a pass-through so
/// the buttons keep one shape to change.
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
