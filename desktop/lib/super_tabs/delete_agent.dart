import 'package:flutter/material.dart';

import '../core/models.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';
import 'my_agents.dart';

/// Delete an agent from the sidebar (Swarm v4, anh Dee 2026-11-09): the Swarm lets go of it, its chat leaves Your Team,
/// and its computer stops its session. The same `agent.remove` Remove from Swarm sends, in the words a person uses. The
/// session stops first, here: the Swarm's removal stops nothing on the computer (backend `agent.remove`), so a deleted agent
/// went on running, and working, with nothing left to see it by (#3791). A stop its computer refuses keeps the agent, in
/// its words.
Future<void> deleteSwarmAgent(
  BuildContext context,
  SuperTabController c,
  SuperTabAgent agent,
  String name, {
  AppNotifier? app,
}) async {
  var busy = false;
  String? stopFailure;
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
                      if (stopFailure ?? c.operationError
                          case final failure?) ...[
                        const SizedBox(height: 12),
                        Text(failure, style: DesktopChrome.metadata()),
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
                            update(() {
                              busy = true;
                              stopFailure = null;
                            });
                            final refused = await _stopSession(app, agent);
                            if (!context.mounted) return;
                            if (refused != null) {
                              update(() {
                                busy = false;
                                stopFailure = refused;
                              });
                              return;
                            }
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

/// Stops [agent]'s session where this app reaches its computer, or says why not; null when stopped, or when there is
/// nothing here to stop (a computer this app does not reach, or a session already stopped).
Future<String?> _stopSession(AppNotifier? app, SuperTabAgent agent) async {
  final machine = app?.stateOf(agent.machineId);
  final session = machine?.agents
      .where((a) => a.id == agent.harnessId)
      .firstOrNull;
  if (app == null ||
      machine == null ||
      session == null ||
      session.isStopped ||
      machine.belongsToOtherAccount ||
      machine.connectionStatus != ConnectionStatus.connected) {
    return null;
  }
  final result = await app.prepareSessionClose(agent.machineId, session)('now');
  if (result['error'] == null) return null;
  return result['detail'] as String? ?? 'Its session could not be stopped.';
}

/// The view moves off the chat of the agent just deleted, to the next agent's chat or, with none, the first project's channel;
/// with neither it has nowhere to go, and the deleted chat is gone.
Future<void> _leaveChatOf(SuperTabController c, SuperTabAgent agent) async {
  final snapshot = c.snapshot;
  if (snapshot == null || agent.chatId != c.selectedId) return;
  final next = [
    for (final other in superTabMyAgents(snapshot, c.accountId))
      if (other.id != agent.id) ?superTabAgentChat(snapshot, other)?.id,
  ].firstOrNull;
  final to = next ?? snapshot.projects.firstOrNull?.leadConversationId;
  if (to != null) await c.select(to);
}
