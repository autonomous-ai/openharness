// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../state/attention_state.dart';
import '../branding/brand_mark.dart';
import '../branding/brand_prefs.dart';
import 'neon.dart';

/// The per-agent spend arc drawn around the pane header's engine mark (design/attention-motion.md, "arcs
/// are quantities"). Present only when a per-agent cap is set (the daemon sends `spend.fraction`).
/// Accent below 80 percent, amber from 80, red at the cap. The child keeps its size: the arc is
/// painted outside it, so the header's layout never moves.
///
/// While the agent waits on you (a question or a permission request) the mark is replaced by your
/// avatar inside a ring in the state colour: the header says who it is waiting on, not just that it
/// waits. The avatar is the one chosen in Settings, Appearance ([BrandPrefsStore]).
class SpendRing extends StatefulWidget {
  const SpendRing({super.key, required this.attention, required this.agentId, required this.child, this.gap = 3, this.brand});

  final AttentionState attention;
  final String agentId;
  final Widget child;
  final double gap;
  final BrandPrefsStore? brand;

  @override
  State<SpendRing> createState() => _SpendRingState();
}

class _SpendRingState extends State<SpendRing> {
  double? _fraction;
  double? _usd;
  AgentAttention? _state;

  BrandPrefsStore get _brand => widget.brand ?? brandPrefsStore;

  bool get _asking => _state == AgentAttention.waiting || _state == AgentAttention.permission;

  @override
  void initState() {
    super.initState();
    widget.attention.addListener(_onFrame);
    _brand.addListener(_onBrand);
    _read();
  }

  void _onBrand() {
    if (_asking && mounted) setState(() {});
  }

  @override
  void didUpdateWidget(SpendRing old) {
    super.didUpdateWidget(old);
    if (!identical(old.attention, widget.attention)) {
      old.attention.removeListener(_onFrame);
      widget.attention.addListener(_onFrame);
    }
    _read();
  }

  bool _read() {
    final row = widget.attention.of(widget.agentId);
    final f = row?.spendFraction, u = row?.spendUsd, st = row?.state;
    if (f == _fraction && u == _usd && st == _state) return false;
    _fraction = f;
    _usd = u;
    _state = st;
    return true;
  }

  void _onFrame() {
    if (_read() && mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.attention.removeListener(_onFrame);
    _brand.removeListener(_onBrand);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final f = _fraction;
    if (_asking) return _avatar(context, f);
    if (f == null) return widget.child;
    final pct = (f * 100).round();
    final usd = _usd == null ? '' : '\$${_usd!.toStringAsFixed(2)} spent, ';
    return Tooltip(
      message: '$usd$pct% of the cap',
      child: Stack(
        clipBehavior: Clip.none,
        alignment: Alignment.center,
        children: [
          widget.child,
          Positioned(
            left: -widget.gap - 2,
            top: -widget.gap - 2,
            right: -widget.gap - 2,
            bottom: -widget.gap - 2,
            child: IgnorePointer(child: SpendArc(fraction: f)),
          ),
        ],
      ),
    );
  }
}

extension on _SpendRingState {
  Widget _avatar(BuildContext context, double? f) {
    final neon = Neon.current();
    final color = neon.of(_state!);
    final label = _state == AgentAttention.permission ? 'Needs your permission' : 'Waiting on you';
    return Tooltip(
      message: f == null ? label : '$label, ${(f * 100).round()}% of the spend cap',
      child: Stack(
        clipBehavior: Clip.none,
        alignment: Alignment.center,
        children: [
          // Same footprint as the mark it replaces, so the header does not move.
          Opacity(opacity: 0, child: widget.child),
          Positioned.fill(
            child: AvatarBadge(avatar: _brand.resolveAvatar(), size: 17, color: color, background: neon.background),
          ),
          Positioned(
            left: -widget.gap - 2,
            top: -widget.gap - 2,
            right: -widget.gap - 2,
            bottom: -widget.gap - 2,
            child: IgnorePointer(
              child: f == null
                  ? CustomPaint(painter: SpendArcPainter(fraction: 1, color: color, track: color, stroke: 2))
                  : SpendArc(fraction: f),
            ),
          ),
        ],
      ),
    );
  }
}

/// A 0..100 percent arc that eases to its new value, turns amber at 80 percent and holds red at the
/// cap, where it pulses once (the moment it crosses) and then stays still.
class SpendArc extends StatefulWidget {
  const SpendArc({super.key, required this.fraction, this.stroke = 2});

  final double fraction;
  final double stroke;

  @override
  State<SpendArc> createState() => _SpendArcState();
}

class _SpendArcState extends State<SpendArc> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 700), value: 1);

  @override
  void didUpdateWidget(SpendArc old) {
    super.didUpdateWidget(old);
    if (old.fraction < 1 && widget.fraction >= 1 && !Motion.reducedOf(context)) _pulse.forward(from: 0);
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final neon = Neon.current();
    final reduced = Motion.reducedOf(context);
    return RepaintBoundary(
      child: TweenAnimationBuilder<double>(
        tween: Tween(end: widget.fraction),
        duration: reduced ? Duration.zero : const Duration(milliseconds: 450),
        curve: Curves.easeOutCubic,
        builder: (context, f, _) => AnimatedBuilder(
          animation: _pulse,
          builder: (context, _) => CustomPaint(
            painter: SpendArcPainter(
              fraction: f,
              color: neon.spend(f),
              track: neon.foreground.withValues(alpha: 0.12),
              stroke: widget.stroke,
              pulse: _pulse.value,
            ),
          ),
        ),
      ),
    );
  }
}

class SpendArcPainter extends CustomPainter {
  const SpendArcPainter({required this.fraction, required this.color, required this.track, required this.stroke, this.pulse = 1});

  final double fraction;
  final Color color, track;
  final double stroke;

  /// 0..1 through the cap-crossing pulse; 1 when none is running.
  final double pulse;

  @override
  void paint(Canvas canvas, Size size) {
    final r = Rect.fromCircle(center: size.center(Offset.zero), radius: math.min(size.width, size.height) / 2 - stroke / 2);
    final p = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(r, 0, 2 * math.pi, false, p..color = track);
    final sweep = 2 * math.pi * fraction.clamp(0.0, 1.0);
    if (pulse < 1) {
      final t = math.sin(pulse * math.pi);
      canvas.drawArc(r.inflate(2 * t), -math.pi / 2, sweep, false, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke + 3 * t
        ..color = color.withValues(alpha: 0.5 * t)
        ..maskFilter = MaskFilter.blur(BlurStyle.normal, 4 * t + 0.01));
    }
    canvas.drawArc(r, -math.pi / 2, sweep, false, p..color = color);
  }

  @override
  bool shouldRepaint(SpendArcPainter old) => old.fraction != fraction || old.color != color || old.track != track || old.stroke != stroke || old.pulse != pulse;
}
