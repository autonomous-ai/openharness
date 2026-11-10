import 'controller.dart';
import 'model.dart';

/// The agents in [accountId]'s My agents, for the left pane (Swarm v3, task #4118): their Buddy first, then the others by
/// name. The server says which (task #4192: their own account's, running and not finished), so every client lists the same.
/// An older backend says nothing: then every agent the person brought, and only their own Buddy (this can go 2026-12-07).
List<SuperTabAgent> superTabMyAgents(
  SuperTabSnapshot snapshot,
  String accountId,
) {
  final own = [
    for (final agent in snapshot.agents)
      if (_mine(agent, accountId)) agent,
  ];
  String name(SuperTabAgent agent) =>
      (agent.displayName ?? agent.name).toLowerCase();
  return own..sort((a, b) {
    final buddy = (b.buddyOf != null ? 1 : 0) - (a.buddyOf != null ? 1 : 0);
    return buddy != 0 ? buddy : name(a).compareTo(name(b));
  });
}

bool _mine(SuperTabAgent agent, String accountId) =>
    agent.myAgent ??
    (agent.contributorId == accountId &&
        (agent.buddyOf == null || agent.buddyOf == accountId));

/// Whether [agent] is a PM, to wear the Lead ring: the backend's kind when it sends one (#4116), else whether it leads a
/// project, as before.
bool superTabAgentIsPm(SuperTabSnapshot snapshot, SuperTabAgent agent) =>
    agent.kind != null ? agent.kind == 'pm' : snapshot.isLead(agent.id);

/// The chat that opens when [agent] is chosen in My agents: a PM's is its project's chat, a Regular agent's is the open task
/// it works on now (the newest, when several); null while it has none.
SuperTabConversation? superTabAgentChat(
  SuperTabSnapshot snapshot,
  SuperTabAgent agent,
) {
  // Swarm v4: an agent's row opens its own chat with its person (#4116), never its project's channel or a task's chat.
  if (agent.chatId case final id?) return snapshot.conversation(id);
  return null;
}

/// The 1:1 chats of the reader's agents with something new for them, by its read marks: an agent there asks its person
/// (Swarm v4: an agent reaches its person only in that chat). What a Swarm's count, the Dock and the menu bar show; read
/// on every change of every open Swarm, so it neither copies nor sorts the agents.
List<(SuperTabAgent, SuperTabConversation)> superTabAgentsAsking(
  SuperTabController c,
) {
  final snapshot = c.snapshot;
  if (snapshot == null || c.accessRevoked) return const [];
  return [
    for (final agent in snapshot.agents)
      if (agent.buddyOf == null && _mine(agent, c.accountId))
        if (superTabAgentChat(snapshot, agent) case final chat?
            when c.unreadShown(chat))
          (agent, chat),
  ];
}
