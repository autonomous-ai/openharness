import 'model.dart';
import 'swarm_buddy.dart';

/// An agent's state on the phone. Read from the Swarm alone: the phone sees
/// no agent's computer, so the work an agent holds is the work it is doing
/// (the desktop's team glance, without its machine readings).
enum SwarmAgentState { working, waiting, stuck, down, limited, idle }

/// One agent in a word: "Working", "Stuck", "Limited until 09:05".
class SwarmAgentGlance {
  SwarmAgentGlance(this.agent, this.name, this.state, this.label, this.task);
  final SuperTabAgent agent;
  final String name;
  final SwarmAgentState state;
  final String label;

  /// The open work it holds, if any.
  final SuperTabConversation? task;
}

/// The team at a glance: [line] for the compact row, [agents] for each one,
/// who needs a person first.
class SwarmTeamGlance {
  SwarmTeamGlance._(this.agents);

  final List<SwarmAgentGlance> agents;

  int _count(Set<SwarmAgentState> states) =>
      agents.where((a) => states.contains(a.state)).length;

  late final int working = _count(const {SwarmAgentState.working});

  /// Waiting on a person: a question, or stuck.
  late final int waiting = _count(const {
    SwarmAgentState.waiting,
    SwarmAgentState.stuck,
  });
  late final int down = _count(const {SwarmAgentState.down});
  late final int limited = _count(const {SwarmAgentState.limited});

  /// What [line] counts, part by part, each with the state it counts: "2
  /// working", "1 down". Leaves out what is none.
  late final List<({String text, SwarmAgentState state})>
  parts = List.unmodifiable([
    if (working > 0) (text: '$working working', state: SwarmAgentState.working),
    if (waiting > 0) (text: '$waiting waiting', state: SwarmAgentState.waiting),
    if (down > 0) (text: '$down down', state: SwarmAgentState.down),
    if (limited > 0) (text: '$limited limited', state: SwarmAgentState.limited),
  ]);

  /// "2 working · 1 waiting · 1 down", leaving out what is none.
  late final String line = agents.isEmpty
      ? 'No agents yet'
      : parts.isEmpty
      ? 'All idle'
      : parts.map((part) => part.text).join(' · ');

  /// "5 agents running", counting who [working] counts: what a project's row
  /// on Home says of its team.
  late final String running = switch (working) {
    _ when agents.isEmpty => 'No agents yet',
    0 => 'No agents running',
    1 => '1 agent running',
    final n => '$n agents running',
  };
}

const _finished = {'done', 'stopped', 'cancelled'};

/// The team of [snapshot], or of its project [projectId]: an agent is in the
/// project it records, else in the one whose work it is in (the desktop's
/// roster rule). A Buddy is no one's team ([swarmTeamAgents]).
///
/// Counted once per read and project: Home, the drawer and the project's page
/// share one glance until the read is replaced, or until [now] crosses an
/// agent's usage limit.
SwarmTeamGlance swarmTeamGlance(
  SuperTabSnapshot snapshot, {
  String? projectId,
  DateTime? now,
}) {
  final at = now ?? DateTime.now();
  final read = _reads[snapshot] ??= _ReadGlances(snapshot);
  final kept = read.glances[projectId];
  if (kept != null && kept.holdsAt(at)) return kept.glance;
  final counted = read.count(snapshot, projectId, at);
  read.glances[projectId] = counted;
  return counted.glance;
}

/// Each read's glances, kept with the read: a replaced read takes its own
/// with it, so nothing counted from an earlier read is shown.
final _reads = Expando<_ReadGlances>('swarm team glances');

/// What one read says of every agent, worked out once: the open work it holds
/// and the project of the first work it is in.
class _ReadGlances {
  _ReadGlances(SuperTabSnapshot snapshot) {
    for (final group in snapshot.conversations) {
      for (final id in [...group.agentIds, ?group.leadId]) {
        _projectOf.putIfAbsent(id, () => group.projectId);
      }
      final work = group.assignment;
      if (!group.closed && !_finished.contains(work?['status'])) {
        if (work?['agentId'] case final String id) {
          _taskOf.putIfAbsent(id, () => group);
        }
      }
    }
  }

  final _projectOf = <String, String>{};
  final _taskOf = <String, SuperTabConversation>{};
  final glances = <String?, _Kept>{};

  _Kept count(SuperTabSnapshot snapshot, String? projectId, DateTime at) {
    final agents =
        [
          for (final agent in swarmTeamAgents(snapshot))
            if (projectId == null || _projectOfAgent(agent) == projectId)
              _glance(snapshot, agent, _taskOf[agent.id], at),
        ]..sort((a, b) {
          final rank = _rank(a.state).compareTo(_rank(b.state));
          return rank != 0 ? rank : a.name.compareTo(b.name);
        });
    // The glance holds while no counted agent's limit starts or ends.
    DateTime? from, until;
    for (final glance in agents) {
      final limit = glance.agent.limitedUntil;
      if (limit == null) continue;
      if (limit.isAfter(at)) {
        if (until == null || limit.isBefore(until)) until = limit;
      } else if (from == null || limit.isAfter(from)) {
        from = limit;
      }
    }
    return _Kept(SwarmTeamGlance._(List.unmodifiable(agents)), from, until);
  }

  String? _projectOfAgent(SuperTabAgent agent) =>
      agent.hasProjectId ? agent.projectId : _projectOf[agent.id];
}

/// A glance and the time it holds for: from [from] (inclusive) to [until].
class _Kept {
  _Kept(this.glance, this.from, this.until);
  final SwarmTeamGlance glance;
  final DateTime? from, until;

  bool holdsAt(DateTime at) =>
      (from == null || !at.isBefore(from!)) &&
      (until == null || at.isBefore(until!));
}

int _rank(SwarmAgentState state) => switch (state) {
  SwarmAgentState.waiting || SwarmAgentState.stuck => 0,
  SwarmAgentState.down => 1,
  SwarmAgentState.limited => 2,
  SwarmAgentState.working => 3,
  SwarmAgentState.idle => 4,
};

SwarmAgentGlance _glance(
  SuperTabSnapshot snapshot,
  SuperTabAgent agent,
  SuperTabConversation? task,
  DateTime at,
) {
  final work = task?.assignment?['status'];
  final until = agent.limitedUntil?.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  // The desktop's order, less what only the agent's computer can say.
  final (state, label) = switch (null) {
    _ when work == 'lost' => (SwarmAgentState.down, 'Lost'),
    _ when agent.downSince != null => (SwarmAgentState.down, 'Down'),
    _ when until != null && until.isAfter(at) => (
      SwarmAgentState.limited,
      'Limited until ${two(until.hour)}:${two(until.minute)}',
    ),
    _ when work == 'blocked' => (SwarmAgentState.stuck, 'Stuck'),
    _ when work == 'needs_human' => (SwarmAgentState.waiting, 'Waiting'),
    _ when work == 'review' => (SwarmAgentState.working, 'Waiting on others'),
    _ when work == 'reconciling' => (SwarmAgentState.working, 'Checking'),
    _ when work == 'planned' || work == 'working' => (
      SwarmAgentState.working,
      'Working',
    ),
    _ => (SwarmAgentState.idle, 'Idle'),
  };
  return SwarmAgentGlance(
    agent,
    snapshot.agentName(agent.id),
    state,
    label,
    task,
  );
}
