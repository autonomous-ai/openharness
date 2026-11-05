import 'backlog.dart';
import 'model.dart';
import 'task_groups.dart';

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

  /// Whether it holds a task; else it is free for the next one.
  bool get working => inHand.isNotEmpty;
}

/// A task nobody holds, with the lane the server lists it in (null when no
/// lane lists it, or the server sends no lanes).
typedef SuperTabUnassignedEntry = ({SuperTabTaskEntry entry, String? lane});

/// The heading of [agent]'s column: its name, then its lane when it has one.
String superTabMemberHeading(SuperTabAgent agent) =>
    [agent.displayName ?? agent.name, ?agent.crew?.lane].join(' · ');

/// Whether [task]'s work is still on: as the backend's `activeWork`
/// (model.ts), an assignment not done, stopped, cancelled or lost.
bool _active(SuperTabConversation task) {
  final status = task.assignment?['status'];
  return task.assignment != null &&
      !const {'done', 'stopped', 'cancelled', 'lost'}.contains(status);
}

/// Handed over: its own status is review (backend handed.ts); a step's
/// review is not a hand-over.
bool _handed(SuperTabConversation task) =>
    task.reviewOf == null && task.assignment?['status'] == 'review';

/// The Members layout of a project: a column for each crew member of
/// [projectId] among [agents], in roster order, and the open tasks of
/// [entries] (the board's cards, in the board's order) that nobody holds.
///
/// A member's column has what is in its hands (active work it has not
/// handed over), then what it handed over. Unassigned goes in the order the
/// server hands work out: each of [lanes]' first tasks in lane order, then
/// each one's second, and so on; then every task no lane lists, in the
/// board's order.
({List<SuperTabMemberColumn> members, List<SuperTabUnassignedEntry> unassigned})
superTabMemberGroups({
  required Iterable<SuperTabAgent> agents,
  required String projectId,
  required Iterable<SuperTabTaskEntry> entries,
  List<SuperTabLaneCapacity> lanes = const [],
}) {
  final open = [
    for (final entry in entries)
      if (entry.task case final task? when !superTabTaskShipped(task)) entry,
  ];
  String? holder(SuperTabTaskEntry e) =>
      e.task!.assignment?['agentId'] as String?;
  final members = [
    for (final agent in agents)
      if (agent.crew != null && agent.projectId == projectId && !agent.isBuddy)
        SuperTabMemberColumn(
          agent: agent,
          inHand: [
            for (final e in open)
              if (holder(e) == agent.id &&
                  _active(e.task!) &&
                  !_handed(e.task!))
                e,
          ],
          handed: [
            for (final e in open)
              if (holder(e) == agent.id && _handed(e.task!)) e,
          ],
        ),
  ];
  final laneOf = <String, String>{};
  final rank = <String, int>{};
  final longest = lanes.fold(
    0,
    (n, l) => l.taskIds.length > n ? l.taskIds.length : n,
  );
  for (var i = 0; i < longest; i++) {
    for (final lane in lanes) {
      if (i >= lane.taskIds.length) continue;
      final id = lane.taskIds[i];
      if (rank.containsKey(id)) continue;
      rank[id] = rank.length;
      laneOf[id] = lane.lane;
    }
  }
  final nobody = [
    for (final e in open)
      if (!_active(e.task!) && e.task!.assignment?['status'] != 'done') e,
  ];
  final listed = nobody.where((e) => rank.containsKey(e.task!.id)).toList()
    ..sort((a, b) => rank[a.task!.id]!.compareTo(rank[b.task!.id]!));
  return (
    members: members,
    unassigned: [
      for (final e in listed) (entry: e, lane: laneOf[e.task!.id]),
      for (final e in nobody)
        if (!rank.containsKey(e.task!.id)) (entry: e, lane: null),
    ],
  );
}

/// The lanes' capacity as one line: "Desktop: 6 waiting, 2 busy, oldest 2 h",
/// lanes joined by middle dots. The oldest is in whole hours, rounded down,
/// or in minutes under an hour, and left out when nothing waits. Null with no
/// lanes.
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
