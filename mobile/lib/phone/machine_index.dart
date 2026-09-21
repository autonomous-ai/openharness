import 'package:harness_mobile/state/app_state.dart';
import 'phone_status.dart';

/// Every machine the Machines tab draws, in the order a finger meets them.
///
/// The tab draws two sections — the ones that work, then the ones wanting something — and that
/// concatenation, not account order, is what somebody actually sees. The machine page swipes along
/// it, so it has to be built in ONE place: a pager computing "the next machine" from a slightly
/// different order than the list it was opened from would skip a machine, or hand back the one just
/// left, and nothing on screen would explain why. The same rule the Agents tab follows with
/// `visibleAgents`.
///
/// Unlike the agent list this one keeps EVERY machine, including the ones that need a password or
/// are offline. A machine row that cannot be opened is still worth a page: the password form is
/// exactly what somebody swiping past it came for, and an offline machine says so in words rather
/// than by being missing.
List<MachineState> visibleMachines(AppNotifier notifier) {
  final states = [
    for (final machine in notifier.machines) ?notifier.stateOf(machine.machineId),
  ];
  // Two runs, by whether the machine is usable as it stands — the split [MachinesTab] renders as
  // its two sections. A machine merely connecting belongs with the working ones: it needs nothing
  // from anybody, it is just not ready yet.
  final working = <MachineState>[];
  final needsAttention = <MachineState>[];
  for (final state in states) {
    switch (phoneMachineStatusOf(state)) {
      case PhoneMachineStatus.needsPassword:
      case PhoneMachineStatus.offline:
        needsAttention.add(state);
      case PhoneMachineStatus.connecting:
      case PhoneMachineStatus.ready:
        working.add(state);
    }
  }
  return [...working, ...needsAttention];
}

/// The machines that work as they stand, in [visibleMachines] order.
///
/// Derived from that one list rather than re-partitioned here, so the sections the tab draws and
/// the order the pager walks cannot drift apart.
List<MachineState> workingMachines(List<MachineState> machines) => [
  for (final machine in machines)
    if (_works(machine)) machine,
];

/// The machines wanting something first — a password, or a Harness that is not running.
List<MachineState> machinesNeedingAttention(List<MachineState> machines) => [
  for (final machine in machines)
    if (!_works(machine)) machine,
];

bool _works(MachineState machine) =>
    switch (phoneMachineStatusOf(machine)) {
      PhoneMachineStatus.connecting || PhoneMachineStatus.ready => true,
      PhoneMachineStatus.needsPassword || PhoneMachineStatus.offline => false,
    };
