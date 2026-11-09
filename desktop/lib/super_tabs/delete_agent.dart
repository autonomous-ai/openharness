import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';
import 'my_agents.dart';

/// Delete an agent from the sidebar (Swarm v4, anh Dee 2026-11-09): the Swarm lets go of it, its chat leaves Your Team,
/// and its computer stops its session. The same `agent.remove` Remove from Swarm sends, in the words a person uses.
Future<void> deleteSwarmAgent(
  BuildContext context,
  SuperTabController c,
  SuperTabAgent agent,
  String name,
) async {
  var busy = false;
  await showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      child: StatefulBuilder(
        builder: (context, update) => ListenableBuilder(
          listenable: c,
          builder: (context, _) {
            final pending = c.pendingCommand;
            final checking =
                pending?['type'] == 'agent.remove' &&
                pending?['agentId'] == agent.id;
            final enabled =
                !busy && !c.saving && (checking || !c.hasPendingAction);
            return PopScope(
              canPop: !busy,
              child: AlertDialog(
                title: Text('Delete $name?'),
                content: SizedBox(
                  width: 400,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Its chat and terminal go too.',
                        style: DesktopChrome.text(),
                      ),
                      if (c.operationError != null) ...[
                        const SizedBox(height: 12),
                        Text(
                          c.operationError!,
                          style: DesktopChrome.metadata(),
                        ),
                      ],
                    ],
                  ),
                ),
                actions: [
                  TextButton(
                    autofocus: true,
                    onPressed: busy ? null : () => Navigator.pop(context),
                    child: const Text('Cancel'),
                  ),
                  FilledButton(
                    key: const ValueKey('delete-agent-confirm'),
                    style: grid.dangerButtonStyle(),
                    onPressed: !enabled
                        ? null
                        : () async {
                            update(() => busy = true);
                            final result = checking
                                ? await c.retry()
                                : await c.command({
                                    'type': 'agent.remove',
                                    'agentId': agent.id,
                                  });
                            if (!context.mounted) return;
                            if (result != null) {
                              Navigator.pop(context);
                              await _leaveChatOf(c, agent);
                            } else {
                              update(() => busy = false);
                            }
                          },
                    child: Text(checking ? 'Retry' : 'Delete'),
                  ),
                ],
              ),
            );
          },
        ),
      ),
    ),
  );
}

/// The view moves off the chat of the agent just deleted, to the next agent's chat or, with none, the first project's channel.
Future<void> _leaveChatOf(SuperTabController c, SuperTabAgent agent) async {
  final snapshot = c.snapshot;
  if (snapshot == null || agent.chatId != c.selectedId) return;
  final next = [
    for (final other in superTabMyAgents(snapshot, c.accountId))
      if (other.id != agent.id) ?superTabAgentChat(snapshot, other)?.id,
  ].firstOrNull;
  await c.select(
    next ?? snapshot.projects.firstOrNull?.leadConversationId ?? 'lead',
  );
}
