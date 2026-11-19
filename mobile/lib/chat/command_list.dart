import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/agent_command.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

/// The chat's `/` list, over the composer while a command is being typed: each of the agent's own commands with the
/// argument it takes and its line. A tap puts the command in the composer for the person to send.
class CommandList extends StatelessWidget {
  const CommandList({super.key, required this.commands, required this.onPick});

  final List<AgentCommand> commands;
  final ValueChanged<AgentCommand> onPick;

  /// Five rows and a half show, the half saying there are more.
  static const double maxHeight = 300;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: maxHeight),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppPalette.cardBg,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: AppPalette.divider),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(20),
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.symmetric(vertical: AppSpace.s),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpace.l,
                  AppSpace.xs,
                  AppSpace.l,
                  AppSpace.xs,
                ),
                child: Text(
                  'Commands',
                  style: AppType.caption(color: AppPalette.textFaint),
                ),
              ),
              for (final command in commands)
                _CommandRow(command: command, onTap: () => onPick(command)),
            ],
          ),
        ),
      ),
    );
  }
}

class _CommandRow extends StatelessWidget {
  const _CommandRow({required this.command, required this.onTap});

  final AgentCommand command;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    child: Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpace.l,
        vertical: AppSpace.s,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(
              LucideIcons.squareTerminal,
              size: 16,
              color: AppPalette.textSecondary,
            ),
          ),
          const SizedBox(width: AppSpace.m),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: '/${command.name}',
                        style: AppType.mono(color: AppPalette.textPrimary),
                      ),
                      if (command.argumentHint.isNotEmpty)
                        TextSpan(
                          text: ' ${command.argumentHint}',
                          style: AppType.mono(color: AppPalette.textFaint),
                        ),
                    ],
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                if (command.description.isNotEmpty)
                  Text(
                    command.description,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppType.caption(color: AppPalette.textSecondary),
                  ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}
