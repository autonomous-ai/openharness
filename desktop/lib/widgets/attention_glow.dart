// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../fleet/neon.dart';
import '../state/attention_state.dart';

/// What a pane's frame does for one attention state. Each motion answers one question:
/// sweep "is it still working?", breathe "is it waiting on me?", alarm "is something blocked or
/// broken?", fill "did it just finish?". Idle and offline draw nothing, so a quiet desk stays quiet.
enum AttentionMotion { sweep, breathe, alarm, fill, none }

/// The pane's attention frame, painted over the child and never resizing it (motion never moves the layout).
///
/// - working: a short accent gradient runs around the border, 2.4 s a lap.
/// - waiting: the border and an outer glow breathe in yellow.
/// - permission / failed: a red pulse with a bright scan band that travels down the two side
///   edges. The band lives in the border, never over the terminal's text (design/attention-motion.md). Failed opens
///   with the device's double flash.
/// - done: the border draws itself once around the pane in green, then holds still. It keeps
///   holding after the pane has been looked at (`idle`, reviewed) until the agent's next turn, so a
///   finished pane reads green whenever it is not the one in front of you.
/// - Colour changes between states cross-fade over 280 ms instead of snapping.
/// - The focused pane draws no frame at all: its blue focus border is the only one on it.
///
/// Loops stop while the window is unfocused or reduced motion is on (then every state is a steady
/// border). The painter sits in its own layer, so the terminal repainting never repaints the frame
/// and a frame tick never repaints the terminal. [AttentionState] rows are value-equal, so the
/// once-a-second frame that changes nothing rebuilds nothing here.
class AttentionGlow extends StatefulWidget {
  const AttentionGlow({super.key, required this.attention, required this.agentId, required this.child, this.reducedMotion = false, this.focused = false});

  final AttentionState attention;
  final String agentId;
  final Widget child;

  /// The pane holds focus: its own focus border shows, so the attention frame steps aside.
  final bool focused;

  /// Forces reduced motion on; the platform setting and HARNESS_REDUCED_MOTION also turn it on.
  final bool reducedMotion;

  static AttentionMotion motionFor(AgentAttention s) => switch (s) {
        AgentAttention.working => AttentionMotion.sweep,
        AgentAttention.waiting => AttentionMotion.breathe,
        AgentAttention.permission || AgentAttention.failed => AttentionMotion.alarm,
        AgentAttention.done => AttentionMotion.fill,
        AgentAttention.idle || AgentAttention.offline => AttentionMotion.none,
      };

  /// Kept for callers of the first version (the bar legend, tests).
  static Color colorFor(AgentAttention s, ColorScheme scheme) => switch (s) {
        AgentAttention.permission || AgentAttention.failed => scheme.error,
        AgentAttention.waiting => Neon.fallbackYellow,
        _ => Colors.transparent,
      };

  @override
  State<AttentionGlow> createState() => _AttentionGlowState();
}

class _AttentionGlowState extends State<AttentionGlow> with TickerProviderStateMixin {
  // One loop clock for sweep, breathe and alarm; one one-shot clock for the done fill and the
  // failed double flash; one for the colour cross-fade. All three sit idle unless a state needs them.
  late final AnimationController _loop = AnimationController(vsync: this, duration: const Duration(milliseconds: 2400));
  late final AnimationController _once = AnimationController(vsync: this, duration: const Duration(milliseconds: 900), value: 1);
  late final AnimationController _fade = AnimationController(vsync: this, duration: const Duration(milliseconds: 280), value: 1);
  late final Listenable _tick = Listenable.merge([_loop, _once, _fade]);

  AttentionRow? _row;
  // The state the frame draws, which is not always the daemon's: nothing on the focused pane, and a
  // finished turn that has been looked at (idle, reviewed) still reads as done.
  AgentAttention? _shown;
  Color _from = Colors.transparent, _to = Colors.transparent;
  bool _reduced = false;

  AgentAttention? _shownFor(AttentionRow? r) {
    if (r == null || widget.focused) return null;
    if (r.state == AgentAttention.idle && r.detail == 'reviewed') return AgentAttention.done;
    return r.state;
  }

  @override
  void initState() {
    super.initState();
    _row = widget.attention.of(widget.agentId);
    _shown = _shownFor(_row);
    widget.attention.addListener(_onFrame);
    WindowFocus.instance.addListener(_syncLoop);
    // Once a fade out of the last state ends, drop the painter layer altogether.
    _fade.addStatusListener((s) {
      if (s == AnimationStatus.completed && mounted) setState(() {});
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduced = widget.reducedMotion || Motion.reducedOf(context);
    _to = _colorOf(_shown);
    if (_fade.value == 1) _from = _to;
    _syncLoop();
  }

  @override
  void didUpdateWidget(AttentionGlow old) {
    super.didUpdateWidget(old);
    if (!identical(old.attention, widget.attention)) {
      old.attention.removeListener(_onFrame);
      widget.attention.addListener(_onFrame);
    }
    _reduced = widget.reducedMotion || Motion.reducedOf(context);
    if (old.agentId != widget.agentId || !identical(old.attention, widget.attention)) {
      _onFrame();
    } else if (old.focused != widget.focused) {
      // Focus moved: show or hide the frame without replaying the done draw or the failed flash.
      _show(_shownFor(_row), animateOnce: false);
      if (mounted) setState(() {});
    }
    _syncLoop();
  }

  Color _colorOf(AgentAttention? s) =>
      s == null || AttentionGlow.motionFor(s) == AttentionMotion.none ? Colors.transparent : Neon.current().of(s);

  void _onFrame() {
    final next = widget.attention.of(widget.agentId);
    if (next == _row) return; // value-equal: nothing changed, nothing repaints
    final realChange = next?.state != _row?.state;
    _row = next;
    // The one-shot (done draw, failed flash) plays for a turn that just ended, not for a pane that
    // was looked at and is now showing its result again.
    _show(_shownFor(next), animateOnce: realChange);
    _syncLoop();
    if (mounted) setState(() {});
  }

  void _show(AgentAttention? next, {required bool animateOnce}) {
    if (next == _shown) return;
    _shown = next;
    // Cross-fade from whatever colour is on screen now.
    _from = Color.lerp(_from, _to, _fade.value) ?? _to;
    _to = _colorOf(next);
    if (_reduced) {
      _fade.value = 1;
    } else {
      _fade.forward(from: 0);
    }
    if (animateOnce && !_reduced && (next == AgentAttention.done || next == AgentAttention.failed)) {
      _once.duration = Duration(milliseconds: next == AgentAttention.done ? 900 : 520);
      _once.forward(from: 0);
    } else {
      _once.value = 1;
    }
  }

  void _syncLoop() {
    final motion = _shown == null ? AttentionMotion.none : AttentionGlow.motionFor(_shown!);
    final loops = motion == AttentionMotion.sweep || motion == AttentionMotion.breathe || motion == AttentionMotion.alarm;
    final run = loops && !_reduced && WindowFocus.instance.value;
    if (run && !_loop.isAnimating) {
      _loop.duration = Duration(milliseconds: switch (motion) { AttentionMotion.sweep => 2400, AttentionMotion.alarm => 1100, _ => 2200 });
      _loop.repeat();
    } else if (!run && _loop.isAnimating) {
      _loop.stop();
    }
  }

  @override
  void dispose() {
    widget.attention.removeListener(_onFrame);
    WindowFocus.instance.removeListener(_syncLoop);
    _loop.dispose();
    _once.dispose();
    _fade.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final shown = _shown;
    final motion = shown == null ? AttentionMotion.none : AttentionGlow.motionFor(shown);
    // One tree shape whether a frame is drawn or not: switching shapes would rebuild the terminal
    // underneath from scratch every time the frame came or went (each focus change, each state).
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: _tick,
        child: RepaintBoundary(child: widget.child),
        builder: (context, child) => CustomPaint(
          foregroundPainter: motion == AttentionMotion.none && _fade.value == 1
              ? null
              : AttentionBorderPainter(
                  motion: motion,
                  color: Color.lerp(_from, _to, Curves.easeOut.transform(_fade.value)) ?? _to,
                  phase: _loop.value,
                  progress: _once.value,
                  failed: shown == AgentAttention.failed,
                  reduced: _reduced,
                ),
          child: child,
        ),
      ),
    );
  }
}

/// Paints one pane's attention frame. Value-equal, so an unchanged frame is never repainted.
class AttentionBorderPainter extends CustomPainter {
  const AttentionBorderPainter({required this.motion, required this.color, required this.phase, required this.progress, this.failed = false, this.reduced = false});

  final AttentionMotion motion;
  final Color color;

  /// 0..1 around the loop clock.
  final double phase;

  /// 0..1 through a one-shot (done fill, failed flash); 1 when none is running.
  final double progress;
  final bool failed;
  final bool reduced;

  static const double width = 2;

  @override
  void paint(Canvas canvas, Size size) {
    if (color.a == 0) return;
    final rect = (Offset.zero & size).deflate(width / 2);
    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = width;
    if (reduced) {
      if (motion == AttentionMotion.none) return;
      canvas.drawRect(rect, stroke..color = color.withValues(alpha: motion == AttentionMotion.sweep ? 0.5 : 0.9));
      return;
    }
    switch (motion) {
      case AttentionMotion.none:
        // Only reached while the colour fades out of a previous state.
        canvas.drawRect(rect, stroke..color = color.withValues(alpha: 0.6));
      case AttentionMotion.sweep:
        _sweep(canvas, rect, stroke);
      case AttentionMotion.breathe:
        final t = 0.5 - 0.5 * math.cos(phase * 2 * math.pi);
        _glow(canvas, rect, 0.18 + 0.30 * t, 8 + 10 * t);
        canvas.drawRect(rect, stroke..color = color.withValues(alpha: 0.55 + 0.4 * t));
      case AttentionMotion.alarm:
        _alarm(canvas, rect, stroke);
      case AttentionMotion.fill:
        _fill(canvas, rect, stroke);
    }
  }

  void _glow(Canvas canvas, Rect rect, double alpha, double blur) {
    canvas.drawRect(
      rect,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 4
        ..color = color.withValues(alpha: alpha)
        ..maskFilter = MaskFilter.blur(BlurStyle.outer, blur),
    );
  }

  void _sweep(Canvas canvas, Rect rect, Paint stroke) {
    // A dim steady frame so the pane reads as "live", and a bright comet running around it.
    canvas.drawRect(rect, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = color.withValues(alpha: 0.22));
    final a = phase * 2 * math.pi;
    final shader = SweepGradient(
      center: Alignment.center,
      transform: GradientRotation(a),
      colors: [color.withValues(alpha: 0), color.withValues(alpha: 0), color.withValues(alpha: 0.35), color, color.withValues(alpha: 0)],
      stops: const [0, 0.72, 0.9, 0.985, 1],
    ).createShader(rect);
    canvas.drawRect(rect, stroke..shader = shader);
  }

  void _alarm(Canvas canvas, Rect rect, Paint stroke) {
    // Failed opens with two quick flashes, then settles into the pulse (design/attention-motion.md, device failed screen).
    if (failed && progress < 1) {
      final on = (progress * 4).floor().isEven;
      canvas.drawRect(rect, stroke..color = color.withValues(alpha: on ? 1 : 0.15));
      if (on) _glow(canvas, rect, 0.6, 18);
      return;
    }
    final t = math.pow(0.5 - 0.5 * math.cos(phase * 2 * math.pi), 2).toDouble();
    _glow(canvas, rect, 0.25 + 0.4 * t, 10 + 8 * t);
    canvas.drawRect(rect, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = width
      ..color = color.withValues(alpha: 0.7 + 0.3 * t));
    // The scan band: a bright 48 px segment sliding down both side edges, inside the border only.
    final y = rect.top + (rect.height + 96) * phase - 48;
    final band = Rect.fromLTRB(rect.left - 2, y - 48, rect.right + 2, y + 48);
    final shader = ui.Gradient.linear(band.topCenter, band.bottomCenter, [color.withValues(alpha: 0), Colors.white.withValues(alpha: 0.9), color.withValues(alpha: 0)], const [0, 0.5, 1]);
    final edge = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = width + 1
      ..shader = shader;
    canvas.save();
    canvas.clipRect(band);
    canvas.drawLine(rect.topLeft, rect.bottomLeft, edge);
    canvas.drawLine(rect.topRight, rect.bottomRight, edge);
    canvas.restore();
  }

  void _fill(Canvas canvas, Rect rect, Paint stroke) {
    final p = Curves.easeInOutCubic.transform(progress.clamp(0.0, 1.0));
    // Drawn clockwise from the top-left corner, like the device's done ring filling.
    final path = Path()..addRect(rect);
    final metric = path.computeMetrics().first;
    canvas.drawPath(metric.extractPath(0, metric.length * p), stroke..color = color);
    if (p < 1) {
      final head = metric.getTangentForOffset(metric.length * p)?.position;
      if (head != null) canvas.drawCircle(head, 3.5, Paint()..color = Colors.white.withValues(alpha: 0.9)..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3));
    } else {
      // Settled: a quieter green frame that says "finished, not yet looked at".
      canvas.drawRect(rect, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = color.withValues(alpha: 0.35));
    }
  }

  @override
  bool shouldRepaint(AttentionBorderPainter old) =>
      old.motion != motion || old.color != color || old.phase != phase || old.progress != progress || old.failed != failed || old.reduced != reduced;
}
