import '../core/models.dart';
import '../state/app_state.dart';
import 'controller.dart';
import 'model.dart';

/// Import an agent running on this Mac into a project
/// (docs/plans/2026-11-03-import-agent-design.md): which agents can be
/// imported, the handoff of one, and the import itself.

/// One agent of this Mac that can be imported, with its machine.
typedef ImportableAgent = ({String machineId, Agent agent});

/// Why import is refused when this Mac is not in the Swarm.
const kImportNeedsThisMac =
    'Add this Mac to the Swarm first: the imported agent continues in its '
    'Harness Team account.';

/// Why import is refused when this Mac has no Harness Team account in the
/// Swarm: the new agent never runs in the person's own account.
const kImportNeedsTeamAccount =
    'Set up Harness Team on this Mac first: the imported agent continues '
    'there, not in your own account.';

const _engines = {'claude', 'codex'};

/// This Mac's own machine: never a Team account's or another person's.
MachineState? _thisMac(AppNotifier app) {
  if (app.viewer != null) return null;
  final mac = app.localMachineState;
  return mac == null || mac.belongsToOtherAccount || mac.machine.isTeamAccount
      ? null
      : mac;
}

/// The agents of this Mac's own account that may be imported, newest first:
/// Claude Code or Codex, running or resumable, listed by no open Swarm, and
/// not started by the Swarm (Buddies included).
List<ImportableAgent> importableAgents(AppNotifier app, SuperTabController c) {
  final mac = _thisMac(app);
  if (mac == null) return const [];
  final id = mac.machine.machineId;
  final listed = <String>{
    for (final snapshot in [
      c.snapshot,
      for (final other in app.superTabs.loadedControllers) other.snapshot,
    ])
      for (final agent in snapshot?.agents ?? const <SuperTabAgent>[])
        if (agent.machineId == id) agent.harnessId,
  };
  final agents = [
    for (final agent in mac.agents)
      if (_engines.contains(agent.engine) &&
          !agent.isCloud &&
          (!agent.isStopped || agent.canResumeConversation) &&
          !agent.startedBySwarm &&
          !listed.contains(agent.id))
        agent,
  ];
  final never = DateTime.fromMillisecondsSinceEpoch(0);
  agents.sort(
    (a, b) => (b.lastActivityAt ?? never).compareTo(a.lastActivityAt ?? never),
  );
  return [for (final agent in agents) (machineId: id, agent: agent)];
}

/// Why nothing can be imported into [c]'s Swarm from here, or null when it
/// can: Harness must run on this Mac, and this Mac's Harness Team account
/// must be in the Swarm and take work.
String? importUnavailable(AppNotifier app, SuperTabController c) {
  final mac = _thisMac(app);
  if (mac == null) {
    return 'Import works in Harness on the Mac where the agent runs.';
  }
  final snapshot = c.snapshot;
  if (snapshot?.pool(mac.machine.machineId) == null) {
    return kImportNeedsThisMac;
  }
  final team = snapshot!.teamPoolOf(mac.machine.machineId);
  if (team == null) return kImportNeedsTeamAccount;
  return switch (team['teamWork']) {
    {'allowed': false, 'reason': final String reason} => reason,
    _ => null,
  };
}
