import '../core/models.dart';
import '../core/runtime_model_name.dart';
import '../shared/theme/prompt_style.dart';
import '../shared/theme/status_line_style.dart';
import '../widgets/engine_identity.dart';
import 'app_state.dart';
import 'swarm.dart';
import 'terminal_pane.dart';

/// A tab's type describes its harness panes. Viewers never cast a second vote
/// for their owner. Ties follow pane order, independently of keyboard focus.
String tabHarnessType(AppNotifier app, Swarm tab) {
  if (tab.isStore) return 'store';
  if (tab.isCompanions) return 'companions';
  if (tab.isDevices) return 'devices';
  if (tab.isOrchestrator) return 'orchestrator';
  final counts = <String, int>{};
  for (final pane in tab.panes) {
    if (pane.isWeb || pane.agentId == null) continue;
    final agent = _agentFor(app, pane.machineId, pane.agentId);
    final engine = agent?.identityEngine ?? pane.session?.engineId;
    if (engine == null || engine.isEmpty) continue;
    final identity = engineIdentity(engine);
    final type = identity.category == 'Code' && !isHarnessId(engine)
        ? 'code'
        : identity.id.split('/').last;
    counts.update(type, (count) => count + 1, ifAbsent: () => 1);
  }
  var winner = 'new';
  var largest = 0;
  for (final entry in counts.entries) {
    if (entry.value > largest) {
      winner = entry.key;
      largest = entry.value;
    }
  }
  return winner;
}

enum _TabTrait { type, project, machine }

typedef _TabName = ({_TabTrait trait, String label, int count});

/// Prefer the strongest shared trait, then the one least repeated in other
/// tabs. Type wins otherwise equal choices; focus and custom names never vote.
Map<String, String> workspaceTabNames(AppNotifier app) {
  final candidates = <String, List<_TabName>>{};
  for (final tab in app.swarms) {
    if (tab.nameIsCustom) {
      candidates[tab.id] = [];
      continue;
    }
    final counts = <_TabTrait, Map<String, int>>{
      for (final trait in _TabTrait.values) trait: {},
    };
    final seen = <(String, String)>{};
    void vote(_TabTrait trait, String? label) {
      if (label == null || label.isEmpty) return;
      counts[trait]!.update(label, (n) => n + 1, ifAbsent: () => 1);
    }

    for (final pane in tab.panes) {
      final id = pane.agentId;
      if (pane.isWeb || id == null || !seen.add((pane.machineId, id))) continue;
      final machine = app.stateOf(pane.machineId);
      final agent = _agentFor(app, pane.machineId, id);
      final engine = agent?.identityEngine ?? pane.session?.engineId;
      if (engine != null && engine.isNotEmpty) {
        final identity = engineIdentity(engine);
        vote(
          _TabTrait.type,
          identity.category == 'Code' && !isHarnessId(engine)
              ? 'code'
              : identity.id.split('/').last,
        );
      }
      vote(
        _TabTrait.project,
        agent == null ? null : machine?.projectOf(agent)?.label,
      );
      vote(_TabTrait.machine, machine?.machine.displayName ?? pane.machineId);
    }
    candidates[tab.id] = [
      for (final trait in _TabTrait.values)
        if (counts[trait]!.isNotEmpty)
          (() {
            final winner = counts[trait]!.entries.reduce(
              (a, b) => b.value > a.value ? b : a,
            );
            return (trait: trait, label: winner.key, count: winner.value);
          })(),
    ];
  }
  int repetitions(_TabName name) => candidates.values
      .where(
        (choices) => choices.any(
          (other) => other.trait == name.trait && other.label == name.label,
        ),
      )
      .length;
  return {
    for (final tab in app.swarms)
      tab.id: tab.nameIsCustom
          ? tab.name
          : tab.isStore
          ? 'store'
          : tab.isCompanions
          ? 'companions'
          : tab.isDevices
          ? Swarm.devicesName
          : tab.isOrchestrator
          ? 'orchestrator'
          : candidates[tab.id]!.isEmpty
          ? Swarm.defaultName
          : candidates[tab.id]!.reduce((a, b) {
              if (b.count != a.count) return b.count > a.count ? b : a;
              return repetitions(b) < repetitions(a) ? b : a;
            }).label,
  };
}

Agent? _agentFor(AppNotifier app, String machineId, String? agentId) => app
    .stateOf(machineId)
    ?.agents
    .where((agent) => agent.id == agentId)
    .firstOrNull;

/// The focused viewer reports its owner's context, just like its terminal.
class WorkspacePaneContext {
  const WorkspacePaneContext({
    required this.pane,
    required this.machineName,
    required this.provider,
    required this.location,
    required this.detail,
    this.projectName = '',
    this.agent,
    this.branch,
    this.project,
  });

  final TerminalPane pane;
  final Agent? agent;
  final AgentProject? project;
  final String machineName, provider, location, detail;
  final String projectName;
  final String? branch;
  String? get agentId => pane.isViewer ? pane.ownerAgentId : pane.agentId;
  String? get engine => agent?.engine ?? pane.session?.engineId;
  String get modelLabel => modelLabelWithEffort(
    provider,
    agent?.gridModel == null && agent?.modelName != null
        ? agent?.modelEffort
        : null,
  );
  String get suffix => branch == null ? '' : '  ($branch)';
  String get text => '$location$suffix';
  StatusLineParts format(PromptPrefs prefs) {
    final note =
        prefs.branch &&
            agent?.gitContext != null &&
            project?.shownBranch == null
        ? branch
        : null;
    final parts = statusLineParts(
      provider: '',
      machine: prefs.machine ? machineName : '',
      project: prefs.project ? projectName : '',
      branch: prefs.branch && note == null ? branch : null,
      style: prefs.statusStyle,
      separateMachine: true,
    );
    if (note == null) return parts;
    return StatusLineParts(parts.style, [
      ...parts.segments,
      if (!parts.style.segmented && parts.segments.isNotEmpty)
        const StatusLineSegment('  '),
      StatusLineSegment(
        note,
        foreground: StatusLineTone.muted,
        background: parts.style.segmented ? StatusLineTone.black : null,
        field: StatusLineField.branch,
      ),
    ]);
  }

  static WorkspacePaneContext? focused(AppNotifier app) {
    final pane = app.focusedPane;
    if (pane == null) return null;
    final machine = app.stateOf(pane.machineId);
    final agentId = pane.isViewer ? pane.ownerAgentId : pane.agentId;
    final agent = _agentFor(app, pane.machineId, agentId);
    final project = agent == null ? null : machine?.projectOf(agent);
    final machineName = machine?.machine.displayName ?? pane.machineId;
    final engine = agent?.engine ?? pane.session?.engineId;
    final provider =
        agent?.gridModel ??
        agent?.modelName ??
        switch (engine) {
          'codex' => 'OpenAI',
          'claude' => 'Anthropic',
          'terminal' || null => '',
          _ => engineIdentity(engine).label,
        };
    final projectName = project?.label ?? '';
    final branch = agent?.gitContext?.branchLabel ?? project?.shownBranch;
    return WorkspacePaneContext(
      pane: pane,
      agent: agent,
      project: project,
      machineName: machineName,
      provider: provider,
      projectName: projectName,
      location: '$machineName${projectName.isEmpty ? '' : ':$projectName'}',
      branch: branch,
      detail: [
        if (agent != null) agent.displayName,
        if (provider.isNotEmpty) provider,
        machineName,
        if (project != null) 'Project: ${project.label}',
        if (agent?.gitContext case final git?) git.explanation,
      ].join('\n'),
    );
  }
}
