// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../state/attention_state.dart';
import '../branding/brand_mark.dart';
import '../branding/brand_prefs.dart';
import 'neon.dart';

/// One agent as the fleet graph draws it.
@immutable
class FleetAgent {
  const FleetAgent({required this.id, required this.name, required this.state, this.lane, this.spendFraction});
  final String id, name;
  final AgentAttention state;
  final String? lane;
  final double? spendFraction;

  @override
  bool operator ==(Object other) => other is FleetAgent && other.id == id && other.name == name && other.state == state && other.lane == lane && other.spendFraction == spendFraction;
  @override
  int get hashCode => Object.hash(id, name, state, lane, spendFraction);
}

/// One machine and its agents.
@immutable
class FleetMachine {
  const FleetMachine({required this.id, required this.name, required this.connected, this.local = false, this.agents = const []});
  final String id, name;
  final bool connected, local;
  final List<FleetAgent> agents;

  @override
  bool operator ==(Object other) =>
      other is FleetMachine && other.id == id && other.name == name && other.connected == connected && other.local == local && _listEq(other.agents, agents);
  @override
  int get hashCode => Object.hash(id, name, connected, local, Object.hashAll(agents));
}

bool _listEq<T>(List<T> a, List<T> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

const _priority = [AgentAttention.permission, AgentAttention.waiting, AgentAttention.failed, AgentAttention.done, AgentAttention.working, AgentAttention.idle, AgentAttention.offline];

bool _live(AgentAttention s) => s == AgentAttention.working || s == AgentAttention.waiting || s == AgentAttention.permission || s == AgentAttention.failed;

/// Where every node sits at phase 0. Machines on an ellipse around the hub, agents on a small orbit
/// around their machine; all inside the canvas whatever its size.
class FleetLayout {
  FleetLayout._(this.hub, this.machines, this.agents, this.machineRadius, this.orbit);

  final Offset hub;
  final Map<String, Offset> machines;
  final Map<String, Offset> agents;
  final double machineRadius, orbit;

  static FleetLayout compute(Size size, List<FleetMachine> fleet, {double phase = 0}) {
    final hub = size.center(Offset.zero);
    final n = math.max(1, fleet.length);
    final most = fleet.fold<int>(1, (m, f) => math.max(m, f.agents.length));
    final machineRadius = (math.min(size.width, size.height) * 0.07).clamp(14.0, 30.0);
    final orbit = machineRadius + (most > 6 ? 30.0 : 24.0);
    final margin = orbit + 12;
    final rx = math.max(0.0, size.width / 2 - margin), ry = math.max(0.0, size.height / 2 - margin - 10);
    final machines = <String, Offset>{};
    final agents = <String, Offset>{};
    for (var i = 0; i < fleet.length; i++) {
      final m = fleet[i];
      final a = -math.pi / 2 + 2 * math.pi * i / n;
      final c = fleet.length == 1 ? hub + Offset(0, ry * 0.35) : hub + Offset(rx * math.cos(a), ry * math.sin(a));
      machines[m.id] = c;
      final k = m.agents.length;
      // Busy machines turn: the orbit's motion is the machine's activity.
      final spin = m.agents.any((g) => g.state == AgentAttention.working) ? phase * 2 * math.pi : 0.0;
      for (var j = 0; j < k; j++) {
        final b = -math.pi / 2 + 2 * math.pi * j / k + spin;
        agents[m.agents[j].id] = c + Offset(orbit * math.cos(b), orbit * math.sin(b));
      }
    }
    return FleetLayout._(hub, machines, agents, machineRadius, orbit);
  }
}

/// The fleet at a glance. The hub is this window; each hexagon a machine (dashed link when
/// it is not connected); each ring an agent in its attention colour and glyph.
///
/// Motion carries the state, nothing else moves:
/// - a machine's agents orbit it only while one of them is working;
/// - packets flow hub to machine along a link while work runs there, and machine to hub, in the
///   state colour, while an agent there waits on you or needs permission (direction = who waits on whom);
/// - waiting rings breathe, permission and failed rings pulse, working rings carry a sweep arc.
/// The whole graph stops (one static frame) when nothing is live, the window is unfocused, or
/// reduced motion is on. Tapping an agent calls [onAgentTap].
class FleetGraph extends StatefulWidget {
  const FleetGraph({super.key, required this.machines, this.onAgentTap, this.hubLabel = 'this app', this.brand});

  /// The avatar drawn inside the ring of an agent waiting on you; the app's store when null.
  final BrandPrefsStore? brand;

  final List<FleetMachine> machines;
  final ValueChanged<String>? onAgentTap;
  final String hubLabel;

  @override
  State<FleetGraph> createState() => _FleetGraphState();
}

class _FleetGraphState extends State<FleetGraph> with SingleTickerProviderStateMixin {
  late final AnimationController _clock = AnimationController(vsync: this, duration: const Duration(seconds: 12));
  bool _reduced = false;
  Size _size = Size.zero;

  bool get _anyLive => widget.machines.any((m) => m.agents.any((a) => _live(a.state)));

  @override
  void initState() {
    super.initState();
    WindowFocus.instance.addListener(_sync);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduced = Motion.reducedOf(context);
    _sync();
  }

  @override
  void didUpdateWidget(FleetGraph old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    final run = _anyLive && !_reduced && WindowFocus.instance.value;
    if (run && !_clock.isAnimating) {
      _clock.repeat();
    } else if (!run && _clock.isAnimating) {
      _clock.stop();
    }
  }

  @override
  void dispose() {
    WindowFocus.instance.removeListener(_sync);
    _clock.dispose();
    super.dispose();
  }

  void _tap(TapUpDetails d) {
    final cb = widget.onAgentTap;
    if (cb == null) return;
    final l = FleetLayout.compute(_size, widget.machines, phase: _clock.value);
    String? best;
    var bestD = 18.0;
    l.agents.forEach((id, p) {
      final dd = (p - d.localPosition).distance;
      if (dd < bestD) {
        bestD = dd;
        best = id;
      }
    });
    if (best != null) cb(best!);
  }

  @override
  Widget build(BuildContext context) {
    final neon = Neon.current();
    final all = [for (final m in widget.machines) ...m.agents];
    final counts = <AgentAttention, int>{};
    for (final a in all) {
      counts[a.state] = (counts[a.state] ?? 0) + 1;
    }
    final top = _priority.where((s) => (counts[s] ?? 0) > 0).firstOrNull;
    final mono = TextStyle(fontFamily: 'monospace', fontSize: 12, color: neon.foreground.withValues(alpha: 0.85));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: Row(
            children: [
              if (top != null)
                Text('${attentionGlyph(top)} ${counts[top]}  ${attentionLabel(top)}', style: mono.copyWith(color: neon.of(top), fontWeight: FontWeight.w700))
              else
                Text('- 0  no agents', style: mono),
              const Spacer(),
              // Legend: glyph and word for every state on screen, so colour is never the only signal.
              for (final s in _priority)
                if (s != top && (counts[s] ?? 0) > 0)
                  Padding(
                    padding: const EdgeInsets.only(left: 12),
                    child: Text('${attentionGlyph(s)} ${counts[s]} ${attentionLabel(s)}', style: mono.copyWith(color: neon.of(s).withValues(alpha: 1))),
                  ),
            ],
          ),
        ),
        Expanded(
          child: LayoutBuilder(builder: (context, c) {
            _size = c.biggest;
            final asking = [for (final m in widget.machines) ...m.agents.where((a) => a.state == AgentAttention.waiting || a.state == AgentAttention.permission)];
            final avatar = (widget.brand ?? brandPrefsStore).resolveAvatar();
            return Stack(
              children: [
                GestureDetector(
                  onTapUp: _tap,
                  child: RepaintBoundary(
                    child: CustomPaint(
                      size: c.biggest,
                      painter: FleetPainter(machines: widget.machines, clock: _clock, neon: neon, hubLabel: widget.hubLabel, reduced: _reduced),
                    ),
                  ),
                ),
                // Who they wait on: the person's avatar inside each asking agent's ring.
                if (asking.isNotEmpty)
                  IgnorePointer(
                    child: AnimatedBuilder(
                      animation: _clock,
                      builder: (context, _) {
                        final l = FleetLayout.compute(c.biggest, widget.machines, phase: _reduced ? 0 : _clock.value);
                        return Stack(children: [
                          for (final a in asking)
                            if (l.agents[a.id] case final p?)
                              Positioned(
                                left: p.dx - 7,
                                top: p.dy - 7,
                                child: AvatarBadge(avatar: avatar, size: 14, color: neon.of(a.state), background: neon.background),
                              ),
                        ]);
                      },
                    ),
                  ),
              ],
            );
          }),
        ),
      ],
    );
  }
}

class FleetPainter extends CustomPainter {
  FleetPainter({required this.machines, required this.clock, required this.neon, required this.hubLabel, required this.reduced}) : super(repaint: clock);

  final List<FleetMachine> machines;
  final Animation<double> clock;
  final Neon neon;
  final String hubLabel;
  final bool reduced;

  Path _hex(Offset c, double r) {
    final p = Path();
    for (var i = 0; i < 6; i++) {
      final a = math.pi / 6 + i * math.pi / 3;
      final v = c + Offset(r * math.cos(a), r * math.sin(a));
      i == 0 ? p.moveTo(v.dx, v.dy) : p.lineTo(v.dx, v.dy);
    }
    return p..close();
  }

  void _label(Canvas canvas, String text, Offset at, Color color, {double size = 11, bool bold = false, double max = 120}) {
    final tp = TextPainter(
      text: TextSpan(text: text, style: TextStyle(fontFamily: 'monospace', fontSize: size, color: color, fontWeight: bold ? FontWeight.w700 : FontWeight.w400)),
      textDirection: TextDirection.ltr,
      maxLines: 1,
      ellipsis: '…',
    )..layout(maxWidth: max);
    tp.paint(canvas, at - Offset(tp.width / 2, 0));
    tp.dispose();
  }

  @override
  void paint(Canvas canvas, Size size) {
    final t = reduced ? 0.0 : clock.value;
    final l = FleetLayout.compute(size, machines, phase: t);
    // Faint scanlines behind the graph (design/attention-motion.md: 6 to 10 percent, never over text).
    final scan = Paint()..color = neon.accent.withValues(alpha: 0.06);
    for (var y = 0.0; y < size.height; y += 4) {
      canvas.drawRect(Rect.fromLTWH(0, y, size.width, 1), scan);
    }

    // Links and their packets.
    for (final m in machines) {
      final c = l.machines[m.id]!;
      final link = Paint()
        ..strokeWidth = 1.5
        ..color = (m.connected ? neon.accent : neon.foreground).withValues(alpha: m.connected ? 0.45 : 0.18);
      if (m.connected) {
        canvas.drawLine(l.hub, c, link);
      } else {
        final d = c - l.hub;
        final len = d.distance;
        for (var s = 0.0; s < len; s += 10) {
          canvas.drawLine(l.hub + d * (s / len), l.hub + d * (math.min(s + 5, len) / len), link);
        }
      }
      if (!m.connected) continue;
      final working = m.agents.any((a) => a.state == AgentAttention.working);
      final asking = m.agents.map((a) => a.state).where((s) => s == AgentAttention.permission || s == AgentAttention.waiting || s == AgentAttention.failed).toList()
        ..sort((a, b) => _priority.indexOf(a) - _priority.indexOf(b));
      void packets(Offset from, Offset to, Color color, double speed) {
        for (var k = 0; k < 3; k++) {
          final u = ((t * speed) + k / 3) % 1.0;
          final p = Offset.lerp(from, to, u)!;
          canvas.drawCircle(p, 3, Paint()..color = color.withValues(alpha: 0.9 * math.sin(u * math.pi))..maskFilter = const MaskFilter.blur(BlurStyle.normal, 2));
        }
      }

      if (working && !reduced) packets(l.hub, c, neon.accent, 6);
      if (asking.isNotEmpty && !reduced) packets(c, l.hub, neon.of(asking.first), 8);
    }

    // Hub.
    final hubR = l.machineRadius * 0.75;
    canvas.drawPath(chamferPath(Rect.fromCircle(center: l.hub, radius: hubR), hubR * 0.4), Paint()..color = neon.background);
    canvas.drawPath(chamferPath(Rect.fromCircle(center: l.hub, radius: hubR), hubR * 0.4), Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..color = neon.accent);
    _label(canvas, hubLabel, l.hub + Offset(0, hubR + 4), neon.foreground.withValues(alpha: 0.7));

    // Machines and agents.
    for (final m in machines) {
      final c = l.machines[m.id]!;
      final top = m.agents.map((a) => a.state).fold<AgentAttention?>(null, (best, s) => best == null || _priority.indexOf(s) < _priority.indexOf(best) ? s : best);
      final hex = _hex(c, l.machineRadius);
      canvas.drawPath(hex, Paint()..color = neon.background);
      if (top != null && (top == AgentAttention.permission || top == AgentAttention.waiting || top == AgentAttention.failed)) {
        // Glow is urgency: only a machine with an agent waiting on you glows.
        canvas.drawPath(hex, Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 6
          ..color = neon.of(top).withValues(alpha: 0.35)
          ..maskFilter = const MaskFilter.blur(BlurStyle.outer, 10));
      }
      canvas.drawPath(hex, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = m.local ? 2.5 : 1.5
        ..color = m.connected ? neon.accent : neon.foreground.withValues(alpha: 0.3));
      _label(canvas, m.name, c - const Offset(0, 7), m.connected ? neon.foreground : neon.foreground.withValues(alpha: 0.4), bold: true, max: l.machineRadius * 2 - 4, size: 10);
      _label(canvas, '${m.agents.length}', c + const Offset(0, 1), neon.foreground.withValues(alpha: 0.6), size: 10);
      for (final a in m.agents) {
        _agent(canvas, l.agents[a.id]!, a, t);
      }
    }
  }

  void _agent(Canvas canvas, Offset p, FleetAgent a, double t) {
    const r = 9.0;
    final color = neon.of(a.state);
    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..color = color;
    canvas.drawCircle(p, r, Paint()..color = neon.background);
    final wave = 0.5 - 0.5 * math.cos(t * 2 * math.pi * 6); // ~2 s breaths on a 12 s clock
    switch (a.state) {
      case AgentAttention.working:
        canvas.drawCircle(p, r, ring..color = color.withValues(alpha: 0.3));
        canvas.drawArc(Rect.fromCircle(center: p, radius: r), t * 2 * math.pi * 12, math.pi * 0.8, false, ring..color = color);
      case AgentAttention.waiting || AgentAttention.permission || AgentAttention.failed:
        final k = reduced ? 1.0 : wave;
        canvas.drawCircle(p, r + 2 + 3 * k, Paint()..color = color.withValues(alpha: 0.18 + 0.25 * k)..maskFilter = const MaskFilter.blur(BlurStyle.normal, 5));
        canvas.drawCircle(p, r, ring);
      case AgentAttention.done:
        canvas.drawCircle(p, r, Paint()..color = color.withValues(alpha: 0.85));
      case AgentAttention.idle || AgentAttention.offline:
        canvas.drawCircle(p, r, ring..strokeWidth = 1);
    }
    final f = a.spendFraction;
    if (f != null) {
      canvas.drawArc(Rect.fromCircle(center: p, radius: r + 3.5), -math.pi / 2, 2 * math.pi * f.clamp(0.0, 1.0), false, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5
        ..color = neon.spend(f));
    }
    _label(canvas, attentionGlyph(a.state), p - const Offset(0, 7), a.state == AgentAttention.done ? neon.background : color, size: 11, bold: true);
    _label(canvas, a.lane == null ? a.name : '${a.name} ${a.lane![0].toUpperCase()}', p + const Offset(0, r + 3), neon.foreground.withValues(alpha: 0.75), size: 9, max: 90);
  }

  @override
  bool shouldRepaint(FleetPainter old) => old.machines != machines && !_listEq(old.machines, machines) || old.neon != neon || old.reduced != reduced || old.hubLabel != hubLabel;
}
