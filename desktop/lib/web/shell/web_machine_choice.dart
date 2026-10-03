import '../../core/models.dart';
import '../../state/app_state.dart';

/// Can [machine] take a new harness from this browser right now?
bool webMachineReady(MachineState machine) =>
    machine.connectionStatus == ConnectionStatus.connected &&
    !machine.needsLink &&
    !machine.isOffline &&
    !machine.machine.isShared;

/// The machine a browser starts New Harness on: the workspace's selected
/// machine when it can take work, else the first that can. Null means none
/// is connected yet, and the workspace opens Machines instead.
String? webNewHarnessMachine(AppNotifier app) {
  final selected = app.stateOf(app.selectedMachineId ?? '');
  if (selected != null && webMachineReady(selected)) {
    return selected.machine.machineId;
  }
  return app.machineStates.values
      .where(webMachineReady)
      .firstOrNull
      ?.machine
      .machineId;
}
