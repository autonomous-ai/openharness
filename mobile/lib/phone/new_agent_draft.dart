import 'package:harness_mobile/core/codex_profiles.dart';
import 'package:harness_mobile/core/git_project.dart';
import 'package:harness_mobile/core/project_folder.dart';

/// What the New Harness form was left holding, so opening it again comes back to it.
///
/// The desktop's `NewHarnessDraft` (`desktop/lib/state/new_harness.dart`), and kept the way the
/// desktop keeps it: **in memory, for as long as the app runs**. Nothing here is written to disk.
/// Closing the form is not the same as changing your mind about it — somebody who backed out to
/// check which branch they meant should not have to name the folder, the engine and the approvals
/// again — but a choice made yesterday is not an answer to a question asked today.
///
/// ⚠️ **Dropped once a harness is actually created, not kept.** The desktop closes its box with
/// `keepDraft: false` on `onCreated` for the same reason: the draft exists to survive a
/// cancellation, and a form that reopens pre-filled with the harness you just started is a second
/// one waiting to be made by accident.
///
/// The engine alone outlives this, and always did — `AppNotifier.agentPreference` remembers it
/// across launches, so a phone that has never opened this form still starts on the right one.
class NewAgentDraft {
  const NewAgentDraft({
    required this.machineId,
    required this.engine,
    required this.permissionMode,
    this.folder,
    this.project,
    this.projectLabel,
    this.worktree,
    this.branchRef,
    this.branchName,
    this.placeholder,
    this.git,
    this.gitFolder,
    this.codexProfile,
  });

  final String machineId;
  final String? engine;
  final String permissionMode;

  /// A folder that exists, or ([project]) one the machine is to make. Exactly one is ever set —
  /// see the note on `_NewAgentPageState._project`.
  final String? folder;
  final ProjectFolderRequest? project;
  final String? projectLabel;

  final bool? worktree;
  final String? branchRef, branchName, placeholder;

  /// What the machine last said about [gitFolder], carried so reopening the form does not flash
  /// an empty Branch section while a round trip to somebody's laptop repeats itself.
  final GitProjectInfo? git;
  final String? gitFolder;

  final LocalCodexProfile? codexProfile;
}

/// The one draft, or null where there is nothing to come back to.
///
/// A plain variable rather than a notifier: nothing rebuilds when it changes. It is read once as
/// the form is built and written once as it goes.
NewAgentDraft? newAgentDraft;
