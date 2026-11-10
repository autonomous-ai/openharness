import '../core/models.dart';
import '../notify/alert_sounds.dart';
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

/// The reader's agents that ask them in a Swarm tab ([superTabAgentsAsking]): what the tab's badge counts.
int tabAgentsAsking(AppNotifier app, Swarm tab) =>
    tab.superTabId == null ? 0 : app.superTabs.agentsAsking(tab.superTabId!);

/// What a Swarm tab's count says: "2 agents ask you".
String tabAgentsAskingLabel(int count) =>
    count == 1 ? '1 agent asks you' : '$count agents ask you';

/// What a Swarm tab's badge says, or null when it counts nothing.
String? tabWaitingLabel(AppNotifier app, Swarm tab) {
  final asking = tabAgentsAsking(app, tab);
  return asking > 0 ? tabAgentsAskingLabel(asking) : null;
}

/// A viewer refers to its owner; showing the same harness twice adds no vote.
/// An agent asking in a Swarm tab needs the person, like a question.
HarnessActivity? tabActivity(AppNotifier app, Swarm tab) {
  if (tab.isStore || tab.isOrchestrator) return null;
  if (tabAgentsAsking(app, tab) > 0) return HarnessActivity.needsInput;
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

/// What needs this account across its Swarm tabs: its agents that ask it, each
/// Swarm once. None from a Swarm it lost, none signed out. The Dock's badge.
int swarmsNeedYou(AppNotifier app) {
  if (app.currentUser == null) return 0;
  var count = 0;
  for (final id in {for (final tab in app.swarms) ?tab.superTabId}) {
    if (app.superTabs.peek(id)?.accessRevoked == true) continue;
    count += app.superTabs.agentsAsking(id);
  }
  return count;
}
