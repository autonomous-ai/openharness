import 'harness_attachments.dart';

/// An optional destination around the existing New Harness launch. Preparing
/// may add instructions; completion registers the confirmed native session.
/// Neither callback starts an agent. Retry keeps the same native receipt.
class HarnessLaunchIntegration {
  HarnessLaunchIntegration({
    required this.creationId,
    required this.prepare,
    required this.complete,
    required this.beforeSubmit,
    this.stageAttachments,
    this.needsAttachmentReview,
    this.resolveAttachments,
    this.resume,
    this.actionLabel = 'New Harness',
    this.projectVisibility,
    this.projectVisibilityLocked = false,
    this.initialTask,
    this.engines,
    this.forcedPermissionMode,
    this.swarmRole,
    this.swarmSkillMode,
  });
  final String creationId, actionLabel;
  final String? swarmRole;
  String? swarmSkillMode;
  // Restores the person's original request from a destination launch journal.
  final String? initialTask;
  // The only agents this destination may start, or null for any.
  final List<String>? engines;
  // A destination can require a mode without changing ordinary launch preferences.
  final String? forcedPermissionMode;
  String? projectVisibility;
  bool projectVisibilityLocked;
  final Future<String> Function(String machineId, String task) prepare;
  final Future<void> Function(String machineId, String harnessId) complete;
  final Future<void> Function(String machineId, String creationId) beforeSubmit;
  Future<void> Function()? resume;
  final Future<void> Function(List<HarnessAttachment> files, String prompt)?
  stageAttachments;
  final bool Function()? needsAttachmentReview;
  final Future<void> Function(bool resend)? resolveAttachments;
  bool pending = false;
  bool completed = false;
  String? preparedPrompt;
}
