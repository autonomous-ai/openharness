import 'dart:async';

import 'package:flutter/material.dart';

import '../logging/app_log.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'model.dart';
import 'my_agents.dart';
import 'new_agent.dart' show swarmAttachAgent;
import 'personal_agents.dart';
import 'personal_projects.dart';

/// Choose PM (anh Dee, 2026-11-11): in a project's settings, its owner chooses its Product Manager from their own agents, and
/// choosing again switches it (backend `project.pm`). The agent chosen takes the project's waiting messages; the one before
/// keeps running and is back in Your Team. Nothing new is started and no folder is made. The PM's own chat opens. In the
/// person's Personal Swarm, with [app], their panes in Your Team not in the Swarm yet are agents to choose too: the one
/// chosen joins as a click on its row joins it ([swarmAttachAgent]), then becomes the PM.
Future<void> showChoosePm(
  BuildContext context,
  SuperTabController c,
  String projectId, {
  AppNotifier? app,
}) {
  String? picked;
  // Why this dialog's own Choose was refused: another command's failure is not said here.
  String? refused;
  var busy = false;
  final opened = DateTime.now();
  return showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      projectId: projectId,
      requireWrite: true,
      child: StatefulBuilder(
        builder: (context, update) => ListenableBuilder(
          listenable: Listenable.merge([c, ?app]),
          builder: (context, _) {
            final snapshot = c.snapshot;
            final current = snapshot?.leadOf(projectId)?.id;
            final agents = snapshot == null
                ? const <SuperTabAgent>[]
                : superTabMyAgents(snapshot, c.accountId);
            // Its pick is the id it gets once it joins, so the choice holds as it does.
            final panes =
                app != null &&
                    snapshot != null &&
                    PersonalProjects.of(app).eligible(c)
                ? personalAgents(app, snapshot)
                : const <PersonalAgent>[];
            // Each project's PM, read once a draw.
            final leading = <String, String>{
              for (final project in snapshot?.projects ?? const [])
                ?snapshot!.leadOf(project.id)?.id: project.name,
            };
            // Why one of them cannot be this project's PM, or null.
            String? why(SuperTabAgent agent) {
              if (agent.id == current) return 'Current';
              final leads = leading[agent.id];
              return leads == null ? null : 'PM of $leads';
            }

            // A choice that is gone, or became the PM here or elsewhere, is no choice.
            if (picked != null &&
                !agents.any((a) => a.id == picked && why(a) == null) &&
                !panes.any(
                  (p) => p.swarmId == picked && !p.machine.isOffline,
                )) {
              picked = null;
            }
            void done(Map<String, dynamic> result) {
              appLog.info(
                'super-tabs',
                'PM chosen in ${DateTime.now().difference(opened).inMilliseconds} ms',
              );
              Navigator.pop(context);
              if (result['chatId'] case final String chat) {
                unawaited(c.select(chat));
              }
            }

            // A pane joining is not left half chosen: the dialog stays until its choice is done or refused.
            return PopScope(
              canPop: !busy,
              child: AlertDialog(
                title: const Text('Choose PM'),
                content: SizedBox(
                  width: 400,
                  child: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
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
                              snapshot!.agentName(
                                agent.id,
                                fallback: agent.name,
                              ),
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
                        for (final pane in panes)
                          ListTile(
                            key: ValueKey('choose-pm-${pane.swarmId}'),
                            dense: true,
                            contentPadding: EdgeInsets.zero,
                            // A computer that is off cannot join it.
                            enabled: !pane.machine.isOffline && !busy,
                            selected: picked == pane.swarmId,
                            leading: SuperTabAvatar(
                              identity: 'agent:${pane.swarmId}',
                              name: pane.name,
                              size: SuperTabAvatar.rowSize,
                              face: true,
                            ),
                            title: Text(pane.name),
                            // Its computer, as its row in Your Team says it: two panes of one name are told apart.
                            subtitle: Text(
                              pane.place,
                              style: DesktopChrome.metadata(),
                            ),
                            onTap: () => update(() => picked = pane.swarmId),
                          ),
                        if (refused case final error?) ...[
                          const SizedBox(height: 12),
                          Text(error, style: DesktopChrome.metadata()),
                        ],
                        // A command whose answer was lost, this one or another: checked before anything new is sent.
                        if (c.hasPendingAction)
                          TextButton(
                            onPressed: c.saving
                                ? null
                                : () async {
                                    final pm =
                                        c.pendingCommand?['type'] ==
                                        'project.pm';
                                    final result = await c.retry();
                                    if (!context.mounted || result == null) {
                                      return;
                                    }
                                    // Its own Choose, confirmed: done. Another command's: choose now.
                                    if (pm) done(result);
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
                            update(() {
                              busy = true;
                              refused = null;
                            });
                            var agentId = picked!;
                            if (panes
                                    .where((p) => p.swarmId == agentId)
                                    .firstOrNull
                                case final pane?) {
                              try {
                                final chat = await swarmAttachAgent(
                                  app!,
                                  c.tabId,
                                  pane.machineId,
                                  pane.agent,
                                );
                                agentId =
                                    c.snapshot
                                        ?.conversation(chat)
                                        ?.agentIds
                                        .firstOrNull ??
                                    agentId;
                              } catch (failure) {
                                appLog.warn(
                                  'super-tabs',
                                  'A pane chosen as PM could not join '
                                      '(${failure is SuperTabFailure ? failure.code : failure.runtimeType})',
                                );
                                if (!context.mounted) return;
                                update(() {
                                  busy = false;
                                  refused = failure is SuperTabFailure
                                      ? failure.message
                                      : "Couldn't join. Try again.";
                                });
                                return;
                              }
                              if (!context.mounted) return;
                            }
                            final result = await c.command({
                              'type': 'project.pm',
                              'projectId': projectId,
                              'agentId': agentId,
                            });
                            if (!context.mounted) return;
                            if (result == null) {
                              // Said by its code alone: no name or project in the log.
                              appLog.warn(
                                'super-tabs',
                                'PM choice refused (${c.operationErrorCode ?? 'unknown'})',
                              );
                              update(() {
                                busy = false;
                                refused = c.operationError;
                              });
                              return;
                            }
                            done(result);
                          },
                    child: const Text('Choose'),
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
