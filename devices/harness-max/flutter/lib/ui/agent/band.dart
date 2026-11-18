// The talk band (the mockup's .band): it rises over the page's foot from the pet's right edge while the mic records.
// "● Listening" and the recording's clock, the green waveform of the mic's level ("Say it…" under it until speech is
// heard), "Tap to send" with the ring that fills in the quiet after speech, and X.
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../overview/bits.dart';
import '../overview/motion.dart';
import '../overview/touch.dart';
import '../tokens.dart';
import 'live_text.dart';

const double kBandH = 118;

/// The X's hit area, from the band's right edge: the X and the ring beside it, as the bar's touch lands left of the
/// finger.
const double kCancelW = 108;

class TalkBand extends StatefulWidget {
  const TalkBand({super.key, required this.model});
  final BarModel model;

  @override
  State<TalkBand> createState() => _TalkBandState();
}

class _TalkBandState extends State<TalkBand> with SingleTickerProviderStateMixin {
  // .band slides up from translateY(120%): .35s cubic-bezier(.2,.8,.2,1)
  late final AnimationController _rise =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 350))..forward();
  late final Animation<double> _up = CurvedAnimation(parent: _rise, curve: const Cubic(.2, .8, .2, 1));

  @override
  void dispose() {
    _rise.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final m = widget.model;
    final listening = m.talk == TalkPhase.listening;
    final started = m.talkStarted;
    return AnimatedBuilder(
      animation: _up,
      builder: (context, child) =>
          Transform.translate(offset: Offset(0, 1.2 * kBandH * (1 - _up.value)), child: child),
      child: Stack(fit: StackFit.expand, children: [
        const DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [Color(0x00000000), Ink.bg],
              stops: [0, .22],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(44, 0, 26, 0),
          child: Row(children: [
            SizedBox(
              width: 150,
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                _Listening(listening: listening),
                const SizedBox(height: 8),
                LiveText(
                  () => started == null ? '0:00' : clockText(m.now().difference(started).inSeconds),
                  style: Face.n(34, weight: FontWeight.w300, height: 1),
                ),
              ]),
            ),
            const SizedBox(width: 24),
            Expanded(
              child: Stack(fit: StackFit.expand, children: [
                Positioned(left: 0, right: 0, top: 12, height: 54, child: _Waveform(model: m)),
                if (listening && !m.heard)
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 14,
                    child: Text('Say it…',
                        maxLines: 1, style: Face.s(24, weight: FontWeight.w500, color: Ink.faint)),
                  ),
              ]),
            ),
            const SizedBox(width: 24),
            // Sending, there is nothing to tap until it is through.
            SizedBox(
              width: 250,
              child: listening
                  ? Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                      Flexible(
                        child: Text(
                          m.heard && m.quiet > 0 ? 'Sending soon · tap to send now' : 'Tap to send',
                          textAlign: TextAlign.right,
                          style: Face.s(18, weight: FontWeight.w600, color: Ink.voice, height: 1.25),
                        ),
                      ),
                      const SizedBox(width: 14),
                      CustomPaint(size: const Size.square(30), painter: _QuietRing(m.heard ? m.quiet : 0)),
                      const SizedBox(width: 14),
                      const RoundButton(size: 52, child: GlyphIcon(Glyph.x, size: 28, color: Ink.fg)),
                    ])
                  : null,
            ),
          ]),
        ),
        if (listening)
          Positioned(
            right: 0,
            top: 0,
            bottom: 0,
            width: kCancelW,
            child: Tap(
              key: const ValueKey('cancel'),
              onTap: () {
                m.touched();
                m.cancelTalk();
              },
              child: const SizedBox.expand(),
            ),
          ),
      ]),
    );
  }
}

/// "● Listening" (or "Sending" once it is out): the green dot glows and pulses every .8 s.
class _Listening extends StatelessWidget {
  const _Listening({required this.listening});
  final bool listening;

  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        RepaintBoundary(
          child: CustomPaint(size: const Size.square(12), painter: _LiveDot(Motion.of(context))),
        ),
        const SizedBox(width: 10),
        Text(listening ? 'Listening' : 'Sending', style: Face.s(20, weight: FontWeight.w600, color: Ink.voice)),
      ]);
}

class _LiveDot extends CustomPainter {
  _LiveDot(this.clock) : super(repaint: clock);
  final ValueListenable<double> clock;

  @override
  void paint(Canvas canvas, Size size) {
    final o = pulse(loop(clock.value, .8)!);
    final c = size.center(Offset.zero);
    // box-shadow 0 0 14px: a blur of sigma 7 around the dot
    canvas.drawCircle(
        c, 6, Paint()..color = Ink.voice.withValues(alpha: o)..maskFilter = const MaskFilter.blur(BlurStyle.outer, 7));
    canvas.drawCircle(c, 6, Paint()..color = Ink.voice.withValues(alpha: o));
  }

  @override
  bool shouldRepaint(_LiveDot old) => old.clock != clock;
}

/// The send ring (svg.cd): a dark track, and the green that fills it from the top as the quiet runs; at nought its
/// round cap shows as a dot.
class _QuietRing extends CustomPainter {
  const _QuietRing(this.quiet);
  final double quiet;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(size.width / 22);
    const c = Offset(11, 11);
    canvas.drawCircle(
        c,
        9,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 3
          ..color = const Color(0xFF2C2C35));
    // the mockup's stroke-dasharray rounds the share to a whole percent
    final k = (quiet.clamp(0, 1) * 100).round() / 100;
    if (k == 0) {
      canvas.drawCircle(const Offset(11, 2), 1.5, Paint()..color = Ink.voice);
      return;
    }
    canvas.drawArc(
      Rect.fromCircle(center: c, radius: 9),
      -math.pi / 2,
      2 * math.pi * k,
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3
        ..strokeCap = StrokeCap.round
        ..color = Ink.voice,
    );
  }

  @override
  bool shouldRepaint(_QuietRing old) => old.quiet != quiet;
}

/// The waveform (drawBand): bars 4 px apart across the band, tallest in the middle (sin(πu)^1.4), each trembling on
/// its own, all as loud as the mic's level, which they follow smoothly (18% of the way each frame at 60 a second).
class _Waveform extends StatefulWidget {
  const _Waveform({required this.model});
  final BarModel model;

  @override
  State<_Waveform> createState() => _WaveformState();
}

class _WaveformState extends State<_Waveform> {
  final ValueNotifier<int> _frame = ValueNotifier(0);
  ValueListenable<double>? _clock;
  double _level = -1, _t = 0, _at = -1;

  double get _target {
    final m = widget.model;
    if (m.talk != TalkPhase.listening || m.levels.isEmpty) return 0;
    return m.levels.last.clamp(0.0, 1.0);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final clock = Motion.of(context);
    if (clock == _clock) return;
    _clock?.removeListener(_tick);
    _clock = clock..addListener(_tick);
    _tick();
  }

  void _tick() {
    final t = _clock!.value, target = _target;
    if (_level < 0) {
      _level = target;   // the first frame shows the level as it is
    } else {
      final dt = (t - _at).clamp(0.0, .25);
      _level += (target - _level) * (1 - math.pow(.82, dt * 60));
    }
    _at = t;
    _t = t * 1000;
    _frame.value++;
  }

  @override
  void dispose() {
    _clock?.removeListener(_tick);
    _frame.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      RepaintBoundary(child: CustomPaint(size: Size.infinite, painter: _WavePainter(this)));
}

class _WavePainter extends CustomPainter {
  _WavePainter(this.wave) : super(repaint: wave._frame);
  final _WaveformState wave;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height, t = wave._t, lvl = wave._level.clamp(0.0, 1.0);
    if (w <= 0) return;
    final n = math.max(30, (w / 10).floor());
    const gap = 4.0;
    final bw = (w - gap * (n - 1)) / n, cy = h / 2;
    final bar = Paint();
    for (var i = 0; i < n; i++) {
      final u = i / (n - 1), shape = math.pow(math.sin(math.pi * u), 1.4).toDouble();
      final v = math.max(.05, shape * lvl * (.6 + .4 * math.sin(t / 90 + i * .9) * math.sin(t / 170 + i * .37)));
      final bh = v * h * .48;
      bar.color = Ink.voice.withValues(alpha: .4 + .6 * shape);
      canvas.drawRect(Rect.fromLTWH(i * (bw + gap), cy - bh, bw, 2 * bh), bar);
    }
  }

  @override
  bool shouldRepaint(_WavePainter old) => old.wave != wave;
}
