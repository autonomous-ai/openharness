// The light that runs around the glass's edge while Attention is up (the mockup's `.ring`): yellow for a question,
// green for a finished turn, red for a failed one. Each side is a faint 4 px track with a bright run in it, the four
// runs going round together every 2 s (top left to right, right side down, bottom right to left, left side up). After
// 4.2 s the light eases down to a quarter over 1.8 s and keeps running there. A new Attention lights it afresh.
import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../attention/kind.dart';

class EdgeLight extends StatefulWidget {
  const EdgeLight({super.key, required this.model});
  final BarModel model;

  @override
  State<EdgeLight> createState() => _EdgeLightState();
}

class _EdgeLightState extends State<EdgeLight> with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick);

  /// How long the light has been up: the painter repaints on it, the page above it does not rebuild.
  final ValueNotifier<Duration> _age = ValueNotifier(Duration.zero);
  Duration _from = Duration.zero, _now = Duration.zero;

  /// The Attention that lit it: another agent, kind or arrival starts the light over, as the mockup's renderAt.
  (String, AttnKind, DateTime)? _lit;

  @override
  void initState() {
    super.initState();
    widget.model.addListener(_changed);
    _sync();
  }

  @override
  void didUpdateWidget(EdgeLight old) {
    super.didUpdateWidget(old);
    if (old.model != widget.model) {
      old.model.removeListener(_changed);
      widget.model.addListener(_changed);
      _sync();
    }
  }

  @override
  void dispose() {
    widget.model.removeListener(_changed);
    _ticker.dispose();
    _age.dispose();
    super.dispose();
  }

  void _sync() {
    final a = widget.model.attention;
    final lit = a == null ? null : (a.agentId, a.kind, a.since);
    if (lit == _lit) return;
    _lit = lit;
    if (lit == null) {
      _ticker.stop();
    } else if (!_ticker.isActive) {
      _from = _now = Duration.zero;
      _ticker.start();
    } else {
      _from = _now;
    }
    _age.value = Duration.zero;
  }

  void _changed() {
    final was = _lit;
    _sync();
    if (_lit != was) setState(() {});
  }

  void _tick(Duration elapsed) {
    _now = elapsed;
    _age.value = elapsed - _from;
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.model.attention;
    if (a == null) return const SizedBox.shrink();
    return IgnorePointer(
      child: RepaintBoundary(
        child: CustomPaint(painter: EdgePainter(_age, edgeInk(a.kind)), size: Size.infinite),
      ),
    );
  }
}

/// Paints the light at an age. Public for the light's own tests.
class EdgePainter extends CustomPainter {
  EdgePainter(this.age, this.color) : super(repaint: age);
  final ValueListenable<Duration> age;
  final Color color;

  // The mockup's numbers: the track's width, the runs' lengths, one lap, the full light and its fade.
  static const double side = 4, run = 340, runDown = 120;
  static const double lapMs = 2000, fullMs = 4200, fadeMs = 1800, restLevel = 0.25;

  /// A run's glow past its ends along the track: the mockup's `box-shadow: 0 0 18px 4px`, cut by the 4 px track it
  /// runs in, so the light only leaks along the edge. Distances from the run's end, and the shadow's opacity there
  /// (a Gaussian of sigma 9 over the 4 px spread, about half of it inside the track's width).
  static const double reach = 28;
  static const List<(double, double)> glow = [
    (28, 0),
    (24, 0.006),
    (20, 0.018),
    (16, 0.045),
    (12, 0.092),
    (8, 0.161),
    (4, 0.245),
    (0, 0.329),
  ];

  /// How bright the light is at [ms]: whole, then down to a quarter with CSS's `ease`, as `fadeRing 6s forwards`.
  static double levelAt(double ms) {
    if (ms <= fullMs) return 1;
    if (ms >= fullMs + fadeMs) return restLevel;
    return 1 - (1 - restLevel) * Curves.ease.transform((ms - fullMs) / fadeMs);
  }

  /// A run along an axis of [length], in its own coordinates from 0 to [length] + 2 * [reach].
  Shader _runShader(double length, double level, {required bool across}) {
    final total = length + 2 * reach;
    final colors = <Color>[], stops = <double>[];
    for (final (d, alpha) in glow) {
      colors.add(color.withValues(alpha: alpha * level));
      stops.add((reach - d) / total);
    }
    // The run itself, solid, its ends sharp against its glow.
    colors
      ..add(color.withValues(alpha: level))
      ..add(color.withValues(alpha: level));
    stops
      ..add(reach / total)
      ..add((reach + length) / total);
    for (final (d, alpha) in glow.reversed) {
      colors.add(color.withValues(alpha: alpha * level));
      stops.add((reach + length + d) / total);
    }
    return LinearGradient(
      begin: across ? Alignment.centerLeft : Alignment.topCenter,
      end: across ? Alignment.centerRight : Alignment.bottomCenter,
      colors: colors,
      stops: stops,
    ).createShader(across ? Rect.fromLTWH(0, 0, total, side) : Rect.fromLTWH(0, 0, side, total));
  }

  @override
  void paint(Canvas canvas, Size size) {
    final ms = age.value.inMicroseconds / 1000;
    final level = levelAt(ms);
    final w = size.width, h = size.height;
    final track = Paint()..color = color.withValues(alpha: 0.22 * level);
    final across = Paint()..shader = _runShader(run, level, across: true);
    final down = Paint()..shader = _runShader(runDown, level, across: false);
    final lap = (ms % lapMs) / lapMs;
    final x = -run + lap * (w + run); // the top run's left end
    final y = -runDown + lap * (h + runDown); // the right run's top end

    // Each side's track, then its run clipped to it, in the mockup's order (top, right, bottom, left): the corners
    // where two tracks cross are a little brighter, as there.
    void runIn(Rect track0, Paint pen, Paint runPen, Offset at, Size runSize) {
      canvas.drawRect(track0, pen);
      canvas.save();
      canvas.clipRect(track0);
      canvas.translate(at.dx, at.dy);
      canvas.drawRect(Offset.zero & runSize, runPen);
      canvas.restore();
    }

    const acrossSize = Size(run + 2 * reach, side), downSize = Size(side, runDown + 2 * reach);
    runIn(Rect.fromLTWH(0, 0, w, side), track, across, Offset(x - reach, 0), acrossSize);
    runIn(Rect.fromLTWH(w - side, 0, side, h), track, down, Offset(w - side, y - reach), downSize);
    runIn(Rect.fromLTWH(0, h - side, w, side), track, across, Offset(w - run - x - reach, h - side), acrossSize);
    runIn(Rect.fromLTWH(0, 0, side, h), track, down, Offset(0, h - runDown - y - reach), downSize);
  }

  @override
  bool shouldRepaint(EdgePainter old) => old.color != color || old.age != age;
}
