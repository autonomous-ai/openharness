import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

import 'agent_context_line.dart';
import 'phone_card.dart';
import 'phone_status.dart';
import 'status_pill.dart';

/// One agent on a machine's page: its engine, its name, what it is doing, and — [AgentContextLine] —
/// the folder and branch it is working in. An agent with no terminal to attach is drawn dimmed and
/// does not open, but it can still be held for [onLongPress], which is the only way to reach an
/// agent whose terminal has gone.
///
/// The machine is named on the line too, though this page is already about one machine: the row is
/// the same row the Agents tab draws, and an agent should not read differently depending on which
/// door was used to reach it.
class AgentTile extends StatelessWidget {
  const AgentTile({
    super.key,
    required this.machine,
    required this.agent,
    required this.onTap,
    this.onLongPress,
    this.border,
  });

  final MachineState machine;
  final Agent agent;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  /// Overrides the card's hairline rim — the tabs panel marks the agent whose
  /// terminal is already on screen with it. Null keeps the ordinary rim.
  final BoxBorder? border;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return PhoneCard(
      height: kPhoneAgentCardHeight,
      onTap: agent.terminalAvailable ? onTap : null,
      onLongPress: onLongPress,
      border: border,
      child: Row(
        children: [
          PhoneCardGlyph(
            child: EngineMark(
              engine: agent.engine,
              displayName: agent.engineDisplayName,
              size: 22,
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  agent.displayName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppPalette.textPrimary,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 3),
                StatusPill(summary: phoneAgentSummary(machine, agent)),
                const SizedBox(height: 3),
                AgentContextLine(
                  project: machine.projectOf(agent),
                  machineName: machine.machine.displayName,
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Icon(
            LucideIcons.chevronRight300,
            size: 22,
            color: AppPalette.textFaint,
          ),
        ],
      ),
    );
  }
}
