import 'dart:async';
import 'dart:io';
import 'dart:isolate';
import 'dart:math';

import 'package:collection/collection.dart' show compareNatural;
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import '../analytics/analytics.dart';
import '../core/codex_profiles.dart';
import '../core/dsh_catalog.dart';
import '../core/harness_catalog.dart';
import '../core/first_task.dart';
import '../core/fuzzy_match.dart';
import '../core/git_worktree.dart';
import '../core/permission_modes.dart';
import '../core/project_folder.dart';
import '../core/repository_clone.dart';
import '../core/test_run.dart';
import '../widgets/engine_identity.dart';
import 'app_state.dart';
import 'harness_placement.dart';
import 'pane_arrangement.dart';

/// Whether New Harness opens as a line in the box, or as the full form.
///
/// The app, including Store Open/Try, uses the box. Advanced options can still
/// open the form with the same draft. Legacy form tests leave this off; dock
/// journeys enable it explicitly.
bool newHarnessOpensInBox = !kUnderTest;

/// A launch command with inherited arguments. Arrows select a launch argument;
/// a focused prompt edits one argument at a time. Enter
/// accepts a choice, Tab completes text, and Escape returns to the menu.
enum NewHarnessField {
  launch,
  task,
  agent,
  machine,
  branch,
  projectMenu,
  project,
  projectName,
  projectRepository,
  mode,
  profile,
}

/// What Project holds: a folder that exists, a project to make, or a
/// GitHub repository to clone.
@immutable
class NewHarnessProject {
  /// A new project, named by the person or (null) after the agent and the time.
  const NewHarnessProject.fresh([this.name])
    : folder = null,
      repository = null,
      generated = null;
  NewHarnessProject.generated(ProjectFolderRequest request)
    : name = request.name,
      generated = request,
      folder = null,
      repository = null;
  const NewHarnessProject.folder(String this.folder)
    : name = null,
      repository = null,
      generated = null;
  const NewHarnessProject.clone(GitHubRepository this.repository)
    : name = null,
      folder = null,
      generated = null;
  final String? name;
  final String? folder;
  final GitHubRepository? repository;
  final ProjectFolderRequest? generated;
  bool get isNew => folder == null;

  @override
  bool operator ==(Object other) =>
      other is NewHarnessProject &&
      other.name == name &&
      other.generated?.generatedAt == generated?.generatedAt &&
      other.generated?.generatedLabel == generated?.generatedLabel &&
      other.folder == folder &&
      other.repository?.url == repository?.url;
  @override
  int get hashCode => Object.hash(
    name,
    folder,
    repository?.url,
    generated?.generatedAt,
    generated?.generatedLabel,
  );
}

/// What Start does with a Git project in a new worktree.
enum WorktreeStart {
  /// A new branch from the chosen base.
  newBranch,

  /// An existing local branch, checked out as it is.
  existingBranch,

  /// The branch already has a worktree: the harness starts in it.
  openWorktree,

  /// The branch is the project folder's own and cannot be checked out twice.
  unavailable,
}

@immutable
class WorktreePlan {
  const WorktreePlan(this.kind, this.branch, {this.base, this.worktree});
  final WorktreeStart kind;
  final String branch;

  /// What a new branch starts from; a remote branch of the same name is tracked.
  final String? base;

  /// Where an existing worktree is.
  final String? worktree;
  bool get tracks =>
      kind == WorktreeStart.newBranch &&
      base != null &&
      base!.startsWith('refs/remotes/') &&
      base!.split('/').skip(3).join('/') == branch;
}

/// The project folder's own branch, if it is on one.
String? currentBranchRef(GitProjectInfo info) =>
    info.branch != null &&
        info.branches.any((b) => b.ref == 'refs/heads/${info.branch}')
    ? 'refs/heads/${info.branch}'
    : null;

/// Worktree starts on for a Git project with a commit to start from.
bool worktreeByDefault(GitProjectInfo info) =>
    info.isGit && info.branches.any((branch) => !branch.remote);

/// Where Start begins when no branch was chosen: new work from the default
/// branch (the local one, which Start brings up to its remote), work in the
/// folder on the branch it is on.
String? defaultBranchRef(GitProjectInfo info, {required bool worktree}) {
  if (!worktree) return currentBranchRef(info);
  final remote = info.defaultRef;
  final local = remote == null
      ? null
      : 'refs/heads/${remote.split('/').skip(3).join('/')}';
  return info.branches.any((b) => b.ref == local)
      ? local
      : remote ?? currentBranchRef(info);
}

/// The branch a worktree started from [base] is on, unless [name] was typed:
/// the default or current branch gets a new [placeholder] branch; another
/// local branch is checked out as it is, or opened in its worktree; a remote
/// branch nobody has locally becomes a local branch tracking it.
WorktreePlan planWorktree(
  GitProjectInfo info, {
  required String? base,
  required String? name,
  required String placeholder,
}) {
  GitBranch? local(String branch) =>
      info.branches.where((b) => !b.remote && b.name == branch).firstOrNull;
  // The folder's own branch cannot be checked out again: typed, it is refused;
  // picked (itself or its remote), a new branch starts from what was picked.
  WorktreePlan onLocal(GitBranch branch, {required bool chosen}) =>
      branch.name == info.branch
      ? chosen
            ? WorktreePlan(WorktreeStart.unavailable, branch.name)
            : WorktreePlan(WorktreeStart.newBranch, placeholder, base: base)
      : branch.worktree != null
      ? WorktreePlan(
          WorktreeStart.openWorktree,
          branch.name,
          worktree: branch.worktree,
        )
      : WorktreePlan(WorktreeStart.existingBranch, branch.name);
  final typed = name?.trim();
  if (typed != null && typed.isNotEmpty) {
    final existing = local(typed);
    return existing == null
        ? WorktreePlan(WorktreeStart.newBranch, typed, base: base)
        : onLocal(existing, chosen: true);
  }
  final fresh = WorktreePlan(WorktreeStart.newBranch, placeholder, base: base);
  final defaultName = info.defaultRef?.split('/').skip(3).join('/');
  if (base == null ||
      base == info.defaultRef ||
      base == 'refs/heads/$defaultName') {
    return fresh;
  }
  if (base.startsWith('refs/heads/')) {
    final branch = local(base.substring('refs/heads/'.length));
    return branch == null ? fresh : onLocal(branch, chosen: false);
  }
  final short = base.split('/').skip(3).join('/');
  final branch = local(short);
  return branch != null
      ? onLocal(branch, chosen: false)
      : WorktreePlan(WorktreeStart.newBranch, short, base: base);
}

/// With Worktree off, the new branch the folder moves to: a typed name no
/// local branch has.
String? newBranchHere(GitProjectInfo info, String? name) {
  final typed = name?.trim();
  return typed == null ||
          typed.isEmpty ||
          info.branches.any((b) => !b.remote && b.name == typed)
      ? null
      : typed;
}

/// The preparation a Git project's folder gets at Start.
ProjectFolderRequest? gitFolderRequest(
  String folder,
  GitProjectInfo info, {
  required bool worktree,
  required String? branchRef,
  required String? branchName,
  required String placeholder,
}) {
  final ref = branchRef ?? defaultBranchRef(info, worktree: worktree);
  if (!worktree) {
    if (newBranchHere(info, branchName) case final name?) {
      return ProjectFolderRequest.branch(
        folder,
        'refs/heads/$name',
        newBranch: name,
      );
    }
    return ref == null ? null : ProjectFolderRequest.branch(folder, ref);
  }
  final plan = planWorktree(
    info,
    base: ref,
    name: branchName,
    placeholder: placeholder,
  );
  return switch (plan.kind) {
    WorktreeStart.openWorktree => ProjectFolderRequest.branch(
      folder,
      'refs/heads/${plan.branch}',
    ),
    WorktreeStart.existingBranch => ProjectFolderRequest.worktree(
      folder,
      branchRef: 'refs/heads/${plan.branch}',
      branchName: plan.branch,
      existingBranch: true,
    ),
    WorktreeStart.newBranch ||
    WorktreeStart.unavailable => ProjectFolderRequest.worktree(
      folder,
      branchRef: plan.base,
      branchName: plan.branch,
      placeholder: plan.branch == placeholder,
    ),
  };
}

/// A creation buffer shared by the prompt and advanced options. It includes
/// the receipt of an unresolved request, so going back cannot start a duplicate.
@immutable
class NewHarnessDraft {
  const NewHarnessDraft({
    required this.machineId,
    required this.engine,
    required this.project,
    required this.task,
    required this.permissionMode,
    this.worktree,
    this.branchRef,
    this.branchName,
    this.placeholder,
    this.gitProject,
    this.profile,
    this.profileChosen = false,
    this.attempt,
    this.error,
    this.dismissalWarningShown = false,
    this.projectsByMachine = const {},
  });

  final String machineId, engine, task, permissionMode;
  final bool? worktree;

  /// The branch chosen in the launcher, and the name typed for a worktree's
  /// branch; null leaves either to [defaultBranchRef] and [placeholder].
  final String? branchRef, branchName, placeholder;
  final GitProjectInfo? gitProject;
  final NewHarnessProject project;
  final LocalCodexProfile? profile;
  final bool profileChosen;
  final AgentCreationAttempt? attempt;
  final String? error;
  // The visible "Escape again" message must keep the same meaning if the
  // unresolved prompt is dismissed and then restored.
  final bool dismissalWarningShown;
  final Map<String, NewHarnessProject> projectsByMachine;

  ProjectFolderRequest? get projectFolderRequest {
    final folder = project.folder;
    final terminal = isTerminalEngine(engine);
    final info = gitProject;
    if (folder != null && !terminal && info != null && info.isGit) {
      return gitFolderRequest(
        folder,
        info,
        worktree: worktree ?? worktreeByDefault(info),
        branchRef: branchRef,
        branchName: branchName,
        placeholder: placeholder ?? placeholderBranch(const []),
      );
    }
    return worktree == true && folder != null && !terminal
        ? ProjectFolderRequest.worktree(folder, branchRef: branchRef)
        : branchRef != null && folder != null && !terminal
        ? ProjectFolderRequest.branch(folder, branchRef!)
        : folder != null || terminal
        ? null
        : project.repository != null
        ? ProjectFolderRequest.remote(project.repository!)
        : project.generated ??
              ProjectFolderRequest.newProject(name: project.name);
  }
}

@immutable
class NewHarnessOption {
  const NewHarnessOption({
    required this.id,
    required this.title,
    this.detail = '',
    this.engine,
    this.project,
    this.profile,
    this.machineId,
    this.enabled = true,
    this.synthetic = false,
    this.risky = false,
    this.why,
  });

  /// A row the box adds rather than finds — "New project", "Use this folder".
  /// It is never a match, so it is in neither half of the `2 of 14`.
  final bool synthetic;

  /// A permission mode that disables the engine's safety checks.
  final bool risky;

  /// Why the row cannot be chosen, said when somebody tries.
  final String? why;

  /// An engine or harness id, a machine id, or a project token.
  final String id;
  final String title, detail;

  /// Whose mark the row wears, on the agent field.
  final String? engine;

  /// What choosing the row sets, on the project field.
  final NewHarnessProject? project;

  /// A profile folder on [machineId], never on an implicitly different host.
  final LocalCodexProfile? profile;

  /// A recent project chooses its machine and folder together.
  final String? machineId;
  final bool enabled;
}

enum NewHarnessOutcome { created, failed }

class NewHarnessController extends ChangeNotifier {
  NewHarnessController(
    this.app, {
    required String machineId,
    String? engine,
    String? folder,
    String? projectName,
    bool autoProject = false,
    DateTime Function()? now,
    String? task,
    NewHarnessDraft? draft,
    this.swarmId,
    this.split,
    HarnessPlacement? placement,
    this.offersStore = false,
    String? home,
    Random? random,
  }) : _random = random ?? Random(),
       placement =
           placement ?? (split == null ? HarnessPlacement.currentTab : null),
       _targetId = swarmId ?? app.activeSwarmId,
       _usesNewTabPage = app.swarms.any(
         (tab) => tab.id == (swarmId ?? app.activeSwarmId) && tab.isBlankNewTab,
       ),
       _machineId = draft?.machineId ?? machineId,
       _autoProject = autoProject || draft?.project.generated != null,
       _now = now ?? DateTime.now,
       _home = home ?? Platform.environment['HOME'] {
    final remembered = app.agentPreference.value;
    engine = draft?.engine ?? engine;
    _engine = _known(engine)
        ? engine!
        : _known(remembered)
        ? remembered!
        : allEngines.first.id;
    _project = projectName != null
        ? NewHarnessProject.fresh(projectName)
        : folder != null
        ? NewHarnessProject.folder(folder)
        : _autoProject
        ? _generatedProject()
        : const NewHarnessProject.fresh();
    if (task != null) this.task = task;
    _worktree = draft?.worktree;
    _branchRef = draft?.branchRef;
    _branchName = draft?.branchName;
    _placeholder = draft?.placeholder;
    _gitProject = draft?.gitProject ?? const GitProjectInfo();
    if (draft != null) {
      _projectsByMachine.addAll(draft.projectsByMachine);
      _project = draft.project;
      this.task = draft.task;
      _mode = draft.permissionMode;
      _profile = draft.profile;
      _profileChosen = draft.profileChosen;
      _attempt = draft.attempt;
      error = draft.error;
      _warnedAboutClosing = draft.dismissalWarningShown;
    }
    if ((projectName != null || _autoProject) &&
        !checking &&
        _project.folder == null &&
        _project.repository == null &&
        (_project.name?.isEmpty ?? true)) {
      _project = projectName != null
          ? NewHarnessProject.fresh(projectName)
          : _generatedProject();
    }
    // A missing project is the only required question. Carried tasks remain
    // part of the draft for Store examples and advanced options.
    field = needsProject && !checking
        ? NewHarnessField.projectMenu
        : NewHarnessField.launch;
    query = field == NewHarnessField.task ? this.task : '';
    if (!takesTask && this.task.trim().isNotEmpty && !checking) {
      error =
          '$agentLabel cannot start on a first message, so '
          '“${_short(this.task)}” will not be sent. Choose another agent to send it.';
    }
    app.addListener(_onApp);
    _refresh();
    unawaited(
      app.projectHistory.load().then((_) {
        if (!_disposed && !listEquals(_seen, _signature())) _refresh();
      }),
    );
    // What the machine has is asked when the box opens, as the form does: an
    // engine installed in a terminal a minute ago is otherwise still "missing".
    unawaited(app.probeEngines(_machineId, force: true));
    unawaited(app.probeDsh(_machineId, force: true));
    unawaited(_ensureHome(_machineId));
    unawaited(_refreshGeneratedProject());
  }

  final AppNotifier app;
  final String? swarmId;
  final PaneSplitRequest? split;
  final HarnessPlacement? placement;
  final String _targetId;
  final bool _usesNewTabPage;
  HarnessPlacement? get effectivePlacement =>
      placement == HarnessPlacement.newTab && _usesNewTabPage
      ? HarnessPlacement.currentTab
      : placement;

  final bool _autoProject;
  final DateTime Function() _now;
  final String? _home;

  late String _engine;
  String _machineId;
  late NewHarnessProject _project;
  final _projectsByMachine = <String, NewHarnessProject>{};
  final _homes = <String, String>{};
  final _homeRequests = <String, Future<String?>>{};
  int _machineRevision = 0;
  String get engine => _engine;
  String get machineId => _machineId;
  NewHarnessProject get project => _project;
  final Random _random;

  bool? _worktree;
  String? _branchRef, _branchName, _placeholder;
  GitProjectInfo _gitProject = const GitProjectInfo();
  (String, String?, bool)? _gitKey;
  Future<void>? _gitFuture;
  int _gitRevision = 0;
  bool checkingGit = false;
  Future<void> waitForGitProject() async {
    while (checkingGit && !_disposed) {
      await _gitFuture;
    }
  }

  bool get isGitProject => _gitProject.isGit && !isTerminal;
  bool get canUseWorktree => isGitProject && !checkingGit;
  bool get worktree =>
      isGitProject && (_worktree ?? worktreeByDefault(_gitProject));

  /// With Worktree on, what a new branch starts from; off, the branch the
  /// folder is on. Unchosen, the default for the mode.
  String? get branchRef =>
      _branchRef ?? defaultBranchRef(_gitProject, worktree: worktree);
  String? get gitError => _gitProject.error;
  String get branchLabel => _refName(branchRef) ?? 'Detached HEAD';
  String? _refName(String? ref) =>
      _gitProject.branches
          .where((branch) => branch.ref == ref)
          .firstOrNull
          ?.name ??
      ref?.replaceFirst(RegExp(r'^refs/(heads|remotes)/'), '');

  /// The branch a new worktree is on until its session names it: two words
  /// the daemon replaces with the session's name.
  String get placeholder => _placeholder ??= placeholderBranch([
    for (final branch in _gitProject.branches) branch.name,
  ], random: _random);
  WorktreePlan? get worktreePlan => worktree
      ? planWorktree(
          _gitProject,
          base: branchRef,
          name: _branchName,
          placeholder: placeholder,
        )
      : null;

  /// A branch with a worktree of its own, other than the project folder's.
  String? _worktreeOf(String? ref) => _gitProject.branches
      .where(
        (branch) =>
            branch.ref == ref &&
            branch.worktree != null &&
            branch.name != _gitProject.branch,
      )
      .firstOrNull
      ?.worktree;

  /// With Worktree off, the new branch Start makes for the folder.
  String? get _branchHere =>
      worktree ? null : newBranchHere(_gitProject, _branchName);

  /// The Branch row: what was picked, or the new branch typed there.
  String get branchRowLabel {
    // Its worktree is where the harness starts, not the project folder.
    if (opensWorktree) return '$branchLabel · in its worktree';
    final plan = worktreePlan;
    if (plan != null &&
        plan.kind == WorktreeStart.newBranch &&
        _branchName != null &&
        plan.branch == _branchName) {
      return '${plan.branch} · new from ${_refName(plan.base) ?? 'HEAD'}';
    }
    final name = _branchHere;
    return name == null
        ? branchLabel
        : '$name · new from ${_refName(currentBranchRef(_gitProject)) ?? 'HEAD'}';
  }

  /// Start goes into a worktree that already exists.
  bool get opensWorktree => worktree
      ? worktreePlan?.kind == WorktreeStart.openWorktree
      : _branchHere == null && _worktreeOf(branchRef) != null;

  /// What Start does with Git, in words for the summary and screen readers.
  String get gitSummary {
    if (!isGitProject) return '';
    final plan = worktreePlan;
    if (plan == null) {
      final here = _branchHere;
      return here != null
          ? ', on a new branch $here'
          : opensWorktree
          ? ', in the worktree of $branchLabel'
          : ', on $branchLabel';
    }
    return switch (plan.kind) {
      WorktreeStart.newBranch =>
        ', in a new worktree on ${plan.branch == placeholder ? 'a branch named after the session' : plan.branch} from ${_refName(plan.base) ?? 'HEAD'}',
      WorktreeStart.existingBranch => ', in a new worktree on ${plan.branch}',
      WorktreeStart.openWorktree => ', in the worktree of ${plan.branch}',
      WorktreeStart.unavailable =>
        ', but ${plan.branch} is the project folder’s branch',
    };
  }

  void toggleWorktree() {
    if (locked || !canUseWorktree) return;
    _worktree = !worktree;
    error = null;
    _refresh();
  }

  void retryGitProject() {
    if (locked || checkingGit || _project.folder == null || isTerminal) return;
    error = null;
    _gitFuture = _readGitProject(_gitKey!);
    notifyListeners();
  }

  void _syncGitProject() {
    final key = (_machineId, _project.folder, isTerminal);
    if (_gitKey == key) return;
    if (_gitKey != null) {
      _worktree = null;
      _branchRef = null;
      _branchName = null;
      _placeholder = null;
      _gitProject = const GitProjectInfo();
    }
    _gitKey = key;
    _gitRevision++;
    checkingGit = false;
    _gitFuture = null;
    if (key.$2 != null && !key.$3 && !checking) {
      _gitFuture = _readGitProject(key);
    }
  }

  Future<void> _readGitProject((String, String?, bool) key) async {
    checkingGit = true;
    final revision = ++_gitRevision;
    GitProjectInfo info;
    try {
      info = GitProjectInfo.fromJson(await app.readGitProject(key.$1, key.$2!));
    } catch (_) {
      info = const GitProjectInfo(error: 'UNAVAILABLE');
    }
    if (_disposed || _gitKey != key || revision != _gitRevision) return;
    checkingGit = false;
    // A worktree is a temporary folder, so the launcher shows its repository.
    // With Worktree off its branch stays chosen and Start reopens that
    // worktree; otherwise new work starts from the repository's own branch.
    if (info.mainFolder case final main? when _project.folder == key.$2) {
      if (_worktree == false && _branchRef == null && info.branch != null) {
        _branchRef = 'refs/heads/${info.branch}';
      }
      _project = NewHarnessProject.folder(main);
      _gitKey = (key.$1, main, key.$3);
      info = GitProjectInfo(
        isGit: true,
        branch: info.mainBranch,
        branches: info.branches,
        defaultRef: info.defaultRef,
      );
    }
    _gitProject = info;
    // A name made up before the branches were known may already be taken.
    if (_placeholder != null &&
        info.branches.any((branch) => branch.name == _placeholder)) {
      _placeholder = null;
    }
    _refresh();
  }

  LocalCodexProfile? _profile;
  bool _profileChosen = false;
  String? get profileLabel =>
      _base == 'codex' && (_profileChosen || _profile != null)
      ? _profile?.label ?? 'Default'
      : null;

  NewHarnessDraft get draft => NewHarnessDraft(
    machineId: _machineId,
    engine: _engine,
    project: _project,
    task: task,
    permissionMode: _mode,
    worktree: _worktree,
    branchRef: _branchRef,
    branchName: _branchName,
    placeholder: isGitProject ? placeholder : _placeholder,
    gitProject: _gitProject,
    profile: _profile,
    profileChosen: _profileChosen,
    attempt: _attempt,
    error: error,
    dismissalWarningShown: _warnedAboutClosing,
    projectsByMachine: Map.unmodifiable({
      ..._projectsByMachine,
      _machineId: _project,
    }),
  );

  /// The same preparation intent is used by the prompt and advanced options.
  ProjectFolderRequest? get projectFolderRequest =>
      isGitProject && _project.folder != null
      ? gitFolderRequest(
          _project.folder!,
          _gitProject,
          worktree: worktree,
          branchRef: _branchRef,
          branchName: _branchName,
          placeholder: placeholder,
        )
      : _project.folder != null || isTerminal
      ? null
      : _project.repository != null
      ? ProjectFolderRequest.remote(_project.repository!)
      : _project.generated ??
            ProjectFolderRequest.newProject(name: _project.name);

  NewHarnessField field = NewHarnessField.agent;
  final bool offersStore;
  String query = '';

  /// The harness's first message, sent exactly as written as it starts. Empty
  /// starts it with nothing sent. Kept while the other answers are changed.
  String task = '';

  /// The permission mode picked, by id; an engine without it uses its default.
  String _mode = kDefaultPermissionMode;

  /// The engine a choice launches: a store harness runs ON one of them.
  String _baseOf(String engine) => isHarnessId(engine)
      ? _machine?.dsh[engine]?.engine ??
            knownHarnessBase[canonicalHarnessId(engine)] ??
            'claude'
      : engine;
  String get _base => _baseOf(_engine);

  // Browsing previews an engine without changing the launch draft. Keep that
  // engine while its settings are open in a child picker.
  String? _agentPreview;
  String get _settingsEngine => _agentPreview ?? _engine;
  String get agentSettingsLabel => labelOf(_settingsEngine);
  LocalCodexProfile? get _settingsProfile =>
      _settingsEngine == _engine ? _profile : null;
  List<PermissionMode> get _settingsModes =>
      permissionModesOf(_baseOf(_settingsEngine));
  String get _settingsMode => _settingsModes.any((mode) => mode.id == _mode)
      ? _mode
      : kDefaultPermissionMode;
  bool get takesTask => takesFirstTask(_base);
  bool get taskTooLong => task.trim().length > kFirstTaskMaxLength;
  List<PermissionMode> get _modes =>
      isTerminal ? const [] : permissionModesOf(_base);
  bool get hasModes => _modes.isNotEmpty;
  String get mode =>
      _modes.any((mode) => mode.id == _mode) ? _mode : kDefaultPermissionMode;
  String get modeLabel =>
      _modes.where((m) => m.id == mode).firstOrNull?.label ?? mode;
  bool get riskyMode => _modes.any((m) => m.id == mode && m.risky);
  bool get usesProfile => _base == 'codex';
  bool get hasProfile => _baseOf(_settingsEngine) == 'codex';
  bool get supportsProfiles =>
      hasProfile && _machine?.engines['codex']?.supportsCodexHome == true;
  String? get profileHelp => supportsProfiles
      ? null
      : _machine?.engines.loaded == true
      ? 'Update Harness CLI on $machineLabel to choose a Codex profile.'
      : 'Checking Codex profile support on $machineLabel…';

  /// Settings are offered separately so browsing never inserts list rows.
  List<NewHarnessOption> agentSettingsFor(String engine) {
    final modes = permissionModesOf(_baseOf(engine));
    final mode =
        modes.where((mode) => mode.id == _mode).firstOrNull ??
        modes.where((mode) => mode.id == kDefaultPermissionMode).firstOrNull;
    return [
      if (mode != null)
        NewHarnessOption(
          id: permissionsId,
          title: 'Permissions',
          detail: mode.label,
          synthetic: true,
        ),
      if (_baseOf(engine) == 'codex')
        NewHarnessOption(
          id: profileId,
          title: 'Codex Profile',
          detail: engine == _engine ? profileLabel ?? 'Default' : 'Default',
          synthetic: true,
        ),
    ];
  }

  void openAgentSetting(String engine, String setting) {
    if (locked ||
        field != NewHarnessField.agent ||
        !options.any((row) => row.engine == engine) ||
        !agentSettingsFor(engine).any((row) => row.id == setting)) {
      return;
    }
    _agentPreview = engine;
    focusField(
      setting == profileId ? NewHarnessField.profile : NewHarnessField.mode,
      previewAgent: true,
    );
  }

  /// The arguments exposed by the launch menu. Machine sets the context;
  /// permissions and profiles belong to the selected agent's picker.
  List<NewHarnessField> get fields => [
    NewHarnessField.agent,
    NewHarnessField.machine,
    NewHarnessField.projectMenu,
    if (isGitProject) NewHarnessField.branch,
  ];
  bool _supportsField(NewHarnessField value) =>
      fields.contains(value) ||
      value == NewHarnessField.launch ||
      (value == NewHarnessField.task && takesTask) ||
      value == NewHarnessField.project ||
      value == NewHarnessField.projectName ||
      value == NewHarnessField.projectRepository ||
      value == NewHarnessField.machine ||
      (value == NewHarnessField.mode && _settingsModes.isNotEmpty) ||
      (value == NewHarnessField.profile && hasProfile);

  NewHarnessField get nextMainField => field == NewHarnessField.machine
      ? NewHarnessField.projectMenu
      : fields[(fields.indexOf(field) + 1) % fields.length];
  int cursor = 0;
  List<NewHarnessOption> options = const [];

  /// How many things the field has before what was typed narrowed them, and
  /// how many are left: the `2 of 14` beside the input. Rows the box adds
  /// itself are in neither number — "1 of 0" was the count lying.
  int total = 0;
  int matchCount = 0;

  /// A folder's listing has been asked for and has not come back: the list is
  /// not empty, it is not here yet, and the two must not read the same.
  bool get listing => _listing != null;
  bool busy = false;
  String? status;
  String? error;
  bool _disposed = false;

  /// Folder listings for path completion, by the folder that was listed.
  final _listings = <String, List<String>>{};
  String? _listing;

  bool _known(String? id) =>
      id != null &&
      (isTerminalEngine(id) ||
          isHarnessId(id) ||
          allEngines.any((identity) => identity.id == id));

  MachineState? get _machine => app.stateOf(_machineId);
  bool get isTerminal => isTerminalEngine(_engine);
  bool get needsProject =>
      !isTerminal &&
      _project.folder == null &&
      _project.repository == null &&
      projectFolderSlug(_project.name ?? '') == null;

  // ---- what the line says -------------------------------------------------

  /// The same on every New Harness: where Start goes is said by the Branch row,
  /// not by a button that changes its name.
  String get createLabel => 'Start Harness';

  String get agentLabel => labelOf(_engine);
  String labelOf(String id) => currentHarnessName(
    id,
    _machine?.dsh[id]?.name ??
        (id == 'claude' ? 'Claude Code' : engineIdentity(id).label),
  );

  String get machineLabel => _machineLabel(_machineId);
  String _machineLabel(String id) =>
      app.stateOf(id)?.machine.displayName ?? 'No machine';

  String get projectLabel {
    final project = _project;
    if (project.folder case final folder?) return tildePath(folder);
    if (project.repository case final repo?) return '~/harnesses/${repo.name}';
    if (isTerminal) return '~';
    final name = project.name == null ? null : projectFolderSlug(project.name!);
    return name == null ? '~/harnesses' : '~/harnesses/$name';
  }

  String get projectLocation => needsProject
      ? 'Choose a project on $machineLabel'
      : '$machineLabel:$projectLabel';

  String location(String path, [String? machineId]) {
    final id = machineId ?? _machineId;
    return '${_machineLabel(id)}:${tildePath(path, id)}';
  }

  String? _homeOf(String id) =>
      app.stateOf(id)?.isLocalMachine == true ? _home : _homes[id];

  String tildePath(String path, [String? machineId]) {
    final home = _homeOf(machineId ?? _machineId);
    if (home == null) return path;
    return path == home
        ? '~'
        : path.startsWith('$home/')
        ? '~${path.substring(home.length)}'
        : path;
  }

  String get hint => switch (field) {
    NewHarnessField.launch => '',
    NewHarnessField.projectMenu => 'Find a project by name or path',
    NewHarnessField.task => 'What should this agent work on? (optional)',
    NewHarnessField.agent => 'Choose an agent',
    NewHarnessField.machine => 'Choose a machine',
    NewHarnessField.branch => 'Search branches',
    NewHarnessField.project => 'Folder path',
    NewHarnessField.projectName => 'Project name',
    NewHarnessField.projectRepository => 'GitHub URL',
    NewHarnessField.mode => 'How much it may do without asking',
    NewHarnessField.profile => 'Find a Codex profile',
  };

  // ---- moving along the line ----------------------------------------------

  ({NewHarnessField field, String query, String? agentPreview}) _machineOrigin =
      (field: NewHarnessField.launch, query: '', agentPreview: null);

  void focusField(NewHarnessField next, {bool previewAgent = false}) {
    if (locked) return;
    // Form fields edit the saved agent. Only an explicit nested setting may
    // use the agent currently being previewed in the choices list.
    if (!previewAgent) _agentPreview = null;
    if (field == next || !_supportsField(next)) return;
    if (next == NewHarnessField.machine) {
      _machineOrigin = (
        field: field,
        query: query,
        agentPreview: _agentPreview,
      );
    }
    if (next == NewHarnessField.mode || next == NewHarnessField.profile) {
      _agentSettingsOrigin = (
        field: field == NewHarnessField.agent
            ? NewHarnessField.agent
            : NewHarnessField.launch,
        query: field == NewHarnessField.agent ? query : '',
      );
    } else {
      _agentPreview = null;
    }
    if (field == NewHarnessField.projectMenu) _projectFilter = query;
    if (next == NewHarnessField.projectMenu &&
        field == NewHarnessField.launch) {
      _projectFilter = '';
    }
    field = next;
    _editingSuggestedProject =
        next == NewHarnessField.projectName && _project.generated != null;
    _cycle = null;
    _steered = false;
    // Keep the task and a Project filter when returning from a child prompt.
    // A fresh visit from the launch menu starts with all recent projects.
    query = next == NewHarnessField.task
        ? task
        : next == NewHarnessField.projectName
        ? _project.name ?? ''
        : next == NewHarnessField.projectMenu
        ? _projectFilter
        : '';
    error = null;
    _refresh();
  }

  void nextField([int step = 1]) {
    if (field == NewHarnessField.machine) {
      _returnToProject();
      return;
    }
    final line = fields;
    final at = line.indexOf(field);
    focusField(line[((at < 0 ? 0 : at) + step) % line.length]);
  }

  void setQuery(String value) {
    if (locked || field == NewHarnessField.launch || query == value) {
      return;
    }
    if (field == NewHarnessField.projectName) _editingSuggestedProject = false;
    if (field == NewHarnessField.task) {
      task = query = value;
      error = taskTooLong
          ? 'A first message can be $kFirstTaskMaxLength characters; '
                'this is ${value.trim().length}.'
          : null;
      notifyListeners();
      return;
    }
    // A completion menu's `/`: with a folder highlighted, typing a slash takes
    // that folder and goes into it, rather than the half-typed stem before it.
    if (field == NewHarnessField.project &&
        _isPath(query) &&
        value == '$query/' &&
        !query.endsWith('/')) {
      final folder = selected?.project?.folder;
      final slash = query.lastIndexOf('/');
      if (folder != null &&
          slash >= 0 &&
          selected!.detail.startsWith('Use ') == false) {
        value = '${query.substring(0, slash + 1)}${selected!.title}/';
      }
    }
    // Typing ends a Tab walk: the list goes back to following what is typed.
    _cycle = null;
    query = value;
    error = null;
    _refresh(resetCursor: true);
    // A filter's top row is the person's: they typed what put it there.
    _steered = value.trim().isNotEmpty;
  }

  /// Only an explicitly highlighted result may override a launch argument
  /// when using the quick-start shortcut from a picker.
  bool _steered = false;

  /// The arrows end a Tab walk: the line goes back to what was typed and the
  /// highlight is the arrows' again. Left set, the walk outranked them — the
  /// next app tick or folder listing yanked the highlight back to its row.
  void _endCycle() {
    final cycle = _cycle;
    if (cycle == null) return;
    _cycle = null;
    query = '${cycle.typedParent}${cycle.stem}';
  }

  /// Escape during a Tab walk gives back what was typed, as vim's wildmenu
  /// does, before it closes anything. Whether there was a walk to end.
  bool endCompletion() {
    if (_cycle == null || locked) return false;
    _endCycle();
    _refresh();
    return true;
  }

  void move(int delta) {
    if (options.isEmpty || locked) return;
    _endCycle();
    cursor = (cursor + delta) % options.length;
    _steered = true;
    if (field == NewHarnessField.agent) {
      _refresh();
      return;
    }
    notifyListeners();
  }

  /// ← and → change the focused field's value where it stands, as a BIOS
  /// settings screen does, rather than opening a list to choose from. Unlike
  /// [accept] the line keeps its field, so the next arrow steps again, and
  /// the rows the box adds for itself — Browse, New project, Permissions —
  /// are skipped: they are doors, not values.
  /// The values a field can be stepped through, in a stable order. The
  /// displayed list is NOT that order: it re-ranks so the chosen row floats
  /// to the front, which makes stepping by index walk in circles — right
  /// always took the second row and left always wrapped to the last.
  List<NewHarnessOption> stepValues() => [
    for (final option in options)
      if (!option.synthetic && option.enabled) option,
  ];

  /// Take [option] as this field's value without moving off the field.
  /// Synthetic rows are allowed here even though [stepValues] leaves them
  /// out: "Create branch x" is a real answer to the Branch row, it is only
  /// not one the arrows should cycle onto.
  void applyOption(NewHarnessOption option) {
    if (locked || !option.enabled) return;
    error = null;
    _steered = true;
    _apply(option);
    _refresh();
  }

  /// Take what the field is highlighting as its value, where it stands.
  /// Typing narrows a field and lands on a row; this is what makes that row
  /// the answer, so the value on screen is always the one Return acts on.
  void takeSelection() {
    final option = selected;
    if (locked || option == null || option.synthetic || !option.enabled) {
      return;
    }
    _apply(option);
    _refresh();
  }

  NewHarnessOption? get selected =>
      cursor < 0 || cursor >= options.length ? null : options[cursor];

  /// The answers cannot change: a create is running, or one whose reply was
  /// lost has still to be checked on.
  bool get locked => busy || checking || linkingProfile;

  /// Lists always choose. The launch menu and optional task prompt start.
  bool get returnCreates =>
      checking ||
      field == NewHarnessField.launch ||
      field == NewHarnessField.task;

  /// Whether [option] is the answer the line already gives — the row that
  /// wears the ✓, as the current folder and branch do in an editor's pickers.
  bool isCurrent(NewHarnessOption option) => switch (field) {
    NewHarnessField.launch || NewHarnessField.task => false,
    NewHarnessField.agent => option.id == _engine,
    NewHarnessField.machine => option.id == _machineId,
    NewHarnessField.branch => option.id == branchRef,
    NewHarnessField.project ||
    NewHarnessField.projectMenu ||
    NewHarnessField.projectName ||
    NewHarnessField.projectRepository =>
      option.project != null &&
          (option.machineId ?? _machineId) == _machineId &&
          option.project == _project,
    NewHarnessField.mode => option.id == _settingsMode,
    NewHarnessField.profile =>
      option.id ==
          (_settingsProfile == null
              ? defaultProfileId
              : 'profile:${_settingsProfile!.path}'),
  };
  bool _isCurrent(NewHarnessOption option) => isCurrent(option);

  /// The project row that opens the system's folder chooser: the way in for
  /// anyone who would rather point at a folder than type its path.
  static const browseId = 'project:browse';
  static const changeMachineId = 'project:machine';
  static const newProjectId = 'project:name';
  static const createBranchId = 'branch:create:';
  static const existingProjectId = 'project:existing';
  static const repositoryId = 'project:repository';
  static const storeId = 'agent:store';
  static const permissionsId = 'agent:permissions';
  static const profileId = 'agent:profile';
  static const defaultProfileId = 'profile:default';
  static const refreshProfilesId = 'profile:refresh';
  static const linkProfileId = 'profile:link';
  static const _store = NewHarnessOption(
    id: storeId,
    synthetic: true,
    title: 'Browse more harnesses…',
    detail: 'Harness Store',
  );

  // For anyone who would rather point at a folder than type its path. It stays
  // under whatever is typed: the way out must not vanish on the first key.
  NewHarnessOption get _browse =>
      NewHarnessOption(id: browseId, synthetic: true, title: 'Browse Folder');

  NewHarnessOption get _changeMachine => NewHarnessOption(
    id: changeMachineId,
    synthetic: true,
    title: 'Change Machine',
    detail: machineLabel,
  );

  List<NewHarnessOption> _projectMenu() => [
    const NewHarnessOption(
      id: repositoryId,
      synthetic: true,
      title: 'Clone Repository',
      detail: 'Paste a GitHub repository URL',
    ),
    const NewHarnessOption(
      id: existingProjectId,
      synthetic: true,
      title: 'Open Folder',
      detail: 'Enter a path or browse folders',
    ),
    const NewHarnessOption(
      id: newProjectId,
      synthetic: true,
      title: 'New Project',
      detail: 'Name a new folder',
    ),
    ..._ranked(_recentProjects()),
  ];

  /// Takes the highlighted row as this field's answer and moves along.
  void accept([NewHarnessOption? row]) {
    final option = row ?? selected;
    if (locked || option?.id == storeId) return;
    if (option?.id == permissionsId) {
      focusField(NewHarnessField.mode, previewAgent: true);
      return;
    }
    if (option?.id == profileId) {
      focusField(NewHarnessField.profile, previewAgent: true);
      return;
    }
    if (option?.id == refreshProfilesId) {
      unawaited(refreshProfiles());
      return;
    }
    if (option?.id == linkProfileId) return;
    if (option?.id == changeMachineId) {
      focusField(NewHarnessField.machine);
      return;
    }
    if (option?.id == newProjectId) {
      focusField(NewHarnessField.projectName);
      return;
    }
    if (option?.id == existingProjectId) {
      focusField(NewHarnessField.project);
      return;
    }
    if (option?.id == repositoryId) {
      focusField(NewHarnessField.projectRepository);
      return;
    }
    if (option?.id == browseId) return;
    if (option == null) {
      // Return is never silent: nothing matched, so say so and how to go on.
      error = field == NewHarnessField.projectName && query.trim().isEmpty
          ? 'Type a project name.'
          : field == NewHarnessField.projectRepository
          ? 'Enter a GitHub URL or a short name like openai/codex.'
          : listing
          ? 'Still reading that folder…'
          : field == NewHarnessField.project && _isPath(query)
          ? 'No folder matches “${query.trim()}”.'
          : 'Nothing matches “${query.trim()}”. Edit it, or press Escape to go back.';
      notifyListeners();
      return;
    }
    if (!option.enabled) {
      // A key that silently does nothing is the worst answer: say why.
      error = option.why ?? '${option.title} cannot be chosen.';
      notifyListeners();
      return;
    }
    if (field == NewHarnessField.profile && option.machineId != _machineId) {
      warn('Choose a Codex profile on $machineLabel. The machine has changed.');
      return;
    }
    if ((field == NewHarnessField.projectMenu ||
            field == NewHarnessField.project ||
            field == NewHarnessField.projectName ||
            field == NewHarnessField.projectRepository) &&
        option.machineId != null &&
        option.machineId != _machineId) {
      warn('Choose a project on $machineLabel. The machine has changed.');
      return;
    }
    final from = field;
    final previousMachine = _machineId;
    _apply(option);
    _cycle = null;
    if (from == NewHarnessField.machine) {
      _returnFromMachine(changed: previousMachine != _machineId);
      return;
    }
    if (from == NewHarnessField.mode || from == NewHarnessField.profile) {
      _returnFromAgentSettings(accepted: true);
      return;
    }
    _agentPreview = null;
    field = needsProject ? NewHarnessField.projectMenu : NewHarnessField.launch;
    query = '';
    _refresh(resetCursor: true);
  }

  /// The folder the system chooser (or the remote browser) came back with.
  void setFolder(String folder) {
    if (locked) return;
    _project = NewHarnessProject.folder(folder);
    field = NewHarnessField.launch;
    _cycle = null;
    query = field == NewHarnessField.task ? task : '';
    error = null;
    _refresh(resetCursor: true);
  }

  /// ⌘↵: make it now — WITH the row under the highlight. Creating with the
  /// old answer while a different one was lit threw away the one thing the
  /// person had just done.
  Future<NewHarnessOutcome> createNow() {
    if (!locked &&
        (field == NewHarnessField.projectMenu ||
            field == NewHarnessField.machine ||
            field == NewHarnessField.mode ||
            field == NewHarnessField.profile ||
            selected?.id == permissionsId ||
            selected?.id == profileId ||
            selected?.id == changeMachineId ||
            selected?.id == newProjectId)) {
      accept();
      return Future.value(NewHarnessOutcome.failed);
    }
    if (!locked && !returnCreates && selected == null) {
      accept();
      return Future.value(NewHarnessOutcome.failed);
    }
    if (!locked && selected?.id == browseId) {
      return Future.value(_fail('Choose a folder to continue.'));
    }
    if (selected?.id == storeId && !locked) {
      return Future.value(_fail('Choose a harness from the Store first.'));
    }
    // Only a row the person went to: see [_steered].
    final option = _steered ? selected : null;
    if (!checking && !busy && option != null && !option.enabled) {
      // Never make it with the OLD answer while a different one is lit.
      if (!returnCreates) {
        return Future.value(
          _fail(option.why ?? '${option.title} cannot be chosen.'),
        );
      }
    }
    if (!checking && !busy && option != null && option.enabled) {
      if (!returnCreates) {
        _apply(option);
        _cycle = null;
        query = '';
        _refresh(resetCursor: true);
      }
    }
    return create();
  }

  void _apply(NewHarnessOption option) {
    switch (field) {
      case NewHarnessField.agent:
        _selectEngine(option.id);
      case NewHarnessField.machine:
        _selectMachine(option.id);
      case NewHarnessField.branch:
        if (option.id.startsWith(createBranchId)) {
          _branchName = option.id.substring(createBranchId.length);
          _branchRef = null;
        } else {
          // A picked branch replaces a new one.
          _branchRef = option.id;
          _branchName = null;
        }
      case NewHarnessField.project:
      case NewHarnessField.projectMenu:
      case NewHarnessField.projectName:
      case NewHarnessField.projectRepository:
        if (option.machineId case final id?) _selectMachine(id);
        _project = option.project ?? _project;
      case NewHarnessField.mode:
        _selectEngine(_settingsEngine);
        _mode = option.id;
      case NewHarnessField.profile:
        _selectEngine(_settingsEngine);
        _profile = option.profile;
        _profileChosen = true;
      case NewHarnessField.task:
      case NewHarnessField.launch:
        break;
    }
  }

  void _selectEngine(String engine) {
    final changed = engine != _engine;
    if (_engine != engine) {
      _profile = null;
      _profileChosen = false;
      _resetProfiles();
    }
    _engine = engine;
    if (changed &&
        _project.generated != null &&
        field != NewHarnessField.projectName) {
      _project = _generatedProject();
      unawaited(_refreshGeneratedProject());
    }
    _dropAccepted = false;
    if (!takesTask && task.trim().isNotEmpty) {
      error =
          '${labelOf(engine)} cannot start on a first message, so '
          '“${_short(task)}” will not be sent. Type it once it is open.';
    }
  }

  void _selectMachine(String id) {
    if (_machineId == id) return;
    _projectsByMachine[_machineId] = _project;
    _machineId = id;
    _projectFilter = '';
    _project =
        _projectsByMachine[id] ??
        (_autoProject ? _generatedProject() : const NewHarnessProject.fresh());
    _profile = null;
    _profileChosen = false;
    _agentPreview = null;
    _resetProfiles();
    _machineRevision++;
    _listDebounce?.cancel();
    _listings.clear();
    _listing = null;
    _pathKey = null;
    unawaited(app.probeEngines(id, force: true));
    unawaited(app.probeDsh(id, force: true));
    unawaited(_ensureHome(id));
    unawaited(_refreshGeneratedProject());
  }

  NewHarnessProject _generatedProject() => NewHarnessProject.generated(
    ProjectFolderRequest.generated(
      label: _machine?.dsh[_engine]?.name ?? engineIdentity(_engine).label,
      at: _now(),
    ),
  );

  /// Offer an unused name without creating anything. Start still reserves the
  /// folder atomically, including when two previews saw the same free name.
  Future<void> _refreshGeneratedProject() async {
    final project = _project;
    final request = project.generated;
    if (request == null) return;
    final id = _machineId;
    final revision = _machineRevision;
    try {
      final home = await _ensureHome(id);
      if (home == null) return;
      final root = p.join(home, 'harnesses');
      final List<String> names;
      if (app.stateOf(id)?.isLocalMachine == true) {
        names = await Isolate.run(
          () =>
              Directory(root)
                  .listSync(followLinks: false)
                  .map((entry) => p.basename(entry.path))
                  .toList(),
        );
      } else {
        final answer = await app.listRemoteFolder(id, root);
        final entries = answer['entries'];
        if (entries is! List) return;
        names = [
          for (final entry in entries)
            if (entry is Map && entry['name'] is String)
              entry['name'] as String,
        ];
      }
      if (_disposed ||
          locked ||
          id != _machineId ||
          revision != _machineRevision ||
          field == NewHarnessField.projectName ||
          !identical(project, _project)) {
        return;
      }
      final name = request.availableGeneratedName(names);
      if (name == project.name) return;
      _project = NewHarnessProject.generated(request.withGeneratedName(name));
      _refresh();
    } catch (_) {
      // Missing or unreadable listings are not permission to reuse a folder.
      // The exclusive reservation at Start remains authoritative.
    }
  }

  ({NewHarnessField field, String query}) _agentSettingsOrigin = (
    field: NewHarnessField.launch,
    query: '',
  );

  void _returnFromAgentSettings({bool accepted = false}) {
    final engine = _settingsEngine;
    field = _agentSettingsOrigin.field;
    query = _agentSettingsOrigin.query;
    if (accepted && field == NewHarnessField.launch && needsProject) {
      field = NewHarnessField.projectMenu;
      query = '';
    }
    _cycle = null;
    error = null;
    _refresh(resetCursor: true, agentSelection: engine);
  }

  List<LocalCodexProfile> _profiles = const [];
  String? _profilesMachine;
  int _profileRevision = 0;
  int _profileRequest = 0;
  bool loadingProfiles = false;
  bool linkingProfile = false;

  void _resetProfiles() {
    _profiles = const [];
    _profilesMachine = null;
    _profileRevision++;
    _profileRequest++;
    loadingProfiles = linkingProfile = false;
  }

  Future<void> refreshProfiles() async {
    if (_disposed || locked || loadingProfiles || !supportsProfiles) return;
    final machine = _machineId;
    final revision = _profileRevision;
    final request = ++_profileRequest;
    bool current() =>
        !_disposed &&
        revision == _profileRevision &&
        request == _profileRequest;
    _profilesMachine = machine;
    loadingProfiles = true;
    error = null;
    _refresh();
    try {
      final result = await app.listCodexProfiles(
        machine,
        observedPaths: {
          for (final agent in _machine?.agents ?? const [])
            if (agent.engine == 'codex' && agent.codexHome != null)
              agent.codexHome!,
        },
      );
      if (!current()) return;
      if (result['error'] != null) throw StateError('Profiles unavailable');
      _profiles = [
        for (final raw in result['profiles'] as List? ?? const [])
          LocalCodexProfile.fromJson(Map<String, dynamic>.from(raw as Map)),
      ];
    } catch (_) {
      if (current() && field == NewHarnessField.profile) {
        error =
            'Could not load Codex profiles on $machineLabel. Choose Refresh profiles to retry.';
      }
    } finally {
      if (current()) {
        loadingProfiles = false;
        _refresh();
      }
    }
  }

  Future<void> linkProfile(String path) async {
    if (_disposed ||
        locked ||
        !supportsProfiles ||
        field != NewHarnessField.profile) {
      return;
    }
    final revision = _profileRevision;
    bool current() => !_disposed && revision == _profileRevision;
    linkingProfile = true;
    error = null;
    _refresh();
    try {
      final result = await app.linkCodexProfile(_machineId, path);
      if (!current()) return;
      if (result['error'] != null || result['profile'] is! Map) {
        throw StateError('Profile unavailable');
      }
      _selectEngine(_settingsEngine);
      _profile = LocalCodexProfile.fromJson(
        Map<String, dynamic>.from(result['profile'] as Map),
      );
      _profileChosen = true;
      _profiles = [..._profiles, _profile!];
      linkingProfile = false;
      _returnFromAgentSettings(accepted: true);
    } catch (_) {
      if (current()) {
        error =
            'Could not link this Codex profile folder on $machineLabel. Try another folder.';
      }
    } finally {
      if (current()) {
        linkingProfile = false;
        _refresh();
      }
    }
  }

  List<NewHarnessOption> _profileOptions() {
    final choices = <String, LocalCodexProfile>{
      if (supportsProfiles) ...{
        for (final profile in [..._profiles, ?_settingsProfile])
          profile.path: profile,
      },
    };
    return [
      if (supportsProfiles) ...[
        const NewHarnessOption(
          id: linkProfileId,
          title: 'Link profile folder…',
          synthetic: true,
        ),
        NewHarnessOption(
          id: refreshProfilesId,
          title: loadingProfiles ? 'Loading profiles…' : 'Refresh profiles',
          synthetic: true,
          enabled: !loadingProfiles,
        ),
      ],
      ..._ranked([
        NewHarnessOption(
          id: defaultProfileId,
          title: 'Default profile',
          detail: 'Use Codex’s default account on $machineLabel',
          machineId: _machineId,
        ),
        for (final profile in choices.values)
          NewHarnessOption(
            id: 'profile:${profile.path}',
            title: profile.label,
            detail: profile.path,
            profile: profile,
            machineId: _machineId,
          ),
      ]),
    ];
  }

  String _projectFilter = '';
  bool _editingSuggestedProject = false;

  void _returnToProject() {
    field = NewHarnessField.projectMenu;
    query = _projectFilter;
    _cycle = null;
    error = null;
    _refresh(resetCursor: true);
  }

  void _returnFromMachine({bool changed = false}) {
    field = _machineOrigin.field;
    _agentPreview = _machineOrigin.agentPreview;
    // A path filter belongs to its machine; a task, name, or URL can travel.
    query =
        changed &&
            (field == NewHarnessField.project ||
                field == NewHarnessField.projectMenu)
        ? ''
        : _machineOrigin.query;
    _cycle = null;
    error = null;
    _refresh(resetCursor: true, agentSelection: _agentPreview);
  }

  /// Escape closes a nested machine chooser before it closes the agent draft.
  bool backToProject() {
    if (locked ||
        (field != NewHarnessField.machine &&
            field != NewHarnessField.project &&
            field != NewHarnessField.projectName &&
            field != NewHarnessField.projectRepository)) {
      return false;
    }
    _returnToProject();
    return true;
  }

  /// Escape leaves the focused prompt before dismissing the launch command.
  /// Uncommitted filters are discarded; the task and accepted arguments stay.
  bool back() {
    if (locked) return false;
    if (field == NewHarnessField.machine) {
      _returnFromMachine();
      return true;
    }
    if (field == NewHarnessField.mode || field == NewHarnessField.profile) {
      _returnFromAgentSettings();
      return true;
    }
    if (endCompletion() || backToProject()) return true;
    if (field == NewHarnessField.launch) return false;
    focusField(NewHarnessField.launch);
    return true;
  }

  static String _short(String text) {
    final one = text.trim().replaceAll(RegExp(r'\s+'), ' ');
    return one.length <= 40 ? one : '${one.substring(0, 39)}…';
  }

  /// Tab is walking a completion menu: the stem that was typed, and the
  /// candidate the line currently holds. Typing anything ends it.
  ({String typedParent, String stem, String name})? _cycle;

  /// Tab completes the current argument without accepting it or changing
  /// prompts. Paths retain common-prefix expansion and reversible cycling.
  String? complete([int step = 1]) {
    if (locked) return null;
    if (!isPathQuery) {
      if (field == NewHarnessField.task ||
          field == NewHarnessField.launch ||
          field == NewHarnessField.projectName ||
          field == NewHarnessField.projectRepository) {
        return null;
      }
      final option = selected;
      if (option != null && !option.synthetic) {
        setQuery(option.title);
        _steered = true;
      }
      return query;
    }
    final slash = query.lastIndexOf('/');
    final typedParent =
        _cycle?.typedParent ?? (slash < 0 ? '' : query.substring(0, slash + 1));
    final stem =
        _cycle?.stem ?? (slash < 0 ? query : query.substring(slash + 1));
    // The folders under what was typed; "Use this folder" is not a candidate.
    final names = [
      for (final option in options)
        if (!option.synthetic) option.title,
    ];
    if (names.isEmpty) return query;
    if (_cycle case final cycle?) {
      final at = names.indexOf(cycle.name);
      final next = names[(at + step) % names.length];
      return _showCandidate(typedParent, stem, next);
    }
    var common = names.first;
    for (final name in names.skip(1)) {
      var i = 0;
      while (i < common.length &&
          i < name.length &&
          common[i].toLowerCase() == name[i].toLowerCase()) {
        i++;
      }
      common = common.substring(0, i);
    }
    if (names.length == 1) {
      final text = '$typedParent${names.single}/';
      setQuery(text);
      return text;
    }
    if (common.length > stem.length) {
      final text = '$typedParent$common';
      setQuery(text);
      return text;
    }
    return _showCandidate(
      typedParent,
      stem,
      step < 0 ? names.last : names.first,
    );
  }

  String _showCandidate(String typedParent, String stem, String name) {
    _cycle = (typedParent: typedParent, stem: stem, name: name);
    query = '$typedParent$name';
    error = null;
    _refresh();
    _steered = true;
    return query;
  }

  // ---- the lists ----------------------------------------------------------

  /// What of the app this box shows, and nothing else. The app notifies on
  /// every turn heartbeat and every terminal byte; none of that is on this
  /// screen, and rebuilding each list — and the panel with it — for each was
  /// work done many times a second for nothing. Same idea as the search
  /// catalog's presentation key.
  List<Object?>? _seen;
  List<Object?> _signature() {
    final machine = _machine;
    return [
      for (final state in app.machineStates.values) ...[
        state.machine.machineId,
        state.machine.displayName,
        state.machine.isShared,
        state.isLocalMachine,
        state.needsLink,
        state.nodeOnline,
      ],
      machine?.engines.loaded,
      for (final identity in allEngines)
        machine?.engines[identity.id]?.installed,
      machine?.engines['codex']?.supportsCodexHome,
      machine?.dsh.loaded,
      machine?.dsh.error,
      for (final entry in machine?.dsh.entries ?? const <DshEntry>[]) ...[
        entry.id,
        entry.name,
        entry.installed,
      ],
      ...app.agentPreference.recent,
      null,
      // Projects can arrive after the box opens, including metadata recovered
      // by the local CLI. Terminal output alone must not reorder this list.
      ..._recentProjectFolders(),
      null,
      for (final id in app.machineStates.keys) ...[
        id,
        ...app.projectHistory.recent(id),
        null,
      ],
    ];
  }

  Timer? _appTick;
  void _onApp() {
    if (_disposed || _appTick != null) return;
    // Coalesced: the app notifies on every terminal byte batch, and building
    // even a small signature for each is work nobody sees. Ten looks a second
    // is more often than any of this changes.
    _appTick = Timer(const Duration(milliseconds: 100), () {
      _appTick = null;
      if (_disposed) return;
      if (listEquals(_seen, _signature())) return;
      _refresh();
    });
  }

  void _refresh({bool resetCursor = false, String? agentSelection}) {
    if (_disposed) return;
    _syncGitProject();
    _seen = _signature();
    final current = resetCursor ? null : selected?.id;
    // An agent picked from another field may have no task or no modes.
    if (!_supportsField(field)) {
      field = fields.first;
      query = field == NewHarnessField.task ? task : '';
    }
    if (field == NewHarnessField.agent) {
      _refreshAgents(agentSelection ?? current, resetCursor: resetCursor);
      return;
    }
    options = switch (field) {
      NewHarnessField.launch ||
      NewHarnessField.task ||
      NewHarnessField.agent => const [],
      NewHarnessField.machine => _machineOptions(),
      NewHarnessField.branch => [
        ..._ranked(_branchOptions()),
        ?_createBranchRow(),
      ],
      NewHarnessField.projectMenu => _projectMenu(),
      NewHarnessField.project ||
      NewHarnessField.projectName => _projectOptions(),
      NewHarnessField.projectRepository => _repositoryOptions(),
      NewHarnessField.mode => _ranked([
        for (final mode in _settingsModes)
          NewHarnessOption(
            id: mode.id,
            title: mode.label,
            detail: mode.detail,
            risky: mode.risky,
          ),
      ]),
      NewHarnessField.profile => _profileOptions(),
    };
    // A path list is capped; its count is of every match, not of the rows.
    matchCount =
        _pathMatched ?? options.where((option) => !option.synthetic).length;
    _pathMatched = null;
    final kept = current == null
        ? -1
        : options.indexWhere((option) => option.id == current);
    final now = options.indexWhere(_isCurrent);
    final pathChoice = isPathQuery
        ? options.indexWhere((option) => option.project?.folder != null)
        : -1;
    final cycling = _cycle == null
        ? -1
        : options.indexWhere(
            (option) => !option.synthetic && option.title == _cycle!.name,
          );
    cursor = cycling >= 0
        ? cycling
        : kept >= 0
        ? kept
        : field == NewHarnessField.projectMenu
        ? (options.length > 3 ? 3 : 1)
        : query.isEmpty && now >= 0
        ? now
        : field == NewHarnessField.profile
        ? options.indexWhere((row) => !row.synthetic).clamp(0, options.length)
        : pathChoice >= 0
        ? pathChoice
        : 0;
    // A row we put the highlight on is not one the person chose.
    if (resetCursor || (cycling < 0 && kept < 0)) _steered = false;
    notifyListeners();
    if (field == NewHarnessField.profile &&
        supportsProfiles &&
        _profilesMachine != _machineId) {
      unawaited(refreshProfiles());
    }
  }

  /// A page of the list, for PgUp/PgDn: [rows] is how many fit on screen.
  void page(int direction, int rows) {
    if (options.isEmpty || locked) return;
    _endCycle();
    cursor = (cursor + direction * rows.clamp(1, options.length)).clamp(
      0,
      options.length - 1,
    );
    _steered = true;
    if (field == NewHarnessField.agent) {
      _refresh();
      return;
    }
    notifyListeners();
  }

  void _refreshAgents(String? current, {required bool resetCursor}) {
    final agents = _agentOptions();
    final target =
        agents.where((row) => row.id == current).firstOrNull ??
        (query.isEmpty
            ? agents.where((row) => row.id == _engine).firstOrNull
            : null) ??
        agents.firstOrNull;
    _agentPreview = target?.id;
    options = [...agents, if (offersStore) _store];
    matchCount = agents.length;
    final kept = options.indexWhere((row) => row.id == current);
    cursor = kept >= 0
        ? kept
        : target == null
        ? (options.isEmpty ? -1 : 0)
        : options.indexWhere(
            (row) => row.engine == _agentPreview && row.engine != null,
          );
    if (resetCursor || kept < 0) _steered = false;
    notifyListeners();
  }

  /// Branches to start from (Worktree on) or to work on (off), tagged the way
  /// editors tag them. Branches Harness named for worktrees that are gone are
  /// left out: nobody chose them.
  List<NewHarnessOption> _branchOptions() {
    final info = _gitProject;
    final defaultName = info.defaultRef?.split('/').skip(3).join('/');
    bool isDefault(GitBranch b) =>
        b.ref == info.defaultRef || !b.remote && b.name == defaultName;
    bool isCurrent(GitBranch b) => !b.remote && b.name == info.branch;
    // A remote branch with a local one of its name is that branch: Start
    // brings the local one up to it.
    final locals = {
      for (final branch in info.branches)
        if (!branch.remote) branch.name,
    };
    bool hasLocal(GitBranch b) =>
        b.remote && locals.contains(b.name.split('/').skip(1).join('/'));
    final shown = [
      for (final branch in info.branches)
        if (!((branch.harness || branch.name.startsWith('harness/')) &&
                branch.worktree == null &&
                branch.ref != branchRef) &&
            !(hasLocal(branch) && branch.ref != branchRef))
          branch,
    ];
    int rank(GitBranch b) => isDefault(b)
        ? 0
        : isCurrent(b)
        ? 1
        : 2;
    final ordered = [
      for (final group in [0, 1, 2])
        for (final branch in shown)
          if (rank(branch) == group) branch,
    ];
    return [
      for (final branch in ordered)
        NewHarnessOption(
          id: branch.ref,
          title: branch.name,
          detail: [
            if (isDefault(branch)) 'default',
            if (isCurrent(branch)) 'current',
            if (_worktreeOf(branch.ref) != null) 'worktree',
            if (branch.remote) 'remote',
          ].join(' · '),
          enabled: worktree || !branch.remote,
          why: branch.remote
              ? 'Turn Worktree on to start from a remote branch.'
              : null,
        ),
    ];
  }

  /// A typed name no branch has can be made — the way an editor's branch
  /// picker offers "Create branch": with Worktree on in a new worktree from
  /// the default branch, off in the folder from the branch it is on. Spaces
  /// become `-`, and what Git refuses in a name is dropped.
  NewHarnessOption? _createBranchRow() {
    final name = branchNameFrom(query);
    if (!plausibleBranchName(name) ||
        newBranchHere(_gitProject, name) == null) {
      return null;
    }
    final base = worktree
        ? defaultBranchRef(_gitProject, worktree: true)
        : currentBranchRef(_gitProject);
    return NewHarnessOption(
      id: '$createBranchId$name',
      synthetic: true,
      title: 'Create branch $name',
      detail: 'New branch from ${_refName(base) ?? 'HEAD'}',
    );
  }

  List<NewHarnessOption> _ranked(List<NewHarnessOption> all) {
    total = all.length;
    String normalize(String text) {
      final lower = text.toLowerCase();
      if (field != NewHarnessField.project &&
          field != NewHarnessField.projectMenu) {
        return lower;
      }
      final normalized = lower.replaceAll(RegExp(r'[\s._-]+'), ' ').trim();
      return normalized.isEmpty ? lower : normalized;
    }

    final needle = normalize(query.trim());
    if (needle.isEmpty) return all;
    final scored = <(int, int, NewHarnessOption)>[];
    for (var i = 0; i < all.length; i++) {
      final option = all[i];
      final name = normalize(option.title);
      final spread = subsequenceSpread(name, needle);
      final detail = subsequenceSpread(normalize(option.detail), needle);
      // The start of the name, then the start of a word in it, then anywhere
      // in it, then scattered through it, then the description. `co` is
      // Codex and Claude Code before it is MuJoCo.
      final score = name.startsWith(needle)
          ? 0
          : name.split(RegExp(r'[\s/._-]+')).any((w) => w.startsWith(needle))
          ? 100
          : name.contains(needle)
          ? 200
          : spread != null
          ? 300 + spread
          // A description is long; two letters scattered through one match
          // nearly everything. It counts from three letters on.
          : detail == null || needle.length < 3
          ? null
          : 1000 + detail;
      if (score != null) scored.add((score, i, option));
    }
    scored.sort((a, b) {
      final by = a.$1.compareTo(b.$1);
      return by != 0 ? by : a.$2.compareTo(b.$2);
    });
    return [for (final entry in scored) entry.$3];
  }

  List<NewHarnessOption> _agentOptions() {
    final machine = _machine;
    final harnesses = machine != null && machine.dsh.loaded
        ? [
            for (final entry in machine.dsh.entries)
              if (!entry.isViewerPackage) entry.id,
          ]
        : [for (final identity in knownHarnesses) identity.id];
    String operationId(String id) =>
        harnessForOperation(
          machine?.dsh.entries ?? const <DshEntry>[],
          id,
        )?.id ??
        canonicalHarnessId(id);
    final ids = <String>{
      for (final id in [
        // Keep the inherited choice beside the prompt, followed by recent choices.
        _engine,
        ...app.agentPreference.recent.where(_known),
        for (final identity in allEngines) identity.id,
        ...harnesses,
        kTerminalEngine,
      ])
        operationId(id),
    };
    return _ranked([
      for (final id in ids)
        NewHarnessOption(
          id: id,
          title: labelOf(id),
          engine: id,
          detail: [
            if (isTerminalEngine(id))
              'A shell, no agent'
            else if (isHarnessId(id))
              machine?.dsh[id]?.tagline ??
                  engineIdentity(id).tagline ??
                  machine?.dsh[id]?.category ??
                  engineIdentity(id).category
            // Every plain engine is "Code"; a column saying so eight times is
            // noise. Only what sets a row apart is said.
            else
              null,
            if (isHarnessId(id) && machine?.dsh[id]?.installed == false)
              'installs first',
          ].whereType<String>().where((part) => part.isNotEmpty).join(' · '),
        ),
    ]);
  }

  List<NewHarnessOption> _machineOptions() => _ranked([
    for (final machine in app.machineStates.values)
      if (!machine.machine.isShared)
        NewHarnessOption(
          id: machine.machine.machineId,
          title: machine.machine.displayName,
          detail: [
            machine.isLocalMachine ? 'This computer' : 'Remote',
            if (machine.needsLink)
              'link required'
            else if (machine.nodeOnline == false)
              'offline',
          ].join(' · '),
          enabled: !machine.needsLink && machine.nodeOnline != false,
          why: machine.needsLink
              ? '${machine.machine.displayName} is not linked to this '
                    'computer yet. Link it from the Machines menu.'
              : '${machine.machine.displayName} is offline.',
        ),
  ]);

  /// Whether what is typed in the project field is a path being completed.
  bool get isPathQuery => field == NewHarnessField.project && _isPath(query);

  /// A notice in the box's bottom line that is not a failed create.
  void warn(String message) {
    error = message;
    notifyListeners();
  }

  bool _isPath(String text) =>
      text.startsWith('/') ||
      text.startsWith('~') ||
      text.startsWith('./') ||
      text.startsWith('../') ||
      text == '.' ||
      text == '..';

  String _expand(String text) {
    final home = _homeOf(_machineId);
    if (home != null) {
      if (text == '~') return home;
      // `~/` keeps its slash: joined with nothing it came back as the home
      // folder itself, which then read as "the folder `me` under /home" — the
      // list showed one row, your own home, and Tab completed to `~/me/`.
      if (text == '~/') return '$home/';
      if (text.startsWith('~/')) return p.join(home, text.substring(2));
    }
    // `./x` and `../x` are relative to the project the line already names —
    // the box's only "here" — and to home when it names none.
    if (text.startsWith('.')) {
      final here = _project.folder ?? home;
      if (here != null) {
        final trailing = text.endsWith('/') ? '/' : '';
        return '${p.normalize(p.join(here, text))}$trailing';
      }
    }
    return text;
  }

  Iterable<String> _recentProjectFolders() sync* {
    final machine = _machine;
    final seen = <String>{};
    // Worktrees Start made are temporary: their repository is the project.
    final worktrees = _expand('~/harnesses/worktrees');
    for (final folder in [
      ?_project.folder,
      ...app.projectHistory.recent(_machineId),
      // Match the full form: explicit choices first, then known agent folders
      // on this machine. Older projects need not be picked again to appear.
      if (machine != null)
        for (final agent in machine.agents.reversed)
          ?machine.projectOf(agent)?.cwd,
    ]) {
      if (!p.isAbsolute(folder) ||
          folder.length > 4096 ||
          RegExp(r'[\x00-\x1f\x7f]').hasMatch(folder) ||
          folder != _project.folder && p.isWithin(worktrees, folder)) {
        continue;
      }
      if (seen.add(p.normalize(folder))) yield folder;
    }
  }

  List<NewHarnessOption> _recentProjects() => [
    for (final folder in _recentProjectFolders())
      NewHarnessOption(
        id: 'project:$_machineId:$folder',
        title: p.basename(folder),
        detail: location(folder),
        project: NewHarnessProject.folder(folder),
        machineId: _machineId,
        enabled: _machine?.needsLink != true && _machine?.nodeOnline != false,
        why: _machine?.needsLink == true
            ? '$machineLabel needs linking. Open Machines to link it.'
            : '$machineLabel is offline.',
      ),
  ];

  List<NewHarnessOption> _projectOptions() {
    final typed = query.trim();
    if (field == NewHarnessField.project) {
      if (_isPath(typed)) return _pathOptions(typed);
      // Recent projects live in the project menu. This prompt only opens a
      // folder by path or browser, so it cannot look like a second history.
      total = 0;
      return [_browse];
    }
    final slug = typed.contains('/') ? null : projectFolderSlug(typed);
    final keepSuggestion = _editingSuggestedProject && typed == _project.name;
    // Resolve the owning machine's home before offering an existing name.
    // The daemon still reserves a fresh name atomically on submission.
    final root = _expand('~/harnesses');
    if (slug != null && p.isAbsolute(root) && !_listings.containsKey(root)) {
      _requestListing(root);
    }
    final existingName = _listings[root]
        ?.where((name) => name == slug)
        .firstOrNull;
    final existingFolder = existingName == null || keepSuggestion
        ? null
        : p.join(root, existingName);
    return [
      if (typed.isNotEmpty)
        NewHarnessOption(
          id: 'project:new',
          synthetic: true,
          title: slug == null
              ? 'Enter a project name'
              : '${existingFolder == null ? 'Create' : 'Open existing'} $slug',
          detail: slug == null
              ? 'Use letters or numbers, like payments'
              : location('~/harnesses/$slug'),
          project: existingFolder != null
              ? NewHarnessProject.folder(existingFolder)
              : keepSuggestion
              ? _project
              : slug == null
              ? null
              : NewHarnessProject.fresh(typed),
          machineId: _machineId,
          enabled: slug != null,
          why: 'Use a project name with letters or numbers. Choose Existing for a folder path.',
        ),
    ];
  }

  List<NewHarnessOption> _repositoryOptions() {
    final repository = GitHubRepository.parse(query.trim());
    return [
      if (repository != null)
        NewHarnessOption(
          id: 'project:clone',
          synthetic: true,
          title: 'Clone ${repository.name}',
          detail: location('~/harnesses/${repository.name}'),
          project: NewHarnessProject.clone(repository),
          machineId: _machineId,
        ),
    ];
  }

  /// The most folders one listing offers. `node_modules` has five thousand; a
  /// list nobody scrolls that far costs a row object each, every keystroke.
  /// Typing narrows it, and the count still says how many there really are.
  static const maxPathRows = 200;

  /// The last path list built, and what it was built from: a keystroke that
  /// changes neither the folder nor the stem (or a tick that changes nothing)
  /// gets the same list back instead of thousands of new rows.
  (String, String, List<String>)? _pathKey;
  List<NewHarnessOption> _pathRows = const [];
  int _pathTotal = 0;
  int _pathHits = 0;
  int? _pathMatched;

  /// zsh's path completion: the folders under what has been typed so far.
  List<NewHarnessOption> _pathOptions(String typed) {
    final full = _expand(typed);
    if (!p.isAbsolute(full)) {
      total = 0;
      return [_browse, _changeMachine];
    }
    final slash = full.lastIndexOf('/');
    final parent = slash <= 0 ? '/' : full.substring(0, slash);
    // While Tab is cycling the candidates, the line holds one of them but the
    // list stays the list of the stem that was typed — a completion menu.
    final stem = (_cycle?.stem ?? full.substring(slash + 1)).toLowerCase();
    final names = _listings[parent];
    if (names == null) {
      _requestListing(parent);
      total = 0;
      return const [];
    }
    final key = (parent, stem, names);
    if (_pathKey != null &&
        _pathKey!.$1 == parent &&
        _pathKey!.$2 == stem &&
        identical(_pathKey!.$3, names)) {
      total = _pathTotal;
      _pathMatched = _pathHits;
      return _pathRows;
    }
    // Dot-folders are offered only once a dot is typed, as `ls` hides them; the
    // count is of what is on offer.
    final dots = stem.startsWith('.');
    var offered = 0;
    final rows = <NewHarnessOption>[
      _browse,
      if (stem.isEmpty && parent != '/')
        NewHarnessOption(
          id: 'project:$parent',
          title: p.basename(parent),
          detail: 'Use ${location(parent)}',
          project: NewHarnessProject.folder(parent),
          synthetic: true,
        ),
    ];
    var matched = 0;
    for (final name in names) {
      if (!dots && name.startsWith('.')) continue;
      offered++;
      if (!name.toLowerCase().startsWith(stem)) continue;
      if (++matched > maxPathRows) continue;
      final folder = p.join(parent, name);
      rows.add(
        NewHarnessOption(
          id: 'project:$folder',
          title: name,
          detail: location(folder),
          project: NewHarnessProject.folder(folder),
        ),
      );
    }
    rows.add(_changeMachine);
    _pathKey = key;
    _pathRows = rows;
    total = _pathTotal = offered;
    _pathMatched = _pathHits = matched;
    return rows;
  }

  Timer? _listDebounce;
  static const _maxListings = 16;

  /// ~ always means the home of the selected machine's account. The browser
  /// protocol resolves an omitted path to that home; no local path is guessed.
  Future<String?> _ensureHome(String id) {
    if (app.stateOf(id)?.isLocalMachine == true) return Future.value(_home);
    return _homeRequests.putIfAbsent(id, () async {
      try {
        final answer = await app.listRemoteFolder(id, null);
        final home = answer['path'];
        if (_disposed || home is! String || !p.isAbsolute(home)) return null;
        _homes[id] = home;
        if (id == _machineId) _refresh();
        return home;
      } catch (_) {
        // Display the full path until this machine can resolve its home.
        return null;
      }
    });
  }

  /// Ask for [folder]'s listing. A local folder is read at once, off this
  /// isolate; another machine's is asked for only once the typing pauses — each
  /// keystroke through `~/code/au` would otherwise be a round trip whose answer
  /// nobody is waiting for any more.
  void _requestListing(String folder) {
    if (_listing == folder) return;
    _listing = folder;
    _listDebounce?.cancel();
    if (_machine?.isLocalMachine == true) {
      unawaited(_list(folder));
    } else {
      _listDebounce = Timer(
        const Duration(milliseconds: 80),
        () => unawaited(_list(folder)),
      );
    }
  }

  Future<void> _list(String folder) async {
    final machineId = _machineId;
    final revision = _machineRevision;
    var names = <String>[];
    try {
      if (_machine?.isLocalMachine == true) {
        // Five thousand entries streamed through the UI isolate's event loop
        // is five thousand events between two frames; read them elsewhere.
        names = await Isolate.run(() {
          final found = <String>[];
          for (final entry in Directory(folder).listSync(followLinks: true)) {
            if (entry is Directory) found.add(p.basename(entry.path));
          }
          return found;
        });
      } else {
        final answer = await app.listRemoteFolder(_machineId, folder);
        final entries = answer['entries'];
        if (entries is List) {
          names = [
            for (final entry in entries)
              if (entry is Map &&
                  entry['isDir'] == true &&
                  entry['name'] is String)
                entry['name'] as String,
          ];
        }
      }
    } catch (_) {
      // A folder that cannot be read lists nothing, as a shell's Tab does.
    }
    if (_disposed || machineId != _machineId || revision != _machineRevision) {
      return;
    }
    names.sort((a, b) => compareNatural(a.toLowerCase(), b.toLowerCase()));
    _listings.remove(folder);
    _listings[folder] = names;
    // Recently listed folders stay; a long walk does not keep every one.
    while (_listings.length > _maxListings) {
      _listings.remove(_listings.keys.first);
    }
    // An answer for a folder the line has already left is kept, not shown.
    final current = _listing == folder;
    if (current) _listing = null;
    if (current &&
        (field == NewHarnessField.project ||
            field == NewHarnessField.projectName)) {
      _refresh();
    }
  }

  // ---- making it ----------------------------------------------------------

  /// One attempt per harness, kept across a lost reply: a create whose answer
  /// never came back may have worked, and asking again must ask the machine
  /// what happened to THAT request rather than start a second harness.
  AgentCreationAttempt? _attempt;

  /// The person has been told a typed task will not be sent, and pressed again.
  bool _dropAccepted = false;

  /// A reply was lost; Return now checks on it instead of creating again.
  bool get checking => _attempt?.awaitingConfirmation == true;

  bool _warnedAboutClosing = false;

  /// Every dismissal path observes the same in-flight receipt and completion.
  /// A second explicit dismissal acknowledges an unresolved creation.
  bool requestDismiss() {
    if (linkingProfile) {
      warn('Linking the profile. Escape closes once it is done.');
      return false;
    }
    if (busy) {
      warn('Still working on it. Escape closes once it is done.');
      return false;
    }
    if (checking && !_warnedAboutClosing) {
      _warnedAboutClosing = true;
      warn(
        'The harness may already exist. Return checks on it; Escape again '
        'closes without knowing.',
      );
      return false;
    }
    return !endCompletion();
  }

  Future<NewHarnessOutcome> create() async {
    if (busy || linkingProfile) {
      return NewHarnessOutcome.failed;
    }
    if (needsProject && !checking) {
      focusField(NewHarnessField.projectMenu);
      return _fail('Choose a project, or create a new one.');
    }
    if (!checking) {
      _syncGitProject();
      if (gitError != null) retryGitProject();
      if (checkingGit) {
        busy = true;
        status = 'Checking project…';
        notifyListeners();
        await _gitFuture;
        if (_disposed) return NewHarnessOutcome.failed;
        busy = false;
        status = null;
      }
      if (gitError != null) {
        return _fail(
          'Could not check Git on $machineLabel. Check the connection and Harness CLI, then retry.',
        );
      }
      if (!worktree && _branchRef?.startsWith('refs/remotes/') == true) {
        return _fail('Choose a local branch, or turn Worktree on.');
      }
      if (worktreePlan case final plan?
          when plan.kind == WorktreeStart.unavailable) {
        return _fail(
          '${plan.branch} is the project folder’s branch. Turn Worktree off to work on it there, or name a new branch.',
        );
      }
      // Switching the folder's branch would move it under a harness at work.
      final folder = _project.folder;
      final ref = branchRef;
      if (!worktree &&
          folder != null &&
          (_branchHere != null ||
              ref != null &&
                  ref != currentBranchRef(_gitProject) &&
                  _worktreeOf(ref) == null) &&
          (_machine?.agents ?? const []).any((agent) {
            final cwd = _machine?.projectOf(agent)?.cwd;
            final root = _gitProject.root ?? folder;
            return cwd != null &&
                (p.equals(cwd, root) || p.isWithin(root, cwd));
          })) {
        return _fail(
          'A harness is working in this folder, so its branch can’t be switched. Turn Worktree on, or stay on $branchLabel.',
        );
      }
    }
    // Shortened by the person, never cut by us: a machine refuses one longer.
    if (takesTask && taskTooLong && !checking) {
      return _fail(
        'A first message can be $kFirstTaskMaxLength characters; '
        'this is ${task.trim().length}.',
      );
    }
    // A task typed for an agent that cannot take one is said BEFORE the
    // harness is made, on every path — ⌘↵ from the agent field went straight
    // past the notice that choosing the agent shows. The second press means it.
    if (!takesTask && task.trim().isNotEmpty && !checking && !_dropAccepted) {
      _dropAccepted = true;
      return _fail(
        '$agentLabel cannot start on a first message, so “${_short(task)}” '
        'will not be sent. Press again to make it anyway.',
      );
    }
    final machine = _machine;
    if (machine == null) {
      error = 'Choose a machine.';
      notifyListeners();
      return NewHarnessOutcome.failed;
    }
    final choice = _engine;
    final harness = isHarnessId(choice) ? choice : null;
    final terminal = isTerminalEngine(choice);
    final base = harness == null
        ? choice
        : machine.dsh[choice]?.engine ??
              knownHarnessBase[canonicalHarnessId(choice)] ??
              'claude';
    // The daemon's launch installs a missing engine inside its new terminal.
    // A cached availability probe must not block that first launch.
    final recheck = checking;
    if (!recheck) {
      _attempt = AgentCreationAttempt();
      _warnedAboutClosing = false;
    }
    final attempt = _attempt!;
    busy = true;
    error = null;
    status = recheck ? 'Checking on the harness…' : 'Starting harness…';
    notifyListeners();
    if (harness != null && !recheck) {
      await app.probeDsh(_machineId, force: true);
      if (_disposed) return NewHarnessOutcome.failed;
      if (!machine.dsh.loaded && machine.dsh.error != null) {
        return _fail(
          'Update Harness CLI on ${machine.machine.displayName} to create a '
          '${labelOf(harness)} harness.',
        );
      }
      if (machine.dsh[harness]?.installed == false) {
        status = 'Installing ${labelOf(harness)}… this can take a few minutes';
        notifyListeners();
        final failure = await app.installDsh(_machineId, harness);
        if (_disposed) return NewHarnessOutcome.failed;
        if (failure != null) return _fail(failure);
        status = 'Starting harness…';
        notifyListeners();
      }
    }
    final permissionMode = hasModes ? mode : null;
    final bypass =
        permissionMode != null && permissionModeApproves(permissionMode);
    final folder = _project.folder;
    final firstMessage = task.trim();
    final failure = await app.createAgent(
      _machineId,
      engine: base,
      folder: terminal ? folder : folder ?? '',
      projectFolder: projectFolderRequest,
      swarmId: _targetId,
      split: split,
      placement: effectivePlacement,
      bypassPermission: bypass,
      permissionMode: permissionMode,
      codexHome: base == 'codex' ? _profile?.path : null,
      dsh: harness,
      // Sent exactly as written; an agent that cannot take one is never sent it.
      prompt: takesTask && firstMessage.isNotEmpty ? firstMessage : null,
      attempt: attempt,
    );
    if (_disposed) return NewHarnessOutcome.failed;
    if (failure != null) {
      // A folder already made for this attempt is the project now: a retry
      // goes into it rather than making a second one beside it.
      if (!checking && attempt.preparedFolder != null) {
        _project = NewHarnessProject.folder(attempt.preparedFolder!);
        _gitKey = (_machineId, _project.folder, isTerminal);
        _worktree = false;
        _branchRef = null;
        _gitProject = const GitProjectInfo();
        _gitFuture = _readGitProject(_gitKey!);
      }
      return _fail(failure);
    }
    analytics.agentCreated(
      engine: choice,
      bypassPermission: bypass,
      permissionMode: permissionMode,
    );
    unawaited(app.agentPreference.remember(choice));
    busy = false;
    status = null;
    return NewHarnessOutcome.created;
  }

  NewHarnessOutcome _fail(String message) {
    busy = false;
    status = null;
    error = message;
    notifyListeners();
    return NewHarnessOutcome.failed;
  }

  @override
  void dispose() {
    _disposed = true;
    _appTick?.cancel();
    _listDebounce?.cancel();
    app.removeListener(_onApp);
    super.dispose();
  }
}
