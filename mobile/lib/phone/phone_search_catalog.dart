import 'package:collection/collection.dart' show compareNatural;
import 'package:flutter/foundation.dart' show listEquals;

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

import 'agent_index.dart';
import 'phone_destination.dart';
import 'phone_prompt_context.dart';
import 'phone_status.dart';

String phoneAgentId(String machineId, String agentId) =>
    'agent:$machineId\u0000$agentId';

/// One catalog, rebuilt only when the fleet actually changes shape.
///
/// The desktop's `SwarmSearchCatalog`, and it exists for the reason its comment
/// gives: terminal output leaves these normalized snapshots intact, and only
/// discovery, membership or metadata rebuilds them.
///
/// ⚠️ **A turn event must not re-normalize the account.** Building the catalog
/// lowercases eleven strings per agent, and on a busy fleet the notifier ticks
/// several times a second — so the uncached version spent a phone's battery
/// re-deriving a list that had not changed a character.
///
/// What it deliberately does NOT key on: `agentActivityAt`, `processingAgentIds`
/// and `blockedAgents`, all of which move constantly. Rows read those live off
/// the [MachineState] they hold, so `working` and `4m` stay current without the
/// catalog being rebuilt — and the ranking no longer depends on them at all.
class PhoneSearchCatalogCache {
  List<Object?>? _presentation;
  List<PhoneDestination> _entries = const [];

  List<PhoneDestination> read(AppNotifier notifier) {
    final presentation = _presentationOf(notifier);
    if (listEquals(_presentation, presentation)) return _entries;
    _presentation = presentation;
    return _entries = List.unmodifiable(phoneSearchCatalog(notifier));
  }

  static List<Object?> _presentationOf(AppNotifier notifier) => [
    for (final machine in notifier.machines) machine,
    for (final machine in notifier.machineStates.values) ...[
      machine.machine,
      machine.nodeOnline,
      machine.needsLink,
      machine.connectionStatus,
      machine.agentLoadStatus,
      // The list's identity, not its contents: `_replaceAgents` hands over a
      // new list whenever anything about the agents changed, and nothing else
      // reassigns it.
      machine.agents,
      machine.agents.length,
    ],
  ];
}

/// Everything one query can reach: every agent, every machine, every project.
///
/// The phone's `SwarmSearchCatalog.read`, ported from the desktop so the same
/// words reach the same rows on both. Agents come first and in [recentAgents]
/// order, which is what an empty query offers before ranking has anything to
/// go on.
///
/// ⚠️ **Machines and projects are rows here, but only `@` and `#` list them.**
/// The desktop keeps them in its catalog the same way and shows them under the
/// same two prefixes — its plain query is agents only (see
/// `PhoneSearchController._filter`). They still earn their place here twice
/// over: the two prefixes read them, and building the project groups is what
/// makes a project's name searchable on the agents inside it.
List<PhoneDestination> phoneSearchCatalog(AppNotifier notifier) {
  final entries = recentAgents(agentIndex(notifier));
  final agents = [
    for (final entry in entries)
      _agent(
        notifier,
        entry,
        engineIdentity(
          entry.agent.engine,
          displayName: entry.agent.engineDisplayName,
        ).label,
      ),
  ];
  final byId = {for (final row in agents) row.id: row};
  return [
    ...agents,
    ..._machines(notifier, byId),
    ..._projects(entries, byId),
  ];
}

PhoneDestination _agent(
  AppNotifier notifier,
  AgentEntry entry,
  String label,
) {
  final agent = entry.agent;
  final project = entry.project;
  final offline = entry.machine.nodeOnline == false;
  // The desktop's name for it ([Agent.displayName]); the CLI's own stays
  // searchable beside it, so typing what the terminal's title bar says still
  // finds the row.
  final renamed = agent.displayName != agent.name;
  final detail = _harnessDetail(
    label,
    project,
    entry.machineName,
    offline,
    agentLabel: label,
  );
  return PhoneDestination(
    id: phoneAgentId(entry.machineId, agent.id),
    kind: PhoneDestinationKind.agent,
    title: agent.displayName,
    detail: detail.text,
    detailBranchOffset: detail.branchOffset,
    promptContext: PhonePromptContext(
      harness: label,
      machine: entry.machineName,
      // The FOLDER, not the project's reported name — the desktop's picker
      // shows `Desktop` and `autonomous-harness`, which is the tail of the path
      // somebody actually recognises, and a phone has no width for the rest.
      project: project?.folder,
      branch: project?.branchLabel,
      leading: offline ? 'Offline' : null,
    ),
    machineId: entry.machineId,
    machineLabel: entry.machineName,
    agentId: agent.id,
    engine: agent.engine,
    previewKey: notifier.previewKey(entry.machineId, agent),
    entry: entry,
    // The agent's own title is ranked like its name (see [titleFields]):
    // "board fab check" finds the agent whose work that is, never the one
    // whose folder or recap happens to mention fab.
    searchFields: [
      agent.title,
      if (renamed) agent.name,
      label,
      entry.machineName,
      project?.name,
      project?.branchLabel,
      project?.cwd,
      agent.engine,
      // Neither is drawn, but "the llama one" or "the model manager" is how
      // somebody away from their desk remembers an agent called `harness-3`.
      agent.gridModel,
      agent.selectedModel,
      agent.dshName,
    ],
    titleFields: 1 + (agent.title == null ? 0 : 1) + (renamed ? 1 : 0),
  );
}

/// One row per machine on the account, whether or not it is answering.
///
/// Every machine, unlike [agentIndex], which lists only the ones that can hand
/// over an agent: a machine that is off or locked is exactly the thing somebody
/// searches for when its agents are missing, and the row says which it is.
List<PhoneDestination> _machines(
  AppNotifier notifier,
  Map<String, PhoneDestination> agents,
) {
  final members = <String, Set<String>>{};
  for (final row in agents.values) {
    (members[row.machineId!] ??= {}).add(row.id);
  }
  return [
    for (final machine in notifier.machines)
      if (notifier.stateOf(machine.machineId) case final state?)
        PhoneDestination(
          id: 'machine:${machine.machineId}',
          kind: PhoneDestinationKind.machine,
          title: state.machine.displayName,
          detail: [
            'Machine',
            _countLabel(members[machine.machineId]?.length ?? 0, 'harness'),
            switch (phoneMachineStatusOf(state)) {
              PhoneMachineStatus.needsPassword => 'Link required',
              PhoneMachineStatus.offline => 'Offline',
              PhoneMachineStatus.connecting => 'Connecting',
              PhoneMachineStatus.ready => null,
            },
          ].whereType<String>().join(' · '),
          machineId: machine.machineId,
          machineLabel: state.machine.displayName,
          machine: state,
          members: Set.unmodifiable(
            members[machine.machineId] ?? const <String>{},
          ),
        ),
  ];
}

/// One row per repository or folder, agents grouped by [AgentProject.identity].
///
/// The same identity rule the desktop uses: checkouts group across machines
/// only when the daemon reports the same canonical remote. Two same-named
/// folders never become one project on a name alone.
///
/// Also makes each project's name searchable on its agents, so `#harness` and a
/// plain `harness` reach the same rows.
List<PhoneDestination> _projects(
  List<AgentEntry> entries,
  Map<String, PhoneDestination> agents,
) {
  final groups = <String, List<AgentEntry>>{};
  for (final entry in entries) {
    final project = entry.project;
    if (project == null) continue;
    (groups[project.identity(entry.machineId)] ??= []).add(entry);
  }
  final rows = <PhoneDestination>[];
  for (final MapEntry(key: id, value: members) in groups.entries) {
    final name = members.first.project!.name;
    final ids = {
      for (final entry in members)
        if (agents.containsKey(phoneAgentId(entry.machineId, entry.agent.id)))
          phoneAgentId(entry.machineId, entry.agent.id),
    };
    rows.add(
      PhoneDestination(
        id: 'project:$id',
        kind: PhoneDestinationKind.project,
        projectId: id,
        title: name,
        detail: 'Project · ${_countLabel(ids.length, 'harness')}',
        machineId: members.first.machineId,
        machineLabel: members.first.machineName,
        members: Set.unmodifiable(ids),
        searchFields: {
          for (final entry in members) ...[
            entry.machineName,
            entry.project?.cwd,
            entry.project?.branchLabel,
          ],
        },
      ),
    );
  }
  rows.sort(
    (a, b) => compareNatural(a.title.toLowerCase(), b.title.toLowerCase()),
  );
  return rows;
}

/// The metadata line, in the desktop's own order and with its branch offset.
///
/// The engine's label stands in for the desktop's harness *category*, which the
/// phone's [engineIdentity] does not carry — "Claude" where the desktop says
/// "Coding agent". Same slot, same ranking, one word the person recognises.
({String text, int? branchOffset}) _harnessDetail(
  String? type,
  AgentProject? project,
  String machine,
  bool offline, {
  required String agentLabel,
}) {
  final prefix = [
    type,
    project?.name,
  ].whereType<String>().where((part) => part.isNotEmpty).join(' · ');
  final branch = project?.branchLabel;
  return (
    text: [
      prefix,
      branch,
      machine,
      if (offline) 'Offline',
    ].whereType<String>().where((part) => part.isNotEmpty).join(' · '),
    branchOffset: branch != null && branch.isNotEmpty
        ? (prefix.isNotEmpty ? prefix.length + 3 : 0)
        : null,
  );
}

String _countLabel(int count, String noun) {
  final plural = noun == 'harness' ? 'harnesses' : '${noun}s';
  return '$count ${count == 1 ? noun : plural}';
}
