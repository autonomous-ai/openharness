import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'model.dart';
import 'my_agents.dart';

/// Choose PM (anh Dee, 2026-11-11): in a project's settings, its owner chooses its Product Manager from their own agents, and
/// choosing again switches it (backend `project.pm`). The agent chosen takes the project's waiting messages; the one before
/// keeps running and is back in Your Team. Nothing new is started and no folder is made. The PM's own chat opens.
Future<void> showChoosePm(
  BuildContext context,
  SuperTabController c,
  String projectId,
) {
  String? picked;
  var busy = false;
  if (!c.hasPendingAction) c.operationError = null;
  return showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      projectId: projectId,
      requireWrite: true,
      child: StatefulBuilder(
        builder: (context, update) => ListenableBuilder(
          listenable: c,
          builder: (context, _) {
            final snapshot = c.snapshot;
            final current = snapshot?.leadOf(projectId)?.id;
            final agents = snapshot == null
                ? const <SuperTabAgent>[]
                : superTabMyAgents(snapshot, c.accountId);
            // Why one of them cannot be this project's PM, or null.
            String? why(SuperTabAgent agent) {
              if (agent.id == current) return 'Current';
              final leads = snapshot?.leadProjectForAgent(agent.id);
              return leads == null ? null : 'PM of ${leads.name}';
            }

            if (picked != null && agents.every((a) => a.id != picked)) {
              picked = null;
            }
            return AlertDialog(
              title: const Text('Choose PM'),
              content: SizedBox(
                width: 400,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (agents.isEmpty)
                        Text(
                          'Start an agent in Your Team first.',
                          style: DesktopChrome.text(),
                        ),
                      for (final agent in agents)
                        ListTile(
                          key: ValueKey('choose-pm-${agent.id}'),
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          enabled: why(agent) == null && !busy,
                          selected: picked == agent.id,
                          leading: SuperTabAvatar.agent(
                            agent,
                            size: SuperTabAvatar.rowSize,
                          ),
                          title: Text(
                            snapshot!.agentName(agent.id, fallback: agent.name),
                          ),
                          trailing: switch (why(agent)) {
                            final reason? => Text(
                              reason,
                              style: DesktopChrome.metadata(),
                            ),
                            null => null,
                          },
                          onTap: () => update(() => picked = agent.id),
                        ),
                      if (c.operationError case final error?) ...[
                        const SizedBox(height: 12),
                        Text(error, style: DesktopChrome.metadata()),
                      ],
                      // A command whose answer was lost, this one or another: checked before anything new is sent.
                      if (c.hasPendingAction)
                        TextButton(
                          onPressed: c.saving
                              ? null
                              : () async {
                                  final result = await c.retry();
                                  if (!context.mounted || result == null) {
                                    return;
                                  }
                                  if (result['chatId'] case final String chat) {
                                    Navigator.pop(context);
                                    unawaited(c.select(chat));
                                  }
                                },
                          child: const Text('Check again'),
                        ),
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: busy ? null : () => Navigator.pop(context),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  key: const ValueKey('choose-pm-confirm'),
                  onPressed:
                      busy || c.saving || c.hasPendingAction || picked == null
                      ? null
                      : () async {
                          update(() => busy = true);
                          final result = await c.command({
                            'type': 'project.pm',
                            'projectId': projectId,
                            'agentId': picked,
                          });
                          if (!context.mounted) return;
                          if (result == null) {
                            update(() => busy = false);
                            return;
                          }
                          Navigator.pop(context);
                          if (result['chatId'] case final String chat) {
                            unawaited(c.select(chat));
                          }
                        },
                  child: const Text('Choose'),
                ),
              ],
            );
          },
        ),
      ),
    ),
  );
}

/// What a project's channel with no PM shows its owner (design doc, Swarm elements): one line, then Choose PM, which opens
/// [showChoosePm]. No [onChoose]: the button waits.
class SwarmPmChoose extends StatelessWidget {
  const SwarmPmChoose({super.key, this.onChoose});

  final VoidCallback? onChoose;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    key: const ValueKey('super-pm-choose'),
    decoration: BoxDecoration(
      color: DesktopChrome.surface,
      borderRadius: BorderRadius.circular(grid.AppCard.radius),
      border: Border.all(color: DesktopChrome.rim),
    ),
    child: Padding(
      padding: const EdgeInsets.all(grid.AppDesktop.groupGap),
      child: Row(
        children: [
          Expanded(
            child: Text(
              'This project has no Product Manager.',
              style: DesktopChrome.control(),
            ),
          ),
          const SizedBox(width: grid.AppDesktop.controlGap),
          FilledButton(onPressed: onChoose, child: const Text('Choose PM')),
        ],
      ),
    ),
  );
}
