import 'package:harness_mobile/state/app_state.dart';

import 'phone_status.dart';

/// Every machine the Machines tab draws, in the order a finger meets them.
///
/// The tab draws three runs — the ones that work, then the ones wanting a password, then the ones
/// asleep — and that concatenation, not account order, is what somebody actually sees. The machine
/// page swipes along it, so it has to be built in ONE place: a pager computing "the next machine"
/// from a slightly different order than the list it was opened from would skip a machine, or hand
/// back the one just left, and nothing on screen would explain why. The same rule the Agents tab
/// follows with `visibleAgents`.
///
/// Unlike the agent list this one keeps EVERY machine, including the ones that need a password or
/// are offline. A machine row that cannot be opened is still worth a page: the password form is
/// exactly what somebody swiping past it came for, and an offline machine says so in words rather
/// than by being missing.
List<MachineState> visibleMachines(AppNotifier notifier) {
  final states = [
    for (final machine in notifier.machines)
      ?notifier.stateOf(machine.machineId),
  ];
  // Usable as it stands first; then what each of the others wants, each kind together — a password
  // (something to do here) before asleep (something to do at the computer). Together, because
  // [MachinesTab] says what a run of them needs once, over the run, rather than under every row;
  // interleaved, as account order left them, a locked one split the asleep ones into two runs. A
  // machine merely connecting belongs with the working ones: it needs nothing from anybody, it is
  // just not ready yet.
  final working = <MachineState>[];
  final locked = <MachineState>[];
  final asleep = <MachineState>[];
  for (final state in states) {
    switch (phoneMachineStatusOf(state)) {
      case PhoneMachineStatus.needsPassword:
        locked.add(state);
      case PhoneMachineStatus.offline:
        asleep.add(state);
      case PhoneMachineStatus.connecting:
      case PhoneMachineStatus.ready:
        working.add(state);
    }
  }
  return [...working, ...locked, ...asleep];
}
