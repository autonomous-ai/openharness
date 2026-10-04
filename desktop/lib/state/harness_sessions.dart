import 'package:collection/collection.dart' show compareNatural;

import '../core/models.dart';
import '../core/relative_time.dart';
import 'app_state.dart';
import 'pending_question.dart';
import 'swarm_navigation.dart';

enum SessionFilter { all, needsInput, running, paused }

enum SessionSort {
  recent('Recently active'),
  name('Name'),
  machine('Machine'),
  project('Project'),
  memory('RAM: highest first'),
  cpu('CPU: highest first');

  const SessionSort(this.label);
  final String label;
}

/// Why a session cannot be reached now, even when a saved pane still exists.
/// Paused sessions that the machine can resume remain valid destinations.
String? harnessSessionUnavailable(MachineState? machine, Agent? agent) {
  if (machine == null) return 'Unavailable';
  if (machine.isOffline) return 'Offline';
  if (machine.needsLink) return 'Link required';
  if (!machine.machine.isShared &&
      machine.connectionStatus != ConnectionStatus.connected) {
    return 'Not connected';
  }
  if (agent == null) return 'Unavailable';
  if (agent.terminalAvailable ||
      (agent.isStopped &&
          agent.canPauseAndResume &&
          !machine.machine.isShared)) {
    return null;
  }
  return switch (agent.launchState) {
    'starting' => 'Starting',
    'failed' => 'Start failed',
    _ => 'Unavailable',
  };
}

/// A session appears once, however many tabs or viewers show it.
class HarnessSession {
  const HarnessSession({
    required this.machine,
    required this.agent,
    required this.open,
    required this.working,
    this.question,
  });

  final MachineState machine;
  final Agent agent;
  final bool open, working;
  final PendingQuestion? question;
  bool get needsInput => question != null && !agent.isStopped;

  /// Conversation activity, independent of opening or focusing the session.
  DateTime? get lastActivityAt => agent.lastActivityAt;
  String get machineId => machine.machine.machineId;
  String get id => agentDestinationId(machineId, agent.id);
  AgentProject? get project => machine.projectOf(agent);
  bool get online =>
      machine.nodeOnline != false &&
      !machine.needsLink &&
      (machine.machine.isShared ||
          machine.connectionStatus == ConnectionStatus.connected) &&
      (!machine.isLocalMachine || machine.usesLocalTransport);
  bool get running => online && !agent.isStopped && agent.terminalAvailable;
  bool get live =>
      running ||
      (online && !agent.isStopped && agent.launchState == 'starting');
  bool get canOpen =>
      open ||
      (online &&
          (agent.terminalAvailable ||
              (agent.isStopped &&
                  agent.canPauseAndResume &&
                  !machine.machine.isShared)));
  bool get canControl =>
      online &&
      !machine.machine.isShared &&
      agent.canPauseAndResume &&
      (agent.isStopped || agent.terminalAvailable) &&
      agent.launchState != 'starting';
  String get status => !online
      ? 'Offline'
      : machine.machine.isShared
      ? 'View only'
      : agent.isStopped
      ? (agent.canPauseAndResume ? 'Saved' : 'Open unavailable')
      : agent.launchState == 'failed'
      ? 'Start failed'
      : agent.launchState == 'starting'
      ? 'Starting'
      : needsInput
      ? 'Needs input'
      : agent.closePlanState == 'failed'
      ? 'Could not close'
      : agent.closePlanState == 'waiting'
      ? 'Stops after finishing'
      : working
      ? 'Working'
      : agent.terminalAvailable
      ? 'Ready'
      : 'Unavailable';
  String? get controlUnavailable => !online
      ? 'Reconnect ${machine.machine.displayName} to control this harness.'
      : machine.machine.isShared
      ? 'Shared harnesses are view-only.'
      // Only reachable against a daemon too old to report what its engines can
      // resume; a current one offers Stop for every harness it runs.
      : !agent.canPauseAndResume
      ? (agent.engine == 'claude' || agent.engine == 'codex'
            ? 'Waiting for a saved conversation before enabling Stop and Open.'
            : 'Update the harness CLI on this machine to stop and reopen this agent.')
      : !canControl
      ? agent.launchDetail ??
            agent.terminalUnavailableReason ??
            'This harness is not ready yet.'
      : null;
}

List<HarnessSession> harnessSessions(
  AppNotifier app, {
  bool includeLive = false,
}) {
  final open = {
    for (final pane in app.allPanes)
      if (pane.agentId != null) (pane.machineId, pane.agentId),
  };
  bool known(String machine, String agent) =>
      open.contains((machine, agent)) || app.hasOpenedHarness(machine, agent);
  return [
    for (final machine in app.machineStates.values)
      for (final agent in machine.agents)
        if (known(machine.machine.machineId, agent.id) ||
            (includeLive &&
                !machine.machine.isShared &&
                !agent.isStopped &&
                (agent.terminalAvailable || agent.launchState == 'starting')))
          HarnessSession(
            machine: machine,
            agent: agent,
            open: open.contains((machine.machine.machineId, agent.id)),
            working: machine.processingAgentIds.contains(agent.id),
            question: machine.blockedAgents[agent.id],
          ),
    // Keep a real pending question visible while its roster entry is missing.
    // It must never become an invented terminal or a target for Pause.
    for (final machine in app.machineStates.values)
      for (final question in machine.blockedAgents.values)
        if (known(machine.machine.machineId, question.agentId) &&
            !machine.agents.any((agent) => agent.id == question.agentId))
          HarnessSession(
            machine: machine,
            agent: Agent(id: question.agentId, name: 'Unavailable harness'),
            open: open.contains((machine.machine.machineId, question.agentId)),
            working: false,
            question: question,
          ),
  ];
}

List<HarnessSession> visibleHarnessSessions(
  List<HarnessSession> sessions, {
  String query = '',
  SessionFilter filter = SessionFilter.all,
  SessionSort sort = SessionSort.recent,
  List<String> recent = const [],
  Map<String, double> memory = const {},
  Map<String, double> cpu = const {},
}) {
  final terms = query.toLowerCase().trim().split(RegExp(r'\s+'));
  final result = sessions.where((row) {
    if (filter == SessionFilter.running && !row.running) return false;
    if (filter == SessionFilter.needsInput && !row.needsInput) return false;
    if (filter == SessionFilter.paused && !row.agent.isStopped) return false;
    final text = [
      row.agent.displayName,
      row.agent.name,
      row.agent.title,
      row.agent.identityEngine,
      row.machine.machine.displayName,
      row.project?.name,
      row.project?.label,
      row.project?.cwd,
      row.project?.branch,
      row.status,
      row.question?.prompt,
    ].whereType<String>().join(' ').toLowerCase();
    return terms.every(text.contains);
  }).toList();
  final ranks = {for (var i = 0; i < recent.length; i++) recent[i]: i};
  result.sort((a, b) {
    final comparison = switch (sort) {
      SessionSort.recent => _byActivity(a, b, ranks, recent.length),
      SessionSort.name => compareNatural(
        a.agent.displayName.toLowerCase(),
        b.agent.displayName.toLowerCase(),
      ),
      SessionSort.machine => compareNatural(
        a.machine.machine.displayName.toLowerCase(),
        b.machine.machine.displayName.toLowerCase(),
      ),
      SessionSort.project => compareNatural(
        (a.project?.label ?? '').toLowerCase(),
        (b.project?.label ?? '').toLowerCase(),
      ),
      SessionSort.memory => (memory[b.id] ?? -1).compareTo(memory[a.id] ?? -1),
      SessionSort.cpu => (cpu[b.id] ?? -1).compareTo(cpu[a.id] ?? -1),
    };
    if (comparison != 0) return comparison;
    final name = compareNatural(
      a.agent.displayName.toLowerCase(),
      b.agent.displayName.toLowerCase(),
    );
    return name == 0 ? a.id.compareTo(b.id) : name;
  });
  return result;
}

/// Most recently active first — the same global order as Open Harness — then
/// this window's own visit order for ties and harnesses with no time at all.
int _byActivity(
  HarnessSession a,
  HarnessSession b,
  Map<String, int> ranks,
  int fallback,
) {
  final used = (b.lastActivityAt?.millisecondsSinceEpoch ?? 0).compareTo(
    a.lastActivityAt?.millisecondsSinceEpoch ?? 0,
  );
  return used != 0
      ? used
      : (ranks[a.id] ?? fallback).compareTo(ranks[b.id] ?? fallback);
}

/// Compact elapsed activity, including old-daemon and clock-skew fallbacks.
String harnessActivityAge(DateTime? activity, DateTime now) {
  if (activity == null) return '—';
  final elapsed = now.difference(activity);
  if (elapsed.inMinutes < 1) return 'now';
  if (elapsed.inDays >= 1) return '${elapsed.inDays}d';
  if (elapsed.inHours >= 1) return '${elapsed.inHours}h';
  return '${elapsed.inMinutes.clamp(0, 59)}m';
}

String harnessActivityTooltip(DateTime activity) =>
    'Last active ${fullDateTime(activity)}';
