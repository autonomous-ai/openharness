// An agent not at work, on its page (the mockup's Focus, .fo-main): "status  ago", then what it last said as large as
// the bar allows (or a resting phrase), and "Tap to talk" at the bottom right. While the band is up the words move to
// the top and shrink to two rows.
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../overview/bits.dart';
import '../overview/rail.dart';
import '../tokens.dart';
import 'live_text.dart';

/// The mockup's RESTING: what an agent with nothing to show says, picked by its place in the ring.
const List<String> kResting = ["What's next?", 'Ready when you are', 'Say the word', "Let's build it"];

class Reading extends StatelessWidget {
  const Reading({super.key, required this.model, required this.agent, required this.talking});
  final BarModel model;
  final Agent agent;

  /// The band is up.
  final bool talking;

  @override
  Widget build(BuildContext context) {
    final a = agent;
    final said = a.said;
    final empty = said.isEmpty;
    final at = model.agents.indexOf(a);
    final known = a.since.millisecondsSinceEpoch > 0;
    final size = empty ? (talking ? 30.0 : 40.0) : (talking ? 28.0 : 36.0);
    return Padding(
      padding: EdgeInsets.fromLTRB(44, talking ? 22 : 20, 56, talking ? 120 : 30),
      child: Column(
        mainAxisAlignment: talking ? MainAxisAlignment.start : MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(model.statusWord(a), style: Face.s(20, color: wordInk(a.state))),
              if (known) ...[
                const SizedBox(width: 16),
                LiveText(() => agoText(a.since, model.now()), style: Face.s(20, color: Ink.faint)),
              ],
            ],
          ),
          const SizedBox(height: 8),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1080),
            child: Text(
              empty ? kResting[(at < 0 ? 0 : at) % kResting.length] : said,
              maxLines: talking ? 2 : 3,
              overflow: TextOverflow.ellipsis,
              style: Face.s(size, color: empty ? Ink.rest : Ink.recap, height: 1.3),
            ),
          ),
        ],
      ),
    );
  }
}

/// "Tap to talk" with the mic, or where to talk to an agent the bar cannot record for.
class TalkHint extends StatelessWidget {
  const TalkHint({super.key, required this.model, required this.agent});
  final BarModel model;
  final Agent agent;

  @override
  Widget build(BuildContext context) {
    final style = Face.s(19, color: Ink.rest);
    if (!model.takesVoice(agent)) {
      final app = model.appOf(agent);
      return Text(app.isEmpty ? 'Talk to it on the computer' : 'Talk to it in $app', style: style);
    }
    return Row(mainAxisSize: MainAxisSize.min, children: [
      const GlyphIcon(Glyph.mic, size: 22, color: Ink.rest),
      const SizedBox(width: 8),
      Text('Tap to talk', style: style),
    ]);
  }
}
