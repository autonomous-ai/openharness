import 'package:collection/collection.dart';

import 'model.dart';

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
