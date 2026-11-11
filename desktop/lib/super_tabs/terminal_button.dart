import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_icon_button.dart';
import 'count_badge.dart';

/// The Terminal button of an agent's chat bar. While the agent's terminal waits on its person ([stuck]: a question on its
/// screen, or a prompt its computer has seen it sit on for 3 minutes), it carries a red 1 over its top right corner, as a
/// notification does (anh Dee, 2026-11-11: "if the terminal is stuck, add a red notification icon on top of the terminal
/// icon"), and its tooltip says so. The badge is drawn only: the button is what is pressed, and its tooltip has the words.
class SwarmTerminalButton extends StatelessWidget {
  const SwarmTerminalButton({
    super.key,
    required this.stuck,
    required this.selected,
    required this.onPressed,
  });

  final bool stuck, selected;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) => Stack(
    clipBehavior: Clip.none,
    children: [
      AppIconButton(
        key: const ValueKey('swarm-terminal-button'),
        icon: AppIcons.terminal,
        size: AppIcons.inlineSize,
        tooltip: stuck ? 'Terminal · waiting on you' : 'Terminal',
        selected: selected,
        onPressed: onPressed,
      ),
      if (stuck)
        const Positioned(
          top: -5,
          right: -7,
          child: IgnorePointer(
            child: ExcludeSemantics(
              child: SuperTabCountBadge(
                1,
                key: ValueKey('swarm-terminal-stuck'),
              ),
            ),
          ),
        ),
    ],
  );
}
