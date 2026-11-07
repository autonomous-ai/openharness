import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../widgets/desktop_chrome.dart';
import '../swarm_type.dart';

/// A chat card's or a fold's one action, as blue text (View brief, More):
/// a button the keyboard reaches with Tab and presses with Enter or Space, as
/// the pointer does with a click.
class SwarmChatLink extends StatelessWidget {
  const SwarmChatLink({
    super.key,
    required this.label,
    required this.onPressed,
    this.chevron = false,
  });

  final String label;
  final VoidCallback onPressed;

  /// A › after the words, for an action that shows more.
  final bool chevron;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    child: InkWell(
      onTap: onPressed,
      borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: SwarmType.body(context, color: DesktopChrome.accent),
          ),
          if (chevron)
            Icon(
              AppIcons.chevronRight,
              size: AppIcons.metadataSize,
              color: DesktopChrome.accent,
            ),
        ],
      ),
    ),
  );
}
