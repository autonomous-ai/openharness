// The open agent's mic band (the mockup's .band), a rounded box across the panel's foot. While the agent's own
// recording runs: "● Listening" and the recording's clock, the green waveform of the mic's level ("Say it…" under it
// until speech is heard), and "Tap to send" with the ring that fills in the quiet after speech; sending, the wave falls
// flat. Otherwise one quiet line: the mic closed, "Tap to talk", or where to talk to an agent the bar cannot record for.
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../agent/live_text.dart';
import '../tokens.dart';
import 'bits.dart';
import 'motion.dart';

/// The mic records for [a], or sends what it recorded: one recording runs at a time, and it may be another agent's.
bool recordsFor(BarModel m, Agent a) =>
    (m.talk == TalkPhase.listening || m.talk == TalkPhase.sending) && m.talkingTo == a.id;

class TalkBand extends StatelessWidget {
  const TalkBand({super.key, required this.model, required this.agent});
  final BarModel model;
  final Agent agent;

  @override
  Widget build(BuildContext context) {
    final live = recordsFor(model, agent);
    final radius = BorderRadius.circular(20);
    // transition: background-color .3s, box-shadow .3s (ease) as the box turns live or quiet.
    return AnimatedContainer(
      duration: const Duration(milliseconds: 300),
      curve: Curves.ease,
      padding: const EdgeInsets.symmetric(horizontal: 22),
      decoration: BoxDecoration(
        color: live ? Color.alphaBlend(Ink.voice.withValues(alpha: .06), Ink.bg) : const Color(0xFF0B0B0F),
        borderRadius: radius,
      ),
      // The rim is the mockup's inset box-shadow: drawn over the box, it takes no room from what is inside.
      foregroundDecoration: BoxDecoration(
        borderRadius: radius,
        border: Border.all(color: live ? Ink.voice.withValues(alpha: .3) : const Color(0xFF24242C)),
      ),
      child: live ? _Live(model: model) : _Quiet(model: model, agent: agent),
    );
  }
}

class _Live extends StatelessWidget {
  const _Live({required this.model});
  final BarModel model;

  @override
  Widget build(BuildContext context) {
    final m = model;
    final listening = m.talk == TalkPhase.listening;
    final started = m.talkStarted;
    return Row(children: [
      SizedBox(
        width: 140,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          _Listening(listening: listening),
          const SizedBox(height: 6),
          LiveText(
            () => started == null ? '0:00' : clockText(m.now().difference(started).inSeconds),
            style: Face.n(30, weight: FontWeight.w300, height: 1),
          ),
        ]),
      ),
      const SizedBox(width: 22),
      Expanded(
        child: Stack(fit: StackFit.expand, children: [
          Positioned(left: 0, right: 0, top: 10, height: 44, child: _Waveform(model: m)),
          if (listening && !m.heard)
            Positioned(
              left: 0,
              right: 0,
              bottom: 12,
              child: Text('Say it…',
                  maxLines: 1, softWrap: false, style: Face.s(21, weight: FontWeight.w500, color: Ink.faint)),
            ),
        ]),
      ),
      const SizedBox(width: 22),
      // Sending, there is nothing to tap for until it is through.
      SizedBox(
        width: 190,
        child: listening
            ? Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                Flexible(
                  child: Text(
                    m.heard && m.quiet > 0 ? 'Sending soon · tap to send now' : 'Tap to send',
                    textAlign: TextAlign.right,
                    style: Face.s(16, weight: FontWeight.w600, color: Ink.voice, height: 1.25),
                  ),
                ),
                const SizedBox(width: 12),
                CustomPaint(size: const Size.square(28), painter: _QuietRing(m.heard ? m.quiet : 0)),
              ])
            : null,
      ),
    ]);
  }
}

/// The band at rest (data-t closed or off): why the mic is closed, or how to talk to the agent.
class _Quiet extends StatelessWidget {
  const _Quiet({required this.model, required this.agent});
  final BarModel model;
  final Agent agent;

  @override
  Widget build(BuildContext context) {
    final style = Face.s(21, color: Ink.rest);
    // Closed is always the open agent's: the model reopens the mic or turns it off when another agent opens.
    final closed = model.talk == TalkPhase.closed;
    if (!closed && !model.takesVoice(agent)) {
      final app = model.appOf(agent);
      return Align(
        alignment: Alignment.centerLeft,
        child: Text(app.isEmpty ? 'Talk to it on the computer' : 'Talk to it in $app',
            maxLines: 1, softWrap: false, overflow: TextOverflow.ellipsis, style: style),
      );
    }
    return Row(children: [
      const GlyphIcon(Glyph.mic, size: 26, color: Ink.rest),
      const SizedBox(width: 12),
      Flexible(
        child: Text(closed ? 'Mic closed · tap to talk' : 'Tap to talk',
            maxLines: 1, softWrap: false, overflow: TextOverflow.ellipsis, style: style),
      ),
    ]);
  }
}

/// "● Listening": the green dot glows and pulses every .8 s. Sending, the dot and the word rest in grey.
class _Listening extends StatelessWidget {
  const _Listening({required this.listening});
  final bool listening;

  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        RepaintBoundary(
          child: CustomPaint(
              size: const Size.square(12), painter: _LiveDot(listening ? Motion.of(context) : null)),
        ),
        const SizedBox(width: 10),
        Text(listening ? 'Listening' : 'Sending',
            maxLines: 1,
            softWrap: false,
            style: Face.s(19, weight: FontWeight.w600, color: listening ? Ink.voice : Ink.rest)),
      ]);
}

class _LiveDot extends CustomPainter {
  _LiveDot(this.clock) : super(repaint: clock);

  /// The panel's clock while the mic listens; null once the words are on their way (a still grey dot).
  final ValueListenable<double>? clock;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final t = clock;
    if (t == null) {
      canvas.drawCircle(c, 6, Paint()..color = Ink.rest);
      return;
    }
    final o = pulse(loop(t.value, .8)!);
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

  // Sending, the level falls to nothing and the bars lie flat.
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
      _level = target; // the first frame shows the level as it is
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
