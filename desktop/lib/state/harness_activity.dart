import '../core/models.dart';
import '../notify/alert_sounds.dart';
import '../super_tabs/pm_chat.dart' show pmUnreadLabel;
import '../widgets/engine_identity.dart' show isTerminalEngine;
import 'app_state.dart';
import 'swarm.dart';

/// The TUI's states, ordered by a tab's most urgent member. Activity is
/// separate from unread results: a new turn always looks busy, not finished.
enum HarnessActivity {
  needsInput('?', 'Needs your input'),
  failed('✗', 'Failed'),
  done('✓', 'Finished · unread'),
  working('⠋', 'Working'),
  starting('◌', 'Starting'),
  unknown('◌', 'Status unavailable'),
  idle('', 'Idle'),
  paused('■', 'Stopped'),
  offline('⊘', 'Offline');

  const HarnessActivity(this.mark, this.label);
  final String mark;
  final String label;
}

/// The same status vocabulary for native tabs and the menu bar overview.
/// Callers supply the pane's theme color, including the monochrome preference.
Map<String, Object> nativeActivityPayload(
  HarnessActivity activity, {
  int? color,
}) => {
  'mark': activity.mark,
  'label': activity.label,
  'working': activity == HarnessActivity.working,
  'color': ?color,
};

const activitySpinnerFrames = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
];
const activityFrameInterval = Duration(milliseconds: 100);

int activityFrameAt(DateTime time) =>
    (time.millisecondsSinceEpoch ~/ activityFrameInterval.inMilliseconds) %
    activitySpinnerFrames.length;

HarnessActivity? harnessActivity(
  AppNotifier app,
  String machineId,
  String agentId,
) {
  final machine = app.stateOf(machineId);
  final agent = machine?.agents.where((a) => a.id == agentId).firstOrNull;
  // A shell or an unknown roster entry has no agent activity to report.
  if (machine == null || agent == null || isTerminalEngine(agent.engine)) {
    return null;
  }
  if (machine.isOffline ||
      machine.needsLink ||
      (!machine.machine.isShared &&
          machine.connectionStatus != ConnectionStatus.connected)) {
    return HarnessActivity.offline;
  }
  if (agent.isStopped) return HarnessActivity.paused;
  if (agent.launchState == 'starting' || agent.launchState == 'held') {
    return HarnessActivity.starting;
  }
  if (agent.launchState == 'failed') {
    return agent.launchError == 'RESUME_UNCONFIRMED'
        ? HarnessActivity.needsInput
        : HarnessActivity.failed;
  }
  if (machine.blockedAgents.containsKey(agentId)) {
    return HarnessActivity.needsInput;
  }
  if (machine.processingAgentIds.contains(agentId)) {
    return HarnessActivity.working;
  }
  if (machine.failedTurnAgents.contains(agentId)) return HarnessActivity.failed;
  if (app.agentUnread.kindFor(machineId, agentId) == AlertKind.done) {
    return HarnessActivity.done;
  }
  if (machine.unknownActivityAgentIds.contains(agentId)) {
    return HarnessActivity.unknown;
  }
  return HarnessActivity.idle;
}

/// The tags waiting for this account in a Swarm tab, for the tab's badge.
int tabMentionsWaiting(AppNotifier app, Swarm tab) =>
    tab.superTabId == null ? 0 : app.superTabs.waitingTags(tab.superTabId!);

/// What a Swarm tab's tag count says: "Tagged in 2 messages".
String tabMentionsLabel(int count) =>
    'Tagged in $count ${count == 1 ? 'message' : 'messages'}';

/// The unread messages in this account's own PM chats in a Swarm tab.
int tabPmWaiting(AppNotifier app, Swarm tab) =>
    tab.superTabId == null ? 0 : app.superTabs.waitingPm(tab.superTabId!);

/// What a Swarm tab's badge counts: its tags and its unread PM messages.
int tabWaiting(AppNotifier app, Swarm tab) =>
    tabMentionsWaiting(app, tab) + tabPmWaiting(app, tab);

/// What a Swarm tab's badge says, or null when it counts nothing:
/// "Tagged in 1 message · 2 new in Chat with PM".
String? tabWaitingLabel(AppNotifier app, Swarm tab) {
  final tags = tabMentionsWaiting(app, tab), pm = tabPmWaiting(app, tab);
  final parts = [
    if (tags > 0) tabMentionsLabel(tags),
    if (pm > 0) pmUnreadLabel(pm),
  ];
  return parts.isEmpty ? null : parts.join(' · ');
}

/// A viewer refers to its owner; showing the same harness twice adds no vote.
/// A Lead's tag waiting in a Swarm tab needs the person, like a question.
HarnessActivity? tabActivity(AppNotifier app, Swarm tab) {
  if (tab.isStore || tab.isOrchestrator) return null;
  if (tabMentionsWaiting(app, tab) > 0) return HarnessActivity.needsInput;
  HarnessActivity? result;
  final seen = <(String, String)>{};
  for (final pane in tab.panes) {
    final id = pane.isViewer ? pane.ownerAgentId : pane.agentId;
    if (id == null || !seen.add((pane.machineId, id))) continue;
    final state = harnessActivity(app, pane.machineId, id);
    if (state != null && (result == null || state.index < result.index)) {
      result = state;
    }
  }
  return result;
}

/// What needs this account across its Swarm tabs: the tags and open decisions
/// the Swarm counts for it alone, each Swarm once. None from a Swarm it lost,
/// none signed out. The Dock's badge, and what the Swarm's sidebar row counted.
int swarmsNeedYou(AppNotifier app) {
  if (app.currentUser == null) return 0;
  var count = 0;
  for (final id in {for (final tab in app.swarms) ?tab.superTabId}) {
    if (app.superTabs.peek(id)?.accessRevoked == true) continue;
    count += app.superTabs.waitingTags(id) + app.superTabs.waitingDecisions(id);
  }
  return count;
}
