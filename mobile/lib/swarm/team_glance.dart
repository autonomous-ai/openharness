import 'model.dart';

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

  int get working => _count(const {SwarmAgentState.working});

  /// Waiting on a person: a question, or stuck.
  int get waiting =>
      _count(const {SwarmAgentState.waiting, SwarmAgentState.stuck});
  int get down => _count(const {SwarmAgentState.down});
  int get limited => _count(const {SwarmAgentState.limited});

  /// "2 working · 1 waiting · 1 down", leaving out what is none.
  String get line {
    if (agents.isEmpty) return 'No agents yet';
    final parts = [
      if (working > 0) '$working working',
      if (waiting > 0) '$waiting waiting',
      if (down > 0) '$down down',
      if (limited > 0) '$limited limited',
    ];
    return parts.isEmpty ? 'All idle' : parts.join(' · ');
  }
}

const _finished = {'done', 'stopped', 'cancelled'};

/// The team of [snapshot], or of its project [projectId]: an agent is in the
/// project it records, else in the one whose work it is in (the desktop's
/// roster rule).
SwarmTeamGlance swarmTeamGlance(
  SuperTabSnapshot snapshot, {
  String? projectId,
  DateTime? now,
}) {
  final at = now ?? DateTime.now();
  String? projectOf(SuperTabAgent agent) => agent.hasProjectId
      ? agent.projectId
      : snapshot.conversations
            .where((g) => g.agentIds.contains(agent.id) || g.leadId == agent.id)
            .firstOrNull
            ?.projectId;
  final agents =
      [
        for (final agent in snapshot.agents)
          if (projectId == null || projectOf(agent) == projectId)
            _glance(snapshot, agent, at),
      ]..sort((a, b) {
        final rank = _rank(a.state).compareTo(_rank(b.state));
        return rank != 0 ? rank : a.name.compareTo(b.name);
      });
  return SwarmTeamGlance._(List.unmodifiable(agents));
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
  DateTime at,
) {
  final task = snapshot.conversations
      .where(
        (g) =>
            !g.closed &&
            g.assignment?['agentId'] == agent.id &&
            !_finished.contains(g.assignment?['status']),
      )
      .firstOrNull;
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
    _ when work == 'review' => (SwarmAgentState.working, 'In review'),
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
