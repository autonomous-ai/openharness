import 'dart:convert';

import 'package:cryptography/dart.dart' show DartSha256;

import '../core/models.dart';
import '../state/app_state.dart';
import '../state/swarm.dart';
import '../state/terminal_pane.dart';
import 'model.dart';

/// The id the Swarm gives the agent a session on [machineId] becomes when it joins: the first 24 hex digits of the SHA-256 of
/// the pair as JSON (backend superTabs/model.ts `stableId`). A pane's row wears the face that id draws, so its face is the
/// same before and after it joins.
String swarmAgentId(String machineId, String harnessId) => const DartSha256()
    .hashSync(utf8.encode(jsonEncode([machineId, harnessId])))
    .bytes
    .map((b) => b.toRadixString(16).padLeft(2, '0'))
    .join()
    .substring(0, 24);

/// A pane of the person's own as a row of Your Team in their Personal Swarm (Swarm v4, anh Dee 2026-11-09: every pane they run
/// is an agent there). It is worked out here, on their Desktop, from the panes their tabs hold: nothing is sent until they open
/// it, and then it joins the Swarm as an agent.
class PersonalAgent {
  PersonalAgent({
    required this.tab,
    required this.pane,
    required this.machine,
    required this.agent,
  }) : name = agent.displayName;

  /// The tab it is first in.
  final Swarm tab;
  final TerminalPane pane;
  final MachineState machine;

  /// What its computer says of the session.
  final Agent agent;

  String get machineId => machine.machine.machineId;

  /// The name where its person already sees it, in the pane's header.
  final String name;

  String get computer => machine.machine.displayName;

  /// Where it runs, and that its computer is asleep or off when it is.
  String get place => machine.isOffline ? '$computer · offline' : computer;

  /// What it is once it joins ([swarmAgentId]).
  late final String swarmId = swarmAgentId(machineId, agent.id);

  late final String _order = name.toLowerCase();
}

/// The panes of the person's own that are agents of their Swarm [snapshot] but not in it yet, by name: a Claude Code or Codex
/// session that runs (the Swarm takes no other) on one of their own computers, each once whatever tabs hold it. A Swarm tab's
/// own views, viewers, a computer shared with them and a Harness Team account's are left out.
List<PersonalAgent> personalAgents(AppNotifier app, SuperTabSnapshot snapshot) {
  final joined = {
    for (final agent in snapshot.agents)
      (machineIdKey(agent.machineId), agent.harnessId),
  };
  final seen = <(String, String)>{};
  // Each computer's sessions by id, worked out once for the pass: a desk holds hundreds of panes.
  final sessions = <String, Map<String, Agent>>{};
  final rows = <PersonalAgent>[];
  for (final tab in app.swarms) {
    if (tab.isSuperTab || tab.isUtility) continue;
    for (final pane in tab.panes) {
      final harnessId = pane.agentId;
      if (harnessId == null || pane.isViewer) continue;
      final machine = app.stateOf(pane.machineId);
      if (machine == null ||
          machine.belongsToOtherAccount ||
          machine.machine.isTeamAccount) {
        continue;
      }
      final key = (machineIdKey(pane.machineId), harnessId);
      if (joined.contains(key) || !seen.add(key)) continue;
      final agent = (sessions[pane.machineId] ??= {
        for (final agent in machine.agents) agent.id: agent,
      })[harnessId];
      if (agent == null ||
          (agent.engine != 'claude' && agent.engine != 'codex') ||
          agent.isStopped ||
          !agent.terminalAvailable) {
        continue;
      }
      rows.add(
        PersonalAgent(tab: tab, pane: pane, machine: machine, agent: agent),
      );
    }
  }
  return rows..sort((a, b) {
    final byName = a._order.compareTo(b._order);
    return byName != 0 ? byName : a.swarmId.compareTo(b.swarmId);
  });
}
