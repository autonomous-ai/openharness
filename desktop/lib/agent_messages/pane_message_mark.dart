import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import 'agent_messages.dart';

/// A message's mark in a pane header, right after the activity mark: `→ api`
/// on the sender's pane and `← lead` on each recipient's, for a few seconds
/// or until the pane is focused. It listens to [controller] itself, as
/// `HarnessActivityMark` listens to activity, so the cached header never
/// rebuilds for traffic.
///
/// A direct child of the header's row: shown, it is a [Flexible] beside the
/// title, so a long list of names gives way rather than overflowing; gone, it
/// takes no share of the row from the title.
class PaneMessageMarkView extends StatelessWidget {
  const PaneMessageMarkView({
    super.key,
    required this.controller,
    required this.machineId,
    required this.agentId,
    required this.style,
  });

  final AgentMessagesController controller;
  final String machineId, agentId;

  /// The header title's style; the mark is a quieter line of the same type.
  final TextStyle style;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final mark = controller.markFor(machineId, agentId);
      if (mark == null) return const SizedBox.shrink();
      final ink = style.color ?? grid.AppPalette.textPrimary;
      return Flexible(
        child: Padding(
          padding: EdgeInsets.only(left: workspaceBarCellSizeOf(context).width),
          child: Tooltip(
            message: mark.tooltip ?? mark.label,
            child: Text(
              mark.label,
              key: const ValueKey('pane-message-mark'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: style.copyWith(
                color: mark.warning
                    ? grid.AppPalette.warn
                    : ink.withValues(alpha: .7),
              ),
            ),
          ),
        ),
      );
    },
  );
}
