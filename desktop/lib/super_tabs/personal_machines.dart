import 'package:flutter/foundation.dart';

import '../state/app_state.dart';
import 'controller.dart';

/// A machine of the person's own not yet in their Personal Swarm.
typedef PersonalMachineRow = ({
  String machineId,
  String name,
  String status,
  String? reason,
});

/// The person's own machines in their Personal Swarm, per app.
class PersonalMachines extends ChangeNotifier {
  PersonalMachines._(this.app);
  static final _of = Expando<PersonalMachines>();
  static PersonalMachines of(AppNotifier app) =>
      _of[app] ??= PersonalMachines._(app);

  final AppNotifier app;

  static String storageKey(String account) => 'super_tab.machines.$account';

  Future<void> sync(SuperTabController c) async {}

  List<PersonalMachineRow> waiting(SuperTabController c) => const [];
}
