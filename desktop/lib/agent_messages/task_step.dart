import 'shared_tabs.dart' show SharedTaskRow;

/// Where a task stands, from its issue, its pull request and whether its
/// assignee is working (Tab Activity's step table).
enum TaskStep {
  merged,
  prClosed,
  merging,
  buildFailed,
  building,
  waitingForReview,
  workingDraft,
  closed,
  working,
  notStarted,
}

TaskStep taskStep(SharedTaskRow row, {required bool assigneeWorking}) {
  final pr = row.pr;
  if (pr != null) {
    if (pr.state == 'Merged') return TaskStep.merged;
    if (pr.state == 'Closed') {
      return row.state == 'open' ? TaskStep.prClosed : TaskStep.closed;
    }
    // Auto-merge only: gh exports no merge-queue field.
    if (pr.autoMerge) return TaskStep.merging;
    if (pr.ci == 'failing') return TaskStep.buildFailed;
    if (pr.ci == 'pending') return TaskStep.building;
    if (pr.state == 'Open') return TaskStep.waitingForReview;
    if (pr.state == 'Draft') return TaskStep.workingDraft;
  }
  if (row.state == 'closed') return TaskStep.closed;
  return assigneeWorking ? TaskStep.working : TaskStep.notStarted;
}

String taskStepLabel(TaskStep step) => switch (step) {
  TaskStep.merged => 'merged',
  TaskStep.prClosed => 'pull request closed',
  TaskStep.merging => 'merging',
  TaskStep.buildFailed => 'build failed',
  TaskStep.building => 'building',
  TaskStep.waitingForReview => 'waiting for review',
  TaskStep.workingDraft => 'working (draft)',
  TaskStep.closed => 'closed',
  TaskStep.working => 'working',
  TaskStep.notStarted => 'not started',
};

/// An account as a task marker's `assignee:<account>/<harness>` names it: the
/// part of the address before its `@` (control and format characters out),
/// other runs of characters outside `[\w.-]` and runs of `-` one `-`, none at
/// either end, at most 64, `account` when nothing is left. The daemon's
/// `markerLabel` (sharedDirectory.ts), so an assignee maps back to a harness.
String markerLabel(String email) {
  final account = _clean(email.replaceFirst(RegExp(r'@[^@]*$'), ''));
  final label = _markerSafe(account.isNotEmpty ? account : _clean(email));
  return label.isEmpty ? 'account' : label;
}

/// A harness as a task marker's `<harness>` names it: [markerLabel]'s rule on
/// its display name, in lower case, `harness` when nothing is left. The
/// daemon's `markerName` (sharedDirectory.ts): the note names each harness by
/// it, since a display name ("Fix login test", "app (1a2b)") is no marker the
/// reader takes (final review I2).
String markerName(String name) {
  final safe = _markerSafe(_clean(name)).toLowerCase();
  return safe.isEmpty ? 'harness' : safe;
}

/// A harness's marker name told apart from another's that makes the same one:
/// `<markerName>-<start of its id>`, the name cut so the whole fits in 64. The
/// daemon's `markerNameWithId` (sharedDirectory.ts): the note gives it where
/// two harnesses of an account collide on [markerName].
String markerNameWithId(String name, String agentId) {
  final id = _clean(agentId);
  var start = _markerSafe(id.substring(0, id.length < 8 ? id.length : 8))
      .toLowerCase();
  if (start.isEmpty) start = 'id';
  var base = markerName(name);
  final room = 63 - start.length;
  if (base.length > room) base = base.substring(0, room);
  return '${base.replaceAll(RegExp(r'-+$'), '')}-$start';
}

/// The one candidate (an index) a marker's `<harness>` names among the harnesses
/// of one account, or null when none, or when it could be more than one: a
/// bare marker name shared by two is no one's, never the first. A candidate
/// has the names it goes by (a display name and a name), and its id.
int? markerMatch(
  String harness,
  List<({List<String> names, String agentId})> all,
) {
  final written = markerName(harness);
  final byId = <int>[], bare = <int>[];
  for (var i = 0; i < all.length; i++) {
    final c = all[i];
    final start = _clean(c.agentId);
    final short = start.isEmpty
        ? '?'
        : start.substring(0, start.length < 8 ? start.length : 8);
    if (c.names.any(
      (n) =>
          written == markerNameWithId(n, c.agentId) ||
          written == markerName('$n ($short)'),
    )) {
      byId.add(i);
    } else if (c.names.any((n) => written == markerName(n))) {
      bare.add(i);
    }
  }
  if (byId.length == 1) return byId.single;
  if (byId.isEmpty && bare.length == 1) return bare.single;
  return null;
}

final _controls = RegExp(r'[\p{Cc}\p{Cf}]', unicode: true);
String _clean(String s) => s.replaceAll(_controls, '');

/// Only `[\w.-]`: other runs, and runs of `-`, one `-`, none at either end, at
/// most 64.
String _markerSafe(String text) {
  var safe = text
      .replaceAll(RegExp(r'[^\w.-]+'), '-')
      .replaceAll(RegExp(r'-{2,}'), '-')
      .replaceAll(RegExp(r'^-+|-+$'), '');
  if (safe.length > 64) safe = safe.substring(0, 64);
  return safe.replaceAll(RegExp(r'-+$'), '');
}
