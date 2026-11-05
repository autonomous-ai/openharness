import 'backlog.dart';
import 'model.dart';
import 'task_groups.dart';

/// How many tasks a crew member may have handed over and still take the next
/// (backend dispatch.ts `DISPATCH_RULES.maxHanded`).
const superTabMaxHanded = 3;

/// Where a crew member stands: a task in its hands, as many handed over as
/// it may have, or free for the next one.
enum SuperTabMemberState {
  working('Working'),
  full('Full'),
  free('Free');

  const SuperTabMemberState(this.label);
  final String label;
}

/// One crew member's column in the Tasks view's Members layout (task #3400):
/// the tasks in its hands, and those it handed over for review.
class SuperTabMemberColumn {
  const SuperTabMemberColumn({
    required this.agent,
    required this.inHand,
    required this.handed,
  });
  final SuperTabAgent agent;
  final List<SuperTabTaskEntry> inHand, handed;

  /// Read from all its tasks: what a search or Mine hides still counts.
  SuperTabMemberState get state => inHand.isNotEmpty
      ? SuperTabMemberState.working
      : handed.length >= superTabMaxHanded
      ? SuperTabMemberState.full
      : SuperTabMemberState.free;
}

/// A task nobody holds, with the lane the Swarm hands it out in (null when
/// no lane owns it, or the server is one from before hand-out lanes).
typedef SuperTabUnassignedEntry = ({SuperTabTaskEntry entry, String? lane});

/// The heading of [agent]'s column: its name, then its lane when it has one.
String superTabMemberHeading(SuperTabAgent agent) =>
    [agent.displayName ?? agent.name, ?agent.crew?.lane].join(' · ');

/// Work on [task] that is still on (backend model.ts `activeWork`).
bool _active(SuperTabConversation task) => const {
  'working',
  'needs_human',
  'blocked',
  'review',
  'planned',
  'reconciling',
}.contains(task.assignment?['status']);

/// Handed over: its own status is review (backend handed.ts); a step's
/// review is not a hand-over.
bool _handed(SuperTabConversation task) =>
    task.reviewOf == null && task.assignment?['status'] == 'review';

/// Nobody holds it and it is not finished: no active work, and not done or
/// cancelled.
bool _unheld(SuperTabConversation task) =>
    !_active(task) &&
    !const {'done', 'cancelled'}.contains(task.assignment?['status']);

/// The Members layout of a project: a column for each crew member of
/// [projectId] among [agents], in roster order, and the open tasks of
/// [entries] (the board's cards, unfiltered) that nobody holds.
///
/// A member's column has what is in its hands (active work it has not
/// handed over), then what it handed over. Unassigned goes in the Swarm's
/// hand-out order (backend dispatch.ts `openTasks`): P0 first, then the
/// project's shared queue; each with its hand-out lane.
({List<SuperTabMemberColumn> members, List<SuperTabUnassignedEntry> unassigned})
superTabMemberGroups({
  required Iterable<SuperTabAgent> agents,
  required String projectId,
  required Iterable<SuperTabTaskEntry> entries,
}) {
  final open = {
    for (final entry in entries)
      if (entry.task case final task? when !superTabTaskShipped(task))
        task.id: entry,
  };
  final tasks = [for (final e in open.values) e.task!];
  final members = [
    for (final agent in agents)
      if (agent.crew != null && agent.projectId == projectId && !agent.isBuddy)
        SuperTabMemberColumn(
          agent: agent,
          inHand: [
            for (final t in tasks)
              if (t.assignment?['agentId'] == agent.id &&
                  _active(t) &&
                  !_handed(t))
                open[t.id]!,
          ],
          handed: [
            for (final t in tasks)
              if (t.assignment?['agentId'] == agent.id && _handed(t))
                open[t.id]!,
          ],
        ),
  ];
  final queue = superTabQueueOrder(tasks.where(_unheld));
  return (
    members: members,
    unassigned: [
      for (final t in [
        ...queue.where((t) => t.priority == 'P0'),
        ...queue.where((t) => t.priority != 'P0'),
      ])
        (entry: open[t.id]!, lane: t.handOutLane),
    ],
  );
}

/// The lanes in the dispatch table's order (backend dispatch.ts
/// `DISPATCH_RULES.lanes`).
const _laneOrder = ['backend', 'CLI', 'Desktop', 'mobile', 'docs'];

/// One lane of a crew project, worked out from its tasks: those waiting for
/// a member, those in hand, and when the oldest waiting one began waiting.
class SuperTabLaneCapacity {
  const SuperTabLaneCapacity({
    required this.lane,
    required this.waiting,
    required this.busy,
    required this.oldestAt,
  });
  final String lane;
  final int waiting, busy;
  final DateTime? oldestAt;
}

/// When [task] began waiting with nobody holding it: when it was orphaned,
/// else when its last attempt was lost (backend dispatch.ts `waitingSince`).
DateTime? _waitingSince(SuperTabConversation task) {
  final liveness = task.liveness;
  final lost = task.assignment?['lost'];
  final since = liveness?['state'] == 'orphaned'
      ? liveness!['since']
      : lost is Map
      ? lost['at']
      : null;
  return since is num
      ? DateTime.fromMillisecondsSinceEpoch(since.toInt())
      : null;
}

/// [tasks]' lanes at [now], as the dispatch counts them (backend dispatch.ts
/// `laneCapacity`), from each task's hand-out lane: waiting, a task not
/// archived, nobody holding it, not done or cancelled, whose not-before day
/// has come (the local date); busy, one with active work. The oldest is the
/// earliest a waiting task began waiting. Lanes in the table's order, only
/// those with work; none from a server before hand-out lanes. Every task the
/// app holds counts, so one changed task moves the line.
List<SuperTabLaneCapacity> superTabLaneCapacity(
  Iterable<SuperTabConversation> tasks,
  DateTime now,
) {
  final today = DateTime(now.year, now.month, now.day);
  final waiting = <String, int>{}, busy = <String, int>{};
  final oldest = <String, DateTime>{};
  for (final task in tasks) {
    final lane = task.handOutLane;
    if (lane == null || task.archived) continue;
    if (_active(task)) {
      busy[lane] = (busy[lane] ?? 0) + 1;
      continue;
    }
    if (!_unheld(task)) continue;
    if (task.notBefore case final day? when day.isAfter(today)) continue;
    waiting[lane] = (waiting[lane] ?? 0) + 1;
    final since = _waitingSince(task);
    final held = oldest[lane];
    if (since != null && (held == null || since.isBefore(held))) {
      oldest[lane] = since;
    }
  }
  int rank(String lane) => switch (_laneOrder.indexOf(lane)) {
    -1 => _laneOrder.length,
    final i => i,
  };
  final lanes = [
    ...{...waiting.keys, ...busy.keys},
  ]..sort((a, b) => rank(a) - rank(b));
  return [
    for (final lane in lanes)
      SuperTabLaneCapacity(
        lane: lane,
        waiting: waiting[lane] ?? 0,
        busy: busy[lane] ?? 0,
        oldestAt: oldest[lane],
      ),
  ];
}

/// The lanes' capacity as one line: "Desktop: 6 waiting, 2 busy, oldest 2 h",
/// lanes joined by middle dots. The oldest is in whole hours, rounded down,
/// or in minutes under an hour, and left out when none was recorded. Null
/// with no lanes.
String? superTabCapacityLine(List<SuperTabLaneCapacity> lanes, DateTime now) {
  if (lanes.isEmpty) return null;
  String oldest(DateTime at) {
    final age = now.difference(at);
    if (age.isNegative) return 'oldest 0 min';
    return age.inHours >= 1
        ? 'oldest ${age.inHours} h'
        : 'oldest ${age.inMinutes} min';
  }

  return [
    for (final lane in lanes)
      [
        '${lane.lane}: ${lane.waiting} waiting',
        '${lane.busy} busy',
        if (lane.oldestAt case final at?) oldest(at),
      ].join(', '),
  ].join(' · ');
}
