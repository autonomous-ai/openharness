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
    required this.swarmId,
  });

  final MachineState machine;

  /// What its computer says of the session.
  final Agent agent;

  String get machineId => machine.machine.machineId;

  /// The name it joins under, so the name the row shows is the one it keeps (review of the Personal Swarm, 2026-11-11):
  /// [swarmJoinName].
  final String name;

  String get computer => machine.machine.displayName;

  /// Where it runs, and that its computer is asleep or off when it is.
  String get place => machine.isOffline ? '$computer · offline' : computer;

  /// What it is once it joins ([swarmAgentId]).
  final String swarmId;
}

/// The names [snapshot] gives someone already, lower case, as the server refuses an agent's name for (backend
/// agentRename.ts `checkedAgentName`): its agents', its people's names, usernames and emails, the person's own agent chats'.
Set<String> swarmTakenNames(SuperTabSnapshot snapshot) => {
  for (final agent in snapshot.agents)
    (agent.displayName ?? agent.name).toLowerCase(),
  for (final person in snapshot.people) ...[
    ?person.name?.toLowerCase(),
    person.username.toLowerCase(),
    person.email.toLowerCase(),
  ],
  for (final chat in snapshot.conversations)
    if (chat.kind == 'agent-chat') chat.title.toLowerCase(),
};

/// What a session's pane shows of it as an agent's name: its name, or the folder it works in while it is still "Untitled
/// Pane", so two sessions of one repo read as what they work on. Null for none, or one the server would refuse as an agent's
/// (backend agentRename.ts: over 60 characters, an engine's or a role's name, a web address).
String? paneAgentName(Agent agent) {
  final shown = agent.displayName.trim();
  final folder = shown == kUntitledPane
      ? agent.displayProject?.label.trim()
      : null;
  final name = (folder == null || folder.isEmpty ? shown : folder).replaceAll(
    RegExp(r'\s+'),
    ' ',
  );
  if (name.isEmpty ||
      name == kUntitledPane ||
      name.runes.length > 60 ||
      _notAName.hasMatch(name) ||
      name.contains('://') ||
      name.toLowerCase().startsWith('www.')) {
    return null;
  }
  return name;
}

/// An engine's or a role's name, which names no agent (backend agentNames.ts `isEngineName`, `isRoleName`, reviewer).
final _notAName = RegExp(
  r'^(?:claude(?: code)?|codex|opencode|pi|(?:lead|builder|agent|new agent|product manager|engineer|pm|dev|reviewer)'
  r'(?:[\s#-]+\d+)?)$',
  caseSensitive: false,
);

/// The name a session joins a Swarm under, whose [taken] names ([swarmTakenNames]) it must not have: [paneAgentName], else
/// one of the Swarm's names from a start fixed by [seed] (the id it gets in the Swarm), stepping past those taken, as the
/// backend's `freeAgentName` does, so it moves only when its own name is taken.
String swarmJoinName(Agent agent, String seed, Set<String> taken) {
  final own = paneAgentName(agent);
  if (own != null && !taken.contains(own.toLowerCase())) return own;
  var hash = 0;
  for (final unit in seed.codeUnits) {
    hash = (hash * 31 + unit) & 0x7fffffff;
  }
  final count = agentNames.length;
  for (var i = 0; i < count; i++) {
    final name = agentNames[(hash + i) % count];
    if (!taken.contains(name.toLowerCase())) return name;
  }
  final first = agentNames[hash % count];
  for (var number = 2; ; number++) {
    if (!taken.contains('$first $number'.toLowerCase()))
      return '$first $number';
  }
}

/// The panes of the person's own that are agents of their Swarm [snapshot] but not in it yet, by name: a Claude Code or Codex
/// session that runs ([kSwarmEngines]) on one of their own computers, each once whatever tabs hold it, under a name nobody
/// in the Swarm and no other row has ([swarmJoinName]). One they took out of the Swarm is left out
/// ([SuperTabSnapshot.removedPanes]).
List<PersonalAgent> personalAgents(AppNotifier app, SuperTabSnapshot snapshot) {
  final joined = {
    for (final agent in snapshot.agents)
      (machineIdKey(agent.machineId), agent.harnessId),
    ...snapshot.removedPanes,
  };
  final seen = <(String, String)>{};
  final sessions =
      <({MachineState machine, Agent agent, String? own, String id})>[];
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
    sessions.add((
      machine: entry.machine,
      agent: agent,
      own: paneAgentName(agent)?.toLowerCase(),
      id: swarmAgentId(entry.machine.machine.machineId, agent.id),
    ));
  }
  // Those with a name of their own claim it first, in a fixed order, so which of two "api" rows keeps it is the same on every
  // draw; the rest then take the Swarm's names.
  sessions.sort((a, b) {
    if ((a.own == null) != (b.own == null)) return a.own == null ? 1 : -1;
    final byName = (a.own ?? '').compareTo(b.own ?? '');
    return byName != 0 ? byName : a.id.compareTo(b.id);
  });
  final taken = swarmTakenNames(snapshot);
  final rows = <PersonalAgent>[];
  for (final session in sessions) {
    final name = swarmJoinName(session.agent, session.id, taken);
    taken.add(name.toLowerCase());
    rows.add(
      PersonalAgent._(
        machine: session.machine,
        agent: session.agent,
        name: name,
        swarmId: session.id,
      ),
    );
  }
  return rows..sort((a, b) {
    final byName = a.name.toLowerCase().compareTo(b.name.toLowerCase());
    return byName != 0 ? byName : a.swarmId.compareTo(b.swarmId);
  });
}
