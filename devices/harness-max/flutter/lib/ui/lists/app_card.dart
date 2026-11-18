// One Apps card (the mockup's `.app`): the app's icon, its name, "N agents" and a dot per agent; the shown app's card
// raised 6 px in a lavender ring that glows under it, marked "Shown". Or the "+ New" card that opens New Harness.
import 'package:flutter/widgets.dart';

import '../../model/types.dart';
import '../app_icon.dart';
import '../tokens.dart';
import 'css_shadow.dart';
import 'press.dart';

const double kAppCardWidth = 176, kAppCardHeight = 244;

/// A dot's ink per agent state, as the mockup's `[data-s]` inks (an idle agent's dot is faint, not the rail's dark).
Color appDotInk(AgentState s) => switch (s) {
      AgentState.working => Ink.accent,
      AgentState.asking => Ink.ask,
      AgentState.done => Ink.done,
      AgentState.failed => Ink.failText,
      AgentState.idle => Ink.faint,
    };

/// At most this many dots fit across a card.
const int kAppDots = 8;

class AppCard extends StatelessWidget {
  /// An app's card. [dots]: one ink per agent, as many as fit.
  const AppCard({super.key, required AppInfo this.app, required this.shown, required this.dots, required this.onTap});

  /// The "+ New" card.
  const AppCard.add({super.key, required this.onTap})
      : app = null,
        shown = false,
        dots = const [];

  final AppInfo? app;
  final bool shown;
  final List<Color> dots;
  final VoidCallback onTap;

  static const _fill = Color(0xFF0C0C11), _rim = Color(0xFF24242C);
  static const _radius = BorderRadius.all(Radius.circular(22));

  @override
  Widget build(BuildContext context) => Press(
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 300),
          curve: const Cubic(0.2, 0.8, 0.2, 1),
          width: kAppCardWidth,
          height: kAppCardHeight,
          transform: Matrix4.translationValues(0, shown ? -6 : 0, 0),
          decoration: BoxDecoration(
            color: _fill,
            borderRadius: _radius,
            boxShadow: [cssShadow(Ink.accent.withValues(alpha: shown ? 1 : 0), y: 18, blur: 40, spread: -14)],
          ),
          // The ring is the mockup's inset box-shadow: over the fill, taking no room.
          foregroundDecoration: BoxDecoration(
            borderRadius: _radius,
            border: Border.all(color: shown ? Ink.accent : _rim, width: shown ? 2 : 1),
          ),
          child: Stack(children: [
            Padding(padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 22), child: _body()),
            if (shown)
              Positioned(
                top: 20,
                right: 18,
                child: Text('Shown', style: Face.s(14, weight: FontWeight.w600, color: Ink.accent)),
              ),
          ]),
        ),
      );

  Widget _body() {
    final a = app;
    if (a == null) {
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: 72,
          height: 72,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(72 * 14 / 60),
            border: Border.all(color: Ink.rim),
          ),
          child: Text('+', style: Face.s(44, weight: FontWeight.w400, color: Ink.dim, height: 1)),
        ),
        const SizedBox(height: 18),
        Text('New', style: Face.s(23, weight: FontWeight.w600)),
      ]);
    }
    final icon = hasAppIcon(a.id) ? a.id : a.name;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      SizedBox(height: 72, child: hasAppIcon(icon) ? AppIcon(icon, size: 72) : null),
      const SizedBox(height: 18),
      Text(a.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: Face.s(23, weight: FontWeight.w600)),
      const SizedBox(height: 4),
      Text(
        a.count == 0 ? 'No agents' : (a.count == 1 ? '1 agent' : '${a.count} agents'),
        style: Face.s(17, color: Ink.dim),
      ),
      const Spacer(),
      Row(children: [
        for (var i = 0; i < dots.length; i++) ...[
          if (i > 0) const SizedBox(width: 6),
          Container(width: 10, height: 10, decoration: BoxDecoration(color: dots[i], shape: BoxShape.circle)),
        ],
      ]),
    ]);
  }
}
