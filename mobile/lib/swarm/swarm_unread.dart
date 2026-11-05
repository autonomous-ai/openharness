import 'model.dart';
import 'swarm_asks.dart';
import 'swarm_chat_notify.dart';
import 'swarm_reader.dart';

/// What a row says is new in a chat or a project (desktop design system,
/// People and conversations in lists): unread, its name in bold, with no dot;
/// the Lead's tags still waiting on the person, bold too, with an `@N` count
/// of them at its trailing edge ([tags]).
typedef SwarmRowNews = ({bool bold, int tags});

/// Project-level chat counts, plus whether any open project chat has a tag
/// waiting. The project number counts only what opening its own chat clears.
typedef SwarmProjectNews = ({bool bold, int tags, bool hasWaitingTag});

/// Nothing new.
const SwarmRowNews swarmNoNews = (bold: false, tags: 0);
const SwarmProjectNews swarmNoProjectNews = (
  bold: false,
  tags: 0,
  hasWaitingTag: false,
);

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

/// Each project's row with something new, by project id: bold only for a
/// person's message or a tag in its own chat, as the desktop's sidebar
/// (#2427, #2638). Agents' progress and system notices never keep it bold.
/// Its number counts only that chat's tags, which opening the project reads.
/// Decisions and open task tags keep it under Home's filters, without
/// bolding it; their counts stay on their own rows and in Activity (#2927).
/// Closed work, private chats and Buddy chats never contribute.
/// One pass over the Swarm's chats for every project.
Map<String, SwarmProjectNews> swarmProjectNews(
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
  final hasWaitingTag = <String>{};
  final projectChats = {
    for (final project in snapshot.projects)
      project.id: project.leadConversationId,
  };
  for (final group in snapshot.conversations) {
    if (group.closed ||
        group.audience != null ||
        reader.buddies.chatOwners.containsKey(group.id)) {
      continue;
    }
    final projectId = group.projectId;
    final ownChat = group.id == projectChats[projectId];
    if (ownChat && (reader.readMarks?.unreadForPeople(group) ?? false)) {
      unread.add(projectId);
    }
    // Most task updates are agents' progress, with no tags or decisions.
    if (!waiting.containsKey(group.id) && !asked.containsKey(group.id)) continue;
    final count = _countIn(
      reader,
      group,
      waiting[group.id] ?? const [],
      asked[group.id] ?? 0,
    );
    if (count > 0) {
      hasWaitingTag.add(projectId);
      if (ownChat) {
        // Its chat's tags alone (#2927): decisions are in Activity and on
        // the chat's own row.
        tags[projectId] = _countIn(
          reader,
          group,
          waiting[group.id] ?? const [],
          0,
        );
        if (tags[projectId]! > 0) unread.add(projectId);
      }
    }
  }
  return {
    for (final id in {...unread, ...hasWaitingTag})
      id: (
        bold: unread.contains(id),
        tags: tags[id] ?? 0,
        hasWaitingTag: hasWaitingTag.contains(id),
      ),
  };
}
