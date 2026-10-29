import 'harness_attachments.dart';
import 'lead_placement.dart';

/// A new project's Product Manager the Swarm starts rather than this
/// Desktop, on [machineId].
class LeadSwarmStart {
  const LeadSwarmStart({
    required this.machineId,
    required this.engine,
    required this.repositoryUrl,
    required this.title,
    required this.task,
    this.files = const [],
  });
  final String? repositoryUrl, title;
  final String machineId, engine, task;
  final List<HarnessAttachment> files;
}

class HarnessLaunchRole {
  const HarnessLaunchRole({
    required this.id,
    required this.name,
    required this.kind,
  });
  final String id, name, kind;
  String get swarmRole => kind == 'reviewer' ? 'review' : 'dev';
}

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
    this.roles,
    this.roleId,
    this.startInSwarm,
  });
  final String creationId, actionLabel;
  String? swarmRole;
  String? swarmSkillMode;
  final List<HarnessLaunchRole>? roles;
  String? roleId;

  void chooseRole(String id) {
    final selected = roles?.where((role) => role.id == id).firstOrNull;
    if (selected == null) return;
    roleId = selected.id;
    swarmRole = selected.swarmRole;
  }

  // Restores the person's original request from a destination launch journal.
  final String? initialTask;
  // The only agents this destination may start, or null for any.
  final List<String>? engines;
  // A destination can require a mode without changing ordinary launch preferences.
  final String? forcedPermissionMode;
  String? projectVisibility;
  bool projectVisibilityLocked;

  /// A new project in a Swarm: the Swarm's machines its Product Manager may
  /// start on, best first. The form then shows only the task, repo and
  /// visibility, with the machine on a "Product Manager:" line. Null keeps
  /// the ordinary machine, agent and folder controls.
  List<LeadMachine>? leadMachines;

  /// With [leadMachines]: creates the project and has the Swarm start its
  /// Product Manager, when this Desktop does not start it itself.
  final Future<void> Function(LeadSwarmStart start)? startInSwarm;

  /// With [leadMachines]: the Swarm's model list for its engine and model.
  LeadModelList? leadModels;
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
  // What a request was sent with. The journal keeps them, and a [pending]
  // recovery shows them: Check status asks that machine, not the form's.
  String? machineId, engine, folder;
  // What a [pending] recovery is waiting for, in the person's words.
  String? pendingNote;
  // Drops a request recovery cannot finish. Null once dropped, or a question
  // to confirm before dropping it anyway; throws when the request is kept.
  Future<String?> Function({bool anyway})? discard;
}
