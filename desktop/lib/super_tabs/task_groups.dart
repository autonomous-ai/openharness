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
