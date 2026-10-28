import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/models.dart';
import '../core/permission_modes.dart';
import '../core/relative_time.dart';
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import 'controller.dart';
import 'identity.dart';
import 'model.dart';
import 'profile_sheet.dart';
import 'pull_requests.dart';

/// Facts already observed by the Swarm or the agent's machine. Unknown facts
/// stay absent; an idle or working claim needs actual work or native activity.
class SuperTabAgentInfo {
  SuperTabAgentInfo(
    SuperTabController controller,
    AppNotifier? app,
    SuperTabAgent agent, {
    HarnessActivity? activity,
  }) : this._(
         controller,
         app,
         agent,
         activity ??
             (app == null
                 ? null
                 : harnessActivity(app, agent.machineId, agent.harnessId)),
         app
             ?.stateOf(agent.machineId)
             ?.agents
             .where((a) => a.id == agent.harnessId)
             .firstOrNull,
         controller.snapshot?.conversations
             .where(
               (g) =>
                   !g.closed &&
                   g.assignment?['agentId'] == agent.id &&
                   !const {
                     'done',
                     'stopped',
                     'cancelled',
                   }.contains(g.assignment?['status']),
             )
             .firstOrNull,
       );

  SuperTabAgentInfo._(
    this.controller,
    this.app,
    this.agent,
    this.activity,
    this.native,
    this.taskGroup,
  );

  final SuperTabController controller;
  final AppNotifier? app;
  final SuperTabAgent agent;
  final HarnessActivity? activity;
  final Agent? native;
  final SuperTabConversation? taskGroup;

  String? get model =>
      _known(native?.modelName) ??
      _known(agent.configuration['model'] as String?);
  String? get engine =>
      _known(agent.engine) == null ? null : engineIdentity(agent.engine).label;

  /// The computer it runs on: the Mac, for an agent in that Mac's Harness Team account ([SuperTabSnapshot.placeOf]).
  String? get machine {
    final place =
        controller.snapshot?.placeOf(agent.machineId) ?? agent.machineId;
    return _known(app?.stateOf(place)?.machine.displayName) ??
        _known(controller.snapshot?.pool(place)?['name'] as String?);
  }

  String? get folder => _known(native?.project?.cwd);
  DateTime? get started => native?.createdAt;
  DateTime? get lastActive => native?.lastActivityAt;
  bool get hasQuestion =>
      app?.questionFor(agent.machineId, agent.harnessId) != null;

  /// The agent's machine owner, named as the sidebar Humans list names them.
  String? get owner => _personName(agent.machineOwnerId);

  String? _personName(Object? personId) {
    final person = controller.snapshot?.people
        .where((p) => p.id == personId)
        .firstOrNull;
    return _known(person == null ? null : superTabPersonName(person.email));
  }

  String? get questionOwner {
    if (!hasQuestion) return null;
    final execution = taskGroup?.assignment?['execution'];
    final ownerId = execution is Map ? execution['machineOwnerId'] : null;
    return _personName(ownerId) ??
        _known(app?.stateOf(agent.machineId)?.machine.machineShare?.owner) ??
        _known(app?.stateOf(agent.machineId)?.machine.ownerName);
  }

  String? get permission {
    final mode = _known(native?.permissionMode);
    if (mode == null) return null;
    return permissionModesOf(agent.engine)
            .where((choice) => choice.id == mode)
            .firstOrNull
            ?.label ??
        'Unrecognized setting';
  }

  String? get status {
    if (activity
        case HarnessActivity.offline ||
            HarnessActivity.paused ||
            HarnessActivity.failed ||
            HarnessActivity.starting) {
      return activity!.label;
    }
    // A usage limit holds the agent whatever its task says, until the reset.
    if (agent.limitedUntil?.toLocal() case final until?
        when until.isAfter(DateTime.now())) {
      String two(int n) => n.toString().padLeft(2, '0');
      return 'Limited until ${two(until.hour)}:${two(until.minute)}';
    }
    final workStatus = taskGroup?.assignment?['status'];
    if (hasQuestion || workStatus == 'needs_human') {
      return 'Waiting for a person to answer';
    }
    if (activity == HarnessActivity.needsInput) return 'Needs input';
    if (taskGroup case final group?) {
      return switch (workStatus) {
        'planned' => 'Assigned to "${group.title}"',
        'blocked' => 'Stuck on "${group.title}"',
        'review' => 'Waiting for review on "${group.title}"',
        'reconciling' => 'Checking "${group.title}"',
        // Its machine died, it stalled or hit a limit, and the Lead hands it on (backend liveness.ts).
        'lost' => 'Lost "${group.title}"',
        'working' when activity == HarnessActivity.working =>
          'Working on "${group.title}"',
        // An assignment can outlive a native turn or connection. Keep the
        // known task as context without claiming the agent is still working.
        _ => 'Assigned to "${group.title}"',
      };
    }
    return switch (activity) {
      HarnessActivity.working => 'Working',
      HarnessActivity.idle => 'Idle',
      HarnessActivity.done => 'Finished',
      HarnessActivity.needsInput => 'Needs input',
      _ => null,
    };
  }

  String get tooltip => [
    if (engine case final value?) [value, ?model].join(' '),
    ?machine,
    if (status case final value?)
      taskGroup == null
          ? value
          : value.replaceFirst(
              taskGroup!.title,
              _compactTitle(taskGroup!.title),
            ),
    if (lastActive case final value?)
      'Last active ${relativeAgo(value, DateTime.now())}',
  ].join(' · ');

  Uri? get latestGroupPr {
    final group = taskGroup;
    if (group == null) return null;
    final result = group.assignment?['result'];
    if (result is String) {
      final links = superTabPullRequestLinks(result);
      if (links.isNotEmpty) return links.last;
    }
    return _agentMessagePr(controller, group.id, agent.id);
  }
}

String? _known(String? text) =>
    text?.trim().isNotEmpty == true ? text!.trim() : null;

String _compactTitle(String title) =>
    title.length <= 52 ? title : '${title.substring(0, 52).trimRight()}…';

Uri? _agentMessagePr(
  SuperTabController controller,
  String groupId,
  String agentId,
) {
  for (final message in controller.messages(groupId).reversed) {
    if (!message.fromAgent ||
        message.authorId != agentId ||
        message.fromTerminal) {
      continue;
    }
    final links = superTabPullRequestLinks(message.text);
    if (links.isNotEmpty) return links.last;
  }
  return null;
}

Future<void> _loadTaskPr(
  SuperTabController controller,
  String groupId,
  String agentId,
) async {
  await controller.loadMessages(groupId);
  // A details dialog must not walk an entire conversation when no PR exists.
  for (var page = 1; page < 3 && controller.hasOlder(groupId); page++) {
    final group = controller.snapshot?.conversation(groupId);
    if (group == null) return;
    final result = group.assignment?['result'];
    if (result is String && superTabPullRequestLinks(result).isNotEmpty) return;
    if (_agentMessagePr(controller, groupId, agentId) != null) return;
    final count = controller.messages(groupId).length;
    await controller.loadMessages(groupId, older: true);
    if (controller.messages(groupId).length == count) return;
  }
}

Future<void> showSuperTabAgentDetails(
  BuildContext context,
  SuperTabController controller,
  AppNotifier? app,
  SuperTabAgent agent,
  ValueChanged<SuperTabAgent> onOpenAgent,
) {
  final taskGroup = SuperTabAgentInfo(controller, app, agent).taskGroup;
  if (taskGroup != null) {
    unawaited(_loadTaskPr(controller, taskGroup.id, agent.id));
  }
  return showAppDialog<void>(
    context: context,
    builder: (context) => ListenableBuilder(
      listenable: Listenable.merge([controller, ?app]),
      builder: (context, _) {
        final current = controller.snapshot?.agent(agent.id) ?? agent;
        final info = SuperTabAgentInfo(controller, app, current);
        final group = info.taskGroup;
        final pr = info.latestGroupPr;
        final name = controller.snapshot?.agentName(agent.id) ?? agent.name;
        // Its contributor dresses it; its Lead may too, from the CLI.
        final dresses =
            controller.canWrite &&
            current.contributorId == controller.accountId;
        return AlertDialog(
          title: Row(
            children: [
              SuperTabAvatar.agent(current, name: name, size: 32),
              const SizedBox(width: 12),
              Expanded(child: Text(name)),
            ],
          ),
          content: SizedBox(
            width: 440,
            child: SingleChildScrollView(
              child: SelectionArea(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _fact(
                      'Role',
                      controller.snapshot?.activeRoleForAgent(current)?.name ??
                          (controller.snapshot?.isLead(agent.id) == true
                              ? 'Product Manager'
                              : current.isReviewer
                              ? 'Reviewer'
                              : 'Engineer'),
                    ),
                    if (info.engine case final value?) _fact('Engine', value),
                    if (current.name != name) _fact('Agent name', current.name),
                    if (info.model case final value?) _fact('Model', value),
                    if (group != null)
                      _link(
                        'Task',
                        group.title,
                        onPressed: () {
                          Navigator.pop(context);
                          controller.select(group.id);
                        },
                      ),
                    if (pr != null)
                      _link(
                        'Latest PR',
                        'PR #${pr.pathSegments[3]}',
                        tooltip: pr.toString(),
                        onPressed: () => unawaited(
                          launchUrl(pr, mode: LaunchMode.externalApplication),
                        ),
                      ),
                    if (info.machine case final value?) _fact('Machine', value),
                    if (info.owner case final value?) _fact('Owner', value),
                    if (info.folder case final value?)
                      _fact('Working folder', value),
                    if (info.permission case final value?)
                      _fact('Permission mode', value),
                    if (info.started case final value?)
                      _fact('Started', fullDateTime(value)),
                    if (info.questionOwner case final value?)
                      _fact('Who can answer', value),
                  ],
                ),
              ),
            ),
          ),
          actions: [
            if (dresses)
              TextButton(
                onPressed: () => unawaited(
                  showSuperTabProfile(context, controller, agentId: agent.id),
                ),
                child: const Text('Change avatar'),
              ),
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close'),
            ),
            FilledButton(
              onPressed: () {
                Navigator.pop(context);
                onOpenAgent(current);
              },
              child: const Text('Open terminal'),
            ),
          ],
        );
      },
    ),
  );
}

Widget _fact(String label, String value) => Padding(
  padding: const EdgeInsets.only(bottom: 10),
  child: Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(label, style: DesktopChrome.metadata()),
      const SizedBox(height: 2),
      Text(value, style: DesktopChrome.control()),
    ],
  ),
);

Widget _link(
  String label,
  String text, {
  String? tooltip,
  required VoidCallback onPressed,
}) => Padding(
  padding: const EdgeInsets.only(bottom: 10),
  child: Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(label, style: DesktopChrome.metadata()),
      Tooltip(
        message: tooltip ?? text,
        child: TextButton(onPressed: onPressed, child: Text(text)),
      ),
    ],
  ),
);
