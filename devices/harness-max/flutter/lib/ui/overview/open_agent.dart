// App Detail's open agent (the mockup's .full in its .cell.sel): the cell a tap opens across the row, its pet, name,
// state chip and task over the mic's band, and X. The panel is one tap (it sends what is being said, or opens the mic
// again); X drops the recording and brings the row back. Its touch is Taps, so it lies in the row's SwipeArea.
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../pet.dart';
import '../tokens.dart';
import 'bits.dart';
import 'chip.dart';
import 'motion.dart';
import 'rail.dart';
import 'talk_band.dart';
import 'touch.dart';

/// The open agent's width in the row: the row's 1172 px less a sliver on each side.
const double kOpenW = 1172 - 2 * kSliverW;

/// A dimmed agent beside the open one.
const double kSliverW = 136;

/// The pet's slot (.fpet): the pet stands on its floor, centred.
const Size kOpenPet = Size(190, 150);

class OpenAgent extends StatelessWidget {
  const OpenAgent({super.key, required this.model, required this.agent});
  final BarModel model;
  final Agent agent;

  @override
  Widget build(BuildContext context) {
    final s = agent.state;
    return DefaultTextHeightBehavior(
      textHeightBehavior: kEvenLeading,
      child: Motion(
        // the band's dot and wave while it records, the rail, chip and glow of an agent at work or waiting
        on: recordsFor(model, agent) || s == AgentState.working || s == AgentState.asking,
        child: Tap(
          onTap: () {
            model.touched();
            model.tapBody();
          },
          child: DecoratedBox(
            decoration: const BoxDecoration(
                color: Color(0xFF060609), border: Border(right: BorderSide(color: Ink.line))),
            child: Padding(
              padding: const EdgeInsets.only(right: 1),
              child: Stack(fit: StackFit.expand, children: [
                if (s != AgentState.idle) _Glow(state: s),
                Positioned(left: 0, right: 0, top: 0, height: 5, child: Rail(color: railInk(s), state: s)),
                Padding(
                  padding: const EdgeInsets.fromLTRB(26, 20, 22, 16),
                  child: Column(children: [
                    Expanded(child: _Top(model: model, agent: agent)),
                    const SizedBox(height: 12),
                    SizedBox(height: 96, child: TalkBand(model: model, agent: agent)),
                  ]),
                ),
                // The X's box reaches past the button on every side (92 x 88): the bar's touch is imprecise, and a
                // miss there is not harmless, it sends what is being said.
                Positioned(
                  top: 0,
                  right: 0,
                  width: 92,
                  height: 88,
                  child: Tap(
                    key: const ValueKey('close'),
                    onTap: () {
                      model.touched();
                      model.closeAgent();
                    },
                    child: const Padding(
                      padding: EdgeInsets.fromLTRB(20, 18, 20, 18),
                      child: RoundButton(size: 52, child: GlyphIcon(Glyph.x, size: 28, color: Ink.fg)),
                    ),
                  ),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// The pet, then the name, the state chip and the task (.ftop).
class _Top extends StatelessWidget {
  const _Top({required this.model, required this.agent});
  final BarModel model;
  final Agent agent;

  @override
  Widget build(BuildContext context) {
    final a = agent, sum = summaryOf(a);
    // The pet puts its headphones on while the mic is its own.
    final scene = recordsFor(model, a) ? 'listen' : petSceneFor(a);
    return Row(children: [
      PetView(engine: a.engine, scene: scene, size: kOpenPet),
      const SizedBox(width: 22),
      Expanded(
        // The X sits over this column's top right: the words stop short of it.
        child: Padding(
          padding: const EdgeInsets.only(right: 64),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(
                child: Text(a.name,
                    maxLines: 1,
                    softWrap: false,
                    overflow: TextOverflow.ellipsis,
                    style: Face.s(32, weight: FontWeight.w600)),
              ),
              const SizedBox(width: 14),
              StateChip(state: a.state, word: model.statusWord(a), small: true),
            ]),
            const SizedBox(height: 10),
            Text(sum.isEmpty ? 'No task yet' : sum,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: Face.s(19, color: sum.isEmpty ? Ink.faint : Ink.recap, height: 1.38)),
          ]),
        ),
      ),
    ]);
  }
}

/// The state's glow from the panel's top left (radial-gradient(70% 70% at 18% 0%, c, transparent 72%)) at .08; a
/// failure's at .14; a waiting agent's at .18, breathing to .05 and back each second.
class _Glow extends StatelessWidget {
  const _Glow({required this.state});
  final AgentState state;

  @override
  Widget build(BuildContext context) => RepaintBoundary(
        child: CustomPaint(
          painter: _GlowPainter(chipInk(state), state, state == AgentState.asking ? Motion.of(context) : null),
        ),
      );
}

class _GlowPainter extends CustomPainter {
  _GlowPainter(this.color, this.state, this.clock) : super(repaint: clock);
  final Color color;
  final AgentState state;

  /// The panel's clock while the glow breathes (a waiting agent), else null.
  final ValueListenable<double>? clock;

  @override
  void paint(Canvas canvas, Size size) {
    final c = clock;
    final o = c != null
        ? keyframes(loop(c.value, 1)!, from: .18, to: .05, curve: Curves.easeInOut)
        : state == AgentState.failed
            ? .14
            : .08;
    final w = size.width, h = size.height, rx = .7 * w, ry = .7 * h;
    // A unit circle's gradient, stretched to the ellipse.
    canvas
      ..save()
      ..clipRect(Offset.zero & size)
      ..translate(.18 * w, 0)
      ..scale(rx, ry);
    canvas.drawRect(
      Rect.fromLTRB(-.18 * w / rx, 0, .82 * w / rx, h / ry),
      Paint()
        ..shader = ui.Gradient.radial(
            Offset.zero, 1, [color.withValues(alpha: o), color.withValues(alpha: 0)], const [0, .72]),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(_GlowPainter old) => old.color != color || old.state != state || old.clock != clock;
}
