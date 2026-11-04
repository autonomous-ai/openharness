import 'package:collection/collection.dart';

import 'attention.dart';
import 'backlog.dart';
import 'controller.dart';
import 'identity.dart';
import 'model.dart';

/// A Buddy proposal in a project's chat that the PM has not answered yet, as
/// the proposals read answers it (backend proposals.ts), not part of the
/// Swarm's state: its root message, its title, and the person it was sent for.
class SuperTabProposal {
  SuperTabProposal.fromJson(Map<String, dynamic> answer)
    : messageId = answer['messageId'] as String,
      title = answer['title'] as String? ?? '',
      personId = answer['personId'] as String?,
      at = DateTime.fromMillisecondsSinceEpoch(
        (answer['at'] as num? ?? 0).toInt(),
      );
  final String messageId, title;
  final String? personId;
  final DateTime at;
}

/// The columns of a project's Tasks view, in this order (Dee, task #2569):
/// where each ask is on its way from proposal to shipped.
enum SuperTabTaskColumn {
  proposals('Proposals'),
  nextUp('Next up'),
  working('Working'),
  waiting('Waiting'),
  shipped('Shipped');

  const SuperTabTaskColumn(this.label);
  final String label;
}

/// Where a task is listed: its column, whether it waits on the reader (a mark
/// in its column, never a column of its own), and what its caption says of
/// its state, or nothing.
typedef SuperTabTaskPlace = ({
  SuperTabTaskColumn column,
  bool needsYou,
  String? state,
});

const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// The pull request a caption names: "PR #12", or none for a task without one.
String? _pullRequest(SuperTabConversation task) {
  final url =
      task.cards.pullRequests.firstOrNull?.url ??
      task.pullRequestUrls.firstOrNull;
  final number = url == null ? null : Uri.tryParse(url)?.pathSegments.last;
  return number == null || int.tryParse(number) == null ? null : 'PR #$number';
}

/// [task]'s place for the reader [readerId] at [now]; null for one that is
/// not listed: cancelled, stopped, closed without shipping, or shipped before
/// the window. It needs the reader as the sidebar's groups did: tagged
/// ([mentions]), waited on by name or by no one named, or asked in its agent's
/// terminal ([needsHuman]). [personName] names the person a wait is on.
SuperTabTaskPlace? superTabTaskPlaceOf(
  SuperTabConversation task, {
  required String readerId,
  required DateTime now,
  int mentions = 0,
  int needsHuman = 0,
  String? Function(String personId)? personName,
}) {
  final assignment = task.assignment;
  final status = assignment?['status'];
  final liveness = task.liveness;
  final (state, why) = (liveness?['state'], liveness?['why']);
  final pullRequest = _pullRequest(task);
  final person = liveness?['personId'] as String?;
  final needsYou =
      mentions > 0 ||
      needsHuman > 0 ||
      (person ?? readerId) == readerId &&
          (state == 'waiting' && why == 'person' || status == 'needs_human');
  SuperTabTaskPlace at(SuperTabTaskColumn column, [String? words]) =>
      (column: column, needsYou: needsYou, state: words);
  SuperTabTaskPlace waiting(String words) =>
      at(SuperTabTaskColumn.waiting, words);
  // Shipped means merged; finished with nothing to merge is Done (#2872).
  final merged = task.cards.pullRequests.any((card) => card.merged);
  if (superTabTaskShipped(task)) {
    final shipped = task.shippedAt;
    final old = shipped == null
        ? task.closed
        : now.difference(shipped) > superTabBacklogShippedWindow;
    return old
        ? null
        : at(SuperTabTaskColumn.shipped, merged ? pullRequest : 'Done');
  }
  if (task.closed || status == 'cancelled' || status == 'stopped') {
    return null;
  }
  if (status == 'done') return waiting('ready to merge');
  if (assignment == null) {
    final date = task.notBefore;
    return at(
      SuperTabTaskColumn.nextUp,
      date == null ? null : 'not before ${_months[date.month - 1]} ${date.day}',
    );
  }
  return switch ((state, why)) {
    ('waiting', 'starting') => at(SuperTabTaskColumn.working, pullRequest),
    ('waiting', 'review') => waiting('in review'),
    ('waiting', 'revision') => waiting('changes requested'),
    ('waiting', 'person') => waiting(
      '${(person == null ? null : personName?.call(person)) ?? 'someone'} to decide',
    ),
    ('waiting', 'blocked') => waiting('blocked'),
    ('waiting', 'queued') => waiting('waiting for a machine'),
    ('quiet', _) => waiting('quiet'),
    ('orphaned', _) => waiting('agent lost'),
    _ => switch (status) {
      'review' => waiting('in review'),
      'needs_human' => waiting('someone to decide'),
      'blocked' => waiting('blocked'),
      'lost' => waiting('agent lost'),
      _ when assignment['agentId'] is! String => waiting(
        'waiting for a machine',
      ),
      _ => at(SuperTabTaskColumn.working, pullRequest),
    },
  };
}

/// One card of the Tasks view: a task, or a Buddy proposal not yet a task.
typedef SuperTabTaskEntry = ({
  SuperTabConversation? task,
  SuperTabProposal? proposal,
  bool needsYou,
  String? state,
});

/// Where [task] sits in its project's shared Next up: the rank a person or the
/// PM gave it, else its number, so a new task joins the bottom.
double _queueKey(SuperTabConversation task) =>
    task.queueRank ?? (task.number ?? 0).toDouble();

int _queueOrder(SuperTabConversation a, SuperTabConversation b) =>
    switch (_queueKey(a).compareTo(_queueKey(b))) {
      0 => (a.number ?? 0).compareTo(b.number ?? 0),
      final c => c,
    };

/// [tasks] in their project's shared Next-up order, as the server keeps it
/// (backend taskQueue.ts): what a move is placed against.
List<SuperTabConversation> superTabQueueOrder(
  Iterable<SuperTabConversation> tasks,
) => [...tasks]..sort(_queueOrder);

/// The project's Tasks view, read by Board, List and the badges alike: every
/// column, in order and empty or not, each listing what needs the reader
/// first, then proposals oldest first, Next up in the shared order, Working
/// and Waiting newest first, and Shipped by when it shipped, newest first.
Map<SuperTabTaskColumn, List<SuperTabTaskEntry>> superTabTaskBoard(
  Iterable<SuperTabConversation> tasks, {
  Iterable<SuperTabProposal> proposals = const [],
  required String readerId,
  required DateTime now,
  int Function(SuperTabConversation task)? mentions,
  int Function(SuperTabConversation task)? needsHuman,
  String? Function(String personId)? personName,
}) {
  final board = {
    for (final column in SuperTabTaskColumn.values)
      column: <SuperTabTaskEntry>[],
  };
  board[SuperTabTaskColumn.proposals]!.addAll([
    for (final proposal in [...proposals]..sort((a, b) => a.at.compareTo(b.at)))
      (task: null, proposal: proposal, needsYou: false, state: null),
  ]);
  for (final task in tasks) {
    final place = superTabTaskPlaceOf(
      task,
      readerId: readerId,
      now: now,
      mentions: mentions?.call(task) ?? 0,
      // A closed task's agent asks nothing: only open ones are asked.
      needsHuman: task.closed ? 0 : needsHuman?.call(task) ?? 0,
      personName: personName,
    );
    if (place == null) continue;
    board[place.column]!.add((
      task: task,
      proposal: null,
      needsYou: place.needsYou,
      state: place.state,
    ));
  }
  int order(
    SuperTabTaskColumn column,
    SuperTabTaskEntry a,
    SuperTabTaskEntry b,
  ) {
    if (a.needsYou != b.needsYou) return a.needsYou ? -1 : 1;
    final (x, y) = (a.task, b.task);
    if (x == null || y == null) return 0;
    return switch (column) {
      SuperTabTaskColumn.nextUp => _queueOrder(x, y),
      SuperTabTaskColumn.shipped => (y.shippedAt ?? now).compareTo(
        x.shippedAt ?? now,
      ),
      _ => (y.number ?? 0).compareTo(x.number ?? 0),
    };
  }

  for (final MapEntry(key: column, value: entries) in board.entries) {
    mergeSort(entries, compare: (a, b) => order(column, a, b));
  }
  return board;
}

/// How many cards of [board] need the reader: the red count on the header's
/// Tasks icon, and what the project's sidebar row adds to its badge.
int superTabTasksNeedingYouIn(
  Map<SuperTabTaskColumn, List<SuperTabTaskEntry>> board,
) => board.values.expand((entries) => entries).where((e) => e.needsYou).length;

/// [project]'s Tasks view for the reader of [c] at [now]: its open tasks, the
/// shipped ones it read for the window ([SuperTabController.closedShipped]),
/// and its open proposals. [needsHuman] says which tasks' agents asked the
/// reader in their terminal.
Map<SuperTabTaskColumn, List<SuperTabTaskEntry>> superTabProjectBoard(
  SuperTabController c,
  SuperTabProject project, {
  required DateTime now,
  int Function(SuperTabConversation task)? needsHuman,
  SuperTabAttention? attention,
}) {
  final tags = attention ?? SuperTabAttention.of(c);
  final people = {
    for (final person in c.snapshot?.people ?? const <SuperTabPerson>[])
      person.id: superTabPersonName(person.email),
  };
  return superTabTaskBoard(
    superTabProjectTasks(
      c,
      project,
      closed: [
        for (final g in c.closedShipped)
          if (g.projectId == project.id) g,
      ],
    ),
    proposals: c.proposalsOf(project.id),
    readerId: c.accountId,
    now: now,
    mentions: (task) => tags.mentionsIn(task.id),
    needsHuman: needsHuman,
    personName: (id) => people[id],
  );
}
