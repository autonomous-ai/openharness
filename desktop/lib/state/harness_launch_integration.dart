import '../super_tabs/new_repository.dart';
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
    this.swarmRole,
    this.startInSwarm,
    this.checkRepositoryOwner,
    this.createRepository,
    this.checkRepositoryAgain,
    this.ownMachinesOnly = false,
  });
  final String creationId, actionLabel;

  /// `lead` for a Product Manager, `dev` for any other agent: what the daemon's launch reads to give a Swarm
  /// agent's engine its folder trust and the team's basics (cli core/agents/create.ts).
  String? swarmRole;

  // Restores the person's original request from a destination launch journal.
  final String? initialTask;
  // The only agents this destination may start, or null for any.
  final List<String>? engines;
  String? projectVisibility;
  bool projectVisibilityLocked;

  /// Only the person's own computers, never a shared, guest or Team one: an
  /// agent they start runs in their own account.
  final bool ownMachinesOnly;

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

  /// With [leadMachines]: the GitHub organizations New Repository offers (the
  /// Swarm's own, in its order; empty when it uses none yet). Null hides New
  /// Repository: a server that cannot create repositories (task #3374).
  List<String>? newRepositoryOwners;

  /// Whether an organization lets Harness create a repository there.
  final Future<NewRepositoryOwnerCheck> Function(String owner)?
  checkRepositoryOwner;

  /// Creates the project, once, then the repository through the person's
  /// own GitHub sign-in in their browser, and gives what was made. Throws
  /// with the line to show when nothing was made.
  final Future<NewRepositoryCreated> Function(
    NewRepositoryAsk ask,
    String task,
  )?
  createRepository;

  /// Reads the Swarm again while a create waits on GitHub (Check again).
  final Future<void> Function()? checkRepositoryAgain;

  /// Before anything is created: the prompt for [task], which a destination
  /// may refuse for [machineId] and [engine], the engine about to start.
  final Future<String> Function(String machineId, String task, String engine)
  prepare;
  final Future<void> Function(String machineId, String harnessId) complete;
  final Future<void> Function(String machineId, String creationId) beforeSubmit;
  Future<void> Function()? resume;
  final Future<void> Function(List<HarnessAttachment> files, String prompt)?
  stageAttachments;
  final bool Function()? needsAttachmentReview;
  final Future<void> Function(bool resend)? resolveAttachments;
  bool pending = false;

  /// The model and effort the launch asked for that its machine refused, so
  /// the agent runs its engine's own model: its join says so in the chat.
  ({String model, String effort})? launchModelRefused;
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

  /// A Swarm's New Project and New Agent (anh Dee, 2026-11-10: "NEVER block users for minutes"): called once the start is
  /// under way and its person has nothing more to choose. The form then closes and the start goes on without it, its row
  /// in the left pane saying so (`super_tabs/swarm_starts.dart`), and it ends there, opening nothing.
  void Function()? onStarted;

  /// Whether the start goes on without its form ([onStarted]).
  bool get inBackground => onStarted != null;

  /// What that row shows while it starts: the agent's name once it has one, and a new project's id once it is made,
  /// whose own row it stands in for.
  String? name, projectId;
}
