import 'model.dart';
import 'swarm_asks.dart';
import 'swarm_reader.dart';

/// What a row says is new in a chat or a project (desktop design system,
/// People and conversations in lists): unread, its name in bold, with no dot;
/// the Lead's tags still waiting on the person, bold too, with an `@N` count
/// of them at its trailing edge ([tags]).
typedef SwarmRowNews = ({bool bold, int tags});

/// Nothing new.
const SwarmRowNews swarmNoNews = (bold: false, tags: 0);

/// [group]'s row: bold while it is unread ([SwarmReader.readMarks]) or holds
/// tags still waiting ([asks]), with their count.
SwarmRowNews swarmChatNews(
  SwarmReader reader,
  SwarmAsks? asks,
  SuperTabConversation group,
) {
  var tags = 0;
  for (final mention in asks?.mentions ?? const <SuperTabMention>[]) {
    if (mention.conversationId == group.id) tags++;
  }
  final unread = reader.readMarks?.unread(group) ?? false;
  return (bold: unread || tags > 0, tags: tags);
}

/// Each project's row with something new, by project id: bold while its
/// project chat or any of its open work is unread, as the desktop's sidebar
/// reads a project — never for closed work, a private chat or the person's
/// Buddy chat, which has a row of its own — or while tags wait in it, with
/// the count of all of them. One pass over the Swarm's chats for every
/// project.
Map<String, SwarmRowNews> swarmProjectNews(
  SwarmReader reader,
  SwarmAsks? asks,
) {
  final snapshot = reader.snapshot, marks = reader.readMarks;
  if (snapshot == null) return const {};
  final unread = <String>{};
  if (marks != null) {
    for (final group in snapshot.conversations) {
      if (group.closed ||
          group.audience != null ||
          reader.buddies.chatOwners.containsKey(group.id) ||
          unread.contains(group.projectId)) {
        continue;
      }
      if (marks.unread(group)) unread.add(group.projectId);
    }
  }
  final tags = <String, int>{};
  for (final mention in asks?.mentions ?? const <SuperTabMention>[]) {
    final projectId = mention.projectId.isNotEmpty
        ? mention.projectId
        : snapshot.conversation(mention.conversationId)?.projectId;
    if (projectId != null) tags[projectId] = (tags[projectId] ?? 0) + 1;
  }
  return {
    for (final id in {...unread, ...tags.keys})
      id: (bold: true, tags: tags[id] ?? 0),
  };
}
