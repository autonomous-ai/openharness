import '../notify/alert_sounds.dart';
import 'app_state.dart';
import 'harness_activity.dart';
import 'harness_sessions.dart';
import 'notification_inbox.dart';
import 'session_preview.dart';
import 'swarm.dart';
import 'workspace_status.dart';

/// One notification section, questions first and newest first within each kind.
/// Receipts travel with each row so a menu left open cannot clear newer news.
List<Map<String, Object?>> statusMenuEntries(
  AppNotifier app, {
  int Function(HarnessActivity)? colorForActivity,
}) {
  final notifications = notificationInbox(app);
  if (notifications.isEmpty) return [];
  final names = workspaceTabNames(app);
  final owners = _owners(app);
  final rows = [
    for (final notification in notifications)
      {
        ..._entry(app, notification, colorForActivity),
        ..._location(
          app,
          notification.machineId,
          notification.agentId,
          owners,
          names,
        ),
      },
  ];
  final positions = {for (final (index, row) in rows.indexed) row: index};
  rows.sort((a, b) {
    final priority = (a['priority'] as int).compareTo(b['priority'] as int);
    if (priority != 0) return priority;
    final time = (b['receivedAt'] as int? ?? 0).compareTo(
      a['receivedAt'] as int? ?? 0,
    );
    return time != 0 ? time : positions[a]!.compareTo(positions[b]!);
  });
  return rows;
}

/// The same live activity as the tabs. Idle shells and waiting questions are
/// not working. A session with unread news gets its one row above instead.
List<Map<String, Object?>> statusMenuWorkingEntries(
  AppNotifier app, {
  int Function(HarnessActivity)? colorForActivity,
}) {
  final names = workspaceTabNames(app);
  final owners = _owners(app);
  final unread = notificationInbox(app).map((row) => row.id).toSet();
  return [
    for (final session in harnessSessions(app))
      // Most rows are saved or idle. Only a processing ID can be working;
      // avoid searching the roster again for every historical conversation.
      if (session.working &&
          !unread.contains('${session.machineId}/${session.agent.id}') &&
          harnessActivity(app, session.machineId, session.agent.id) ==
              HarnessActivity.working)
        {
          'machineId': session.machineId,
          'agentId': session.agent.id,
          'sessionId': session.agent.sessionId,
          'title': session.agent.displayName,
          'unread': false,
          'label': 'Working',
          'activity': nativeActivityPayload(
            HarnessActivity.working,
            color: colorForActivity?.call(HarnessActivity.working),
          ),
          'startedAt': app
              .agentWorkingSince(session.machineId, session.agent.id)
              ?.millisecondsSinceEpoch,
          'unavailable': harnessSessionUnavailable(
            session.machine,
            session.agent,
          ),
          ..._location(app, session.machineId, session.agent.id, owners, names),
          'readToken': app.agentUnread.readTokenFor(
            session.machineId,
            session.agent.id,
          ),
          'questionId': app
              .questionFor(session.machineId, session.agent.id)
              ?.requestId,
        },
  ];
}

Map<(String, String), Swarm> _owners(AppNotifier app) {
  final owners = <(String, String), Swarm>{};
  // A shared session counts once. Prefer its active tab, otherwise the first
  // tab containing it. Include tabs hidden by the machine profile, too.
  for (final tab in app.swarms) {
    for (final pane in tab.panes) {
      if (pane.agentId == null) continue;
      final key = (pane.machineId, pane.agentId!);
      if (!owners.containsKey(key) || tab.id == app.activeSwarmId) {
        owners[key] = tab;
      }
    }
  }
  return owners;
}

Map<String, Object?> _location(
  AppNotifier app,
  String machineId,
  String agentId,
  Map<(String, String), Swarm> owners,
  Map<String, String> names,
) {
  final tab = owners[(machineId, agentId)];
  return {
    'tabId': tab?.id,
    'tabName': tab == null ? 'Other sessions' : names[tab.id],
    'machineName':
        app.stateOf(machineId)?.machine.displayName ?? 'Unavailable machine',
  };
}

Map<String, Object?> _entry(
  AppNotifier app,
  InboxNotification notification,
  int Function(HarnessActivity)? colorForActivity,
) {
  final machineId = notification.machineId;
  final agentId = notification.agentId;
  final question = app.questionFor(machineId, agentId);
  return {
    'machineId': machineId,
    'agentId': agentId,
    'title': notification.title,
    'detail': notification.detail,
    'unavailable': notification.unavailable,
    'unread': true,
    'activity': nativeActivityPayload(
      notification.activity,
      color: colorForActivity?.call(notification.activity),
    ),
    'label': notification.kind == AlertKind.done
        ? 'Ready for review'
        : notification.label,
    'priority': notification.kind == AlertKind.needsYou
        ? 0
        : notification.kind == AlertKind.failed
        ? 1
        : 2,
    'message': statusMenuMessage(
      question?.prompt ?? app.agentUnread.messageFor(machineId, agentId),
    ),
    'receivedAt':
        (question?.since ?? app.agentUnread.receivedAtFor(machineId, agentId))
            ?.millisecondsSinceEpoch,
    'readToken': app.agentUnread.readTokenFor(machineId, agentId),
    'questionId': question?.requestId,
  };
}

/// A plain-text excerpt, never rendered markdown or terminal control bytes.
String? statusMenuMessage(Object? value) => previewText(value, limit: 600)
    ?.replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^\)]+\)'), (match) => match[1]!)
    .replaceAll(RegExp(r'(^|\n)\s{0,3}(#{1,6}\s+|[-*]\s+|>\s*)'), ' ')
    .replaceAllMapped(RegExp(r'(\*\*|__)([^\n]+?)\1'), (match) => match[2]!)
    .replaceAll(RegExp(r'`'), '')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim();

bool statusMenuReceiptIsCurrent(AppNotifier app, Map receipt) {
  final machineId = receipt['machineId'], agentId = receipt['agentId'];
  return machineId is String &&
      agentId is String &&
      receipt['readToken'] ==
          app.agentUnread.readTokenFor(machineId, agentId) &&
      receipt['questionId'] == app.questionFor(machineId, agentId)?.requestId;
}

/// Dismiss the exact opening snapshot when Mark all read was selected.
/// A pending question remains pending; a newer notification remains unread.
void clearStatusMenuNotifications(AppNotifier app, List receipts) {
  for (final receipt in receipts.whereType<Map>()) {
    if (receipt['unread'] != true ||
        !statusMenuReceiptIsCurrent(app, receipt)) {
      continue;
    }
    app.readAgentNotification(
      receipt['machineId'] as String,
      receipt['agentId'] as String,
      readToken: receipt['readToken'] as String?,
    );
  }
}
