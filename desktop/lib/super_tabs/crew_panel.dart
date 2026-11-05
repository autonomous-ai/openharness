import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'model.dart';

/// How long a crew member's session may be gone while its machine reopens it, as the server keeps its task for (backend
/// crew.ts `CREW_REOPEN_GRACE_MS`): shown as Reopening, then Down.
const superTabCrewReopenGrace = Duration(minutes: 5);

/// What the panel says when the project has no crew.
const superTabCrewEmpty = 'No crew yet. The PM adds crew in this project.';

/// The statuses of a task its agent still holds (backend model.ts `activeWork`).
const _open = {'working', 'review', 'needs_human', 'blocked', 'reconciling'};

/// One crew member as the panel shows it (task #3397).
class SuperTabCrewRow {
  const SuperTabCrewRow({
    required this.name,
    required this.role,
    required this.machine,
    required this.state,
    required this.task,
  });

  final String name, role, machine, state, task;
}

String _engine(Object? engine) => switch (engine) {
  'claude' => 'Claude',
  'codex' => 'Codex',
  final String other when other.isNotEmpty =>
    '${other[0].toUpperCase()}${other.substring(1)}',
  _ => '',
};

/// The crew of [projectId] in [swarm], in the order the Swarm lists its agents: each one's name, role (and lane), machine
/// and engine, state and the open task it holds.
List<SuperTabCrewRow> superTabCrewRows(
  SuperTabSnapshot swarm,
  String projectId, {
  DateTime? now,
}) {
  final at = now ?? DateTime.now();
  return [
    for (final agent in swarm.teamAgents)
      if (agent.crewRole != null && agent.projectId == projectId)
        SuperTabCrewRow(
          name: agent.displayName ?? agent.name,
          role: [agent.crewRole!, ?agent.crewLane].join(' · '),
          machine: [
            swarm.pool(agent.machineId)?['name'] as String? ?? agent.machineId,
            _engine(agent.configuration['engine']),
          ].where((part) => part.isNotEmpty).join(' · '),
          state: switch (agent.downSince) {
            _ when agent.crewAsleep => 'Asleep',
            null => 'Running',
            final DateTime since when at.difference(since) < superTabCrewReopenGrace =>
              'Reopening',
            final DateTime since => 'Down ${at.difference(since).inMinutes}m',
          },
          task: switch (swarm.conversations
              .where(
                (c) =>
                    c.assignment?['agentId'] == agent.id &&
                    _open.contains(c.assignment?['status']),
              )
              .firstOrNull) {
            null => 'No task',
            final SuperTabConversation c =>
              [if (c.number != null) '#${c.number}', c.title].join(' '),
          },
        ),
  ];
}

/// The crew list: a row per member, or one line when there is none.
class SuperTabCrewList extends StatelessWidget {
  const SuperTabCrewList({super.key, required this.rows});

  final List<SuperTabCrewRow> rows;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    if (rows.isEmpty) {
      return Text(superTabCrewEmpty, style: DesktopChrome.metadata());
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (index, row) in rows.indexed)
          SuperTabDetailSection(
            title: row.name,
            first: index == 0,
            trailing: Text(row.state, style: DesktopChrome.metadata()),
            children: [
              SuperTabDetailRow(label: 'Role', value: row.role),
              SuperTabDetailRow(label: 'Machine', value: row.machine),
              SuperTabDetailRow(label: 'Task', value: row.task),
            ],
          ),
      ],
    );
  }
}

/// The project's crew in the Swarm's details frame: the agents the Swarm keeps running, which a crash or a frozen screen
/// reopens with their task and idle never closes (task #3397).
Future<void> showSuperTabCrew(
  BuildContext context,
  SuperTabController c,
  String projectId,
) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    projectId: projectId,
    requireWrite: false,
    child: ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final swarm = c.snapshot;
        return SuperTabDetailDialog(
          title: 'Crew',
          detail:
              'Agents the Swarm keeps running. A crashed or frozen session reopens with its task, and idle never closes them.',
          body: SuperTabCrewList(
            rows: swarm == null ? const [] : superTabCrewRows(swarm, projectId),
          ),
        );
      },
    ),
  ),
);
