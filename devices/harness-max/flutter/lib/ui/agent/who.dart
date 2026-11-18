// The agent page's left column (the mockup's .who): the agent's pet in a faint glow of its engine's colour, and the
// engine's name under it. At work, a thinking step puts a bubble of three dots by the pet.
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../overview/motion.dart';
import '../pet.dart';
import '../tokens.dart';

class Who extends StatelessWidget {
  const Who({
    super.key,
    required this.engine,
    required this.scene,
    required this.box,
    required this.label,
    this.thinking,
  });

  final String engine, scene;

  /// The pet's slot: the mockup's pet(…, 220, 186), or (…, 230, 190) for the working scene.
  final Size box;

  /// The engine's name shows (not while the band is up).
  final bool label;

  /// At work: whether its current step is a thinking one (the bubble shows); null when it is not at work.
  final bool? thinking;

  @override
  Widget build(BuildContext context) {
    final eng = engineOf(engine);
    Widget pet = PetView(engine: engine, scene: scene, size: petFit(engine, scene, box));
    final think = thinking;
    if (think != null) {
      pet = Stack(clipBehavior: Clip.none, children: [
        pet,
        Positioned(right: -34, top: -30, child: _Thinking(on: think)),
      ]);
    }
    return DecoratedBox(
      decoration: const BoxDecoration(border: Border(right: BorderSide(color: Ink.line))),
      child: Padding(
        padding: const EdgeInsets.only(right: 1),
        child: ClipRect(
          child: Stack(fit: StackFit.expand, children: [
            RepaintBoundary(child: CustomPaint(painter: _EngineGlow(eng.ink))),
            Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                pet,
                if (label) ...[
                  const SizedBox(height: 16),
                  Text(eng.label, style: Face.s(15, weight: FontWeight.w500, color: eng.ink)),
                ],
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

/// .who::before: a 340 px circle centred in the column, radial-gradient(circle, engine 0%, transparent 62%) at .14.
/// The gradient's 100% is the circle box's far corner, 170·√2 px out.
class _EngineGlow extends CustomPainter {
  const _EngineGlow(this.ink);
  final Color ink;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    const r = 170 * 1.4142135623730951 * .62;
    final glow = ink.withValues(alpha: .14);
    canvas.drawCircle(
      c,
      r,
      Paint()..shader = ui.Gradient.radial(c, r, [glow, glow.withValues(alpha: 0)]),
    );
  }

  @override
  bool shouldRepaint(_EngineGlow old) => old.ink != ink;
}

/// The mockup's .think: a card bubble of three lavender dots that bob in turn; it fades in and out (.3s) as the
/// current step turns to thinking and back.
class _Thinking extends StatelessWidget {
  const _Thinking({required this.on});
  final bool on;

  @override
  Widget build(BuildContext context) => AnimatedOpacity(
        opacity: on ? 1 : 0,
        duration: const Duration(milliseconds: 300),
        curve: Curves.ease,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: Ink.card,
            border: Border.all(color: Ink.rim),
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(14),
              topRight: Radius.circular(14),
              bottomRight: Radius.circular(14),
              bottomLeft: Radius.circular(4),
            ),
          ),
          child: RepaintBoundary(
            child: CustomPaint(size: const Size(34, 8), painter: _Dots(Motion.of(context))),
          ),
        ),
      );
}

/// Three 8 px dots 5 apart; each bobs 5 px up and brightens from .4 at 40% of a 1.2 s loop, .2 s after the one before.
class _Dots extends CustomPainter {
  _Dots(this.clock) : super(repaint: clock);
  final ValueListenable<double> clock;

  @override
  void paint(Canvas canvas, Size size) {
    for (var i = 0; i < 3; i++) {
      final p = loop(clock.value, 1.2, delay: .2 * i);
      final k = p == null ? null : keyframes(p, from: 0, to: 1, at: .4, curve: Curves.easeInOut);
      final o = k == null ? 1.0 : .4 + .6 * k, dy = k == null ? 0.0 : -5 * k;
      canvas.drawCircle(Offset(4 + 13.0 * i, 4 + dy), 4, Paint()..color = Ink.accent.withValues(alpha: o));
    }
  }

  @override
  bool shouldRepaint(_Dots old) => old.clock != clock;
}
