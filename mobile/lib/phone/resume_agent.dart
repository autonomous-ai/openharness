import 'dart:async';

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
  final result = await notifier.resumeAgent(entry.machineId, entry.agent.id);
  if (result.error case final error?) return error;
  if (_openable(notifier, entry)) return null;

  final ready = Completer<bool>();
  void check() {
    if (ready.isCompleted) return;
    if (_openable(notifier, entry)) ready.complete(true);
  }

  notifier.addListener(check);
  Timer? timeout;
  try {
    timeout = Timer(_terminalWait, () {
      if (!ready.isCompleted) ready.complete(false);
    });
    // Checked once more after subscribing: the agent can land between the test
    // above and the listener going on, and nothing would fire again.
    check();
    if (await ready.future) return null;
  } finally {
    timeout?.cancel();
    notifier.removeListener(check);
  }
  return 'Resumed, but its terminal has not come back yet. Try again in a moment.';
}

bool _openable(AppNotifier notifier, AgentEntry entry) =>
    notifier
        .stateOf(entry.machineId)
        ?.agents
        .where((agent) => agent.id == entry.agent.id)
        .firstOrNull
        ?.terminalAvailable ??
    false;
