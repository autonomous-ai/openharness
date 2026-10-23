import '../state/app_state.dart';

/// The backend agent id is stable; native Stop/Delete uses the machine's harness id.
String? superTabLeadProtectionReason(
  AppNotifier app,
  String machineId,
  String harnessId,
) {
  for (final controller in app.superTabs.loadedControllers) {
    final snapshot = controller.snapshot;
    if (snapshot == null) continue;
    for (final agent in snapshot.agents) {
      if (agent.machineId != machineId || agent.harnessId != harnessId) {
        continue;
      }
      if (snapshot.leadProtectionReason(agent.id) case final reason?) {
        return reason;
      }
    }
  }
  return null;
}
