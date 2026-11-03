import 'dart:async';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';

/// How long to wait for a resumed agent's terminal to be reported before giving
/// up and saying so.
///
/// The restart itself has already succeeded by then; this is the machine
/// allocating a pty and the daemon pushing the agent back. Long enough for a
/// cold engine on a phone's connection, short enough that a person who is going
/// to be told "try again" is not left holding a spinner.
const _terminalWait = Duration(seconds: 12);

/// Bring stopped work back, and return only once something can be opened on it.
///
/// Returns null on success, or the message to show.
///
/// ⚠️ **The wait is the point, not the restart.** The desktop does the same in
/// `_resumeStoppedDestination`: it sends the lifecycle command and then races
/// the reply against an observer watching for `terminalAvailable`, because the
/// RPC returning does not mean there is a pty yet. Opening the pager on an agent
/// that has not got one lands on an empty screen — worse, the phone's pager
/// filters its pages to agents WITH terminals (`agent_swipe_list.dart`), so the
/// swipe would silently open a different agent than the row that was tapped.
///
/// Shared by the search and the Agents list so the two cannot disagree about
/// what tapping stopped work does.
Future<String?> resumeAgentForOpen(
  AppNotifier notifier,
  AgentEntry entry,
) async {
  final stopped = entry.agent;
  final ready = Completer<void>();
  void check() {
    if (!ready.isCompleted && _resumedTerminal(notifier, entry, stopped)) {
      ready.complete();
    }
  }

  notifier.addListener(check);
  Timer? timeout;
  try {
    // ⚠️ **Raced, as the desktop's `_resumeStoppedDestination` races them.** The daemon pushes the
    // resumed agent (`agent_synced`) as soon as its pane is up, and the reply can trail it — or be
    // lost to a dropped socket after the resume has in fact happened. Whichever says "there is a
    // terminal" first opens it; only a reply naming a failure, before any terminal, is an error.
    final reply = notifier.resumeAgent(entry.machineId, stopped.id);
    check();
    final error = await Future.any([
      reply.then((result) => result.error),
      ready.future.then((_) => null),
    ]);
    if (ready.isCompleted) return null;
    if (error != null) return error;
    // Confirmed; the pty follows it.
    final arrived = Completer<bool>();
    timeout = Timer(_terminalWait, () {
      if (!arrived.isCompleted) arrived.complete(false);
    });
    unawaited(
      ready.future.then((_) {
        if (!arrived.isCompleted) arrived.complete(true);
      }),
    );
    if (await arrived.future) return null;
  } finally {
    timeout?.cancel();
    notifier.removeListener(check);
  }
  return 'Resumed, but its terminal has not come back yet. Try again in a moment.';
}

/// Whether [stopped] is back with a terminal, as the conversation its resume promised — see
/// [Agent.resumedAsPromised].
bool _resumedTerminal(AppNotifier notifier, AgentEntry entry, Agent stopped) {
  final current = notifier
      .stateOf(entry.machineId)
      ?.agents
      .where((agent) => agent.id == stopped.id)
      .firstOrNull;
  return current != null &&
      current.terminalAvailable &&
      !current.isStopped &&
      current.launchState != 'failed' &&
      stopped.resumedAsPromised(current);
}

/// Whether [agentId]'s session on [machineId] is stopped there, as this phone's
/// list of that machine's agents says — what the Swarm's Open terminal reads
/// (`PhoneShellScope.agentStopped`). Null while it runs, or when the phone does
/// not list it, or lists it on a machine another account shares (the
/// desktop's Resume is for the person's own machines alone,
/// `belongsToOtherAccount`); true for stopped work [resumeAgentForOpen] can
/// bring back ([Agent.canPauseAndResume]), false for stopped work it cannot.
bool? phoneAgentStopped(
  AppNotifier notifier,
  String machineId,
  String agentId,
) {
  final machine = notifier.stateOf(machineId);
  final agent = machine?.agents.where((a) => a.id == agentId).firstOrNull;
  if (machine == null ||
      machine.machine.shared ||
      agent == null ||
      !agent.isStopped) {
    return null;
  }
  return agent.canPauseAndResume;
}

/// Brings [agentId]'s stopped work on [machineId] back for the Swarm's Open
/// terminal (`PhoneShellScope.onResumeAgent`), the desktop's
/// `resumeStoppedSession`: [resumeAgentForOpen], read afresh at the press.
/// Null once there is a terminal to open — at once for work that is no longer
/// stopped — or what to say.
Future<String?> phoneResumeAgent(
  AppNotifier notifier,
  String machineId,
  String agentId,
) async {
  final machine = notifier.stateOf(machineId);
  // Never offered there ([phoneAgentStopped]): refused should it be asked.
  if (machine != null && machine.machine.shared) {
    return 'Only the person whose machine runs this agent can resume it.';
  }
  final agent = machine?.agents.where((a) => a.id == agentId).firstOrNull;
  if (machine == null || agent == null) {
    // The desktop pane's words for a harness its machine no longer lists.
    return 'This harness is no longer on '
        '${machine?.machine.displayName ?? 'this machine'}.';
  }
  if (!agent.isStopped) return null;
  return resumeAgentForOpen(
    notifier,
    AgentEntry(machine: machine, agent: agent),
  );
}
