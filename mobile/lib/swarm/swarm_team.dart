import 'package:harness_mobile/widgets/engine_identity.dart';

import 'model.dart';
import 'swarm_reader.dart';
import 'swarm_unread.dart';

/// Your Team, as Desktop's left pane has it (Swarm v4, `my_agents.dart`): the
/// agents the reader brought, each opening its own chat with them.

/// The agents [accountId] brought to [snapshot]'s Swarm, A to Z by the name
/// they show (Desktop's `superTabMyAgents`): the backend's `myAgent` when it
/// sends one, else whose agent it is.
List<SuperTabAgent> swarmMyAgents(SuperTabSnapshot snapshot, String accountId) {
  String name(SuperTabAgent agent) =>
      (agent.displayName ?? agent.name).toLowerCase();
  return [
    for (final agent in snapshot.agents)
      if (agent.myAgent ?? agent.contributorId == accountId) agent,
  ]..sort((a, b) => name(a).compareTo(name(b)));
}

/// Whether [agent] is a Product Manager, for its face's colour: the backend's
/// kind when it sends one, else whether it leads a project (Desktop's
/// `superTabAgentIsPm`).
bool swarmAgentIsPm(SuperTabSnapshot snapshot, SuperTabAgent agent) =>
    agent.kind != null ? agent.kind == 'pm' : snapshot.isLead(agent.id);

/// [agent]'s own chat with its person, while the Swarm lists it (Desktop's
/// `superTabAgentChat`).
SuperTabConversation? swarmAgentChat(
  SuperTabSnapshot snapshot,
  SuperTabAgent agent,
) => switch (agent.chatId) {
  final id? => snapshot.conversation(id),
  null => null,
};

/// [agent]'s engine as people read it, or null when it names none (Desktop's
/// `swarmEngineName`).
String? swarmEngineName(SuperTabAgent agent) => switch (agent.engine.trim()) {
  '' => null,
  'claude' => 'Claude Code',
  final engine => engineIdentity(engine).label,
};

/// Where [agent] runs, under its chat's name: its machine and its engine,
/// "Mac Studio · Claude Code", as Desktop's agent bar says it; null when the
/// Swarm names neither.
String? swarmAgentWhere(SuperTabSnapshot snapshot, SuperTabAgent agent) {
  final machine = snapshot.pool(agent.machineId)?['name'];
  final where = [
    if (machine is String && machine.trim().isNotEmpty) machine.trim(),
    ?swarmEngineName(agent),
  ];
  return where.isEmpty ? null : where.join(' · ');
}

/// One row of Your Team: the agent, the chat it opens (null while it has
/// none), and whether that chat shows as unread.
typedef SwarmTeamMember = ({
  SuperTabAgent agent,
  SuperTabConversation? chat,
  bool unread,
});

/// Your Team in [reader]'s Swarm, A to Z; none before it is read.
List<SwarmTeamMember> swarmTeam(SwarmReader reader) {
  final snapshot = reader.snapshot;
  if (snapshot == null) return const [];
  SwarmTeamMember member(SuperTabAgent agent) {
    final chat = swarmAgentChat(snapshot, agent);
    return (
      agent: agent,
      chat: chat,
      unread: chat != null && swarmUnreadShown(reader, chat),
    );
  }

  return [
    for (final agent in swarmMyAgents(snapshot, reader.accountId))
      member(agent),
  ];
}

/// How many of Your Team's rows show before "N more" (Desktop's `teamShown`).
const swarmTeamShown = 8;

/// Which of [team]'s rows show, by their place in it, how many fold under
/// "N more", and whether one folded has something new (Desktop's
/// `_teamRows`): every one when at most one more than [swarmTeamShown] would
/// show, or once the reader opened them all ([open]); else the
/// [swarmTeamShown] that matter most, those with something new first, each
/// where it stands in the list.
({List<int> shown, int hidden, bool hiddenUnread}) swarmTeamRows(
  List<SwarmTeamMember> team, {
  required bool open,
}) {
  final all = [for (var i = 0; i < team.length; i++) i];
  if (open || team.length <= swarmTeamShown + 1) {
    return (shown: all, hidden: 0, hiddenUnread: false);
  }
  final first = {
    ...[
      for (final i in all)
        if (team[i].unread) i,
      for (final i in all)
        if (!team[i].unread) i,
    ].take(swarmTeamShown),
  };
  return (
    shown: [
      for (final i in all)
        if (first.contains(i)) i,
    ],
    hidden: team.length - first.length,
    hiddenUnread: all.any((i) => !first.contains(i) && team[i].unread),
  );
}
