import '../core/models.dart';
import '../core/relative_time.dart';
import '../core/runtime_model_name.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../widgets/engine_identity.dart';
import 'agent_line.dart';
import 'agent_mark.dart';
import 'controller.dart';
import 'identity.dart';
import 'model.dart';

/// The task [agent] holds now. A task the Swarm lost is that task's history: it names the agent's state only when the
/// agent holds nothing else (Gray, 2026-11-06: Lamp read "Lost" on an old task while working on another).
SuperTabConversation? _currentTask(
  SuperTabController controller,
  SuperTabAgent agent,
) {
  final open = [
    for (final g
        in controller.snapshot?.conversations ?? const <SuperTabConversation>[])
      if (!g.closed &&
          g.assignment?['agentId'] == agent.id &&
          // Never a task the viewer may not read (review of #2281).
          superTabGroupReadable(controller, g) &&
          !const {
            'done',
            'stopped',
            'cancelled',
          }.contains(g.assignment?['status']))
        g,
  ];
  return open.where((g) => g.assignment?['status'] != 'lost').firstOrNull ??
      open.firstOrNull;
}

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
         _currentTask(controller, agent),
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

  /// The model as people know it ("Opus 5.5"): the native agent's reading is already one; the configuration holds the
  /// engine's own word ("opus", "claude-opus-5-5").
  String? get model =>
      _known(native?.modelName) ??
      switch (_known(agent.configuration['model'] as String?)) {
        final String id => modelDisplayName(id),
        null => null,
      };
  String? get engine =>
      _known(agent.engine) == null ? null : engineIdentity(agent.engine).label;

  /// The computer it runs on: the Mac, for an agent in that Mac's Harness Team account ([SuperTabSnapshot.placeOf]),
  /// named '<Mac> · Team account' then, so it never reads like an agent of the Mac's own account (task #3060).
  String? get machine {
    final place =
        controller.snapshot?.placeOf(agent.machineId) ?? agent.machineId;
    final mac =
        _known(app?.stateOf(place)?.machine.displayName) ??
        _known(controller.snapshot?.pool(place)?['name'] as String?);
    return mac == null || place == agent.machineId
        ? mac
        : '$mac$kTeamEntryLabel';
  }

  String? get folder => _known(native?.project?.cwd);
  DateTime? get lastActive => native?.lastActivityAt;
  bool get hasQuestion =>
      app?.questionFor(agent.machineId, agent.harnessId) != null;

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
    // Closed on its machine and kept by someone: the same word as its line and its group (agent_line.dart), also in the
    // roster's hover, which adds the status when it differs from the line's.
    if (agent.keptClosed && workStatus != 'lost') return 'Kept (closed)';
    if (taskGroup case final group?) {
      return switch (workStatus) {
        'planned' => 'Assigned to "${group.title}"',
        'blocked' => 'Stuck on "${group.title}"',
        'review' => 'Waiting on others for "${group.title}"',
        // Handed over with its status still working, as the Swarm reads it.
        'working'
            when SuperTabAgentWork(
              group,
              readsHandoff: superTabReadsHandoff(controller, group),
            ).handedOver =>
          'Waiting on others for "${group.title}"',
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

  String get tooltip =>
      // Closed on its machine and kept by someone: it reads as its line does (agent_line.dart), the mockup Huy approved.
      agent.keptClosed &&
          activity != HarnessActivity.offline &&
          taskGroup?.assignment?['status'] != 'lost'
      ? superTabAgentGlance(this).line
      : _tooltip;

  String get _tooltip => [
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
}

String? _known(String? text) =>
    text?.trim().isNotEmpty == true ? text!.trim() : null;

String _compactTitle(String title) =>
    title.length <= 52 ? title : '${title.substring(0, 52).trimRight()}…';
