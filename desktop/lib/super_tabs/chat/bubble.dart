import 'package:flutter/material.dart';

import '../../shared/theme/swarm_palette.dart';
import '../../widgets/desktop_chrome.dart';

/// A chat message's bubble (anh Dee's mockup, 11-07, #4529): your own on the
/// right in blue under white text, everyone else's on the left in grey.
/// Radius 18, and a small corner on the sender's side where one sender's
/// bubbles meet, as iMessage joins a run. Keyed `swarm-bubble`.
class SwarmBubble extends StatelessWidget {
  const SwarmBubble({
    super.key,
    required this.own,
    this.joinsAbove = false,
    this.joinsBelow = false,
    this.tooltip,
    required this.child,
  });

  final bool own;

  /// The bubble right above, or below, is the same sender's.
  final bool joinsAbove, joinsBelow;

  /// What hovering the bubble says, such as its message's exact time.
  final String? tooltip;
  final Widget child;

  static const radius = Radius.circular(18);
  static const joined = Radius.circular(4);

  /// The text colour inside one of your own bubbles.
  static Color get ownInk => DesktopChrome.onSelection;

  BorderRadius get _corners {
    final top = joinsAbove ? joined : radius;
    final bottom = joinsBelow ? joined : radius;
    return own
        ? BorderRadius.only(
            topLeft: radius,
            bottomLeft: radius,
            topRight: top,
            bottomRight: bottom,
          )
        : BorderRadius.only(
            topRight: radius,
            bottomRight: radius,
            topLeft: top,
            bottomLeft: bottom,
          );
  }

  @override
  Widget build(BuildContext context) => switch (tooltip) {
    final tip? => Tooltip(
      message: tip,
      waitDuration: const Duration(milliseconds: 600),
      child: _bubble,
    ),
    null => _bubble,
  };

  Widget get _bubble => DecoratedBox(
    key: const ValueKey('swarm-bubble'),
    decoration: BoxDecoration(
      color: own ? SwarmPalette.ownBubble : DesktopChrome.field,
      borderRadius: _corners,
    ),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      child: child,
    ),
  );
}
