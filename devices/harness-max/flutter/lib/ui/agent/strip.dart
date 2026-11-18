// The agent page's strip (the mockup's .strip): Back (the chevron, the app's icon and name) and one segment per agent of
// the ring with its rail; the agent shown is bold, on a thicker rail that glows down into its segment.
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../app_icon.dart';
import '../overview/bits.dart';
import '../overview/rail.dart';
import '../overview/touch.dart';
import '../tokens.dart';

const double kStripH = 52;

/// Back's width, and the pet column's under it.
const double kSideW = 260;

class Strip extends StatelessWidget {
  const Strip({super.key, required this.model, required this.shown});
  final BarModel model;
  final Agent? shown;

  @override
  Widget build(BuildContext context) {
    final app = model.shown?.id ?? '';
    final segments = model.segments;
    return DecoratedBox(
      decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Ink.line))),
      child: Padding(
        padding: const EdgeInsets.only(bottom: 1),
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SizedBox(
            width: kSideW,
            child: Tap(
              onTap: () {
                model.touched();
                model.back();
              },
              child: DecoratedBox(
                decoration: const BoxDecoration(border: Border(right: BorderSide(color: Ink.line))),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 13, 0),
                  child: Row(children: [
                    const GlyphIcon(Glyph.back, size: 24, color: Ink.dim),
                    const SizedBox(width: 6),
                    if (app.isNotEmpty && hasAppIcon(app)) ...[
                      Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 4), child: AppIcon(app, size: 30)),
                      const SizedBox(width: 6),
                    ],
                    Flexible(
                      child: Text(model.appLabel,
                          maxLines: 1,
                          softWrap: false,
                          overflow: TextOverflow.ellipsis,
                          style: Face.s(19, weight: FontWeight.w600, color: Ink.dim)),
                    ),
                  ]),
                ),
              ),
            ),
          ),
          for (var i = 0; i < segments.length; i++)
            Expanded(
              child: Tap(
                key: ValueKey('seg:${segments[i].id}'),
                onTap: () {
                  model.touched();
                  model.tapSegment(segments[i].id);
                },
                child: _Segment(agent: segments[i], on: segments[i] == shown, first: i == 0),
              ),
            ),
        ]),
      ),
    );
  }
}

class _Segment extends StatelessWidget {
  const _Segment({required this.agent, required this.on, required this.first});
  final Agent agent;
  final bool on, first;

  @override
  Widget build(BuildContext context) {
    final s = agent.state;
    final seg = Stack(fit: StackFit.expand, children: [
      Rail(color: railInk(s), state: s, height: on ? 6 : 4, opacity: on ? 1 : .5, glow: on),
      // A <button> centres its words in what its padding leaves (14 px on top).
      Padding(
        padding: const EdgeInsets.fromLTRB(10, 14, 10, 0),
        child: Center(
          child: Text(agent.name,
              maxLines: 1,
              softWrap: false,
              overflow: TextOverflow.ellipsis,
              style: Face.s(16, weight: on ? FontWeight.w600 : FontWeight.w400, color: on ? Ink.fg : Ink.faint)),
        ),
      ),
    ]);
    if (first) return seg;
    return DecoratedBox(
      decoration: const BoxDecoration(border: Border(left: BorderSide(color: Ink.line))),
      child: Padding(padding: const EdgeInsets.only(left: 1), child: seg),
    );
  }
}
