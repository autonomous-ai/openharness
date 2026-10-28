import 'identity.dart';
import 'model.dart';
import 'team_glance.dart';

/// The office map (Dee, 2026-10-27: "an open-plan office feel"): each conversation with work moving, or a person in it
/// lately, is a table, and the agents and people with it sit around it. Read from the Swarm the person already sees, so
/// nobody sees a conversation they could not open; private chats, Chat with PM and the Product Managers' conversation
/// never get a table.

enum SuperTabSeatState { working, waiting, idle }

/// How long a person's last post keeps them at a table; the backend keeps the same window (parts/commit.ts).
const superTabRecentPeopleWindow = Duration(hours: 2);

class SuperTabOfficeSeat {
  const SuperTabOfficeSeat({
    required this.id,
    required this.name,
    required this.isAgent,
    this.state,
    this.machine,
  });
  final String id, name;
  final bool isAgent;

  /// An agent's; null for a person.
  final SuperTabSeatState? state;

  /// The computer an agent runs on; null for a person or when it is not known.
  final String? machine;
}

class SuperTabOfficeTable {
  const SuperTabOfficeTable({
    required this.conversationId,
    required this.title,
    required this.projectName,
    required this.seats,
  });
  final String conversationId, title, projectName;
  final List<SuperTabOfficeSeat> seats;
}

const _movingWork = {
  'planned',
  'working',
  'reconciling',
  'needs_human',
  'blocked',
  'review',
};

/// Team at a glance's state of an agent (team_glance.dart) in one of three words: waiting is on a person (a question,
/// needs-human, stuck or in-review work); working has a task in hand, a turn running or a start under way; everything
/// else is idle.
SuperTabSeatState superTabSeatState(SuperTabAgentState state) =>
    switch (state) {
      SuperTabAgentState.working ||
      SuperTabAgentState.assigned ||
      SuperTabAgentState.checking ||
      SuperTabAgentState.starting => SuperTabSeatState.working,
      SuperTabAgentState.waiting ||
      SuperTabAgentState.stuck ||
      SuperTabAgentState.review => SuperTabSeatState.waiting,
      SuperTabAgentState.idle ||
      SuperTabAgentState.down ||
      SuperTabAgentState.lost ||
      SuperTabAgentState.limited ||
      SuperTabAgentState.paused => SuperTabSeatState.idle,
    };

/// The tables, by project and then by the order the Swarm lists its conversations; seats put the Lead first, then the
/// other agents, then the people who posted in the last two hours, newest first.
List<SuperTabOfficeTable> superTabOfficeMap(
  SuperTabSnapshot snapshot, {
  required DateTime now,
  required SuperTabSeatState Function(SuperTabAgent agent) stateOf,
  required String? Function(SuperTabAgent agent) machineOf,
}) {
  final since = now.subtract(superTabRecentPeopleWindow);
  final tables = <SuperTabOfficeTable>[];
  for (final project in snapshot.projects) {
    for (final group in snapshot.conversations) {
      if (group.projectId != project.id ||
          group.closed ||
          group.audience != null ||
          group.id == snapshot.leadsConversationId) {
        continue;
      }
      final people = [
        for (final entry in group.recentPeople.entries)
          if (entry.value.isAfter(since))
            if (snapshot.people.where((p) => p.id == entry.key).firstOrNull
                case final person?)
              (person, entry.value),
      ]..sort((a, b) => b.$2.compareTo(a.$2));
      final moving = _movingWork.contains(group.assignment?['status']);
      if (!moving && people.isEmpty) continue;
      final agents = [
        for (final id in [
          ?group.leadId,
          ...group.agentIds.where((id) => id != group.leadId),
        ])
          ?snapshot.agent(id),
      ];
      tables.add(
        SuperTabOfficeTable(
          conversationId: group.id,
          title: snapshot.isProjectLead(group.id) ? project.name : group.label,
          projectName: project.name,
          seats: [
            for (final agent in agents)
              SuperTabOfficeSeat(
                id: agent.id,
                name: agent.displayName ?? agent.name,
                isAgent: true,
                state: stateOf(agent),
                machine: machineOf(agent),
              ),
            for (final (person, _) in people)
              SuperTabOfficeSeat(
                id: person.id,
                name: superTabPersonName(person.email),
                isAgent: false,
              ),
          ],
        ),
      );
    }
  }
  return tables;
}
