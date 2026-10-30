import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';

/// The person's computers as a test scripts them.
class FakeComputers extends ChangeNotifier implements SwarmComputers {
  /// The person's own computers a Buddy may run on.
  @override
  List<SwarmOwnComputer> own = const [];

  /// Each question asked of a computer, and how the computer answers it.
  final asked = <(String, Map<String, dynamic>)>[];
  Map<String, dynamic> Function(String machineId, Map<String, dynamic> payload)?
  answer;

  @override
  Future<Map<String, dynamic>> ask(
    String machineId,
    Map<String, dynamic> payload,
  ) async {
    asked.add((machineId, payload));
    return answer?.call(machineId, payload) ?? const {};
  }

  FakeComputers(this.computers);

  @override
  List<SwarmComputer>? computers;

  @override
  bool rechecking = false;

  int rechecks = 0, adds = 0;

  /// Holds a recheck until completed.
  Completer<void>? held;

  /// What a recheck finds.
  List<SwarmComputer>? found;

  void set(List<SwarmComputer>? next) {
    computers = next;
    notifyListeners();
  }

  @override
  Future<void> recheck() async {
    rechecks++;
    rechecking = true;
    notifyListeners();
    await held?.future;
    rechecking = false;
    if (found case final next?) computers = next;
    notifyListeners();
  }

  @override
  void add(BuildContext context) => adds++;
}
