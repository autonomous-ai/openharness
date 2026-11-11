import 'model.dart';
import 'swarm_buddy.dart';
import 'swarm_unread.dart';

/// How long a project is quiet before Home folds it under "Other projects".
const swarmQuietAfter = Duration(hours: 24);

/// How Home lays its projects out: in [sections], Pinned, Projects and the
/// quiet ones folded under Other projects; [newest], every project not pinned
/// in one list, nothing folded. A pin holds under both.
enum SwarmHomeSort { sections, newest }

/// Which projects Home lists: [all]; those with something new, [unread]; those
/// where the person is tagged or asked to decide, [mentions].
enum SwarmHomeFilter { all, unread, mentions }

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
    this.news = swarmNoProjectNews,
  });

  final String swarmId;
  final SuperTabProject project;
  final DateTime? active;
  final SwarmProjectNews news;

  String get key => swarmHomeProjectKey(swarmId, project.id);
}

/// Home's projects alphabetically in their groups: those the person pinned
/// ([pinned]); then the others ([recent]), save those quiet for more
/// than [swarmQuietAfter], which fold under "Other projects" ([quiet]).
typedef SwarmHomeLists = ({
  List<SwarmHomeProject> pinned,
  List<SwarmHomeProject> recent,
  List<SwarmHomeProject> quiet,
});

/// [projects], in the order read, as Home groups them (Tony, 2026-10-29):
/// pinned ones by their [pins] key at the top, quiet or not; the others by
/// name, ignoring a leading # and case, with quiet projects folded for a day.
/// A project with unknown activity or something new is never folded. Nothing
/// is folded when nothing else would be listed. [sort] newest orders by
/// activity and folds nothing; [unreadsFirst] brings those with something new
/// to the top of each list, in the same order among them.
SwarmHomeLists swarmHomeLists(
  Iterable<SwarmHomeProject> projects, {
  required Set<String> pins,
  required DateTime now,
  SwarmHomeSort sort = SwarmHomeSort.sections,
  bool unreadsFirst = false,
}) {
  final pinned = <SwarmHomeProject>[];
  final recent = <SwarmHomeProject>[];
  final quiet = <SwarmHomeProject>[];
  for (final project in projects) {
    final active = project.active;
    if (pins.contains(project.key)) {
      pinned.add(project);
    } else if (sort == SwarmHomeSort.sections &&
        active != null &&
        now.difference(active) > swarmQuietAfter &&
        !_hasNews(project)) {
      quiet.add(project);
    } else {
      recent.add(project);
    }
  }
  List<SwarmHomeProject> ordered(List<SwarmHomeProject> list) {
    if (sort == SwarmHomeSort.sections) {
      final named =
          [
            for (final p in list)
              (
                p,
                (p.project.name.startsWith('#')
                        ? p.project.name.substring(1).trimLeft()
                        : p.project.name)
                    .toLowerCase(),
              ),
          ]..sort((a, b) {
            if (unreadsFirst && _hasNews(a.$1) != _hasNews(b.$1)) {
              return _hasNews(a.$1) ? -1 : 1;
            }
            final byName = a.$2.compareTo(b.$2);
            return byName != 0 ? byName : a.$1.key.compareTo(b.$1.key);
          });
      return [for (final entry in named) entry.$1];
    }
    final order = {for (final (i, p) in list.indexed) p: i};
    return list..sort((a, b) {
      if (unreadsFirst && _hasNews(a) != _hasNews(b)) {
        return _hasNews(a) ? -1 : 1;
      }
      final (x, y) = (a.active, b.active);
      if (x != null && y != null && x != y) return y.compareTo(x);
      if ((x == null) != (y == null)) return x == null ? 1 : -1;
      return order[a]!.compareTo(order[b]!);
    });
  }

  if (pinned.isEmpty && recent.isEmpty) {
    return (pinned: const [], recent: ordered(quiet), quiet: const []);
  }
  return (
    pinned: ordered(pinned),
    recent: ordered(recent),
    quiet: ordered(quiet),
  );
}

bool _hasNews(SwarmHomeProject p) =>
    p.news.bold || p.news.tags > 0 || p.news.hasWaitingTag;

/// [lists] under Home's [filter] (`SwarmHomePrefs.filter`; unread is the
/// desktop's `_hasUnread`), pinned ones too. None with something new was
/// folded.
SwarmHomeLists swarmHomeFiltered(SwarmHomeLists lists, SwarmHomeFilter filter) {
  final bool Function(SwarmHomeProject) keep;
  switch (filter) {
    case SwarmHomeFilter.all:
      return lists;
    case SwarmHomeFilter.unread:
      keep = _hasNews;
    case SwarmHomeFilter.mentions:
      keep = (p) => p.news.hasWaitingTag || p.news.tags > 0;
  }
  return (
    pinned: lists.pinned.where(keep).toList(),
    recent: lists.recent.where(keep).toList(),
    quiet: lists.quiet.where(keep).toList(),
  );
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
