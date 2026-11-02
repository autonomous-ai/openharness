import 'model.dart';
import 'swarm_asks.dart';
import 'swarm_chat_notify.dart';
import 'swarm_reader.dart';

/// What a row says is new in a chat or a project (desktop design system,
/// People and conversations in lists): unread, its name in bold, with no dot;
/// the Lead's tags still waiting on the person, bold too, with an `@N` count
/// of them at its trailing edge ([tags]).
typedef SwarmRowNews = ({bool bold, int tags});

/// Nothing new.
const SwarmRowNews swarmNoNews = (bold: false, tags: 0);

/// [group]'s row: bold while it is unread ([SwarmReader.readMarks]) and not
/// muted, or while something counts in it ([swarmChatCount]), with that count.
SwarmRowNews swarmChatNews(
  SwarmReader reader,
  SwarmAsks? asks,
  SuperTabConversation group,
) {
  final tags = swarmChatCount(reader, asks, group);
  return (bold: swarmUnreadShown(reader, group) || tags > 0, tags: tags);
}

/// The `@` count of [group], as the desktop's red number counts
/// (attention.dart `mentionsIn`): tags of the reader waiting in its main
/// stream — a reply also sent to the chat is in it, one that lives only in
/// its thread counts on Threads instead — that the reader has not read past,
/// and decisions asked of them there while the chat shows unread (a
/// decision's row does not say which message asked). A muted chat never
/// counts; its tags stay listed in Activity. No tag counts until the phone's
/// marks are back, and nothing once access is gone.
int swarmChatCount(
  SwarmReader reader,
  SwarmAsks? asks,
  SuperTabConversation group,
) => _countIn(
  reader,
  group,
  [
    for (final m in asks?.mentions ?? const <SuperTabMention>[])
      if (m.conversationId == group.id) m,
  ],
  (asks?.decisions ?? const [])
      .where((d) => d.conversationId == group.id)
      .length,
);

/// How much counts in [group] ([swarmChatCount]) of [mentions] and [asked]
/// open decisions, all of them in it.
int _countIn(
  SwarmReader reader,
  SuperTabConversation group,
  Iterable<SuperTabMention> mentions,
  int asked,
) {
  final snapshot = reader.snapshot;
  if (reader.accessRevoked || snapshot == null) return 0;
  if (swarmMuted(reader, group)) return 0;
  var count = 0;
  if (reader.readMarks?.tagsReadThrough(group.id) case final through?) {
    for (final m in mentions) {
      if (m.threadId == null && (m.messageSequence ?? _unknown) > through) {
        count++;
      }
    }
  }
  if (asked > 0 && swarmUnreadShown(reader, group)) count += asked;
  return count;
}

/// A tag from a server that does not say where it is: it counts until
/// answered, past any read mark.
const _unknown = 1 << 52;

/// Whether [group] shows as unread: unread, and not muted. A muted chat stays
/// listed and never counts (the desktop's `unreadShown`).
bool swarmUnreadShown(SwarmReader reader, SuperTabConversation group) =>
    !swarmMuted(reader, group) && (reader.readMarks?.unread(group) ?? false);

/// Each project's row with something new, by project id: bold while its
/// project chat or any of its open work shows unread, as the desktop's
/// sidebar reads a collapsed project — never for closed work, a private chat
/// or the person's Buddy chat, which has a row of its own — or while tags
/// count there. Its number counts only its project chat ([swarmChatCount]),
/// which opening the project reads. Task tags stay on their own rows and in
/// Activity. A tag counts only in a listed chat under its own project.
/// One pass over the Swarm's chats for every project.
Map<String, SwarmRowNews> swarmProjectNews(
  SwarmReader reader,
  SwarmAsks? asks,
) {
  final snapshot = reader.snapshot;
  if (snapshot == null || reader.accessRevoked) return const {};
  final waiting = <String, List<SuperTabMention>>{};
  for (final m in asks?.mentions ?? const <SuperTabMention>[]) {
    (waiting[m.conversationId] ??= []).add(m);
  }
  final asked = <String, int>{};
  for (final d in asks?.decisions ?? const <SuperTabDecision>[]) {
    asked[d.conversationId] = (asked[d.conversationId] ?? 0) + 1;
  }
  final unread = <String>{};
  final tags = <String, int>{};
  for (final group in snapshot.conversations) {
    if (group.closed ||
        group.audience != null ||
        reader.buddies.chatOwners.containsKey(group.id)) {
      continue;
    }
    final projectId = group.projectId;
    if (!unread.contains(projectId) && swarmUnreadShown(reader, group)) {
      unread.add(projectId);
    }
    final count = _countIn(
      reader,
      group,
      waiting[group.id] ?? const [],
      asked[group.id] ?? 0,
    );
    if (count > 0) {
      unread.add(projectId);
      if (group.id == snapshot.projectById(projectId)?.leadConversationId) {
        tags[projectId] = count;
      }
    }
  }
  return {
    for (final id in {...unread, ...tags.keys})
      id: (bold: true, tags: tags[id] ?? 0),
  };
}
