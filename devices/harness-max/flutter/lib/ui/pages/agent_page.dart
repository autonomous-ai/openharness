// The agent page: the strip, the pet and engine, the words or the working turn, and the talk band. One page for reading
// and talking, as the mockup's Focus and Working with the band of its one tap. A tap on the page talks (or sends what
// is being said), a sideways swipe walks the ring.
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../agent/band.dart';
import '../agent/mic_closed.dart';
import '../agent/reading.dart';
import '../agent/strip.dart';
import '../agent/who.dart';
import '../agent/working.dart';
import '../overview/bits.dart';
import '../overview/motion.dart';
import '../overview/touch.dart';
import '../pet.dart';

class AgentPage extends StatelessWidget {
  const AgentPage({super.key, required this.model});
  final BarModel model;

  @override
  Widget build(BuildContext context) {
    final a = model.selected;
    final talking = model.talk == TalkPhase.listening || model.talk == TalkPhase.sending;
    final moving = talking ||
        a?.state == AgentState.working ||
        model.segments.any((s) => s.state == AgentState.working || s.state == AgentState.asking);
    return DefaultTextHeightBehavior(
      textHeightBehavior: kEvenLeading,
      child: Motion(
        on: moving,
        child: SwipeArea(
          onSwipe: (dir) {
            model.touched();
            model.swipeAgent(dir);
          },
          onTap: () {
            model.touched();
            model.tapBody();
          },
          child: Stack(fit: StackFit.expand, children: [
            Positioned(
              left: 0,
              right: 0,
              top: kStripH,
              bottom: 0,
              child: a == null ? const SizedBox() : _Body(model: model, agent: a, talking: talking),
            ),
            Positioned(left: 0, right: 0, top: 0, height: kStripH, child: Strip(model: model, shown: a)),
            if (model.talk == TalkPhase.closed && model.toast?.text != kMicClosed)
              const Positioned(left: 0, right: 0, bottom: 22, child: Center(child: MicClosedNote())),
          ]),
        ),
      ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.model, required this.agent, required this.talking});
  final BarModel model;
  final Agent agent;
  final bool talking;

  @override
  Widget build(BuildContext context) {
    final working = agent.state == AgentState.working;
    return Stack(fit: StackFit.expand, children: [
      // The mockup's Focus and Working are two pages: going from one to the other fades as a page change does. The
      // band is above both, so a turn that starts or ends under it does not make it rise again.
      FadeSwitch(
        child: _Content(key: ValueKey(working), model: model, agent: agent, talking: talking, working: working),
      ),
      if (talking) Positioned(left: kSideW, right: 0, bottom: 0, height: kBandH, child: TalkBand(model: model)),
    ]);
  }
}

class _Content extends StatelessWidget {
  const _Content(
      {super.key, required this.model, required this.agent, required this.talking, required this.working});
  final BarModel model;
  final Agent agent;
  final bool talking, working;

  @override
  Widget build(BuildContext context) {
    final a = agent;
    // The pet puts its headphones on while it listens (the mockup swaps in its listen scene, 220 x 186).
    final scene = talking ? 'listen' : petSceneFor(a);
    final box = working && !talking ? const Size(230, 190) : const Size(220, 186);
    return Stack(fit: StackFit.expand, children: [
      Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SizedBox(
          width: kSideW,
          child: Who(
            engine: a.engine,
            scene: scene,
            box: box,
            label: !talking,
            thinking: working ? a.steps.isNotEmpty && a.steps.last.think : null,
          ),
        ),
        Expanded(
          child: working
              ? Working(model: model, agent: a, talking: talking)
              : Reading(model: model, agent: a, talking: talking),
        ),
      ]),
      if (working && !talking) const Positioned(left: kSideW, right: 0, bottom: 0, height: 3, child: FlowBar()),
      if (!working && !talking) Positioned(right: 30, bottom: 16, child: TalkHint(model: model, agent: a)),
    ]);
  }
}
