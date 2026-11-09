import '../core/models.dart';
import '../state/app_state.dart';
import '../state/swarm.dart';
import '../state/terminal_pane.dart';
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
typedef OwnPane = ({Swarm tab, TerminalPane pane, MachineState machine});

/// The person's own panes, in their tabs in tab order: a Swarm tab's own views, viewers, a computer shared with them and a
/// Harness Team account's are left out. A session two tabs show is two entries ([personalAgents] lists it once).
Iterable<OwnPane> ownPanes(AppNotifier app) sync* {
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
  PersonalAgent({required this.machine, required this.agent})
    : name = _nameOf(agent);

  final MachineState machine;

  /// What its computer says of the session.
  final Agent agent;

  String get machineId => machine.machine.machineId;

  /// The name its pane shows, or the folder it works in while that is still "Untitled Pane": two sessions of one repo read as
  /// what they work on.
  final String name;

  static String _nameOf(Agent agent) {
    final shown = agent.displayName;
    final folder = shown == kUntitledPane
        ? agent.displayProject?.label.trim()
        : null;
    return folder == null || folder.isEmpty ? shown : folder;
  }

  String get computer => machine.machine.displayName;

  /// Where it runs, and that its computer is asleep or off when it is.
  String get place => machine.isOffline ? '$computer · offline' : computer;

  /// What it is once it joins ([swarmAgentId]).
  late final String swarmId = swarmAgentId(machineId, agent.id);

  late final String _order = name.toLowerCase();
}

/// The panes of the person's own that are agents of their Swarm [snapshot] but not in it yet, by name: a Claude Code or Codex
/// session that runs ([kSwarmEngines]) on one of their own computers, each once whatever tabs hold it.
List<PersonalAgent> personalAgents(AppNotifier app, SuperTabSnapshot snapshot) {
  final joined = {
    for (final agent in snapshot.agents)
      (machineIdKey(agent.machineId), agent.harnessId),
  };
  final seen = <(String, String)>{};
  // Each computer's sessions by id, worked out once for the pass: a desk holds hundreds of panes.
  final sessions = <String, Map<String, Agent>>{};
  final rows = <PersonalAgent>[];
  for (final entry in ownPanes(app)) {
    final harnessId = entry.pane.agentId!;
    final key = (machineIdKey(entry.pane.machineId), harnessId);
    if (joined.contains(key) || !seen.add(key)) continue;
    final agent = (sessions[entry.pane.machineId] ??= {
      for (final agent in entry.machine.agents) agent.id: agent,
    })[harnessId];
    if (agent == null ||
        !kSwarmEngines.contains(agent.engine) ||
        agent.isStopped ||
        !agent.terminalAvailable) {
      continue;
    }
    rows.add(PersonalAgent(machine: entry.machine, agent: agent));
  }
  return rows..sort((a, b) {
    final byName = a._order.compareTo(b._order);
    return byName != 0 ? byName : a.swarmId.compareTo(b.swarmId);
  });
}
