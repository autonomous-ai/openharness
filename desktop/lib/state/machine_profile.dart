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
  final ids = <String>{
    for (final pane in swarm.panes)
      if (pane.machineId.isNotEmpty) pane.machineId,
    if (swarm.titleMachineId != null && swarm.titleMachineId!.isNotEmpty)
      swarm.titleMachineId!,
    if (swarm.orchestratorMachineId != null &&
        swarm.orchestratorMachineId!.isNotEmpty)
      swarm.orchestratorMachineId!,
  };
  if (ids.isEmpty) return true;
  return ids.every((id) => id == machineId);
}

/// Tabs this window shows for [machineId]. The underlying list is not copied
/// and is not filtered in place: the desk keeps every machine's tabs.
List<Swarm> swarmsForMachineProfile(List<Swarm> swarms, String? machineId) => [
  for (final swarm in swarms)
    if (swarmMatchesMachineProfile(swarm, machineId)) swarm,
];
