import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/swarm_layout.dart';
import '../widgets/desktop_chrome.dart';

/// Below the width two panes fit, a pane a person opened (an agent's Instructions or Info, its Terminal, a project's Tasks) takes
/// the chat's place under the chat's bar (Swarm v4, anh Dee 2026-11-09), and this strip, a quiet pill with a left chevron, leads
/// back to the chat.
class SwarmBackToChat extends StatelessWidget {
  const SwarmBackToChat({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      key: const ValueKey('swarm-back-to-chat'),
      alignment: Alignment.centerLeft,
      padding: SwarmLayout.backPadding,
      child: DesktopPill(
        key: const ValueKey('swarm-back-to-chat-button'),
        label: 'Chat',
        icon: AppIcons.chevronLeft,
        compact: true,
        quiet: true,
        onPressed: onBack,
      ),
    );
  }
}
