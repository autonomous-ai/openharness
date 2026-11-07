import 'package:collection/collection.dart';

import 'controller.dart';
import 'linked_tasks.dart';
import 'model.dart';

/// How far back a shipped task stays listed: fixed, with no control to change
/// it (the PM's reshape of Scholes's ask, task #2551).
const superTabShippedWindow = Duration(days: 7);

/// Whether [task] merged and waits for the release that carries it (task
/// #3452): the server lists its `releasing` parts from the merge until the
/// release, an empty list included, so present is what says it.
bool superTabTaskReleasing(SuperTabConversation task) => task.releasing != null;

/// Whether [task] has shipped (task #2558, released since #3452): a recorded
/// merge of any of its pull requests (a batch's counts, its own closed) that
/// no release still waits on, or Done with none to merge. Its `shippedAt`
/// alone cannot say: the server sets that at the first Done.
bool superTabTaskShipped(SuperTabConversation task) =>
    !superTabTaskReleasing(task) &&
    (task.cards.pullRequests.any((card) => card.merged) ||
        (task.assignment?['status'] == 'done' &&
            task.cards.pullRequests.isEmpty &&
            task.pullRequestUrls.isEmpty));

/// [project]'s tasks the controller holds, open and closed, and of [closed],
/// those read for a list alone: the groups the server lets this reader read,
/// less its chat, Buddy chats, steps and private chats. What the controller
/// holds is newer than a read, so it wins.
List<SuperTabConversation> superTabProjectTasks(
  SuperTabController c,
  SuperTabProject project, {
  Iterable<SuperTabConversation> closed = const [],
}) {
  final snapshot = c.snapshot;
  if (snapshot == null) return const [];
  return [
    for (final g in superTabListedWork([
      ...c.projectConversations(project.id),
      for (final g in closed)
        if (snapshot.conversation(g.id) == null) g,
    ]))
      if (g.id != project.leadConversationId &&
          !g.isBuddyChat &&
          !g.isAgentChat &&
          !c.hiddenByBuddies(g))
        g,
  ];
}

/// A task's priority (task #3117): P0 goes first wherever work is ordered.
enum SuperTabTaskPriority {
  p0('P0', 'Hotfix: something shipped is broken'),
  p1('P1', 'Needed by users soon'),
  p2('P2', 'Planned goal'),
  p3('P3', 'Tools, docs or process');

  const SuperTabTaskPriority(this.badge, this.meaning);

  /// What its badge says, which is also its value on the wire: "P0".
  final String badge;
  final String meaning;

  /// The priority [value] names ("P0" to "P3"); null for anything else.
  static SuperTabTaskPriority? named(Object? value) =>
      values.where((p) => p.badge == value).firstOrNull;
}

/// [task]'s effective priority: its field, else its title's marker (a task
/// from before the field: URGENT is P0, high is P1), else P2.
SuperTabTaskPriority superTabTaskPriority(SuperTabConversation task) =>
    SuperTabTaskPriority.named(task.priority) ??
    superTabTitlePriority(task.title).priority ??
    SuperTabTaskPriority.p2;

/// Whether [group] carries a priority: a task, not a step or a private chat
/// (a Buddy chat is one). The project's chat is the caller's to leave out.
bool superTabCarriesPriority(SuperTabConversation group) =>
    !superTabIsStep(group) && group.audience == null && !group.isBuddyChat;

final _leading = RegExp(r'^\s*URGENT\b\s*:?\s*', caseSensitive: false);
final _trailing = RegExp(
  r'\s*\((?:[^()]*,\s*)?(urgent|high)(?:\s+priority)?\)\s*$',
  caseSensitive: false,
);

/// [title]'s priority and the title without its marker (Scholes's mockup,
/// task #2774). Before the priority field (task #3117) the PM wrote it into
/// the title, as a leading URGENT (P0) or a closing "(Name, high)" (P1); the
/// shown title drops the marker either way. Any other parenthetical stays.
({SuperTabTaskPriority? priority, String title}) superTabTitlePriority(
  String title,
) {
  if (_leading.firstMatch(title) case final match?) {
    final rest = title.substring(match.end);
    if (rest.isNotEmpty) {
      return (
        priority: SuperTabTaskPriority.p0,
        title: rest[0].toUpperCase() + rest.substring(1),
      );
    }
  }
  if (_trailing.firstMatch(title) case final match?) {
    final rest = title.substring(0, match.start);
    if (rest.isNotEmpty) {
      return (
        priority: match.group(1)!.toLowerCase() == 'urgent'
            ? SuperTabTaskPriority.p0
            : SuperTabTaskPriority.p1,
        title: rest,
      );
    }
  }
  return (priority: null, title: title);
}
