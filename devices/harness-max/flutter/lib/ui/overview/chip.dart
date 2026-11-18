// App Detail (the owner's call, 18 Nov): an agent's state as a chip, a pill in the state's colour at a cell's bottom
// centre and beside the open agent's name, and the line of its task a cell shows under its name. A working agent's dot
// blinks and a waiting agent's chip breathes, on the page's Motion clock.
import 'package:flutter/widgets.dart';

import '../../model/types.dart';
import '../tokens.dart';
import 'motion.dart';

/// The chip's colour (the artifact's --c): a resting agent's a quiet grey, every other state its own.
Color chipInk(AgentState s) => s == AgentState.idle ? const Color(0xFF6B6B77) : statusInk(s);

/// The chip's words' colour (--ct): a resting agent's grey, a failure in its lighter red.
Color chipWords(AgentState s) => switch (s) {
      AgentState.idle => Ink.rest,
      AgentState.failed => Ink.failText,
      _ => statusInk(s),
    };

/// What a cell says of the agent's task: at work, the progress sentence (else its last step); otherwise the last
/// words worth reading (the summary, the question, the failure). "" when there is none.
String summaryOf(Agent a) {
  if (a.state == AgentState.working) {
    if (a.activity.isNotEmpty) return a.activity;
    if (a.steps.isNotEmpty) return '${a.steps.last.verb} · ${a.steps.last.detail}';
  }
  return a.said;
}

class StateChip extends StatelessWidget {
  const StateChip({super.key, required this.state, required this.word, this.small = false});
  final AgentState state;

  /// The status word (BarModel.statusWord).
  final String word;

  /// Beside the open agent's name: 30 px tall with 15 px words; a cell's is 34 px with 16 px words.
  final bool small;

  @override
  Widget build(BuildContext context) {
    final c = chipInk(state);
    final moves = state == AgentState.working || state == AgentState.asking;
    final clock = moves ? Motion.of(context) : null;
    Widget chip(double dot, double whole) => Opacity(
          opacity: whole,
          child: Container(
            height: small ? 30 : 34,
            padding: EdgeInsets.symmetric(horizontal: small ? 13 : 16),
            decoration: BoxDecoration(
              color: Color.alphaBlend(c.withValues(alpha: .15), Ink.bg),
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: c.withValues(alpha: .4)),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(color: c.withValues(alpha: dot), shape: BoxShape.circle),
              ),
              const SizedBox(width: 8),
              Text(word,
                  maxLines: 1,
                  softWrap: false,
                  style: Face.s(small ? 15 : 16, weight: FontWeight.w600, color: chipWords(state))),
            ]),
          ),
        );
    if (clock == null) return chip(1, 1);
    return ValueListenableBuilder<double>(
      valueListenable: clock,
      builder: (context, t, _) => state == AgentState.working
          // blink 1.2s ease-in-out: the dot down to .25 and back
          ? chip(keyframes(loop(t, 1.2)!, from: 1, to: .25, curve: Curves.easeInOut), 1)
          // pulse 1s ease-in-out: the whole chip down to .35 and back
          : chip(1, pulse(loop(t, 1)!, curve: Curves.easeInOut)),
    );
  }
}
