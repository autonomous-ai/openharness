import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/codex_profiles.dart';
import 'package:harness_mobile/core/first_task.dart';
import 'package:harness_mobile/core/permission_modes.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';
import 'package:harness_mobile/core/git_project.dart';
import 'package:harness_mobile/core/project_folder.dart';
import 'package:harness_mobile/widgets/remote_folder_picker.dart';

import 'agent_index.dart';
import 'branch_picker_sheet.dart';
import 'phone_navigation.dart';
import 'new_agent_draft.dart';
import 'phone_status.dart';
import 'new_agent_chooser.dart';
import 'tty.dart';
import 'tty_controls.dart';
import 'voice_input_controller.dart';

/// Starting an agent from the phone: a folder on that machine, and an engine to
/// run there.
///
/// A page rather than a sheet. There are two choices to make and one of them can
/// open a folder browser on top — a sheet that has to be dismissed to reach the
/// browser, and rebuilt after it, loses the other choice on the way.
///
/// The desktop asks the same two things (`widgets/new_agent_dialog.dart`) and a
/// few more it has room for — a Codex profile, a split to place the pane into,
/// a permission bypass. A phone shows one agent at a time, so there is no split
/// to aim at, and the rest belong to the machine that already knows them.
class NewAgentPage extends StatefulWidget {
  const NewAgentPage({
    super.key,
    required this.notifier,
    required this.machineId,
    this.folder,
    this.voice,
  });

  /// The mic the task field talks through — the pager's, so a take survives the swipe here. Null
  /// makes the page its own.
  final VoiceInputController? voice;

  final AppNotifier notifier;
  final String machineId;

  /// A folder on [machineId] to start in — Find's `+ New Harness in api`. Null takes the last one
  /// used there.
  final String? folder;

  @override
  State<NewAgentPage> createState() => _NewAgentPageState();
}

class _NewAgentPageState extends State<NewAgentPage> {
  /// The machine the agent is created on. Starts on the one the page was opened with, and the
  /// MACHINE rows change it.
  late String _machineId = widget.machineId;

  String? _folder;

  /// Set when the MACHINE is to produce the folder — a fresh project, or a clone — instead of one
  /// being picked here.
  ///
  /// ⚠️ Exclusive with [_folder], and the two are cleared against each other everywhere they are
  /// set. They answer the same question, and both being live would leave the button's `ready` true
  /// with no way to tell which answer it meant.
  ProjectFolderRequest? _project;

  /// What the FOLDER rows show as chosen for [_project], since a request carries no path to show:
  /// "New project", or the repository's name.
  String? _projectLabel;

  /// Claude until somebody picks another — the engine most agents are started with.
  String? _engine = 'claude';
  String? _error;
  bool _creating = false;

  /// Codex state folders this machine reported, and the one chosen. Null is the
  /// machine's own default `CODEX_HOME`, which is what the desktop dialog calls
  /// "default profile" and what it starts on.
  List<LocalCodexProfile> _codexProfiles = const [];
  LocalCodexProfile? _codexProfile;
  bool _codexProfilesLoaded = false;

  /// How far the harness may go without asking — the desktop's Approvals row.
  ///
  /// ⚠️ **Per engine, and reset with it.** Claude's "Accept edits" is not a mode Codex has, and a
  /// mode an engine lacks is refused by the CLI at launch — so switching engine drops back to
  /// [kDefaultPermissionMode] rather than carrying a choice across. See
  /// `core/permission_modes.dart`.
  String _permissionMode = kDefaultPermissionMode;

  /// The modes the chosen engine offers, empty for one that has none to choose between — the row
  /// is then left out rather than drawn dead.
  List<PermissionMode> get _permissionModes =>
      _engine == null ? const [] : permissionModesOf(_engine!);

  PermissionMode? get _permissionModeChoice =>
      _permissionModes.where((mode) => mode.id == _permissionMode).firstOrNull;

  /// What the machine said about [_folder]'s repository, and which folder it
  /// answered about.
  ///
  /// ⚠️ **The path is kept beside the answer on purpose.** The read is a round
  /// trip to somebody's laptop and the folder can change twice while one is in
  /// flight; without it, a slow answer about the folder before last would draw
  /// that repository's branches under this one's name.
  GitProjectInfo? _git;
  String? _gitFolder;
  bool _gitLoading = false;

  /// Set when the machine could not answer at all, as opposed to answering
  /// "not a repository".
  ///
  /// ⚠️ **Kept apart from [_git] because the two used to look identical, and
  /// that hid a real fault.** `git_project_info` was missing from this app's
  /// end-to-end encrypted frame list, so every machine refused it with
  /// `E2EE_REQUIRED` — and since a folder that is not a checkout also offers
  /// nothing, the section simply never appeared and there was nothing on screen
  /// to say why. A refusal says so now.
  bool _gitFailed = false;

  /// Start puts the harness in a worktree of its own rather than in the folder
  /// itself. Set from [worktreeByDefault] each time a repository is read, which
  /// is what the desktop's box does with the same answer.
  bool _worktree = false;

  /// What the new branch starts FROM (a ref), and what to call it. Null base
  /// means [defaultBranchRef]; null name means a made-up one.
  String? _branchRef;
  String? _branchName;

  /// Held for the length of the form rather than drawn fresh on every build:
  /// the name is random, and one that changed under the person between the row
  /// they read and the harness they started would be a different branch.
  String? _placeholder;

  @override
  void initState() {
    super.initState();
    _restoreDraft();
    // After the first frame, not during it: `probeEngines` can notify synchronously, and a notify
    // while this page is still being mounted marks the listeners above it dirty mid-build — the
    // "setState() called during build" assertion.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _askMachine();
    });
    // Read from disk once. `recent` answers from memory after this, so the rows below need no
    // await — but the first build happens before it lands, hence the rebuild.
    unawaited(
      widget.notifier.projectHistory.load().then((_) {
        if (mounted) setState(() {});
      }),
    );
    // The last agent started from this phone, the desktop's `agentPreference`. A draft being
    // restored keeps its own.
    if (newAgentDraft == null) {
      final preference = widget.notifier.agentPreference;
      unawaited(
        preference.load().then((_) {
          final remembered = preference.value;
          if (!mounted || remembered == null || _engineChosen) return;
          setState(() => _engine = remembered);
        }),
      );
    }
  }

  /// Whether the engine was picked on this page — a remembered one arriving late must not undo it.
  bool _engineChosen = false;

  @override
  void dispose() {
    _keepDraft();
    _task.dispose();
    _ownVoice?.dispose();
    super.dispose();
  }

  /// The first task — `prompt` on `agent_create`. Optional: empty starts the harness idle.
  final _task = TextEditingController();

  /// Made on the first tap of the mic, not before: a recorder opens a platform channel, and a
  /// form nobody talks to should not.
  VoiceInputController? _ownVoice;
  VoiceInputController? get _voiceIfAny => widget.voice ?? _ownVoice;

  /// The task field's mic: talk, and what was said is added to the task.
  void _talk() {
    final voice =
        _voiceIfAny ??
        (_ownVoice = VoiceInputController(
          transcriber: (wav, lang) =>
              widget.notifier.api.transcribeVoice(wav, lang: lang),
        ));
    if (widget.voice == null) setState(() {});
    if (voice.status == VoiceInputStatus.listening) {
      unawaited(
        voice.submit((text) async {
          if (!mounted) return false;
          final said = text.trim();
          final before = _task.text.trimRight();
          final next = before.isEmpty ? said : '$before $said';
          _task.value = TextEditingValue(
            text: next,
            selection: TextSelection.collapsed(offset: next.length),
          );
          setState(() {});
          return true;
        }),
      );
      return;
    }
    if (voice.status == VoiceInputStatus.idle)
      unawaited(voice.startListening());
  }

  /// Takes back what the form was left holding — see [NewAgentDraft].
  ///
  /// ⚠️ **The machine comes from the draft, not from the page's argument**, which is what the
  /// desktop does (`_machineId = draft?.machineId ?? machineId`): the form was opened from a
  /// terminal or a list that names ONE machine, and a draft that came back on a different one
  /// would be a folder path belonging to a machine that has never heard of it.
  ///
  /// Nothing is restored for a machine the account no longer has. The whole draft goes with it,
  /// rather than half of it: a folder and a branch are answers about a machine, and re-hanging
  /// them on another is how a form comes back subtly wrong.
  void _restoreDraft() {
    final draft = newAgentDraft;
    if (draft == null) return;
    // Opened for a place — `+ New Harness in api` — the place wins; only the words carry over.
    if (widget.folder != null) {
      _task.text = draft.task ?? '';
      return;
    }
    if (widget.notifier.stateOf(draft.machineId) == null) {
      newAgentDraft = null;
      return;
    }
    _machineId = draft.machineId;
    _engine = draft.engine;
    _permissionMode = draft.permissionMode;
    _folder = draft.folder;
    _project = draft.project;
    _projectLabel = draft.projectLabel;
    _worktree = draft.worktree ?? false;
    _branchRef = draft.branchRef;
    _branchName = draft.branchName;
    _placeholder = draft.placeholder;
    _git = draft.git;
    _gitFolder = draft.gitFolder;
    _codexProfile = draft.codexProfile;
    _task.text = draft.task ?? '';
  }

  /// Leaves the form's answers where the next open will find them. Called from [dispose], so it
  /// covers every way out — Back, a swipe, the route being replaced — except the one that must
  /// not be covered: [_create] clears the draft the moment a harness exists.
  void _keepDraft() {
    // Nothing chosen and nothing typed is not a draft; it is the form as it opens. Kept, it would
    // pin the page to whichever machine was last looked at for the rest of the run.
    if (_folder == null &&
        _project == null &&
        _branchName == null &&
        _task.text.trim().isEmpty) {
      newAgentDraft = null;
      return;
    }
    newAgentDraft = NewAgentDraft(
      machineId: _machineId,
      engine: _engine,
      permissionMode: _permissionMode,
      folder: _folder,
      project: _project,
      projectLabel: _projectLabel,
      worktree: _worktree,
      branchRef: _branchRef,
      branchName: _branchName,
      placeholder: _placeholder,
      git: _git,
      gitFolder: _gitFolder,
      codexProfile: _codexProfile,
      task: _task.text,
    );
  }

  /// What this form needs to hear from [_machineId]: its engines and its Codex profiles.
  void _askMachine() {
    // Which engines this machine actually has. Best effort: an unanswered probe
    // leaves the list to the engines its own agents are already running, and a
    // machine with neither still gets the browse-and-create path.
    unawaited(widget.notifier.probeEngines(_machineId));
    unawaited(_loadCodexProfiles());
  }

  /// Moves the form to another machine.
  ///
  /// ⚠️ Every folder choice goes with the old machine — a path, a Recent entry and a Codex profile
  /// all name something on THAT computer, and carried over they would point at nothing, or at a
  /// different folder that happens to share the path. The engine stays: it names a program, not a
  /// place.
  void _selectMachine(String machineId) {
    if (machineId == _machineId) return;
    setState(() {
      _machineId = machineId;
      _folder = null;
      _project = null;
      _projectLabel = null;
      _git = null;
      _gitFolder = null;
      _gitLoading = false;
      _gitFailed = false;
      _worktree = false;
      _branchRef = null;
      _branchName = null;
      _codexProfiles = const [];
      _codexProfile = null;
      _codexProfilesLoaded = false;
      _error = null;
    });
    _askMachine();
  }

  /// Machines an agent can be created on right now, in the order the Agents tab's chips draw them —
  /// so "the first one" is the same machine in both places. The chosen one is kept even if it stops
  /// answering, so the row never goes blank under the person.
  List<MachineState> get _machines => [
    for (final machine in filterableMachines(widget.notifier))
      if (phoneMachineStatusOf(machine) == PhoneMachineStatus.ready ||
          machine.machine.machineId == _machineId)
        machine,
  ];

  /// Reads [folder]'s repository on its machine, and starts the Git choices
  /// where the desktop starts them.
  ///
  /// Silent about failure. A folder that is not a repository and a machine that
  /// could not answer both come back with nothing to offer, and neither is
  /// something to interrupt a half-filled form about — the section simply does
  /// not appear, and everything else on the page still works.
  Future<void> _loadGit(String folder) async {
    final machineId = _machineId;
    setState(() {
      _gitLoading = true;
      _gitFailed = false;
      _gitFolder = folder;
      _git = null;
      _branchRef = null;
      _branchName = null;
      _worktree = false;
    });
    final raw = await widget.notifier.readGitProject(machineId, folder);
    // A late answer about a folder the form has since left belongs to nobody —
    // see the note on [_gitFolder].
    if (!mounted || machineId != _machineId || folder != _folder) return;
    var info = GitProjectInfo.fromJson(raw);
    // ⚠️ **A worktree is a temporary folder, so New shows its repository** — the desktop's rule
    // (`state/new_harness.dart`). Harness made it for another harness; opening New on it named
    // that harness's folder (`silent-beacon`) as the project, which nobody recognises. The
    // machine names the main checkout, and new work starts from the branch that is on.
    if (info.mainFolder case final main?) {
      _folder = main;
      _gitFolder = main;
      info = GitProjectInfo(
        isGit: true,
        branch: info.mainBranch,
        branches: info.branches,
        defaultRef: info.defaultRef,
        root: main,
      );
    }
    setState(() {
      _gitLoading = false;
      _gitFailed = info.unavailable;
      _git = info.isGit ? info : null;
      if (!info.isGit) return;
      _worktree = worktreeByDefault(info);
      _branchRef = defaultBranchRef(info, worktree: _worktree);
      _placeholder ??= placeholderBranch([
        for (final branch in info.branches)
          if (!branch.remote) branch.name,
      ]);
    });
  }

  /// The repository the Git rows are about, or null when there is none to show.
  GitProjectInfo? get _repository =>
      _folder != null && _folder == _gitFolder ? _git : null;

  /// What Start would do, so the rows can say it before it is done. Null when
  /// there is no repository, or when Worktree is off — the folder simply moves
  /// to the branch then, and the row already names it.
  WorktreePlan? get _plan {
    final info = _repository;
    if (info == null || !_worktree) return null;
    return planWorktree(
      info,
      base: _branchRef ?? defaultBranchRef(info, worktree: true),
      name: _branchName,
      placeholder: _placeholder ?? 'new-branch',
    );
  }

  /// What this form calls an engine.
  ///
  /// ⚠️ **"Claude Code", not "Claude", and only here.** The desktop's launcher says the same
  /// (`new_harness.dart`: `id == 'claude' ? 'Claude Code' : engineIdentity(id).label`) while its
  /// engine table keeps the bare `Claude` for everywhere else — a pane header, a row on the Agents
  /// list. The launcher is the one screen naming the PROGRAM rather than the harness running it,
  /// and "Claude" alone reads there as a model.
  String _engineName(String id) => id == 'claude'
      ? 'Claude Code'
      : allEngines.where((identity) => identity.id == id).firstOrNull?.label ??
            id;

  /// What the BRANCH row says is about to happen, in the words of the thing it
  /// will do. Null leaves the row showing the branch alone.
  ///
  /// ⚠️ The four answers are not decoration: with Worktree on, the same branch
  /// name means make one, check one out, or walk into a worktree that already
  /// exists — and the last two are surprises if the row said only "main".
  String? get _branchNote => switch (_plan?.kind) {
    WorktreeStart.newBranch => 'A new branch from here, in its own worktree',
    WorktreeStart.existingBranch => 'Checked out in a new worktree',
    WorktreeStart.openWorktree => 'Opens the worktree it already has',
    WorktreeStart.unavailable =>
      'The folder is on this branch — pick another, or turn Worktree off',
    null =>
      _repository == null || _branchName == null ? null : 'New branch here',
  };

  /// The branch the row names: the one Start begins FROM.
  ///
  /// ⚠️ **Never the made-up name a new worktree's branch gets.** With Worktree
  /// on, [planWorktree] answers with a two-word placeholder — `brave-otter` —
  /// that the daemon replaces with the session's own name later. Shown as the
  /// title it read as the app picking a branch at random, and the branch the
  /// person actually chose was nowhere on the row. The desktop's field shows
  /// `branchLabel`, which is the name of `branchRef` and nothing else; this is
  /// that. What the placeholder is FOR belongs in the note under it.
  String get _branchTitle {
    final typed = _branchName?.trim();
    if (typed != null && typed.isNotEmpty) return typed;
    final info = _repository;
    final ref =
        _branchRef ??
        (info == null ? null : defaultBranchRef(info, worktree: _worktree));
    if (ref == null) return info?.branch ?? 'Default';
    final named = info?.branches
        .where((branch) => branch.ref == ref)
        .firstOrNull
        ?.name;
    return named ?? ref.replaceFirst(RegExp(r'^refs/(heads|remotes)/'), '');
  }

  /// Discovery runs on the MACHINE, never on this device — the phone has no
  /// Codex config of its own and the agent will not run here anyway.
  Future<void> _loadCodexProfiles() async {
    final machineId = _machineId;
    final result = await widget.notifier.listCodexProfiles(machineId);
    // A late answer from a machine the form has since moved off belongs to nobody.
    if (!mounted || machineId != _machineId) return;
    final raw = result['profiles'] as List<dynamic>? ?? const [];
    final loaded = raw.map(
      (entry) =>
          LocalCodexProfile.fromJson(Map<String, dynamic>.from(entry as Map)),
    );
    // Keyed by path: the machine can report one folder under two labels.
    final profiles = {for (final p in loaded) p.path: p}.values.toList();
    setState(() {
      _codexProfiles = profiles;
      _codexProfilesLoaded = true;
      // Exactly one, and there is nothing to choose between — the desktop
      // dialog settles on it the same way.
      if (profiles.length == 1) _codexProfile = profiles.single;
    });
  }

  /// Codex can be pointed at a state folder; nothing else can, and the CLI has
  /// to be new enough to be told.
  bool get _showsCodexProfile =>
      _engine == 'codex' &&
      _machine?.engines['codex']?.supportsCodexHome == true;

  MachineState? get _machine => widget.notifier.stateOf(_machineId);

  /// Whether this machine can make a folder of its own — a fresh project, or a clone.
  ///
  /// ⚠️ Gated because an older CLI fails in a way that BLAMES THE PERSON. It ignores
  /// `projectSource`, finds no `cwd`, and refuses with INVALID_CWD, which the app renders as "the
  /// project folder is unavailable on this machine, choose another folder and try again" — advice
  /// about a folder they never chose, for a problem that is not theirs to fix.
  ///
  /// ⚠️ The desktop offers both unconditionally and has the same hole. Worth carrying over there.
  bool get _canMakeProject => _machine?.projectFolderAvailable ?? false;

  /// Why the two rows are unavailable, or null while they are not.
  ///
  /// Printed rather than left to a disabled row: "Update Harness on that machine" is something the
  /// person can act on, and a row that simply does nothing teaches them nothing.
  String? get _projectSourceNote {
    final machine = _machine;
    if (machine == null || _canMakeProject) return null;
    // Said only once the machine has actually answered. Before that, silence — a row must not call
    // a machine out of date on the strength of an answer that has not arrived.
    if (!machine.terminalCapabilityLoaded) return null;
    return 'Update Harness on ${machine.machine.displayName} to create a '
        'project or clone one there.';
  }

  /// The last segment of a path, for the row's title. No `package:path` here — these are the remote
  /// machine's paths, and its separator is not this device's to assume.
  String _basename(String path) {
    final trimmed = path.endsWith('/') && path.length > 1
        ? path.substring(0, path.length - 1)
        : path;
    final cut = trimmed.lastIndexOf('/');
    return cut < 0 || cut == trimmed.length - 1
        ? trimmed
        : trimmed.substring(cut + 1);
  }

  /// Every engine Harness knows, the way the desktop dialog offers them.
  ///
  /// Offered, not filtered to what is installed: an engine Harness can install
  /// is installed on launch, and hiding the rest would make a machine that has
  /// not answered the probe yet look like it runs one engine. The row carries
  /// the caveat instead — see [_engineNote].
  List<EngineIdentity> get _engines => allEngines;

  /// The one caveat worth printing beside an engine's name, or none.
  ///
  /// Absent and installable earns nothing: Harness puts it there before it
  /// launches. Absent and NOT installable is the one state nobody else can fix,
  /// so it keeps words. An unanswered probe says nothing at all — a row must
  /// not call an engine missing on the strength of an answer that never came.
  String? _engineNote(String engine) {
    final machine = _machine;
    if (machine == null || !machine.engines.loaded) return null;
    final entry = machine.engines[engine];
    if (entry == null || entry.installed || entry.installable) return null;
    return 'not installed';
  }

  /// Asks for a GitHub repository by URL — the desktop's "Git" button, which is also just a field
  /// to paste into. Neither end lists repositories or talks to GitHub.
  ///
  /// ⚠️ Refuses in the dialog rather than on submit. `cli/src/lib/projectFolder.ts` parses the URL
  /// again at its end and would refuse too, but that answer arrives after a round trip and lands as
  /// a failed creation; [GitHubRepository.parse] is the same rule applied where it was typed.
  Future<void> _pickRepository() async {
    final repository = await showDialog<GitHubRepository>(
      context: context,
      useRootNavigator: true,
      // ⚠️ The dialog owns its controller. Holding one out here and disposing it when `showDialog`
      // returns disposes it while the route is still animating OUT, with the field still attached —
      // "A TextEditingController was used after being disposed", and the frame after it takes the
      // whole screen down.
      builder: (_) => _RepositoryDialog(initialUrl: _project?.repository?.url),
    );
    if (repository == null || !mounted) return;
    setState(() {
      _project = ProjectFolderRequest.remote(repository);
      _projectLabel = repository.name;
      _folder = null;
      _git = null;
      _gitFolder = null;
      _error = null;
    });
  }

  Future<void> _browse() async {
    final chosen = await showRemoteFolderPicker(
      context,
      notifier: widget.notifier,
      machineId: _machineId,
      initialPath: _folder,
    );
    if (chosen == null || !mounted) return;
    setState(() {
      _folder = chosen;
      _project = null;
      _projectLabel = null;
      _error = null;
    });
    unawaited(_loadGit(chosen));
  }

  Future<void> _create() async {
    final folder = _folder, engine = _engine, project = _project;
    if ((folder == null && project == null) || engine == null || _creating) {
      return;
    }
    setState(() {
      _creating = true;
      _error = null;
    });
    // Held so the id of what it starts comes back here — see
    // [AgentCreationAttempt.agentId]. A fresh one per submit, which is what the
    // call made on its own before: a retry after a refusal is a new request.
    final creation = AgentCreationAttempt();
    // A folder in a repository is not sent as a bare `cwd`: the branch and the
    // worktree travel with it, and [gitFolderRequest] is the desktop's own rule
    // for turning the rows above into what the machine is asked to do. A folder
    // that is not a repository, or one this form never read, falls through to
    // the plain path — and `New project` / `Git…` keep the request they made.
    final request =
        project ??
        (folder == null || _repository == null
            ? null
            : gitFolderRequest(
                folder,
                _repository!,
                worktree: _worktree,
                branchRef: _branchRef,
                branchName: _branchName,
                placeholder: _placeholder ?? 'new-branch',
              ));
    final error = await widget.notifier.createAgent(
      _machineId,
      engine: engine,
      // Empty only in the branch that drops `cwd` from the payload entirely — `createAgent` keeps
      // this required so the ordinary case cannot be left out by accident.
      folder: folder ?? '',
      projectFolder: request,
      // Omitted for an engine with no modes, rather than sent as the default: the CLI refuses a
      // mode an engine lacks, and "the default" is the machine's to decide there.
      permissionMode: _permissionModes.isEmpty ? null : _permissionMode,
      // Only for Codex, and only when chosen: omitted, the machine launches
      // with its own default CODEX_HOME.
      codexHome: _showsCodexProfile ? _codexProfile?.path : null,
      attempt: creation,
      prompt: _engine != null && takesFirstTask(_engine!) ? _task.text : null,
    );
    if (!mounted) return;
    if (error == null) {
      // The harness exists: the draft that described it would be a second one waiting to be made
      // by accident. See [NewAgentDraft].
      newAgentDraft = null;
      unawaited(widget.notifier.agentPreference.select(engine));
      _open(creation.agentId);
      return;
    }
    setState(() {
      _creating = false;
      _error = error;
      _failed = true;
    });
  }

  /// Options unfolded: branch, approvals and profile shown rather than left on their defaults.
  bool _optionsOpen = false;

  /// The last Start did not take: the button says Try Again, and every value stays.
  bool _failed = false;

  /// Where a finished creation lands: inside the agent it just started.
  ///
  /// Asking for an agent and being handed back the list to find it in is a step
  /// nobody wants — the answer to "create this" is the thing created. It
  /// REPLACES this page rather than stacking on it, so back from the terminal
  /// is the list this was opened from, not a form for an agent that now exists.
  ///
  /// A machine can still confirm a creation without naming the agent — an older
  /// CLI's reply carries no record. Then there is nothing to open, and the list
  /// behind this page picks the new agent up the way it picks up every other.
  void _open(String? agentId) {
    if (agentId == null) {
      Navigator.of(context).pop();
      return;
    }
    openAgent(
      context,
      widget.notifier,
      _machineId,
      agentId,
      replacingCurrentPage: true,
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.notifier,
    builder: (context, _) {
      final tty = Tty.of(context);
      _applyDefaultProject();
      final info = _repository;
      final mode = _permissionModeChoice;
      final ready = _engine != null && (_folder != null || _project != null);
      final nothingRunning = _machines.every((m) => m.agents.isEmpty);
      final count = _task.text.trim().length;
      // Typing the task, the keyboard leaves room for one line of the choices, not four cut ones.
      final typing = MediaQuery.viewInsetsOf(context).bottom > 0;
      final summary = [
        if (_engine != null) _engineName(_engine!),
        if (_folder != null || _project != null) _projectValue,
        if (_repository != null) _worktree ? 'worktree' : _branchTitle,
        if (_permissionModes.isNotEmpty)
          (_permissionModeChoice?.label ?? 'Auto-approve'),
      ].join(' · ');
      return Scaffold(
        backgroundColor: tty.ground,
        body: SafeArea(
          // ⚠️ **A swipe right ANYWHERE goes back to Focus.** New is a swipe left from the terminal
          // (Snapchat's layout), and the way home is the same swipe the other way — not only the
          // system's sliver of left edge, which a thumb in the middle of the screen never finds.
          child: GestureDetector(
            behavior: HitTestBehavior.translucent,
            onHorizontalDragStart: (_) => _swipedBack = 0,
            onHorizontalDragUpdate: (details) =>
                _swipedBack += details.primaryDelta ?? 0,
            onHorizontalDragEnd: (details) {
              if (_swipedBack >= 64 || (details.primaryVelocity ?? 0) >= 300) {
                unawaited(Navigator.of(context).maybePop());
              }
            },
            // A form, the phone's way: who and where on top, what to do and Start at the foot, in
            // the thumb's reach and riding the keyboard. See
            // docs/plans/2026-09-26-003-mobile-find-new-spec.md.
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(Tty.origin, 8, 4, 0),
                  child: Row(
                    children: [
                      Expanded(
                        child: TtyText(
                          'New Harness',
                          size: TtySize.title,
                          weight: FontWeight.w600,
                        ),
                      ),
                      // No Cancel: a swipe right goes back, the way a swipe left came in.
                      const SizedBox(height: 44),
                    ],
                  ),
                ),
                if (nothingRunning)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                      Tty.origin,
                      0,
                      Tty.origin,
                      4,
                    ),
                    child: TtyText(
                      'Nothing running yet. Start your first harness.',
                      color: tty.faint,
                      size: TtySize.meta,
                    ),
                  ),
                const SizedBox(height: 8),
                if (typing)
                  TtyFormRow(
                    label: 'harness',
                    value: summary.isEmpty ? 'Choose an agent' : summary,
                    onTap: () => FocusManager.instance.primaryFocus?.unfocus(),
                  )
                else
                  Expanded(
                    child: ListView(
                      keyboardDismissBehavior:
                          ScrollViewKeyboardDismissBehavior.onDrag,
                      padding: EdgeInsets.zero,
                      children: [
                        TtyFormRow(
                          label: 'agent',
                          value: _engine == null
                              ? 'Choose an agent'
                              : _engineName(_engine!),
                          valueColor: _engine == null ? tty.green : null,
                          detail: _engine == null
                              ? null
                              : _engineNote(_engine!),
                          onTap: _creating
                              ? null
                              : () => unawaited(_chooseAgent()),
                        ),
                        TtyFormRow(
                          label: 'project',
                          value: _folder == null && _project == null
                              ? 'Choose a project'
                              : _projectValue,
                          valueColor: _folder == null && _project == null
                              ? tty.green
                              : null,
                          detail: null,
                          onTap: _creating
                              ? null
                              : () => unawaited(_chooseProject()),
                        ),
                        // Options, folded as the desktop folds them: branch, approvals and profile
                        // sit on their defaults until asked for.
                        TtyFormRow(
                          label: 'options',
                          // Left as it is nearly every time: folded to `[+]`.
                          value: _optionsOpen ? '[−]' : '[+]',
                          chevron: false,
                          onTap: () =>
                              setState(() => _optionsOpen = !_optionsOpen),
                        ),
                        if (_optionsOpen &&
                            (info != null || _gitLoading || _gitFailed))
                          TtyFormRow(
                            label: 'branch',
                            valueColor: info == null && !_gitLoading
                                ? tty.faint
                                : null,
                            value: _gitLoading
                                ? 'Reading…'
                                : info == null
                                ? 'No answer from the computer'
                                : _worktree
                                ? 'New worktree'
                                : _branchTitle,
                            detail: info == null
                                ? null
                                : _worktree
                                ? 'from $_branchTitle, in its own folder'
                                : _branchNote,
                            onTap: info == null || _creating
                                ? null
                                : () => unawaited(_chooseBranch(info)),
                          ),
                        if (_optionsOpen && _permissionModes.isNotEmpty)
                          TtyFormRow(
                            label: 'approvals',
                            value: mode?.label ?? 'Auto-approve',
                            detail: mode?.detail,
                            valueColor: (mode?.risky ?? false) ? tty.red : null,
                            onTap: _creating
                                ? null
                                : () => unawaited(_chooseApprovals()),
                          ),
                        if (_optionsOpen && _showsCodexProfile)
                          TtyFormRow(
                            label: 'profile',
                            value: _codexProfile?.label ?? 'Default',
                            onTap: _creating
                                ? null
                                : () => unawaited(_chooseProfile()),
                          ),
                      ],
                    ),
                  ),
                if (typing) const Spacer(),
                // The dock: the task, then Start. It rides the keyboard.
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    Tty.origin,
                    20,
                    Tty.origin,
                    12,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // A first harness has nothing to go on: three first tasks to tap, the kind
                      // that shows what an agent does in a minute.
                      if (_task.text.trim().isEmpty && !_creating)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            children: [
                              for (final idea in const [
                                'Explain this project to me',
                                'Find a bug and fix it',
                                'Run the tests',
                              ])
                                _Suggestion(
                                  text: idea,
                                  onTap: () => setState(() {
                                    _task.value = TextEditingValue(
                                      text: idea,
                                      selection: TextSelection.collapsed(
                                        offset: idea.length,
                                      ),
                                    );
                                  }),
                                ),
                            ],
                          ),
                        ),
                      Row(
                        children: [
                          Expanded(
                            child: TtyText(
                              'task (optional)',
                              color: tty.faint,
                              size: TtySize.meta,
                            ),
                          ),
                          if (count > 1800)
                            TtyText(
                              '$count/$kFirstTaskMaxLength',
                              color: count > kFirstTaskMaxLength
                                  ? tty.red
                                  : tty.faint,
                              size: TtySize.meta,
                            ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      TtyField(
                        controller: _task,
                        hint: 'What should it do?',
                        lines: 6,
                        maxLength: kFirstTaskMaxLength,
                        action: TextInputAction.newline,
                        onChanged: (_) => setState(() {}),
                        trailing: [
                          Align(
                            alignment: Alignment.bottomRight,
                            child: ListenableBuilder(
                              listenable: _voiceIfAny ?? const _Silent(),
                              builder: (context, _) {
                                final status = _voiceIfAny?.status;
                                return TtyFieldMic(
                                  live:
                                      status == VoiceInputStatus.listening ||
                                      status == VoiceInputStatus.starting,
                                  onTap: _creating ? null : _talk,
                                );
                              },
                            ),
                          ),
                        ],
                      ),
                      if (_error != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Text(
                            '✗ ${_error!}',
                            style: tty.style(
                              color: tty.red,
                              size: TtySize.meta,
                            ),
                          ),
                        ),
                      const SizedBox(height: 10),
                      TtyPrimaryButton(
                        // Says what it will do: start, or choose what is still missing first.
                        label: _failed
                            ? 'Try Again'
                            : ready
                            ? 'Start'
                            : _engine == null
                            ? 'Choose an agent'
                            : 'Choose a project',
                        busy: _creating,
                        busyLabel: 'Starting…',
                        // Never a dead button: with a choice missing, Start opens its chooser.
                        onPressed: () => unawaited(_start()),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );

  /// The branch row: this folder as it is, or a new worktree — and any other branch behind them.
  Future<void> _chooseBranch(GitProjectInfo info) async {
    final here = info.branch ?? 'This folder';
    final picked = await showNewAgentChooser<String>(
      context,
      title: 'Branch',
      hint: 'Search branches',
      items: [
        ChooserItem(
          value: 'here',
          title: here,
          subtitle: 'this folder, as it is',
          selected: !_worktree && _branchName == null,
        ),
        ChooserItem(
          value: 'worktree',
          title: 'New Worktree',
          subtitle: 'a new branch from $here, in its own folder',
          selected: _worktree,
        ),
      ],
      actions: const [
        ChooserItem(
          value: 'other',
          title: 'Other Branch',
          subtitle: 'start from another branch, or name a new one',
        ),
      ],
    );
    if (picked == null || !mounted) return;
    switch (picked) {
      case 'here':
        setState(() {
          _worktree = false;
          _branchRef = defaultBranchRef(info, worktree: false);
          _branchName = null;
          _error = null;
        });
      case 'worktree':
        setState(() {
          _worktree = true;
          _branchRef = defaultBranchRef(info, worktree: true);
          _error = null;
        });
      case 'other':
        await _pickBranch(info);
    }
  }

  /// A home folder written the way a shell prints it.
  static String _tilde(String path) =>
      path.replaceFirst(RegExp(r'^/(Users|home)/[^/]+'), '~');

  /// How far the current drag has gone right — see the swipe back in [build].
  double _swipedBack = 0;

  /// The last project started on this machine, else its most recent one — the desktop's rule. No
  /// project yet leaves the row on "Choose project", which the button then asks for.
  void _applyDefaultProject() {
    if (_folder != null || _project != null || _projectDefaulted) return;
    final history = widget.notifier.projectHistory;
    // Then, with no history on this phone: the folder of the computer's most recent harness —
    // someone who has only ever started harnesses on the desktop still opens New ready to Start.
    final folder =
        widget.folder ??
        history.selected(_machineId) ??
        history.recent(_machineId).firstOrNull ??
        _latestAgentFolder();
    if (folder == null) return;
    _projectDefaulted = true;
    _folder = folder;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _folder == folder) unawaited(_loadGit(folder));
    });
  }

  /// A folder Harness made for a harness's worktree — `~/harnesses/worktrees/<repo>/<name>`.
  static bool _isHarnessWorktree(String folder) =>
      folder.contains('/harnesses/worktrees/');

  String? _latestAgentFolder() {
    final agents = [...?_machine?.agents]
      ..sort(
        (a, b) =>
            (b.updatedAt ?? DateTime(0)).compareTo(a.updatedAt ?? DateTime(0)),
      );
    for (final agent in agents) {
      final path = agent.project?.root ?? agent.project?.cwd;
      if (path != null && path.isNotEmpty) return path;
    }
    return null;
  }

  /// Set once the default project has been applied, so a person who clears it is not handed it
  /// back on the next build.
  bool _projectDefaulted = false;

  /// The project on one line: `computer:name`. The full path is in the chooser.
  String get _projectValue {
    final String name;
    if (_folder case final folder?) {
      name = _basename(folder);
    } else if (_project?.repository case final repository?) {
      name = repository.name;
    } else if (_project != null) {
      name = 'New folder';
    } else {
      return 'Choose project';
    }
    // One line, `computer:name` — always the computer, as the title on Focus and every Find row
    // write it. Most repositories live in a folder of the same name; the full path is in the
    // chooser.
    final machine = _machine?.machine.displayName;
    return machine == null ? name : '$machine:$name';
  }

  /// The button: a missing choice opens its chooser and says why, the desktop's `requiredChoice`.
  Future<void> _start() async {
    // The keyboard goes with the form: the new harness should open on its terminal and the mic,
    // not on a keyboard left up from typing the task.
    FocusManager.instance.primaryFocus?.unfocus();
    if (_engine == null) {
      setState(() => _error = 'Choose an agent.');
      await _chooseAgent();
      return;
    }
    if (_folder == null && _project == null) {
      setState(() => _error = 'Choose a project.');
      await _chooseProject();
      return;
    }
    await _create();
  }

  Future<void> _chooseAgent() async {
    final machine = _machine;
    // Claude Code and Codex first — what nearly everyone runs — then the rest A to Z behind `more`.
    const first = ['claude', 'codex'];
    final ids = {for (final identity in _engines) identity.id, ?_engine};
    final ordered = [
      for (final id in first)
        if (ids.contains(id)) id,
      ...(ids.where((id) => !first.contains(id)).toList()
        ..sort((a, b) => _engineName(a).compareTo(_engineName(b)))),
    ];
    final picked = await showNewAgentChooser<String>(
      context,
      title: 'Agent',
      hint: 'Search agents',
      fold: ordered.where(first.contains).length,
      items: [
        for (final id in ordered)
          ChooserItem(
            value: id,
            title: _engineName(id),
            subtitle: _engineNote(id),
            leading: EngineMark(engine: id, size: 18),
            selected: id == _engine,
            enabled:
                machine == null ||
                !machine.engines.loaded ||
                _engineNote(id) == null,
          ),
      ],
    );
    if (picked == null || !mounted) return;
    setState(() {
      if (picked != _engine) _permissionMode = kDefaultPermissionMode;
      _engineChosen = true;
      _engine = picked;
      _error = null;
    });
  }

  /// Every machine's projects as `machine · folder` pairs — this machine first, then the rest —
  /// with Clone Repository, Open Folder and New Folder above them, as the desktop lists them.
  /// Choosing a pair on another machine moves the harness there.
  Future<void> _chooseProject() async {
    final notifier = widget.notifier;
    final machines = [
      ?_machine,
      for (final other in _machines)
        if (other.machine.machineId != _machineId) other,
    ];
    final pairs = <ChooserItem<_ProjectChoice>>[];
    for (final machine in machines) {
      final id = machine.machine.machineId;
      // Worktrees Start made are temporary: their repository is the project, and it is listed
      // once it has been chosen (the desktop's `_recentProjectFolders`).
      final folders = <String>{
        if (id == _machineId) ?_folder,
        for (final folder in [
          ...notifier.projectHistory.recent(id),
          for (final agent in machine.agents)
            if (agent.project?.root ?? agent.project?.cwd case final path?)
              path,
        ])
          if (folder.isNotEmpty && !_isHarnessWorktree(folder)) folder,
      };
      for (final folder in folders) {
        pairs.add(
          ChooserItem(
            value: _ProjectChoice.folder(id, folder),
            title: _basename(folder),
            subtitle: '${machine.machine.displayName}:${_tilde(folder)}',
            icon: LucideIcons.folder300,
            selected: id == _machineId && folder == _folder,
          ),
        );
      }
    }
    final here = _machine?.machine.displayName ?? 'this machine';
    final canMake = _canMakeProject;
    final picked = await showNewAgentChooser<_ProjectChoice>(
      context,
      title: 'Project',
      hint: 'Search projects',
      actions: [
        ChooserItem(
          value: const _ProjectChoice.open(),
          title: 'Open Folder',
          subtitle: 'Any folder on $here',
          icon: LucideIcons.folderSearch300,
        ),
        ChooserItem(
          value: const _ProjectChoice.clone(),
          title: 'Clone Repository',
          subtitle: _projectSourceNote ?? 'A GitHub repository, on $here',
          icon: LucideIcons.gitBranch300,
          enabled: canMake,
        ),
        ChooserItem(
          value: const _ProjectChoice.newFolder(),
          title: 'New Folder',
          subtitle: _projectSourceNote ?? 'A fresh folder, made on $here',
          icon: LucideIcons.folderPlus300,
          enabled: canMake,
        ),
      ],
      items: pairs,
    );
    if (picked == null || !mounted) return;
    switch (picked.kind) {
      case _ProjectChoiceKind.clone:
        await _pickRepository();
      case _ProjectChoiceKind.open:
        await _browse();
      case _ProjectChoiceKind.newFolder:
        setState(() {
          _project = const ProjectFolderRequest.newProject();
          _projectLabel = 'New folder';
          _folder = null;
          _git = null;
          _gitFolder = null;
          _error = null;
        });
      case _ProjectChoiceKind.folder:
        final machineId = picked.machineId!, folder = picked.folder!;
        if (machineId != _machineId) _selectMachine(machineId);
        setState(() {
          _projectDefaulted = true;
          _folder = folder;
          _project = null;
          _projectLabel = null;
          _error = null;
        });
        unawaited(_loadGit(folder));
    }
  }

  Future<void> _chooseApprovals() async {
    final picked = await showNewAgentChooser<String>(
      context,
      title: 'Approvals',
      hint: 'How much it may do without asking',
      items: [
        for (final mode in _permissionModes)
          ChooserItem(
            value: mode.id,
            title: mode.label,
            subtitle: mode.detail,
            icon: LucideIcons.shieldCheck300,
            selected: mode.id == _permissionMode,
            warn: mode.risky,
          ),
      ],
    );
    if (picked == null || !mounted) return;
    setState(() => _permissionMode = picked);
  }

  Future<void> _chooseProfile() async {
    final picked = await showNewAgentChooser<LocalCodexProfile?>(
      context,
      title: 'Profile',
      hint: 'Search profiles',
      items: [
        ChooserItem(
          value: null,
          title: 'Default',
          subtitle: _codexProfilesLoaded ? null : 'Looking for others…',
          icon: LucideIcons.user300,
          selected: _codexProfile == null,
        ),
        for (final profile in _codexProfiles)
          ChooserItem(
            value: profile,
            title: profile.label,
            subtitle: profile.path,
            icon: LucideIcons.user300,
            selected: _codexProfile == profile,
          ),
      ],
    );
    if (!mounted) return;
    setState(() => _codexProfile = picked);
  }

  /// The branch row: the picker, and the name dialog behind its first entry.
  ///
  /// ⚠️ **Two sheets, one after the other, rather than a field in the list.**
  /// The picker is a list to search; naming a branch is a keyboard and a rule
  /// about what Git accepts. Put together, the keyboard covered the list the
  /// moment the field took focus.
  Future<void> _pickBranch(GitProjectInfo info) async {
    final choice = await showBranchPickerSheet(
      context,
      info: info,
      selectedRef: _branchRef ?? defaultBranchRef(info, worktree: _worktree),
      typedName: _branchName,
    );
    if (choice == null || !mounted) return;
    if (choice.ref case final ref?) {
      setState(() {
        _branchRef = ref;
        _branchName = null;
        _error = null;
      });
      return;
    }
    await _typeBranch();
  }

  /// Asks for a branch name, and keeps only what Git would take.
  Future<void> _typeBranch() async {
    final typed = await showDialog<String>(
      context: context,
      useRootNavigator: true,
      builder: (_) => _BranchDialog(initial: _branchName),
    );
    if (typed == null || !mounted) return;
    setState(() {
      _branchName = typed.isEmpty ? null : typed;
      _error = null;
    });
  }
}

/// A branch name, cleaned the way Git would take it.
///
/// ⚠️ **Cleaned as it is typed, not on submit.** `branchNameFrom` turns spaces
/// into dashes and drops what `git check-ref-format` refuses, and a person who
/// only finds that out after starting a harness has a branch they did not name.
/// Shown live, the field IS the answer.
class _BranchDialog extends StatefulWidget {
  const _BranchDialog({this.initial});

  final String? initial;

  @override
  State<_BranchDialog> createState() => _BranchDialogState();
}

class _BranchDialogState extends State<_BranchDialog> {
  late final _controller = TextEditingController(text: widget.initial ?? '');

  String get _clean => branchNameFrom(_controller.text);
  bool get _ok => _clean.isEmpty || plausibleBranchName(_clean);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    if (!_ok) return;
    Navigator.of(context).pop(_clean);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final clean = _clean;
    return AlertDialog(
      title: const Text('New branch'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _controller,
            autofocus: true,
            autocorrect: false,
            style: kFieldTextStyle,
            textInputAction: TextInputAction.done,
            onChanged: (_) => setState(() {}),
            onSubmitted: (_) => _submit(),
          ),
          // Only when it differs: repeating back exactly what was typed is
          // noise, and the line is here to warn.
          if (clean.isNotEmpty && clean != _controller.text.trim()) ...[
            const SizedBox(height: 10),
            Text(
              'Git will call it $clean',
              style: TextStyle(color: AppPalette.textSecondary, fontSize: 12.5),
            ),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _ok ? _submit : null, child: const Text('Use')),
      ],
    );
  }
}

/// The Git field, as its own widget so the text it holds survives the parent's rebuilds — a
/// `StatefulBuilder` inside the dialog would lose the error the moment anything above repainted.
class _RepositoryDialog extends StatefulWidget {
  const _RepositoryDialog({this.initialUrl});

  final String? initialUrl;

  @override
  State<_RepositoryDialog> createState() => _RepositoryDialogState();
}

class _RepositoryDialogState extends State<_RepositoryDialog> {
  late final _controller = TextEditingController(text: widget.initialUrl ?? '');
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final repository = GitHubRepository.parse(_controller.text);
    if (repository == null) {
      setState(() => _error = 'That is not a GitHub repository.');
      return;
    }
    Navigator.of(context).pop(repository);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return AlertDialog(
      backgroundColor: AppPalette.panelBg,
      title: Text(
        'Git repository',
        style: TextStyle(color: AppPalette.textPrimary, fontSize: 18),
      ),
      content: TextField(
        controller: _controller,
        autofocus: true,
        autocorrect: false,
        enableSuggestions: false,
        keyboardType: TextInputType.url,
        textInputAction: TextInputAction.go,
        style: TextStyle(color: AppPalette.textPrimary, fontSize: 15),
        decoration: InputDecoration(
          hintText: 'owner/repo, or a GitHub URL',
          errorText: _error,
        ),
        onChanged: (_) {
          if (_error != null) setState(() => _error = null);
        },
        onSubmitted: (_) => _submit(),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Select')),
      ],
    );
  }
}

enum _ProjectChoiceKind { folder, clone, open, newFolder }

/// What the Project chooser hands back: a `machine · folder` pair, or one of its three actions.
class _ProjectChoice {
  const _ProjectChoice.folder(String this.machineId, String this.folder)
    : kind = _ProjectChoiceKind.folder;
  const _ProjectChoice.clone()
    : kind = _ProjectChoiceKind.clone,
      machineId = null,
      folder = null;
  const _ProjectChoice.open()
    : kind = _ProjectChoiceKind.open,
      machineId = null,
      folder = null;
  const _ProjectChoice.newFolder()
    : kind = _ProjectChoiceKind.newFolder,
      machineId = null,
      folder = null;

  final _ProjectChoiceKind kind;
  final String? machineId;
  final String? folder;
}

/// A listenable that never speaks — the mic's before a recorder exists.
class _Silent implements Listenable {
  const _Silent();

  @override
  void addListener(VoidCallback listener) {}

  @override
  void removeListener(VoidCallback listener) {}
}

/// A first task to tap — fills the task field.
class _Suggestion extends StatelessWidget {
  const _Suggestion({required this.text, required this.onTap});

  final String text;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: text,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 36),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: tty.dim),
          ),
          child: TtyText(text, size: TtySize.meta, color: tty.text),
        ),
      ),
    );
  }
}
