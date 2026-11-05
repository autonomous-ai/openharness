import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../core/models.dart';
import '../core/project_folder.dart';
import '../phone/agent_index.dart';
import '../phone/agents_list_page.dart';
import '../phone/phone_navigation.dart';
import '../phone/phone_status.dart';
import '../phone/welcome/your_computer.dart';
import '../state/app_state.dart';
import 'swarm_agents.dart';
import 'swarm_chat_agents.dart';
import 'swarm_lead_start.dart';
import 'swarm_request.dart';
import 'swarm_start.dart';

/// The account's computers for Swarm's start screens, from the app's own
/// machine list: each one's name, and whether it is away for real
/// ([phoneMachineAway]) — the socket down and the account's list agreeing.
///
/// Tells only when that changes, or one more computer's socket is up (what
/// a Swarm read waiting for a computer needs, `SwarmInbox.computerUp`) — not
/// at every change of the app's state, which moves with every frame a
/// terminal sends.
///
/// It also lists the sessions running on them, for Add agent ([running]).
class AppSwarmComputers extends ChangeNotifier
    implements
        SwarmComputers,
        SwarmAgentsSource,
        SwarmRunningSessions,
        SwarmLeadComputers {
  AppSwarmComputers(this.notifier) {
    notifier.addListener(_changed);
    _changed();
  }

  final AppNotifier notifier;

  List<SwarmComputer>? _computers;
  List<SwarmOwnComputer> _own = const [];
  bool _rechecking = false;

  /// How many computers' sockets are up.
  int _up = 0;

  @override
  List<SwarmComputer>? get computers => _computers;

  @override
  bool get rechecking => _rechecking;

  void _changed() {
    final computers = notifier.machinesAnswered
        ? List<SwarmComputer>.unmodifiable([
            for (final machine in notifier.machineStates.values)
              (
                name: machine.machine.displayName,
                away: phoneMachineAway(machine),
              ),
          ])
        : null;
    final own = List<SwarmOwnComputer>.unmodifiable([
      if (notifier.machinesAnswered)
        for (final machine in notifier.machineStates.values)
          if (!machine.machine.shared &&
              machine.machine.sessionKind != 'team' &&
              !machine.needsLink)
            (
              id: machine.machine.machineId,
              name: machine.machine.displayName,
              away: phoneMachineAway(machine),
            ),
    ]);
    final rechecking = notifier.machinesRefreshing;
    final up = notifier.machineStates.values
        .where((m) => m.connectionStatus == ConnectionStatus.connected)
        .length;
    final cameUp = up > _up;
    _up = up;
    // A computer shared, become a Team account or waiting for a link changes
    // the person's own without changing a name or whether one is away.
    if (!cameUp &&
        listEquals(computers, _computers) &&
        listEquals(own, _own) &&
        rechecking == _rechecking) {
      return;
    }
    _computers = computers;
    _own = own;
    _rechecking = rechecking;
    notifyListeners();
  }

  /// The person's own connected computers a Personal project's Lead starts
  /// on (task #2941), as Desktop's card lists them (personal_lead.dart
  /// `machinesFor`): never shared, a Harness Team account or one waiting for
  /// a link. Each with Claude Code then Codex where installed (or installable)
  /// and not signed out; a list not read yet asks the computer and offers
  /// Claude Code meanwhile, as Desktop does. And each repo its agents work
  /// in, by remote, with the checkout's folder.
  @override
  List<SwarmLeadComputer> get leadComputers => [
    for (final machine in notifier.machineStates.values)
      if (!machine.machine.shared &&
          machine.machine.sessionKind != 'team' &&
          !machine.needsLink &&
          machine.connectionStatus == ConnectionStatus.connected)
        (
          id: machine.machine.machineId,
          name: machine.machine.displayName,
          engines: _leadEngines(machine),
          folders: {
            for (final agent in machine.agents)
              if (agent.project case final project?)
                ?swarmNormalizedRemote(project.remote):
                    project.root ?? project.cwd,
          },
        ),
  ];

  /// The computers whose engines the card asked for: once each, as a computer
  /// that cannot answer stays unread and would be asked at every draw.
  final _probed = <String>{};
  bool _disposed = false;

  List<String> _leadEngines(MachineState machine) {
    final engines = machine.engines;
    if (!engines.loaded) {
      if (_probed.add(machine.machine.machineId)) {
        unawaited(
          notifier.probeEngines(machine.machine.machineId).then((_) {
            if (!_disposed) notifyListeners();
          }),
        );
      }
      return const ['claude'];
    }
    return [
      for (final engine in const ['claude', 'codex'])
        if (engines[engine] case final known?
            when (known.installed || known.installable) &&
                known.signedIn != false)
          engine,
    ];
  }

  /// Starts the Lead on [machineId] as Desktop's card does (personal_lead.dart
  /// `_launch`): approving everything, as a Swarm agent, with the Lead's
  /// prompt and Claude's Lead model, in the repo's folder or a new one named
  /// after the project.
  @override
  Future<SwarmLeadStarted> startLead(
    String machineId,
    SwarmLeadLaunch launch,
  ) async {
    final attempt = AgentCreationAttempt();
    final failure = await notifier.createAgent(
      machineId,
      engine: launch.engine,
      folder: launch.folder,
      projectFolder: launch.folder == null
          ? ProjectFolderRequest.forTask(launch.projectName)
          : null,
      permissionMode: 'full',
      prompt: launch.prompt,
      swarmRole: 'lead',
      swarmSkillMode: launch.skillMode,
      launchModel: launch.engine == 'claude'
          ? (model: 'opus', effort: 'xhigh')
          : null,
      attempt: attempt,
    );
    if (failure != null) throw SuperTabFailure('CREATE_FAILED', failure);
    final harnessId = attempt.agentId;
    if (harnessId == null) {
      throw const SuperTabFailure(
        'CREATE_FAILED',
        'the computer didn’t say which harness it started',
      );
    }
    final project = notifier
        .stateOf(machineId)
        ?.agents
        .where((a) => a.id == harnessId)
        .firstOrNull
        ?.project;
    return (
      harnessId: harnessId,
      cwd: project == null ? launch.folder : project.root ?? project.cwd,
      remote: project?.remote,
    );
  }

  /// The account's own computers, as the Buddy picker lists them: never one
  /// shared with this person, nor a Harness Team account, nor one waiting for
  /// a link. Told of like [computers].
  @override
  List<SwarmOwnComputer> get own => _own;

  @override
  Future<Map<String, dynamic>> ask(
    String machineId,
    Map<String, dynamic> payload,
  ) => notifier.swarmAskComputer(machineId, payload);

  /// What runs on the computers now ([swarmRunningSessions]), read when
  /// asked: told of by nothing here, since it moves with the app's state.
  @override
  List<SwarmRunningSession> get running =>
      swarmRunningSessions(notifier.machineStates.values);

  /// The machines tab's Try again: the account's list read again.
  @override
  Future<void> recheck() => notifier.retryMachines();

  /// The machines tab's Add computer (`welcome/your_computer.dart`).
  @override
  void add(BuildContext context) => unawaited(
    Navigator.of(context)
        .push(phoneRoute((_) => YourComputerPage(notifier: notifier))),
  );

  /// The harnesses on them, told of on their own: a change there is no
  /// computer coming or going for Swarm's reads.
  @override
  late final AppSwarmAgents agents = AppSwarmAgents(notifier);

  @override
  void dispose() {
    _disposed = true;
    notifier.removeListener(_changed);
    agents.dispose();
    super.dispose();
  }
}

/// The app's harnesses for Swarm ([SwarmAgents]), from [agentIndex]: told of
/// when how many work or wait — Search's dots — or the list itself, changes.
class AppSwarmAgents extends ChangeNotifier implements SwarmAgents {
  AppSwarmAgents(this.notifier) {
    notifier.addListener(_changed);
    _changed();
  }

  final AppNotifier notifier;
  int? _working, _waiting;
  List<AgentEntry>? _index;

  @override
  int? get working => _working;

  @override
  List<SwarmAgentRef> get agents => [
    for (final entry in visibleAgents(agentIndex(notifier)))
      if (entry.isOpenable)
        (
          machineId: entry.machineId,
          agentId: entry.agent.id,
          name: entry.agent.displayName,
          machine: entry.machineName,
          engine: entry.agent.engineDisplayName ?? entry.agent.engine,
          working: entry.isWorking,
          waiting: entry.isWaiting,
        ),
  ];

  void _changed() {
    final index = notifier.machinesAnswered ? agentIndex(notifier) : null;
    final working = index?.where((entry) => entry.isWorking).length;
    final waiting = index?.where((entry) => entry.isWaiting).length;
    if (working == _working &&
        waiting == _waiting &&
        identical(index, _index)) {
      return;
    }
    _working = working;
    _waiting = waiting;
    _index = index;
    notifyListeners();
  }

  @override
  void openList(BuildContext context) => unawaited(
    Navigator.of(context)
        .push(phoneRoute((_) => AgentsListPage(notifier: notifier))),
  );

  @override
  void open(BuildContext context, SwarmAgentRef agent) =>
      openAgent(context, notifier, agent.machineId, agent.agentId);

  @override
  void dispose() {
    notifier.removeListener(_changed);
    super.dispose();
  }
}

/// The sessions running on [machines] that may join a Swarm, as Desktop's Add
/// agent offers them (`swarm_screen.dart` `unavailable`): Claude Code or
/// Codex, its terminal there and not stopped, the last used first; never one
/// whose id the Swarm would refuse. Only on a computer answering now with a
/// list of its own: one kept from the last run may name a session long gone.
List<SwarmRunningSession> swarmRunningSessions(
  Iterable<MachineState> machines,
) => [
  for (final machine in machines)
    if (phoneMachineStatusOf(machine) == PhoneMachineStatus.ready &&
        !machine.agentsFromCache)
      for (final agent in [...machine.agents]..sort(_lastUsedFirst))
        if (agent.engine case final engine?
            when (engine == 'claude' || engine == 'codex') &&
                agent.terminalAvailable &&
                !agent.isStopped &&
                _sessionId.hasMatch(agent.id))
          (
            machineId: machine.machine.machineId,
            machine: machine.machine.displayName,
            harnessId: agent.id,
            name: agent.displayName,
            engine: engine,
          ),
];

int _lastUsedFirst(Agent a, Agent b) {
  final at = a.lastUsedAt, bt = b.lastUsedAt;
  if (at == null || bt == null) {
    return (at == null ? 1 : 0) - (bt == null ? 1 : 0);
  }
  return bt.compareTo(at);
}

/// An id the Swarm takes for a session (backend commands.ts `id`).
final _sessionId = RegExp(r'^[A-Za-z0-9_-]{1,160}$');
