import 'swarm_reader.dart';

/// The projects with something new, by id: a person's message in the
/// project's own chat, as the desktop's sidebar (#2427, #2638). Agents'
/// progress and system notices never make it new. One pass over the Swarm's
/// chats.
Set<String> swarmUnreadProjects(SwarmReader reader) {
  final snapshot = reader.snapshot;
  if (snapshot == null || reader.accessRevoked) return const {};
  return {
    for (final project in snapshot.projects)
      if (snapshot.conversation(project.leadConversationId) case final chat?
          when !chat.closed &&
              (reader.readMarks?.unreadForPeople(chat) ?? false))
        project.id,
  };
}
