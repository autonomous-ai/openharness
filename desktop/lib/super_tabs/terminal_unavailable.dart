import '../state/app_state.dart';
import 'machine_status.dart';
import 'model.dart';

/// What a pane says when this account's machine list has no terminal for a member.
const superTabTerminalOffline =
    'The shared terminal is not available yet. Its execution machine must be online.';

/// Why a member's terminal cannot be shown here, as a person reads it.
///
/// A member on another account's computer is shown read-only only through the invitation that computer sends each
/// Swarm member (cli/src/superTabs/observers.ts): until it arrives, that computer is missing from this account's
/// machine list, which said nothing about it being offline. Seen 2026-10-23: River on a collaborator's computer,
/// working, read "must be online" to every other member.
String superTabTerminalUnavailable({
  required SuperTabSnapshot? snapshot,
  required SuperTabAgent agent,
  required String? accountId,
  required MachineState? machine,
  DateTime? now,
}) {
  final ownerId = agent.machineOwnerId;
  if (snapshot == null || ownerId == accountId) return superTabTerminalOffline;
  final owner =
      snapshot.people.where((p) => p.id == ownerId).firstOrNull?.username ??
      'its owner';
  final row = snapshot.machines
      .where((m) => m['machineId'] == agent.machineId)
      .firstOrNull;
  final computer =
      machine?.machine.displayName ?? row?['name'] as String? ?? 'a computer';
  final name = snapshot.agentName(agent.id);
  // A private session is never shared, so no update or Retry brings it here. River, Ken's Product Manager, read
  // "update and restart Harness" to every member while that Mac ran the latest Harness (2026-10-28).
  if (superTabTerminalPrivate(snapshot, agent)) {
    return '$name reads private chats, so only $owner can watch its terminal.';
  }
  final where = '$name runs on $computer, $owner’s computer';
  if (_swarmOffline(row, now ?? DateTime.now())) {
    return '$where, which is offline. Its terminal shows here once that computer is back.';
  }
  return '$where. Its terminal is not shared with you yet: Harness there shares it with Swarm members '
      'once it is up to date and running. Ask $owner to update and restart Harness, then Retry.';
}

/// Whether an agent's terminal is private to the person whose computer runs it: it reads private chats. The current
/// Product Manager is not, though the backend marks it: every member watches it, view only (Ken, 2026-10-28).
bool superTabTerminalPrivate(SuperTabSnapshot snapshot, SuperTabAgent agent) =>
    agent.confidential && !snapshot.isLead(agent.id);

/// Whether the Swarm last heard from this machine long enough ago to call it offline. A machine the Swarm does not
/// list is not called offline: what is known of it then is only that this account cannot see it.
bool _swarmOffline(Map<String, dynamic>? row, DateTime now) {
  if (row == null) return false;
  final observation = row['observation'];
  final at = observation is Map ? observation['receivedAt'] : null;
  final age = at is num
      ? now.difference(DateTime.fromMillisecondsSinceEpoch(at.toInt()))
      : null;
  return superTabMachineStatus(age: age) == SuperTabMachineStatus.offline;
}
