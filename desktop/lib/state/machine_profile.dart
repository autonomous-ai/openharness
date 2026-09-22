import 'swarm.dart';

/// Which computer a window is looking at.
///
/// The account still has one desk — the same tabs on every computer — and a
/// profile only decides which of those tabs this window draws. `null` is every
/// machine. A machine id is that computer alone: a tab is in it when every
/// agent it holds is on that computer. The Store and a tab with no agent yet
/// stay, so there is always a place to start one.
bool swarmMatchesMachineProfile(Swarm swarm, String? machineId) {
  if (machineId == null || machineId.isEmpty) return true;
  if (swarm.isStore) return true;
  final paneIds = <String>{
    for (final pane in swarm.panes)
      if (pane.machineId.isNotEmpty) pane.machineId,
  };
  // Panes are the membership. A title left over from an agent that has since
  // left the tab must not hide a tab whose remaining agents are all here.
  if (paneIds.isNotEmpty) return paneIds.every((id) => id == machineId);
  if (swarm.orchestratorMachineId != null &&
      swarm.orchestratorMachineId!.isNotEmpty) {
    return swarm.orchestratorMachineId == machineId;
  }
  if (swarm.titleMachineId != null && swarm.titleMachineId!.isNotEmpty) {
    return swarm.titleMachineId == machineId;
  }
  return true;
}

/// After [closedIndex] is removed, the visible tab that should come forward.
/// The hidden tabs in between are not candidates. Null when none are visible.
String? profileNeighborId(
  List<Swarm> swarms,
  String? machineId,
  int closedIndex,
) {
  Swarm? fallback;
  for (var i = 0; i < swarms.length; i++) {
    if (!swarmMatchesMachineProfile(swarms[i], machineId)) continue;
    fallback = swarms[i];
    if (i >= closedIndex) return swarms[i].id;
  }
  return fallback?.id;
}

/// Tabs this window shows for [machineId]. The underlying list is not copied
/// and is not filtered in place: the desk keeps every machine's tabs.
List<Swarm> swarmsForMachineProfile(List<Swarm> swarms, String? machineId) => [
  for (final swarm in swarms)
    if (swarmMatchesMachineProfile(swarm, machineId)) swarm,
];
