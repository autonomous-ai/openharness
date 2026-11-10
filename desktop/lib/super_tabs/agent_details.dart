import '../core/models.dart';
import '../core/relative_time.dart';
import '../core/runtime_model_name.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../widgets/engine_identity.dart';
import 'controller.dart';
import 'identity.dart' show kTeamEntryLabel;
import 'model.dart';

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
       );

  SuperTabAgentInfo._(
    this.controller,
    this.app,
    this.agent,
    this.activity,
    this.native,
  );

  final SuperTabController controller;
  final AppNotifier? app;
  final SuperTabAgent agent;
  final HarnessActivity? activity;
  final Agent? native;

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
    if (hasQuestion) return 'Waiting for a person to answer';
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
    ?status,
    if (lastActive case final value?)
      'Last active ${relativeAgo(value, DateTime.now())}',
  ].join(' · ');
}

String? _known(String? text) =>
    text?.trim().isNotEmpty == true ? text!.trim() : null;
