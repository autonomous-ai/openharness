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
