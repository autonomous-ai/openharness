import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../phone/phone_navigation.dart';
import '../phone/phone_status.dart';
import '../phone/welcome/your_computer.dart';
import '../state/app_state.dart';
import 'swarm_start.dart';

/// The account's computers for Swarm's start screens, from the app's own
/// machine list: each one's name, and whether it is away for real
/// ([phoneMachineAway]) — the socket down and the account's list agreeing.
///
/// Tells only when that changes, not at every change of the app's state,
/// which moves with every frame a terminal sends.
class AppSwarmComputers extends ChangeNotifier implements SwarmComputers {
  AppSwarmComputers(this.notifier) {
    notifier.addListener(_changed);
    _changed();
  }

  final AppNotifier notifier;

  List<SwarmComputer>? _computers;
  bool _rechecking = false;

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
    final rechecking = notifier.machinesRefreshing;
    if (listEquals(computers, _computers) && rechecking == _rechecking) return;
    _computers = computers;
    _rechecking = rechecking;
    notifyListeners();
  }

  /// The machines tab's Try again: the account's list read again.
  @override
  Future<void> recheck() => notifier.retryMachines();

  /// The machines tab's Add computer (`welcome/your_computer.dart`).
  @override
  void add(BuildContext context) => unawaited(
    Navigator.of(
      context,
    ).push(phoneRoute((_) => YourComputerPage(notifier: notifier))),
  );

  @override
  void dispose() {
    notifier.removeListener(_changed);
    super.dispose();
  }
}
