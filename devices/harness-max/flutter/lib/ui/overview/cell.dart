// One agent on Overview (the mockup's .cell): its status rail, the faint glow of its colour from the top, its pet, its
// name and its status word. The whole cell is the tap.
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../../model/types.dart';
import '../pet.dart';
import '../tokens.dart';
import 'motion.dart';
import 'rail.dart';
import 'touch.dart';

/// The cell's pet slot (the mockup's pet(…, 150, 112) in a 124 px slot, 16 px above its floor).
const Size kCellPet = Size(150, 112);

class AgentCell extends StatelessWidget {
  const AgentCell({super.key, required this.agent, required this.word, required this.onTap});
  final Agent agent;

  /// The status word (BarModel.statusWord).
  final String word;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = agent.state, ink = wordInk(s), scene = petSceneFor(agent, list: true);
    return Tap(
      onTap: onTap,
      pressed: const Color(0xFF0A0A0E),
      child: DecoratedBox(
        decoration: const BoxDecoration(border: Border(right: BorderSide(color: Ink.line))),
        child: Padding(
          padding: const EdgeInsets.only(right: 1),
          child: Stack(fit: StackFit.expand, children: [
            if (s != AgentState.idle)
              RepaintBoundary(
                child: CustomPaint(
                    painter: _GlowPainter(ink, s == AgentState.asking ? Motion.of(context) : null)),
              ),
            Positioned(left: 0, right: 0, top: 0, height: 5, child: Rail(color: railInk(s), state: s)),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                SizedBox(
                  height: 124,
                  child: Align(
                    alignment: Alignment.bottomCenter,
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: PetView(
                          engine: agent.engine, scene: scene, size: petFit(agent.engine, scene, kCellPet)),
                    ),
                  ),
                ),
                Text(agent.name,
                    maxLines: 1,
                    softWrap: false,
                    overflow: TextOverflow.ellipsis,
                    style: Face.s(27, weight: FontWeight.w600)),
                const SizedBox(height: 6),
                Text(word,
                    maxLines: 1, softWrap: false, overflow: TextOverflow.ellipsis, style: Face.s(21, color: ink)),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

/// The cell's glow: radial-gradient(110% 60% at 50% 0%, c, transparent 72%) at .08; a waiting cell's at .18, breathing
/// to .05 and back each second.
class _GlowPainter extends CustomPainter {
  _GlowPainter(this.color, this.clock) : super(repaint: clock);
  final Color color;

  /// The page's clock while the glow breathes (a waiting agent), else null.
  final ValueListenable<double>? clock;

  @override
  void paint(Canvas canvas, Size size) {
    final c = clock;
    final o = c == null ? .08 : keyframes(loop(c.value, 1)!, from: .18, to: .05, curve: Curves.easeInOut);
    final rx = 1.1 * size.width, ry = .6 * size.height;
    canvas
      ..save()
      ..clipRect(Offset.zero & size)
      ..translate(size.width / 2, 0)
      ..scale(rx, ry);
    canvas.drawRect(
      Rect.fromLTRB(-size.width / 2 / rx, 0, size.width / 2 / rx, size.height / ry),
      Paint()
        ..shader = ui.Gradient.radial(
            Offset.zero, 1, [color.withValues(alpha: o), color.withValues(alpha: 0)], const [0, .72]),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(_GlowPainter old) => old.color != color || old.clock != clock;
}
