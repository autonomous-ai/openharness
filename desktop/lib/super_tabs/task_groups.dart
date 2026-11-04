import 'package:collection/collection.dart';

import 'model.dart';

/// The groups a project's open tasks are listed in under it in the sidebar, in
/// this order (Huy, #2309): a busy project's list read as one long run of
/// unread rows.
enum SuperTabTaskGroup {
  needsYou('Needs you'),
  working('Working'),
  waitingOnOthers('Waiting on others'),
  rest('The rest');

  const SuperTabTaskGroup(this.label);
  final String label;

  /// Only The rest starts folded: the first screen is what needs the reader
  /// and what is moving.
  bool get foldedByDefault => this == rest;
}

/// Which group [group] is listed in, for the reader [readerId]: tagged, or
/// waited on (by name, or by no one named), or asked in its agent's terminal
/// ([needsHuman]) is theirs; a wait on someone or something else, or a stuck
/// task the PM hands on, is others'; an agent moving or starting is working.
/// The task line says the same states (task_status.dart).
SuperTabTaskGroup superTabTaskGroupOf(
  SuperTabConversation group, {
  required String readerId,
  int mentions = 0,
  int needsHuman = 0,
}) {
  if (mentions > 0) return SuperTabTaskGroup.needsYou;
  final liveness = group.liveness;
  if (liveness == null) {
    if (needsHuman > 0) return SuperTabTaskGroup.needsYou;
    return const {'working', 'planned'}.contains(group.assignment?['status'])
        ? SuperTabTaskGroup.working
        : SuperTabTaskGroup.rest;
  }
  return switch ((liveness['state'], liveness['why'])) {
    ('waiting', 'person') => switch (liveness['personId']) {
      final String person when person != readerId =>
        SuperTabTaskGroup.waitingOnOthers,
      _ => SuperTabTaskGroup.needsYou,
    },
    // An agent at a question makes no progress, so its task goes quiet
    // after 30 minutes: the question still waits on the reader.
    ('quiet', _) when needsHuman > 0 => SuperTabTaskGroup.needsYou,
    ('waiting', 'review' || 'revision' || 'blocked' || 'queued') ||
    ('quiet' || 'orphaned', _) => SuperTabTaskGroup.waitingOnOthers,
    ('waiting', 'starting') => SuperTabTaskGroup.working,
    _ => SuperTabTaskGroup.rest,
  };
}

/// [tasks] in their groups, in the groups' order and each in the order given:
/// how the sidebar lists them and how next unread walks them.
Map<SuperTabTaskGroup, List<SuperTabConversation>> superTabGroupTasks(
  Iterable<SuperTabConversation> tasks, {
  required String readerId,
  int Function(SuperTabConversation task)? mentions,
  int Function(SuperTabConversation task)? needsHuman,
}) {
  final grouped = {
    for (final group in SuperTabTaskGroup.values)
      group: <SuperTabConversation>[],
  };
  for (final task in tasks) {
    grouped[superTabTaskGroupOf(
          task,
          readerId: readerId,
          mentions: mentions?.call(task) ?? 0,
          needsHuman: needsHuman?.call(task) ?? 0,
        )]!
        .add(task);
  }
  return grouped;
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

/// How far back Shipped looks, as Manage ▸ Backlog's Shipped does.
const superTabShippedWindow = Duration(days: 7);

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
  if (merged || status == 'done' && pullRequest == null) {
    final shipped = task.shippedAt;
    final old = shipped == null
        ? task.closed
        : now.difference(shipped) > superTabShippedWindow;
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
      needsHuman: needsHuman?.call(task) ?? 0,
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
      SuperTabTaskColumn.nextUp => switch (_queueKey(x)
          .compareTo(_queueKey(y))) {
        0 => (x.number ?? 0).compareTo(y.number ?? 0),
        final c => c,
      },
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
