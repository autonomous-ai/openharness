import 'dart:math' as math;

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
      priority =
          SuperTabTaskPriority.named(answer['priority']) ??
          SuperTabTaskPriority.p2,
      at = DateTime.fromMillisecondsSinceEpoch(
        (answer['at'] as num? ?? 0).toInt(),
      );
  final String messageId, title;
  final String? personId;

  /// What the task it asks for would be: the proposal's high, normal or low as
  /// P1, P2 or P3 (task #3117); P2 when an older server sends none.
  final SuperTabTaskPriority priority;
  final DateTime at;
}

/// The columns of a project's Tasks view, in this order (Ken's Task Board,
/// task #3812): each is one place where work waits, so where cards pile up is
/// where the flow is stuck. Working holds a task whatever it waits on, with
/// one mark for where it is; Done is finished and waiting to merge; Merged is
/// on main and waiting for a release.
enum SuperTabTaskColumn {
  proposals('Proposal'),
  nextUp('Next up'),
  working('Working'),
  done('Done'),
  merged('Merged'),
  shipped('Shipped');

  const SuperTabTaskColumn(this.label);
  final String label;
}

/// The columns [project] draws, in order: Full's six, Simple's three, which are Next up, Working and Done under their own
/// titles (task #3897, #3896). A project with none read, or from an older server, is Full.
List<SuperTabTaskColumn> superTabBoardColumns(SuperTabProject? project) =>
    project?.isSimple == true
    ? const [
        SuperTabTaskColumn.nextUp,
        SuperTabTaskColumn.working,
        SuperTabTaskColumn.done,
      ]
    : SuperTabTaskColumn.values;

/// [column]'s title in [project]: the server's for a Simple project, else Full's own.
String superTabColumnLabel(
  SuperTabProject? project,
  SuperTabTaskColumn column,
) {
  if (project?.isSimple != true) return column.label;
  return switch (column) {
    SuperTabTaskColumn.nextUp => project!.columnTitle('nextUp') ?? 'To do',
    SuperTabTaskColumn.working => project!.columnTitle('working') ?? 'Doing',
    _ => project!.columnTitle('done') ?? column.label,
  };
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

/// What a release tag carried (`v1.3.84_desktop` is "Desktop 1.3.84"), for
/// every tag of [task]'s that reads so; null when it has none.
String? _versions(List<String> tags) {
  final named = [
    for (final tag in tags)
      if (RegExp(r'^v(\d+\.\d+\.\d+)_(\w+)$').firstMatch(tag) case final m?)
        '${_parts([m[2]!])} ${m[1]}',
  ];
  return named.isEmpty ? null : named.join(', ');
}

/// How long [task], set done, has waited for its merge: since its first Done
/// ([SuperTabConversation.shippedAt]); null when the server did not say.
Duration? superTabMergeWait(SuperTabConversation task, DateTime now) {
  final done = task.shippedAt;
  return done == null ? null : now.difference(done);
}

/// Past this a merge waiting turns to a warning, so a merge bottleneck shows.
const superTabMergeWarnAfter = Duration(hours: 1);

/// Whether [task] is done and waits for its pull request to merge.
bool _waitingToMerge(SuperTabConversation task) =>
    task.assignment?['status'] == 'done' &&
    !task.closed &&
    !superTabTaskReleasing(task) &&
    !superTabTaskShipped(task);

/// Whether [task] is done, not merged, and has waited past the warning.
bool superTabMergeOverdue(SuperTabConversation task, DateTime now) =>
    _waitingToMerge(task) &&
    (superTabMergeWait(task, now) ?? Duration.zero) > superTabMergeWarnAfter;

/// The state chips a Board card wears (task #3869), each a colour and its words: green Ready to merge, red CI failing,
/// yellow Needs you. A chip says its state once: the card's quiet line leaves the same words out ([superTabQuietState]).
enum SuperTabStateChip {
  readyToMerge('Ready to merge'),
  ciFailing('CI failing'),
  needsYou('Needs you');

  const SuperTabStateChip(this.label);
  final String label;
}

/// The chips of [entry]'s card, in the order they read.
List<SuperTabStateChip> superTabStateChips(SuperTabTaskEntry entry) {
  final task = entry.task;
  final checks = task == null ? null : _checksOf(task);
  return [
    if (checks == 'red') SuperTabStateChip.ciFailing,
    if (task != null && checks == 'green' && _waitingToMerge(task))
      SuperTabStateChip.readyToMerge,
    if (entry.needsYou) SuperTabStateChip.needsYou,
  ];
}

/// A card's quiet line with what its chips and footer already say left out: the red checks (a chip), the green that leads
/// "green, waiting 12 min" and the pull request (the footer's); null when nothing is left.
String? superTabQuietState(String? state) => switch (state) {
  'CI red' => null,
  // The footer names the pull request.
  final String text when RegExp(r'^PR #\d+$').hasMatch(text) => null,
  final String text when text.startsWith('green, ') => text.substring(7),
  _ => state,
};

/// A task's checks as the server recorded them for the pull requests it still links, the worst first: `red`, then `running`,
/// then `green`; null when it recorded none (an older server, or the watch has not read one).
String? _checksOf(SuperTabConversation task) {
  final states = {
    for (final url in task.pullRequestUrls)
      if (task.pullRequestChecks[url] case final state?
          when const {'red', 'running', 'green'}.contains(state))
        state,
  };
  return const ['red', 'running', 'green'].firstWhereOrNull(states.contains);
}

/// When the next release of any of [parts] may open, as the Merged card says it, in the reader's time: "about 15:30", with
/// "tomorrow" or the date for another day, and "due now" when it may already; null when none of them has a time.
String? _nextRelease(List<String> parts, Map<String, int> times, DateTime now) {
  final known = [for (final part in parts) ?times[part]];
  if (known.isEmpty) return null;
  final first = known.reduce(math.min);
  if (first <= now.millisecondsSinceEpoch) return 'next release due now';
  final at = DateTime.fromMillisecondsSinceEpoch(first);
  String two(int n) => n.toString().padLeft(2, '0');
  final day = DateTime(
    at.year,
    at.month,
    at.day,
  ).difference(DateTime(now.year, now.month, now.day)).inDays;
  final when = switch (day) {
    0 => '',
    1 => ' tomorrow',
    _ => ' ${_months[at.month - 1]} ${at.day}',
  };
  return 'next release about ${two(at.hour)}:${two(at.minute)}$when';
}

String _waited(Duration wait) {
  final (hours, minutes) = (wait.inHours, wait.inMinutes % 60);
  return hours == 0
      ? '$minutes min'
      : minutes == 0
      ? '$hours h'
      : '$hours h $minutes min';
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
  Map<String, int> releaseTimes = const {},
  bool simple = false,
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
  // Where it is, in Working: a wait on review, a person, a machine or a block
  // is a mark on the card, not a column of its own.
  // A Simple project has no review step to wait on (#3897): that mark is plain Doing.
  SuperTabTaskPlace mark(String words) =>
      simple && (words == 'in review' || words == 'changes requested')
      ? at(SuperTabTaskColumn.working)
      : at(SuperTabTaskColumn.working, words);
  // Merged is Shipped only once a release carries it (#3452): until then it
  // waits for one, whatever else the task is (it is often closed already).
  if (!simple && superTabTaskReleasing(task)) {
    final parts = _parts(task.releasing!);
    final next = _nextRelease(task.releasing!, releaseTimes, now);
    return at(
      SuperTabTaskColumn.merged,
      parts.isEmpty
          ? 'waiting for a release'
          : ['waiting for $parts', ?next].join(' · '),
    );
  }
  // Shipped means released; finished with nothing to merge is Done (#2872).
  final merged = task.cards.pullRequests.any((card) => card.merged);
  if (superTabTaskShipped(task)) {
    final shipped = task.shippedAt;
    final old = shipped == null
        ? task.closed
        : now.difference(shipped) > superTabBacklogShippedWindow;
    if (old) return null;
    return merged && !simple
        ? at(
            SuperTabTaskColumn.shipped,
            _versions(task.releasedTags) ?? pullRequest,
          )
        : at(SuperTabTaskColumn.done, simple ? null : 'Done');
  }
  if (task.closed || status == 'cancelled' || status == 'stopped') {
    return null;
  }
  // Simple: its agent marking it done is the end, with no merge or checks to wait on (#3897).
  if (simple && status == 'done') return at(SuperTabTaskColumn.done);
  if (status == 'done') {
    // Red checks put it back in Working: Done is waiting to merge, with the checks green (task #3827).
    final checks = _checksOf(task);
    if (checks == 'red') return mark('CI red');
    final wait = superTabMergeWait(task, now);
    final waited = wait == null ? null : _waited(wait);
    return at(SuperTabTaskColumn.done, switch (checks) {
      'green' =>
        'green, ${waited == null ? 'waiting to merge' : 'waiting $waited'}',
      'running' =>
        'CI running, ${waited == null ? 'waiting to merge' : 'waiting $waited'}',
      _ => waited == null ? 'waiting to merge' : 'waiting to merge for $waited',
    });
  }
  if (assignment == null) {
    final date = task.notBefore;
    return at(
      SuperTabTaskColumn.nextUp,
      date == null ? null : 'not before ${_months[date.month - 1]} ${date.day}',
    );
  }
  return switch ((state, why)) {
    ('waiting', 'starting') => at(SuperTabTaskColumn.working, pullRequest),
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

/// [entry]'s priority: its task's effective one, or its proposal's.
SuperTabTaskPriority superTabEntryPriority(SuperTabTaskEntry entry) =>
    switch (entry.task) {
      final task? => superTabTaskPriority(task),
      null => entry.proposal!.priority,
    };

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
/// column, in order and empty or not, each listing by priority, P0 first
/// (task #3117); within a priority what needs the reader first, then
/// proposals oldest first, Next up in the shared order, Working, Done and
/// Merged newest first, and Shipped by when it shipped, newest first.
Map<SuperTabTaskColumn, List<SuperTabTaskEntry>> superTabTaskBoard(
  Iterable<SuperTabConversation> tasks, {
  Iterable<SuperTabProposal> proposals = const [],
  bool boardMode = false,
  required String readerId,
  required DateTime now,
  int Function(SuperTabConversation task)? mentions,
  int Function(SuperTabConversation task)? needsHuman,
  String? Function(String personId)? personName,
  Map<String, int> releaseTimes = const {},
  bool simple = false,
}) {
  final board = {
    for (final column in SuperTabTaskColumn.values)
      column: <SuperTabTaskEntry>[],
  };
  // A Simple project has no Proposal column: what is proposed waits in To do, never out of sight (#3897).
  final proposed = simple
      ? SuperTabTaskColumn.nextUp
      : SuperTabTaskColumn.proposals;
  board[proposed]!.addAll([
    for (final proposal in [...proposals]..sort((a, b) => a.at.compareTo(b.at)))
      (task: null, proposal: proposal, needsYou: false, state: null),
  ]);
  for (final task in tasks) {
    // On the Board (#3817) a proposal is its own card: in Proposals until the PM makes it a task, and marked when
    // its question waits on the reader. A duplicate merged into another card is not shown.
    final proposal = boardMode ? task.proposal : null;
    final asked = proposal?.openQuestion?.personId == readerId;
    if (proposal != null && proposal.mergedInto != null) continue;
    if (proposal != null && !proposal.becameTask) {
      if (task.closed) continue;
      board[proposed]!.add((
        task: task,
        proposal: null,
        needsYou: asked || (mentions?.call(task) ?? 0) > 0,
        state: null,
      ));
      continue;
    }
    final place = superTabTaskPlaceOf(
      task,
      readerId: readerId,
      now: now,
      mentions: mentions?.call(task) ?? 0,
      // A closed task's agent asks nothing: only open ones are asked.
      needsHuman: task.closed ? 0 : needsHuman?.call(task) ?? 0,
      personName: personName,
      releaseTimes: releaseTimes,
      simple: simple,
    );
    if (place == null) continue;
    board[place.column]!.add((
      task: task,
      proposal: null,
      needsYou: place.needsYou || asked,
      state: place.state,
    ));
  }
  int order(
    SuperTabTaskColumn column,
    SuperTabTaskEntry a,
    SuperTabTaskEntry b,
  ) {
    final priority = superTabEntryPriority(a).index
        .compareTo(superTabEntryPriority(b).index);
    if (priority != 0) return priority;
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
/// Tasks icon. The project's sidebar row counts only its chat's tags (#2927).
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
    boardMode: project.boardMode,
    readerId: c.accountId,
    now: now,
    mentions: (task) => tags.mentionsIn(task.id),
    needsHuman: needsHuman,
    personName: (id) => people[id],
    releaseTimes: c.snapshot?.releaseTimesOf(project.id) ?? const {},
    simple: project.isSimple,
  );
}
