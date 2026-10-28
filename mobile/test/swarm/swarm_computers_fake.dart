import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';

/// The person's computers as a test scripts them.
class FakeComputers extends ChangeNotifier implements SwarmComputers {
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
