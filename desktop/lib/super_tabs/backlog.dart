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

/// Which group [task] is listed in; null for a cancelled task, which is not
/// listed. A wait on a person is "Waiting on someone", as the sidebar's groups
/// read it (task_groups.dart, Huy); the task's own line says on whom.
SuperTabBacklogGroup? superTabBacklogGroupOf(SuperTabConversation task) {
  if (task.shippedAt != null) return SuperTabBacklogGroup.shipped;
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
  if (assignment == null ||
      assignment['agentId'] is! String ||
      status == 'stopped' ||
      status == 'lost' ||
      wait == 'queued') {
    return SuperTabBacklogGroup.waitingForMachine;
  }
  return SuperTabBacklogGroup.working;
}

/// Every task of the Swarm the controller holds, open and closed, across
/// projects, newest first: the groups the server lets this reader read, less
/// project chats, Buddy chats, steps and private chats, as the sidebar lists
/// a project's work (project_sidebar.dart superTabOpenWorkgroups).
List<SuperTabConversation> superTabBacklogTasks(SuperTabController c) {
  final snapshot = c.snapshot;
  if (snapshot == null) return const [];
  final tasks = [
    for (final project in snapshot.projects)
      for (final g in superTabListedWork(c.projectConversations(project.id)))
        if (g.id != project.leadConversationId &&
            !g.isBuddyChat &&
            !c.hiddenByBuddies(g))
          g,
  ];
  // A stable sort keeps the snapshot's order among unnumbered ones.
  mergeSort(tasks, compare: (a, b) => (b.number ?? 0).compareTo(a.number ?? 0));
  return tasks;
}
