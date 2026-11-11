import 'dart:math';

import '../core/models.dart';
import '../state/app_state.dart';
import '../state/swarm.dart';
import '../state/terminal_pane.dart';
import 'agent_names.dart';
import 'model.dart';

/// The Swarm's ids for the agents whose rows have drawn: a row asks again on every draw, and a desk holds hundreds of panes.
final _swarmIds = <(String, String), String>{};

/// The id the Swarm gives the agent a session on [machineId] becomes when it joins (backend `stableId`, here [stableId]): the
/// pair its join sends. A pane's row wears the face that id draws, so its face is the same before and after it joins.
String swarmAgentId(String machineId, String harnessId) {
  if (_swarmIds.length > 512) _swarmIds.clear();
  return _swarmIds[(machineId, harnessId)] ??= stableId([machineId, harnessId]);
}

/// One pane of the person's own in one of their tabs.
typedef _OwnPane = ({Swarm tab, TerminalPane pane, MachineState machine});

/// The person's own panes, in their tabs in tab order: a Swarm tab's own views, viewers, a computer shared with them and a
/// Harness Team account's are left out. A session two tabs show is two entries ([personalAgents] lists it once).
Iterable<_OwnPane> _ownPanes(AppNotifier app) sync* {
  for (final tab in app.swarms) {
    if (tab.isSuperTab || tab.isUtility) continue;
    for (final pane in tab.panes) {
      if (pane.agentId == null || pane.isViewer) continue;
      final machine = app.stateOf(pane.machineId);
      if (machine == null ||
          machine.belongsToOtherAccount ||
          machine.machine.isTeamAccount) {
        continue;
      }
      yield (tab: tab, pane: pane, machine: machine);
    }
  }
}

/// A pane of the person's own as a row of Your Team in their Personal Swarm (Swarm v4, anh Dee 2026-11-09: every pane they run
/// is an agent there). It is worked out here, on their Desktop, from the panes their tabs hold: nothing is sent until they open
/// it, and then it joins the Swarm as an agent.
class PersonalAgent {
  PersonalAgent._({
    required this.machine,
    required this.agent,
    required this.name,
  });

  final MachineState machine;

  /// What its computer says of the session.
  final Agent agent;

  String get machineId => machine.machine.machineId;

  /// The name it joins under, so the name the row shows is the one it keeps (review of the Personal Swarm, 2026-11-11):
  /// its pane's, or the folder it works in while that is still "Untitled Pane", so two sessions of one repo read as what
  /// they work on. One the Swarm or an earlier row already has, or none, gives way to one of the Swarm's names
  /// ([_swarmName]).
  final String name;

  /// What its pane shows of it, or null when that names nothing.
  static String? _shownName(Agent agent) {
    final shown = agent.displayName.trim();
    final folder = shown == kUntitledPane
        ? agent.displayProject?.label.trim()
        : null;
    final name = folder == null || folder.isEmpty ? shown : folder;
    return name.isEmpty || name == kUntitledPane ? null : name;
  }

  /// One of the Swarm's names that [taken] has not, the same one on every draw and every computer: picked by the id the
  /// session gets once it joins.
  static String _swarmName(String swarmId, Iterable<String> taken) =>
      freshAgentName(
        taken,
        Random(int.parse(swarmId.substring(0, 8), radix: 16)),
      );

  String get computer => machine.machine.displayName;

  /// Where it runs, and that its computer is asleep or off when it is.
  String get place => machine.isOffline ? '$computer · offline' : computer;

  /// What it is once it joins ([swarmAgentId]).
  String get swarmId => swarmAgentId(machineId, agent.id);
}

/// The panes of the person's own that are agents of their Swarm [snapshot] but not in it yet, by name: a Claude Code or Codex
/// session that runs ([kSwarmEngines]) on one of their own computers, each once whatever tabs hold it, under a name no
/// other agent of the Swarm or row has. One they took out of the Swarm is left out ([SuperTabSnapshot.removedPanes]).
List<PersonalAgent> personalAgents(AppNotifier app, SuperTabSnapshot snapshot) {
  final joined = {
    for (final agent in snapshot.agents)
      (machineIdKey(agent.machineId), agent.harnessId),
    ...snapshot.removedPanes,
  };
  final taken = {
    for (final agent in snapshot.agents)
      (agent.displayName ?? agent.name).toLowerCase(),
  };
  final seen = <(String, String)>{};
  final sessions = <(MachineState, Agent)>[];
  // Each computer's sessions by id, worked out once for the pass: a desk holds hundreds of panes.
  final byId = <String, Map<String, Agent>>{};
  for (final entry in _ownPanes(app)) {
    final harnessId = entry.pane.agentId!;
    final key = (machineIdKey(entry.pane.machineId), harnessId);
    if (joined.contains(key) || !seen.add(key)) continue;
    final agent = (byId[entry.pane.machineId] ??= {
      for (final agent in entry.machine.agents) agent.id: agent,
    })[harnessId];
    if (agent == null ||
        !kSwarmEngines.contains(agent.engine) ||
        agent.isStopped ||
        !agent.terminalAvailable) {
      continue;
    }
    sessions.add((entry.machine, agent));
  }
  // Names its own first, in a fixed order, so which of two "api" rows keeps it is the same on every draw.
  sessions.sort((a, b) {
    final byName = (_order(a.$2)).compareTo(_order(b.$2));
    return byName != 0
        ? byName
        : swarmAgentId(
            a.$1.machine.machineId,
            a.$2.id,
          ).compareTo(swarmAgentId(b.$1.machine.machineId, b.$2.id));
  });
  final rows = <PersonalAgent>[];
  for (final (machine, agent) in sessions) {
    final shown = PersonalAgent._shownName(agent);
    final name = shown != null && !taken.contains(shown.toLowerCase())
        ? shown
        : PersonalAgent._swarmName(
            swarmAgentId(machine.machine.machineId, agent.id),
            taken,
          );
    taken.add(name.toLowerCase());
    rows.add(PersonalAgent._(machine: machine, agent: agent, name: name));
  }
  return rows..sort((a, b) {
    final byName = a.name.toLowerCase().compareTo(b.name.toLowerCase());
    return byName != 0 ? byName : a.swarmId.compareTo(b.swarmId);
  });
}

String _order(Agent agent) =>
    (PersonalAgent._shownName(agent) ?? '').toLowerCase();
