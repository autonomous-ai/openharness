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

/// Remove an agent from Your Team (Swarm v4; anh Dee 2026-11-11: as closing a pane): the Swarm lets go of it
/// (`agent.remove`) and its chat goes. Its session follows the rule a tab's last view has: shown in one of its person's
/// tabs, it keeps running there; with Your Team its last place, an idle one stops quietly and a working one asks first, in
/// the review closing a tab's last view shows (`AppNotifier.reviewSessionClose`), whose Cancel keeps the agent as it was.
/// The session stops before the Swarm lets go of it (the Swarm's removal stops nothing on the computer, backend
/// `agent.remove`), so a cancel or a stop its computer refuses changes nothing.
Future<void> removeSwarmAgent(
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
          listenable: Listenable.merge([c, ?app]),
          builder: (context, _) {
            // Read again on each draw: a tab that shows it may close while the dialog is open.
            final stops = app == null ? null : _lastPlaceSession(app, c, agent);
            final pending = c.pendingCommand;
            final checking =
                pending?['type'] == 'agent.remove' &&
                pending?['agentId'] == agent.id;
            final enabled =
                !busy && !c.saving && (checking || !c.hasPendingAction);
            return PopScope(
              canPop: !busy,
              child: AlertDialog(
                title: Text('Remove $name?'),
                content: SizedBox(
                  width: 400,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        stops != null
                            ? 'Its chat goes and its session stops.'
                            : app != null && _shownInTab(app, agent)
                            ? 'Its chat goes. It keeps running in your tab.'
                            : 'Its chat goes.',
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
                    key: const ValueKey('remove-agent-confirm'),
                    style: grid.dangerButtonStyle(),
                    onPressed: !enabled
                        ? null
                        : () async {
                            update(() {
                              busy = true;
                              stopFailure = null;
                            });
                            final stopped = checking || stops == null
                                ? (stopped: true, refused: null)
                                : await _stopLastPlace(app!, stops);
                            if (!context.mounted) return;
                            if (!stopped.stopped) {
                              update(() {
                                busy = false;
                                stopFailure = stopped.refused;
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
                    child: Text(checking ? 'Retry' : 'Remove'),
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

/// Whether one of its person's own tabs shows [agent]'s session: removing it from Your Team then leaves it running there.
bool _shownInTab(AppNotifier app, SuperTabAgent agent) => app.swarms.any(
  (tab) =>
      !tab.isSuperTab &&
      tab.panes.any(
        (pane) =>
            sameMachineId(pane.machineId, agent.machineId) &&
            (pane.agentId ?? pane.ownerAgentId) == agent.harnessId,
      ),
);

/// [agent]'s session, when removing it from Your Team of [c] is its last place, by the rule closing a tab's last view
/// keeps (`AppNotifier._requestViewClose`): none while one of its person's tabs shows it, another Swarm has it as an
/// agent or it is a project's PM, and none that its computer cannot close (not reached, shared, a session already stopped,
/// one with no terminal, or a CLI too old to close it safely). Those keep running as they are.
(String, Agent)? _lastPlaceSession(
  AppNotifier app,
  SuperTabController c,
  SuperTabAgent agent,
) {
  final machine = app.stateOf(agent.machineId);
  final session = machine?.agents
      .where((a) => a.id == agent.harnessId)
      .firstOrNull;
  if (machine == null ||
      session == null ||
      session.isStopped ||
      !session.terminalAvailable ||
      !session.closeSupported ||
      session.createdAt == null ||
      machine.machine.isShared ||
      machine.belongsToOtherAccount ||
      machine.connectionStatus != ConnectionStatus.connected ||
      _shownInTab(app, agent) ||
      app.superTabs.leadProtectionReasonForHarness(
            agent.machineId,
            agent.harnessId,
          ) !=
          null) {
    return null;
  }
  final elsewhere = app.superTabs.loadedControllers.any(
    (other) =>
        other.tabId != c.tabId &&
        (other.snapshot?.agents.any(
              (a) =>
                  sameMachineId(a.machineId, agent.machineId) &&
                  a.harnessId == agent.harnessId,
            ) ??
            false),
  );
  return elsewhere ? null : (machine.machine.machineId, session);
}

/// Stops [session] as its last view's close does ([AppNotifier.reviewSessionClose]): quietly while idle, after asking while
/// it works. Not [stopped] when its person kept it running, or when it still runs after the review (a stop its computer
/// refused or could not confirm, closed past in the review): the Swarm keeps it then, as it was.
Future<({bool stopped, String? refused})> _stopLastPlace(
  AppNotifier app,
  (String, Agent) session,
) async {
  final review = app.reviewSessionClose;
  if (review == null) {
    return (stopped: false, refused: 'Its session could not be stopped.');
  }
  if (!await review([session])) return (stopped: false, refused: null);
  final (machineId, agent) = session;
  final now = app
      .stateOf(machineId)
      ?.agents
      .where((a) => a.id == agent.id)
      .firstOrNull;
  if (now != null && !now.isStopped && now.continuesSession(agent)) {
    return (stopped: false, refused: 'Its session is still running.');
  }
  return (stopped: true, refused: null);
}

/// The view moves off the chat of the agent just removed, to the next agent's chat or, with none, the first project's channel;
/// with neither it has nowhere to go, and the removed chat is gone.
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
