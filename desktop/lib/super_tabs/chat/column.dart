import 'package:flutter/material.dart';

import '../../shared/theme/swarm_layout.dart';

/// The chat's column (Swarm v4, anh Dee 2026-11-09): what a chat draws in its pane, its message rows, day lines, New messages
/// line and composer, takes at most [SwarmLayout.chatColumn] and sits in the middle of the pane. A pane narrower than that
/// is filled, so each row's own 24 keeps its gutters. The list around it, so its scrollbar, and the header stay the pane's
/// whole width.
class SwarmChatColumn extends StatelessWidget {
  const SwarmChatColumn({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Center(
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: SwarmLayout.chatColumn),
      child: child,
    ),
  );
}
