import 'model.dart';

/// The agents [accountId] brought to the Swarm, for the left pane's My agents (Swarm v3, task #4118): their Buddy first,
/// then the others by name. Only the person's own: another person's agent, and another person's Buddy, never appear.
List<SuperTabAgent> superTabMyAgents(
  SuperTabSnapshot snapshot,
  String accountId,
) {
  final own = [
    for (final agent in snapshot.agents)
      if (agent.contributorId == accountId &&
          (agent.buddyOf == null || agent.buddyOf == accountId))
        agent,
  ];
  String name(SuperTabAgent agent) =>
      (agent.displayName ?? agent.name).toLowerCase();
  return own..sort((a, b) {
    final buddy = (b.buddyOf != null ? 1 : 0) - (a.buddyOf != null ? 1 : 0);
    return buddy != 0 ? buddy : name(a).compareTo(name(b));
  });
}

/// Whether [agent] is a PM, to wear the crown: the backend's kind when it sends one (#4116), else whether it leads a
/// project, as before.
bool superTabAgentIsPm(SuperTabSnapshot snapshot, SuperTabAgent agent) =>
    agent.kind != null ? agent.kind == 'pm' : snapshot.isLead(agent.id);

/// The chat that opens when [agent] is chosen in My agents: a PM's is its project's chat, a Regular agent's is the open task
/// it works on now (the newest, when several); null while it has none.
SuperTabConversation? superTabAgentChat(
  SuperTabSnapshot snapshot,
  SuperTabAgent agent,
) {
  // The chat the backend names is the one its person talks to it in (#4116); an older backend names none.
  if (agent.chatId case final id? when snapshot.conversation(id) != null) {
    return snapshot.conversation(id);
  }
  if (snapshot.leadProjectForAgent(agent.id) case final project?) {
    return snapshot.conversation(project.leadConversationId);
  }
  final tasks = [
    for (final group in snapshot.conversations)
      if (!group.closed && group.assignment?['agentId'] == agent.id) group,
  ]..sort((a, b) => (b.number ?? 0).compareTo(a.number ?? 0));
  return tasks.firstOrNull;
}
