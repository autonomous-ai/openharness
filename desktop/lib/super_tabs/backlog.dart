import 'package:collection/collection.dart';

import 'controller.dart';
import 'linked_tasks.dart';
import 'model.dart';

/// The groups Manage ▸ Backlog lists a Swarm's tasks in, in this order (Scholes,
/// task #2355): where each task is on its way from asked to shipped.
enum SuperTabBacklogGroup {
  waitingForMachine('Waiting for a machine'),
  working('Working'),
  waitingOnSomeone('Waiting on someone'),
  inReview('In review'),
  readyToMerge('Ready to merge'),
  shipped('Shipped');

  const SuperTabBacklogGroup(this.label);
  final String label;
}

/// How far back Shipped looks: fixed, with no control to change it (the PM's
/// reshape of Scholes's ask, task #2551).
const superTabBacklogShippedWindow = Duration(days: 7);

/// Whether [task] has shipped (task #2558): a recorded merge of any of its pull
/// requests (a batch's counts, its own closed), or Done with none to merge. Its
/// `shippedAt` alone cannot say: the server sets that at the first Done.
bool _shipped(SuperTabConversation task, Object? status) =>
    task.cards.pullRequests.any((card) => card.merged) ||
    (status == 'done' &&
        task.cards.pullRequests.isEmpty &&
        task.pullRequestUrls.isEmpty);

/// Which group [task] is listed in at [now]; null for one that is not listed:
/// cancelled, closed without shipping, or shipped before the window. A wait on
/// a person is "Waiting on someone", as the sidebar's groups read it
/// (task_groups.dart, Huy); the task's own line says on whom.
SuperTabBacklogGroup? superTabBacklogGroupOf(
  SuperTabConversation task,
  DateTime now,
) {
  final status = task.assignment?['status'];
  final at = task.shippedAt;
  final inWindow =
      at != null && now.difference(at) <= superTabBacklogShippedWindow;
  if (at != null && _shipped(task, status)) {
    if (inWindow) return SuperTabBacklogGroup.shipped;
    // Past the window, unless it is back at work.
    if (task.closed || status == 'done') return null;
  }
  // Quiet for a day is still waiting for its merge; archived is over.
  if (task.closed) {
    return !task.archived && status == 'done' && inWindow
        ? SuperTabBacklogGroup.readyToMerge
        : null;
  }
  final assignment = task.assignment;
  final liveness = task.liveness;
  final wait = liveness?['state'] == 'waiting' ? liveness!['why'] : null;
  if (status == 'cancelled') return null;
  if (status == 'done') return SuperTabBacklogGroup.readyToMerge;
  if (wait == 'person' || status == 'needs_human' || status == 'blocked') {
    return SuperTabBacklogGroup.waitingOnSomeone;
  }
  if (status == 'review' || wait == 'review' || wait == 'revision') {
    return SuperTabBacklogGroup.inReview;
  }
  // Orphaned (its agent removed or lost, never started, its start failed),
  // though the assignment may still read working: it needs a new agent.
  if (assignment == null ||
      assignment['agentId'] is! String ||
      status == 'stopped' ||
      status == 'lost' ||
      wait == 'queued' ||
      liveness?['state'] == 'orphaned') {
    return SuperTabBacklogGroup.waitingForMachine;
  }
  return SuperTabBacklogGroup.working;
}

/// Every task of the Swarm the controller holds, open and closed, and of
/// [closed], those read for the list alone, across projects, newest first: the
/// groups the server lets this reader read, less project chats, Buddy chats,
/// steps and private chats, as the sidebar lists a project's work
/// (project_sidebar.dart superTabOpenWorkgroups). What the controller holds is
/// newer than a read, so it wins.
List<SuperTabConversation> superTabBacklogTasks(
  SuperTabController c, {
  Iterable<SuperTabConversation> closed = const [],
}) {
  final snapshot = c.snapshot;
  if (snapshot == null) return const [];
  final byProject = closed.groupListsBy((g) => g.projectId);
  final tasks = [
    for (final project in snapshot.projects)
      for (final g in superTabListedWork([
        ...c.projectConversations(project.id),
        for (final g in byProject[project.id] ?? const <SuperTabConversation>[])
          if (snapshot.conversation(g.id) == null) g,
      ]))
        if (g.id != project.leadConversationId &&
            !g.isBuddyChat &&
            !c.hiddenByBuddies(g))
          g,
  ];
  // A stable sort keeps the snapshot's order among unnumbered ones.
  mergeSort(tasks, compare: (a, b) => (b.number ?? 0).compareTo(a.number ?? 0));
  return tasks;
}
