import '../notify/alert_sounds.dart';
import 'app_state.dart';
import 'harness_activity.dart';
import 'harness_sessions.dart';

/// A current question or an unread result, using the existing alert ledger.
class InboxNotification {
  const InboxNotification({
    required this.machineId,
    required this.agentId,
    required this.title,
    required this.detail,
    required this.kind,
    required this.unavailable,
  });

  final String machineId, agentId, title, detail;
  final AlertKind kind;
  final String? unavailable;
  String get id => '$machineId/$agentId';
  String get label => switch (kind) {
    AlertKind.needsYou => 'Needs input',
    AlertKind.failed => 'Failed',
    AlertKind.done => 'Finished',
  };
  HarnessActivity get activity => switch (kind) {
    AlertKind.needsYou => HarnessActivity.needsInput,
    AlertKind.failed => HarnessActivity.failed,
    AlertKind.done => HarnessActivity.done,
  };
}

List<InboxNotification> notificationInbox(AppNotifier app) {
  final kinds = <(String, String), AlertKind>{
    for (final item in app.agentUnread.newestFirst)
      (item.machineId, item.agentId): item.kind,
  };
  // Questions survive a reconnect and remain actionable even if an old unread
  // mark was evicted. Merely opening this list never acknowledges a question.
  for (final row in harnessSessions(app)) {
    if (row.needsInput &&
        !app.questionNotificationRead(row.machineId, row.agent.id)) {
      kinds[(row.machineId, row.agent.id)] = AlertKind.needsYou;
    }
  }
  return [
    for (final entry in kinds.entries)
      ?_notification(app, entry.key.$1, entry.key.$2, entry.value),
  ];
}

InboxNotification? _notification(
  AppNotifier app,
  String machineId,
  String agentId,
  AlertKind kind,
) {
  final machine = app.stateOf(machineId);
  final agent = machine?.agents.where((a) => a.id == agentId).firstOrNull;
  final question = app.questionFor(machineId, agentId);
  // A question that closed is no longer a notification to answer.
  if (kind == AlertKind.needsYou && question == null) return null;
  final current = question != null ? AlertKind.needsYou : kind;
  final project = agent == null ? null : machine?.projectOf(agent);
  final branch = agent?.gitContext?.branchLabel ?? project?.shownBranch;
  return InboxNotification(
    machineId: machineId,
    agentId: agentId,
    title: agent?.displayName ?? 'Unavailable harness',
    detail: [
      machine?.machine.displayName ?? 'Unavailable machine',
      if (project?.label case final name? when name.isNotEmpty) name,
      if (branch != null && branch.isNotEmpty) branch,
    ].join('  '),
    kind: current,
    unavailable: harnessSessionUnavailable(machine, agent),
  );
}
