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

/// Which group [task] is listed in at [now]; null for one that is not listed:
/// cancelled, closed without shipping, or shipped before the window. A wait on
/// a person is "Waiting on someone", as the sidebar's groups read it
/// (task_groups.dart, Huy); the task's own line says on whom.
SuperTabBacklogGroup? superTabBacklogGroupOf(
  SuperTabConversation task,
  DateTime now,
) {
  if (task.shippedAt case final shipped?) {
    return now.difference(shipped) > superTabBacklogShippedWindow
        ? null
        : SuperTabBacklogGroup.shipped;
  }
  if (task.closed) return null;
  final assignment = task.assignment;
  final status = assignment?['status'];
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
/// [closed], those read for the list alone, across projects, newest first.
List<SuperTabConversation> superTabBacklogTasks(
  SuperTabController c, {
  Iterable<SuperTabConversation> closed = const [],
}) {
  final byProject = closed.groupListsBy((g) => g.projectId);
  final tasks = [
    for (final project in c.snapshot?.projects ?? const <SuperTabProject>[])
      ...superTabProjectTasks(
        c,
        project,
        closed: byProject[project.id] ?? const [],
      ),
  ];
  // A stable sort keeps the snapshot's order among unnumbered ones.
  mergeSort(tasks, compare: (a, b) => (b.number ?? 0).compareTo(a.number ?? 0));
  return tasks;
}

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
          !c.hiddenByBuddies(g))
        g,
  ];
}
