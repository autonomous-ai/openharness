import 'package:collection/collection.dart';

import 'model.dart';

/// A Buddy proposal in a project's chat that its PM has not answered yet, as
/// the proposals read answers it (backend proposals.ts): not part of the
/// Swarm's state. Its root message, its title, the person it was sent for, the
/// priority of the task it asks for (P2 from a server that sends none) and
/// when it came.
class SwarmProposal {
  SwarmProposal.fromJson(Map<String, dynamic> answer)
    : messageId = answer['messageId'] as String,
      title = answer['title'] as String? ?? '',
      personId = answer['personId'] as String?,
      priority = _priorities.contains(answer['priority'])
          ? answer['priority'] as String
          : 'P2',
      at = DateTime.fromMillisecondsSinceEpoch(
        (answer['at'] as num? ?? 0).toInt(),
      );
  final String messageId, title, priority;
  final String? personId;
  final DateTime at;
}

const _priorities = ['P0', 'P1', 'P2', 'P3'];

/// The columns of a project's Board, in this order (the Task Board table of
/// docs/plans/2026-11-06-buddy-board-final-spec.md; Desktop's Tasks board,
/// task #3812): where each ask is on its way from proposal to shipped.
enum SwarmBoardColumn {
  proposal('Proposal'),
  nextUp('Next up'),
  working('Working'),
  done('Done'),
  merged('Merged'),
  shipped('Shipped');

  const SwarmBoardColumn(this.label);
  final String label;
}

/// How far back Shipped looks: fixed, as Desktop's (task #2551).
const swarmBoardShippedWindow = Duration(days: 7);

/// Where a task is listed: its column, whether it waits on the reader (a mark
/// on its card, never a column of its own), and what its card says of its
/// state, or nothing.
typedef SwarmBoardPlace = ({
  SwarmBoardColumn column,
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

/// The pull request a card names: "PR #12", or none for a task without one.
String? _pullRequest(SuperTabConversation task) {
  final url =
      task.cards.pullRequests.firstOrNull?.url ??
      task.pullRequestUrls.firstOrNull;
  final number = url == null ? null : Uri.tryParse(url)?.pathSegments.last;
  return number == null || int.tryParse(number) == null ? null : 'PR #$number';
}

/// The parts a task waits on, as people name them.
String _parts(List<String> parts) => parts
    .map(
      (part) => switch (part) {
        'desktop' => 'Desktop',
        'cli' => 'CLI',
        'web' => 'Web',
        'backend' => 'Backend',
        _ => part,
      },
    )
    .join(', ');

/// What release tags carried (`v1.3.84_desktop` is "Desktop 1.3.84"); null
/// when none reads so.
String? _versions(List<String> tags) {
  final named = [
    for (final tag in tags)
      if (RegExp(r'^v(\d+\.\d+\.\d+)_(\w+)$').firstMatch(tag) case final m?)
        '${_parts([m[2]!])} ${m[1]}',
  ];
  return named.isEmpty ? null : named.join(', ');
}

String _waited(Duration wait) {
  final (hours, minutes) = (wait.inHours, wait.inMinutes % 60);
  return hours == 0
      ? '$minutes min'
      : minutes == 0
      ? '$hours h'
      : '$hours h $minutes min';
}

/// Whether [task] merged and waits for the release that carries it: the
/// server lists its `releasing` parts from the merge until the release, an
/// empty list included, so present is what says it.
bool _releasing(SuperTabConversation task) => task.releasing != null;

/// Whether [task] has shipped: a recorded merge of any of its pull requests
/// that no release still waits on, or Done with none to merge. Its
/// `shippedAt` alone cannot say: the server sets that at the first Done.
bool _shipped(SuperTabConversation task) =>
    !_releasing(task) &&
    (task.cards.pullRequests.any((card) => card.merged) ||
        (task.assignment?['status'] == 'done' &&
            task.cards.pullRequests.isEmpty &&
            task.pullRequestUrls.isEmpty));

/// [task]'s place at [now]; null for one that is not listed: cancelled,
/// stopped, closed without shipping, or shipped before the window.
/// [needsYou] is whether it waits on the reader, which the caller knows from
/// the one rule Needs you uses; [personName] names the person a wait is on.
/// The same rules as Desktop's `superTabTaskPlaceOf`, so one read puts a task
/// in the same column on both.
SwarmBoardPlace? swarmBoardPlaceOf(
  SuperTabConversation task, {
  required DateTime now,
  required bool needsYou,
  String? Function(String personId)? personName,
}) {
  final assignment = task.assignment;
  final status = assignment?['status'];
  final liveness = task.liveness;
  final (state, why) = (liveness?['state'], liveness?['why']);
  final pullRequest = _pullRequest(task);
  final person = liveness?['personId'] as String?;
  SwarmBoardPlace at(SwarmBoardColumn column, [String? words]) =>
      (column: column, needsYou: needsYou, state: words);
  // Where it is, in Working: a wait on review, a person, a machine or a block
  // is a mark on the card, not a column of its own.
  SwarmBoardPlace mark(String words) => at(SwarmBoardColumn.working, words);
  // Merged is Shipped only once a release carries it: until then it waits for
  // one, whatever else the task is (it is often closed already).
  if (_releasing(task)) {
    final parts = _parts(task.releasing!);
    return at(
      SwarmBoardColumn.merged,
      parts.isEmpty ? 'waiting for a release' : 'waiting for $parts',
    );
  }
  // Shipped means released; finished with nothing to merge is Done.
  if (_shipped(task)) {
    final shipped = task.shippedAt;
    final old = shipped == null
        ? task.closed
        : now.difference(shipped) > swarmBoardShippedWindow;
    if (old) return null;
    return task.cards.pullRequests.any((card) => card.merged)
        ? at(
            SwarmBoardColumn.shipped,
            _versions(task.releasedTags) ?? pullRequest,
          )
        : at(SwarmBoardColumn.done, 'Done');
  }
  if (task.closed || status == 'cancelled' || status == 'stopped') return null;
  if (status == 'done') {
    final done = task.shippedAt;
    return at(
      SwarmBoardColumn.done,
      done == null
          ? 'waiting to merge'
          : 'waiting to merge for ${_waited(now.difference(done))}',
    );
  }
  if (assignment == null) {
    final date = task.notBefore;
    return at(
      SwarmBoardColumn.nextUp,
      date == null ? null : 'not before ${_months[date.month - 1]} ${date.day}',
    );
  }
  return switch ((state, why)) {
    ('waiting', 'starting') => at(SwarmBoardColumn.working, pullRequest),
    ('waiting', 'review') => mark('in review'),
    ('waiting', 'revision') => mark('changes requested'),
    ('waiting', 'person') => mark(
      '${(person == null ? null : personName?.call(person)) ?? 'someone'} to decide',
    ),
    ('waiting', 'blocked') => mark('blocked'),
    ('waiting', 'queued') => mark('waiting for a machine'),
    ('quiet', _) => mark('quiet'),
    ('orphaned', _) => mark('agent lost'),
    _ => switch (status) {
      'review' => mark('in review'),
      'needs_human' => mark('someone to decide'),
      'blocked' => mark('blocked'),
      'lost' => mark('agent lost'),
      _ when assignment['agentId'] is! String => mark('waiting for a machine'),
      _ => at(SwarmBoardColumn.working, pullRequest),
    },
  };
}

/// One card of the Board: a task, or a proposal not yet a task.
typedef SwarmBoardEntry = ({
  SuperTabConversation? task,
  SwarmProposal? proposal,
  bool needsYou,
  String? state,
});

/// [priority] as the server keeps it, P2 when it has none, as an index into
/// P0 to P3.
int _priorityOf(String? priority) {
  final at = _priorities.indexOf(priority ?? 'P2');
  return at < 0 ? _priorities.indexOf('P2') : at;
}

int _entryPriority(SwarmBoardEntry entry) => _priorityOf(
  entry.task == null ? entry.proposal!.priority : entry.task!.priority,
);

/// Where [task] sits in its project's shared Next up: the rank a person or the
/// PM gave it, else its number, so a new task joins the bottom.
double _queueKey(SuperTabConversation task) =>
    task.queueRank ?? (task.number ?? 0).toDouble();

int _queueOrder(SuperTabConversation a, SuperTabConversation b) =>
    switch (_queueKey(a).compareTo(_queueKey(b))) {
      0 => (a.number ?? 0).compareTo(b.number ?? 0),
      final c => c,
    };

/// The Board of a project: every column, in order and empty or not, each
/// listing by priority, P0 first; within a priority what waits on the reader
/// first, then proposals oldest first, Next up in the shared order, Working,
/// Done and Merged newest first, and Shipped by when it shipped, newest
/// first. [tasks] are the project's tasks the reader holds, [waiting] the ids
/// of those that wait on the reader (the one rule Needs you uses).
Map<SwarmBoardColumn, List<SwarmBoardEntry>> swarmBoardOf(
  Iterable<SuperTabConversation> tasks, {
  required Iterable<SwarmProposal> proposals,
  required Set<String> waiting,
  required DateTime now,
  String? Function(String personId)? personName,
}) {
  final board = {
    for (final column in SwarmBoardColumn.values) column: <SwarmBoardEntry>[],
  };
  board[SwarmBoardColumn.proposal]!.addAll([
    for (final proposal in [...proposals]..sort((a, b) => a.at.compareTo(b.at)))
      (task: null, proposal: proposal, needsYou: false, state: null),
  ]);
  for (final task in tasks) {
    final place = swarmBoardPlaceOf(
      task,
      now: now,
      needsYou: waiting.contains(task.id),
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
  int order(SwarmBoardColumn column, SwarmBoardEntry a, SwarmBoardEntry b) {
    final priority = _entryPriority(a).compareTo(_entryPriority(b));
    if (priority != 0) return priority;
    if (a.needsYou != b.needsYou) return a.needsYou ? -1 : 1;
    final (x, y) = (a.task, b.task);
    if (x == null || y == null) return 0;
    return switch (column) {
      SwarmBoardColumn.nextUp => _queueOrder(x, y),
      SwarmBoardColumn.shipped => (y.shippedAt ?? now).compareTo(
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

/// How many cards of [board] wait on the reader.
int swarmBoardNeedingYou(Map<SwarmBoardColumn, List<SwarmBoardEntry>> board) =>
    board.values.expand((entries) => entries).where((e) => e.needsYou).length;
