import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../core/models.dart';
import '../phone/phone_navigation.dart';
import '../phone/phone_status.dart';
import '../phone/welcome/your_computer.dart';
import '../state/app_state.dart';
import 'swarm_chat_agents.dart';
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
    implements SwarmComputers, SwarmRunningSessions {
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
