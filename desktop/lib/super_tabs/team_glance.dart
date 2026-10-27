import '../state/app_state.dart';
import '../state/harness_activity.dart';
import 'agent_details.dart';
import 'controller.dart';
import 'machine_status.dart';

/// Team at a glance (Dee, 2026-10-27: "it's hard to monitor the team"): where every agent runs, on which model and
/// effort, and whether the spread makes sense. Read from the Swarm the person already sees, so nobody sees an agent
/// or a machine they could not see before.

/// An agent's state in a word. [waiting]: on a person (a question, needs-human work, an input prompt). [assigned]:
/// holding a task with no turn seen running: a task can outlive its turn or connection, so it never reads as working.
enum SuperTabAgentState {
  working,
  assigned,
  stuck,
  review,
  checking,
  waiting,
  idle,
  down,
  lost,
  limited,
  starting,
  paused,
}

/// One agent in one line: "Working · Mac Studio · opus high".
class SuperTabAgentGlance {
  const SuperTabAgentGlance({
    required this.state,
    required this.label,
    required this.machine,
    required this.model,
    required this.effort,
    required this.busy,
    this.recordedEffort,
    this.requestedEffort,
  });

  final SuperTabAgentState state;

  /// The state as shown: one word, or "Limited until 09:05".
  final String label;
  final String? machine, model;

  /// The effort to show: the recorded one, else its start's, else "unknown".
  final String effort;

  /// Holding a task: what the Swarm counts as this agent's load.
  final bool busy;

  /// The effort the agent's configuration records, and the one its start asked for; null when not known.
  final String? recordedEffort, requestedEffort;

  /// "opus high"; null when the model is not known (an agent read before it reported one).
  String? get modelEffort => model == null ? null : '$model $effort';

  String get line => [label, ?machine, ?modelEffort].join(' · ');
}

/// An effort that says which one runs. 'auto' is what Claude Code reports for an effort it was launched with, and
/// 'default' what a start asks when it leaves the engine's own: neither names one.
String? _concrete(Object? effort) =>
    effort is String &&
        effort.isNotEmpty &&
        effort != 'auto' &&
        effort != 'default'
    ? effort
    : null;

const _activeWork = {
  'planned',
  'working',
  'review',
  'reconciling',
  'needs_human',
  'blocked',
};

SuperTabAgentGlance superTabAgentGlance(
  SuperTabAgentInfo info, {
  DateTime? now,
}) {
  final at = now ?? DateTime.now();
  final agent = info.agent;
  final work = info.taskGroup?.assignment?['status'];
  final activity = info.activity;
  final until = agent.limitedUntil?.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  final (state, label) = switch (null) {
    _ when work == 'lost' => (SuperTabAgentState.lost, 'Lost'),
    _
        when agent.downSince != null ||
            activity == HarnessActivity.offline ||
            activity == HarnessActivity.failed =>
      (SuperTabAgentState.down, 'Down'),
    _ when until != null && until.isAfter(at) => (
      SuperTabAgentState.limited,
      'Limited until ${two(until.hour)}:${two(until.minute)}',
    ),
    _ when activity == HarnessActivity.starting => (
      SuperTabAgentState.starting,
      'Starting',
    ),
    _ when activity == HarnessActivity.paused => (
      SuperTabAgentState.paused,
      'Stopped',
    ),
    // Before waiting: the sidebar marks blocked work as needing input too.
    _ when work == 'blocked' => (SuperTabAgentState.stuck, 'Stuck'),
    _
        when info.hasQuestion ||
            work == 'needs_human' ||
            activity == HarnessActivity.needsInput =>
      (SuperTabAgentState.waiting, 'Waiting'),
    _ when work == 'review' => (SuperTabAgentState.review, 'In review'),
    _ when work == 'reconciling' => (SuperTabAgentState.checking, 'Checking'),
    _ when activity == HarnessActivity.working => (
      SuperTabAgentState.working,
      'Working',
    ),
    _ when work == 'planned' || work == 'working' => (
      SuperTabAgentState.assigned,
      'Assigned',
    ),
    _ when activity == HarnessActivity.done => (
      SuperTabAgentState.idle,
      'Finished',
    ),
    _ => (SuperTabAgentState.idle, 'Idle'),
  };
  final recorded = _concrete(agent.configuration['effort']);
  final requested = _concrete(
    info.controller.snapshot?.startEfforts[agent.harnessId],
  );
  return SuperTabAgentGlance(
    state: state,
    label: label,
    machine: info.machine,
    model: info.model,
    effort: recorded ?? requested ?? 'unknown',
    busy: _activeWork.contains(work),
    recordedEffort: recorded,
    requestedEffort: requested,
  );
}

/// A machine of the Swarm with the agents on it. [status] is null for a machine the Swarm has no reading of.
class SuperTabGlanceMachine {
  SuperTabGlanceMachine(
    this.id,
    this.name,
    this.status,
    this.total,
    this.free, {
    this.paused = false,
  });
  final String id, name;
  final SuperTabMachineStatus? status;
  final int? total, free;
  final bool paused;
  final agents = <(String, SuperTabAgentGlance)>[];
  bool get online =>
      status == SuperTabMachineStatus.live ||
      status == SuperTabMachineStatus.late;
  int get busy => agents.where((a) => a.$2.busy).length;
}

class SuperTabTeamGlance {
  SuperTabTeamGlance._(this.machines, this.models, this.warnings);

  final List<SuperTabGlanceMachine> machines;

  /// "opus high" and how many agents run it, most first.
  final List<(String, int)> models;
  final List<String> warnings;

  factory SuperTabTeamGlance.of(
    SuperTabController c,
    AppNotifier? app, {
    DateTime? now,
  }) {
    final at = now ?? DateTime.now();
    final snapshot = c.snapshot;
    if (snapshot == null) {
      return SuperTabTeamGlance._(const [], const [], const []);
    }
    final machines = <String, SuperTabGlanceMachine>{};
    for (final pool in snapshot.machines) {
      final id = pool['machineId'] as String? ?? '';
      // A Mac's Harness Team account is that Mac (SuperTabSnapshot.placeOf).
      if (id.isEmpty || snapshot.placeOf(id) != id) continue;
      // As the Machines view reads it: a teammate reads a Mac by its Harness Team account (review of #1759).
      final reading = snapshot.readingPoolOf(id, c.accountId) ?? pool;
      final received = (reading['observation'] as Map?)?['receivedAt'];
      final total = (reading['maxAgents'] as num?)?.toInt();
      machines[id] = SuperTabGlanceMachine(
        id,
        pool['name'] as String? ?? 'Unnamed machine',
        superTabMachineStatus(
          age: received is num
              ? at.difference(
                  DateTime.fromMillisecondsSinceEpoch(received.toInt()),
                )
              : null,
        ),
        total,
        (reading['availableSlots'] as num?)?.toInt(),
        // A paused machine, or a paused Swarm, takes no new work.
        paused:
            snapshot.paused ||
            pool['paused'] == true ||
            reading['paused'] == true,
      );
    }
    final models = <String, int>{};
    final warnings = <String>[];
    for (final agent in snapshot.agents) {
      final info = SuperTabAgentInfo(c, app, agent);
      final glance = superTabAgentGlance(info, now: at);
      final name = snapshot.agentName(agent.id);
      final place = snapshot.placeOf(agent.machineId);
      (machines[place] ??= SuperTabGlanceMachine(
        place,
        glance.machine ?? 'Unknown machine',
        null,
        null,
        null,
      )).agents.add((name, glance));
      final model = glance.modelEffort ?? 'Model not reported';
      models[model] = (models[model] ?? 0) + 1;
      if (glance.recordedEffort case final recorded?
          when glance.requestedEffort != null &&
              recorded != glance.requestedEffort) {
        warnings.add(
          '$name runs effort $recorded; its start asked for ${glance.requestedEffort}.',
        );
      }
    }
    for (final machine in machines.values) {
      if (machine.status != SuperTabMachineStatus.offline) continue;
      for (final (name, _) in machine.agents.where((a) => a.$2.busy)) {
        warnings.add('$name is busy on ${machine.name}, which is offline.');
      }
    }
    if (_pileUp(machines.values.toList()) case final warning?) {
      warnings.insert(0, warning);
    }
    return SuperTabTeamGlance._(
      machines.values.toList(),
      (models.entries.map((e) => (e.key, e.value)).toList()
        ..sort((a, b) => b.$2.compareTo(a.$2))),
      warnings,
    );
  }
}

/// More than half the busy agents on one machine while an online one, not paused, has free slots.
String? _pileUp(List<SuperTabGlanceMachine> machines) {
  final busy = machines.fold(0, (sum, m) => sum + m.busy);
  if (busy < 2) return null;
  final crowded = machines.reduce((a, b) => a.busy >= b.busy ? a : b);
  if (crowded.busy * 2 <= busy) return null;
  int free(SuperTabGlanceMachine m) =>
      m.free ?? ((m.total ?? 0) - m.agents.length).clamp(0, 1 << 30);
  final room =
      machines
          .where((m) => m != crowded && m.online && !m.paused && free(m) > 0)
          .toList()
        ..sort((a, b) => free(b).compareTo(free(a)));
  if (room.isEmpty) return null;
  final slots = free(room.first);
  return '${crowded.busy} of $busy busy agents are on ${crowded.name}, while ${room.first.name} has $slots free '
      'slot${slots == 1 ? '' : 's'}.';
}
