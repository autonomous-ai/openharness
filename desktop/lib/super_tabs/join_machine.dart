import 'dart:async';

import '../core/machine_resources.dart';
import 'controller.dart';

/// What one more agent needs to start, the CLI's own figure
/// (`START_REQUIREMENTS.memoryBytes`, `cli/src/superTabs/capacity.ts`).
const _agentMemoryBytes = 2 * 1024 * 1024 * 1024;

/// Add machine's starting number of agents: half the machine's memory in
/// agents, from 1 to 16. Null while its memory is unknown.
int? superTabSuggestedAgentSlots(MachineResources? resources) {
  final total = resources?.memoryTotalBytes;
  if (total == null) return null;
  return (total / (2 * _agentMemoryBytes)).floor().clamp(1, 16);
}

/// The role [answer] says this account just became a member as: the
/// server's own answer to the join that asked, a link join (store.ts
/// `joinSwarm`) or an invitation's accept (commands.ts `invite.accept`). Null
/// when the person was a member already, whatever an earlier preview said (they
/// may have joined on another device meanwhile), or when an older server does
/// not say: this computer is added only to a membership this request made.
String? swarmNewMemberRole(Map<String, dynamic> answer) =>
    answer['alreadyMember'] == false && answer['role'] is String
    ? answer['role'] as String
    : null;

/// The engines a Swarm machine runs (backend `swarmEngine`).
const _swarmEngines = {'claude', 'codex'};

/// This computer, added to a Swarm by the join that just let its person in
/// (Scholes, 2026-10-29): what [SwarmJoinMachine.add] did, for the note the
/// person sees. [problem]: why it was not added, in a sentence for them.
class SwarmJoinedMachine {
  const SwarmJoinedMachine({
    required this.tabId,
    required this.swarmName,
    required this.machineId,
    required this.machineName,
    this.problem,
  });

  final String tabId, swarmName, machineId, machineName;
  final String? problem;
  bool get added => problem == null;
}

/// Adds this computer to a Swarm its person just joined, with Add machine's
/// defaults: the Claude Code and Codex it has, the folder its daemon sets up,
/// and the number of agents its memory suggests. It is added as
/// `teamAccountOnly`, so the server sends teammates' work to it only through
/// its Harness Team account whose privacy check passed (backend
/// superTabs/machines.ts `teamWorkRefusal`); until then it runs only its
/// person's own projects.
///
/// Only a new collaborator's computer, in a Swarm that uses Harness Team
/// accounts: a viewer, a computer already in the Swarm and a Swarm whose
/// server does not try Team accounts yet are left as they are.
class SwarmJoinMachine {
  SwarmJoinMachine({
    required this.machineRequest,
    required this.readResources,
    required this.wake,
    this.pause = const Duration(seconds: 1),
    this.deadline = const Duration(minutes: 5),
  });

  /// A `super_tabs` request to this computer's own daemon.
  final Future<Map<String, dynamic>> Function(
    String machineId,
    Map<String, dynamic> payload,
  )
  machineRequest;
  final Future<MachineResources?> Function(String machineId) readResources;

  /// Tells the daemon it is in the Swarm now, so it starts hosting at once.
  final Future<void> Function(String machineId) wake;

  /// Between two reads of a folder setup still running, and how long the
  /// whole setup may take, as Add machine waits.
  final Duration pause, deadline;

  /// Null when nothing was to be done, or the account changed or signed out
  /// meanwhile ([current] false): nothing is added or said then.
  Future<SwarmJoinedMachine?> add(
    SuperTabController c, {
    required String machineId,
    required String machineName,
    required bool Function() current,
  }) async {
    final snapshot = c.snapshot;
    if (snapshot == null || !current()) return null;
    if (!snapshot.teamAccounts || !c.canWrite) return null;
    final me = snapshot.people.where((p) => p.id == c.accountId).firstOrNull;
    if (me?.role != 'collaborator') return null;
    if (snapshot.machines.any((m) => m['machineId'] == machineId)) return null;
    SwarmJoinedMachine note([String? problem]) => SwarmJoinedMachine(
      tabId: c.tabId,
      swarmName: snapshot.name,
      machineId: machineId,
      machineName: machineName,
      problem: problem,
    );

    final operationId = superTabOperationId();
    final until = DateTime.now().add(deadline);
    Map<String, dynamic> prepared;
    while (true) {
      try {
        prepared = await machineRequest(machineId, {
          'action': 'prepareContribution',
          'tabId': c.tabId,
          'scope': 'swarm',
          'operationId': operationId,
        });
      } catch (_) {
        if (!current()) return null;
        return note(
          'Could not reach Harness on this computer. Add it from Machines.',
        );
      }
      if (!current()) return null;
      if (prepared['state'] == 'ready' && prepared['scope'] == 'swarm') break;
      if (prepared['state'] != 'preparing') {
        return note(
          'Update Harness on this computer, then add it from Machines.',
        );
      }
      if (DateTime.now().isAfter(until)) {
        return note(
          'Setting up this computer took too long. Add it from Machines.',
        );
      }
      await Future<void>.delayed(pause);
    }
    final engines = [
      for (final engine in prepared['engines'] as List? ?? const [])
        if (_swarmEngines.contains(engine)) engine as String,
    ];
    if (engines.isEmpty) {
      return note(
        'Install Claude Code or Codex on this computer, then add it from Machines.',
      );
    }
    MachineResources? resources;
    try {
      resources = await readResources(machineId);
    } catch (_) {
      // Its offer below stands in.
    }
    final offered = prepared['maxAgents'];
    final slots =
        superTabSuggestedAgentSlots(resources) ??
        (offered is num ? offered.toInt().clamp(1, 1024) : 4);
    if (!current() || !c.canWrite) return null;
    final result = await c.command({
      'type': 'machine.contribute',
      'machineId': machineId,
      'name': machineName,
      'cwd': prepared['cwd'],
      'scope': 'swarm',
      'engines': engines,
      'maxAgents': slots,
      'teamAccountOnly': true,
    });
    if (!current()) return null;
    if (result == null) {
      return note(
        c.operationError ??
            'Could not add this computer. Add it from Machines.',
      );
    }
    try {
      await wake(machineId);
    } catch (_) {
      // Its daemon finds the Swarm on its next read anyway.
    }
    return note();
  }
}
