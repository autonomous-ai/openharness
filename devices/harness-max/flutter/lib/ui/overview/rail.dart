// The bar's signature: a status light along the top of a cell, a column or a strip segment (the mockup's .rail). A
// working agent's rail has a white light sweeping along it; a waiting agent's pulses.
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../../model/types.dart';
import '../tokens.dart';
import 'motion.dart';

/// A state's rail: its status colour, but a resting agent's is the mockup's dark #2a2a33.
Color railInk(AgentState s) => s == AgentState.idle ? const Color(0xFF2A2A33) : statusInk(s);

/// A state's words and glow (the mockup's --c): a failure in its red, a resting agent in faint.
Color wordInk(AgentState s) => switch (s) {
      AgentState.failed => Ink.failText,
      AgentState.idle => Ink.faint,
      _ => statusInk(s),
    };

/// The app and bell columns' rail, lit by nothing.
const Color kSideRail = Color(0xFF1A1A22);

/// A rail [height] tall along the top of its box. [opacity]: the rail's own (a strip segment's is .5); [glow]: the
/// shown segment's, the light falling from it into the box (box-shadow 0 0 14px).
class Rail extends StatelessWidget {
  const Rail({super.key, required this.color, this.state, this.height = 5, this.opacity = 1, this.glow = false});
  final Color color;

  /// The agent's state: working sweeps, asking pulses; null for a column's still rail.
  final AgentState? state;
  final double height, opacity;
  final bool glow;

  @override
  Widget build(BuildContext context) {
    final moves = state == AgentState.working || state == AgentState.asking;
    return RepaintBoundary(
      child: CustomPaint(
        size: Size.infinite,
        painter: _RailPainter(this, moves ? Motion.of(context) : null),
      ),
    );
  }
}

class _RailPainter extends CustomPainter {
  _RailPainter(this.rail, this.clock) : super(repaint: clock);
  final Rail rail;
  final ValueListenable<double>? clock;

  @override
  void paint(Canvas canvas, Size size) {
    final t = clock?.value ?? 0;
    var o = rail.opacity;
    // pulse 1s ease-in-out: down to .35 and back
    if (rail.state == AgentState.asking) o = pulse(loop(t, 1)!, base: rail.opacity, curve: Curves.easeInOut);
    final c = rail.color;
    final bar = Rect.fromLTWH(0, 0, size.width, rail.height);
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    if (rail.glow) {
      canvas.drawRect(
          bar, Paint()..color = c.withValues(alpha: o)..maskFilter = const MaskFilter.blur(BlurStyle.normal, 7));
    }
    final base = c.withValues(alpha: o);
    // A shader's colours are multiplied by the paint's alpha: the swept rail's paint stays opaque.
    final paint = Paint()..color = rail.state == AgentState.working ? const Color(0xFF000000) : base;
    if (rail.state == AgentState.working) {
      // sweep 1.5s linear: a light 55% of the rail long, white in overlay over the rail's colour, which takes the rail
      // toward overlayWhite by the light's alpha; outside the light the gradient clamps to the rail's colour.
      final w = size.width * .55, x = sweep(loop(t, 1.5)!) * w;
      final peak = overlayWhite(c).withValues(alpha: o);
      paint.shader = ui.Gradient.linear(Offset(x, 0), Offset(x + w, 0), [base, peak, base], const [0, .5, 1]);
    }
    canvas.drawRect(bar, paint);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_RailPainter old) =>
      old.rail.color != rail.color ||
      old.rail.state != rail.state ||
      old.rail.height != rail.height ||
      old.rail.opacity != rail.opacity ||
      old.rail.glow != rail.glow ||
      old.clock != clock;
}
