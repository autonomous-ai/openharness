import 'model.dart';
import 'swarm_buddy.dart';
import 'swarm_unread.dart';

/// How long a project is quiet before Home folds it under "Other projects".
const swarmQuietAfter = Duration(hours: 24);

/// What a pin names: a project in one Swarm, as the same id may be in
/// another.
String swarmHomeProjectKey(String swarmId, String projectId) =>
    '$swarmId/$projectId';

/// One project on Home: [project] of Swarm [swarmId], when its work last
/// moved ([active], null when not known) and what is new in it ([news]).
class SwarmHomeProject {
  const SwarmHomeProject({
    required this.swarmId,
    required this.project,
    this.active,
    this.news = swarmNoNews,
  });

  final String swarmId;
  final SuperTabProject project;
  final DateTime? active;
  final SwarmRowNews news;

  String get key => swarmHomeProjectKey(swarmId, project.id);
}

/// Home's projects in their groups, each newest first: those the person
/// pinned ([pinned]); then the others ([recent]), save those quiet for more
/// than [swarmQuietAfter], which fold under "Other projects" ([quiet]).
typedef SwarmHomeLists = ({
  List<SwarmHomeProject> pinned,
  List<SwarmHomeProject> recent,
  List<SwarmHomeProject> quiet,
});

/// [projects], in the order read, as Home groups them (Tony, 2026-10-29):
/// pinned ones by their [pins] key at the top, quiet or not; the others by
/// latest activity, those quiet for a day folded. A project whose time is not
/// known comes after those whose is, in the order read, and is never folded,
/// nor is one with something new in it. Nothing is folded when nothing else
/// would be listed.
SwarmHomeLists swarmHomeLists(
  Iterable<SwarmHomeProject> projects, {
  required Set<String> pins,
  required DateTime now,
}) {
  final pinned = <SwarmHomeProject>[];
  final recent = <SwarmHomeProject>[];
  final quiet = <SwarmHomeProject>[];
  for (final project in projects) {
    final active = project.active;
    if (pins.contains(project.key)) {
      pinned.add(project);
    } else if (active != null &&
        now.difference(active) > swarmQuietAfter &&
        !project.news.bold &&
        project.news.tags == 0) {
      quiet.add(project);
    } else {
      recent.add(project);
    }
  }
  // Stable: what is not known keeps the order read, after the rest.
  List<SwarmHomeProject> newest(List<SwarmHomeProject> list) {
    final order = {for (final (i, p) in list.indexed) p: i};
    return list..sort((a, b) {
      final (x, y) = (a.active, b.active);
      if (x != null && y != null && x != y) return y.compareTo(x);
      if ((x == null) != (y == null)) return x == null ? 1 : -1;
      return order[a]!.compareTo(order[b]!);
    });
  }

  if (pinned.isEmpty && recent.isEmpty) {
    return (pinned: const [], recent: newest(quiet), quiet: const []);
  }
  return (pinned: newest(pinned), recent: newest(recent), quiet: newest(quiet));
}

/// When each project of [snapshot] last moved: the newest change of its
/// chats ([SuperTabConversation.changedAt]), its project chat and its work
/// alike, closed work too. Not the person's Buddy chat ([buddies]) or a
/// private chat, as a project's news counts neither ([swarmProjectNews]). A
/// project none of whose chats has a time is not in it.
Map<String, DateTime> swarmProjectActivity(
  SuperTabSnapshot snapshot,
  SwarmBuddies buddies,
) {
  final activity = <String, DateTime>{};
  for (final group in snapshot.conversations) {
    final at = group.changedAt;
    if (at == null ||
        group.audience != null ||
        group.isBuddyChat ||
        buddies.chatOwners.containsKey(group.id)) {
      continue;
    }
    final held = activity[group.projectId];
    if (held == null || at.isAfter(held)) activity[group.projectId] = at;
  }
  return activity;
}
