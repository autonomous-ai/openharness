import '../state/app_state.dart';

/// The backend agent id is stable; native Stop/Delete uses the machine's harness id.
String? superTabLeadProtectionReason(
  AppNotifier app,
  String machineId,
  String harnessId,
) {
  return app.superTabs.leadProtectionReasonForHarness(machineId, harnessId);
}

/// The coordinator's name for the agent [superTabLeadProtectionReason] protects.
String? superTabLeadCoordinatorName(
  AppNotifier app,
  String machineId,
  String harnessId,
) => app.superTabs.leadCoordinatorForHarness(machineId, harnessId);
