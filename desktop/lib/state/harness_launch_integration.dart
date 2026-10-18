/// An optional destination around the existing New Harness launch. Preparing
/// may add instructions; completion registers the confirmed native session.
/// Neither callback starts an agent. Retry keeps the same native receipt.
class HarnessLaunchIntegration {
  HarnessLaunchIntegration({
    required this.creationId,
    required this.prepare,
    required this.complete,
    required this.beforeSubmit,
    this.resume,
    this.actionLabel = 'New Harness',
  });
  final String creationId, actionLabel;
  final Future<String> Function(String machineId, String task) prepare;
  final Future<void> Function(String machineId, String harnessId) complete;
  final Future<void> Function(String machineId, String creationId) beforeSubmit;
  final Future<void> Function()? resume;
  bool pending = false;
  bool completed = false;
  String? preparedPrompt;
}
