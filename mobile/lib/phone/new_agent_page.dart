import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/codex_profiles.dart';
import 'package:harness_mobile/core/first_task.dart';
import 'package:harness_mobile/core/first_engine.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/core/permission_modes.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/attached_task_delivery.dart';
import 'package:harness_mobile/state/harness_attachments.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';
import 'package:harness_mobile/core/git_project.dart';
import 'package:harness_mobile/core/project_folder.dart';
import 'package:harness_mobile/widgets/remote_folder_picker.dart';

import '../demo/sample_mode.dart' show SampleMode;
import 'agent_index.dart';
import 'first_task_suggestion.dart';
import 'branch_picker_sheet.dart';
import 'phone_navigation.dart';
import 'new_agent_attachments.dart';
import 'new_agent_draft.dart';
import 'new_agent_model_sheet.dart';
import 'phone_status.dart';
import 'new_agent_chooser.dart';
import 'settings_page.dart' show PhoneSettingsButton;
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
/// Agent, computer and project are the default flow, the desktop header's three
/// pills in its order. Model, approvals, Codex profile, branch and the
/// independent worktree toggle live under Options, as on desktop.
class NewAgentPage extends StatefulWidget {
  const NewAgentPage({
    super.key,
    required this.notifier,
    required this.machineId,
    this.folder,
    this.deskTabId,
    this.newDeskTab = false,
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

  /// The desk tab the new harness joins — the tab Find was narrowed to when New Harness was tapped.
  /// Null joins the tab the phone is in. See `PhoneDesk.adopt`.
  final String? deskTabId;

  /// The new harness opens a desk tab of its own — the `+` at the end of Find's tab chips, the
  /// desktop's New Tab. Wins over [deskTabId]. See `PhoneDesk.adopt`.
  final bool newDeskTab;

  @override
  State<NewAgentPage> createState() => _NewAgentPageState();
}

class _NewAgentPageState extends State<NewAgentPage> {
  /// The machine the agent is created on. Starts on the one the page was opened with; the computer
  /// row changes it, and so does a Project pair on another computer.
  late String _machineId = widget.machineId;

  /// What was chosen on each computer the form has moved off, so the computer row coming back
  /// finds it again — the desktop's `_projectsByMachine`. Never carried to ANOTHER computer: see
  /// [_selectMachine].
  final _projectsByMachine = <String, _KeptProject>{};

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

  /// What the form opens on until somebody picks another: [_defaultEngine], read again whenever
  /// this computer's engines arrive or the computer changes ([_adoptDefaultEngine]). OpenCode is the
  /// answer before the computer has said anything.
  String? _engine = 'opencode';

  /// A plain shell is chosen rather than an agent — the desktop's `isTerminal`.
  ///
  /// ⚠️ **A terminal takes none of an agent's choices, so the form asks for none.** The machine opens
  /// it in a folder that exists, or at home with none (`cli/src/core/agents/launches.ts`): a project
  /// is optional, New Folder and Clone are refused (`INVALID_PROJECT_SOURCE`, it does not prepare
  /// one), and a shell has no model, approvals, Codex profile, branch, worktree or first task. Each
  /// of those is left out of the request rather than sent and refused, and its row is not drawn.
  /// The choices themselves are kept, as the desktop keeps them, so picking an agent again finds
  /// the form as it was.
  bool get _terminal => isTerminalEngine(_engine);
  String? _error;
  bool _creating = false;
  bool _optionsOpen = false;
  GridModel? _model;

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

  /// The read [_gitLoading] is about, held so a Start pressed during it can wait for the same
  /// answer — see [_gitSettled].
  Future<void>? _gitRead;

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
    if (!_engineChosen) _engine = _defaultEngine();
    // The last agent started from this phone, the desktop's `agentPreference`: read from disk once,
    // and [_engine] follows it if it lands before anybody has picked.
    unawaited(
      widget.notifier.agentPreference.load().then((_) => _adoptDefaultEngine()),
    );
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
  }

  /// Whether the engine was picked on this page. A pick is never undone: not by a remembered agent
  /// arriving late, nor by the computer's engines, nor by moving to another computer.
  bool _engineChosen = false;

  /// What the desktop's New Harness opens on: the agent last started from this phone while this
  /// computer can still run it, otherwise [firstEngine] — Claude Code or Codex when installed and
  /// signed in there, else OpenCode.
  String _defaultEngine() {
    final remembered = widget.notifier.agentPreference.value;
    if (remembered != null && _rememberedUsable(remembered)) return remembered;
    return firstEngine(_machine?.engines);
  }

  /// Whether this computer can run [id]: installed, and signed in where it reports that. A computer
  /// that has not answered yet, or an older one that reports no sign-in at all (null), has not said
  /// "no" — it is not treated as signed out.
  bool _rememberedUsable(String id) {
    if (isTerminalEngine(id)) return true;
    final engines = _machine?.engines;
    if (engines == null || !engines.loaded) return true;
    final engine = engines[id];
    return engine != null && engine.installed && engine.signedIn != false;
  }

  /// Opens on [_defaultEngine] while nothing was picked. Run when the computer's engines or the
  /// remembered agent arrive and when the computer changes — never from [build].
  void _adoptDefaultEngine() {
    if (!mounted || _engineChosen) return;
    final next = _defaultEngine();
    if (next == _engine) return;
    setState(() {
      _permissionMode = kDefaultPermissionMode;
      _engine = next;
    });
  }

  @override
  void dispose() {
    _holdCheck?.cancel();
    _keepDraft();
    _task.dispose();
    _attachments.dispose();
    _ownVoice?.dispose();
    super.dispose();
  }

  /// The files the harness will be handed — the desktop's `HarnessAttachments` behind its 📎. Only
  /// for this open form: the draft a closed form leaves keeps the words, not the bytes.
  final _attachments = HarnessAttachments();

  /// Files can go to this machine's harnesses, and this agent takes the task they lead: the 📎 is
  /// drawn only then, never as a button that is refused at Start.
  bool get _canAttach {
    final engine = _engine;
    return engine != null &&
        takesFirstTask(engine) &&
        canAttachFiles(widget.notifier, _machineId);
  }

  /// The 📎: the system's picker, then the files under the task.
  Future<void> _attach() async {
    final problem = await addPickedAttachments(_attachments);
    if (!mounted) return;
    setState(() => _error = problem);
  }

  /// The first task — `prompt` on `agent_create`. Optional: empty starts the harness idle.
  ///
  /// ⚠️ **No length limit on the field.** One cut whatever was typed or pasted past
  /// [kFirstTaskMaxLength] without a word, and what the mic added went past it unchecked. Start
  /// says so instead, and sends nothing — see [_lengthError].
  final _task = TextEditingController();

  /// What Start said about the task's length, while it is the line under the task. Editing the
  /// task keeps it true: the count follows the words, and the line goes once they fit.
  String? _lengthError;

  /// The task changed — typed, pasted or said.
  void _taskEdited(String text) => setState(() {
    if (_lengthError != null && _error == _lengthError) {
      _error = _lengthError = firstTaskLengthError(text);
    }
  });

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
          _taskEdited(next);
          return true;
        }),
      );
      return;
    }
    if (voice.status == VoiceInputStatus.idle) {
      unawaited(voice.startListening());
    }
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
    _engineChosen = draft.engineChosen;
    _permissionMode = draft.permissionMode;
    _folder = draft.folder;
    _exactFolder = draft.exactFolder;
    _project = draft.project;
    _projectLabel = draft.projectLabel;
    _worktree = draft.worktree ?? false;
    _branchRef = draft.branchRef;
    _branchName = draft.branchName;
    _placeholder = draft.placeholder;
    _git = draft.git;
    _gitFolder = draft.gitFolder;
    _codexProfile = draft.codexProfile;
    _model = draft.model;
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
      engineChosen: _engineChosen,
      permissionMode: _permissionMode,
      folder: _folder,
      exactFolder: _exactFolder,
      project: _project,
      projectLabel: _projectLabel,
      worktree: _worktree,
      branchRef: _branchRef,
      branchName: _branchName,
      placeholder: _placeholder,
      git: _git,
      // Only an answer is kept. A read still out, or one that failed, comes back as no read at
      // all, so Start asks again instead of taking "not a repository" from it — see [_gitSettled].
      gitFolder: _gitLoading || _gitFailed ? null : _gitFolder,
      codexProfile: _codexProfile,
      model: _model,
      task: _task.text,
    );
  }

  /// What this form needs to hear from [_machineId]: its engines and its Codex profiles.
  void _askMachine() {
    // Which engines this machine actually has. Best effort: an unanswered probe
    // leaves the list to the engines its own agents are already running, and a
    // machine with neither still gets the browse-and-create path.
    unawaited(
      widget.notifier.probeEngines(_machineId).then((_) => _adoptDefaultEngine()),
    );
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
    if (_folder != null || _project != null) {
      _projectsByMachine[_machineId] = (
        folder: _folder,
        project: _project,
        label: _projectLabel,
      );
    }
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
      _model = null;
      _error = null;
    });
    _adoptDefaultEngine();
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
  /// not appear, and everything else on the page still works. Start is where
  /// it matters, and Start waits for this answer: see [_gitSettled].
  Future<void> _loadGit(String folder) => _gitRead = _readGit(folder);

  /// The folder the person browsed to: a worktree there stays itself, on every read of it.
  String? _exactFolder;

  /// [_loadGit]'s read, which it keeps in [_gitRead].
  Future<void> _readGit(String folder) async {
    final exact = folder == _exactFolder;
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
    // machine names the main checkout, and new work starts from the branch that is on. One the
    // person browsed to stays itself, mainFolder and all ([_inWorktree]).
    if (info.mainFolder case final main? when !exact) {
      // The main checkout itself, which is where its branch is checked out: [main] when the
      // worktree was opened at its top, the checkout above it when opened on a subfolder. That
      // whole checkout moves if Start switches its branch, so a harness anywhere in it must count
      // — see [_branchSwitchRefusal]. [main] when the checkout is on no branch to find it by.
      final mainBranch = info.mainBranch;
      final checkout =
          info.branches
              .where((branch) => !branch.remote && branch.name == mainBranch)
              .firstOrNull
              ?.worktree ??
          main;
      _folder = main;
      _gitFolder = main;
      info = GitProjectInfo(
        isGit: true,
        branch: info.mainBranch,
        branches: info.branches,
        defaultRef: info.defaultRef,
        root: checkout,
      );
    }
    setState(() {
      _gitLoading = false;
      _gitFailed = info.unavailable;
      _git = info.isGit ? info : null;
      if (!info.isGit) return;
      _worktree = info.mainFolder == null && worktreeByDefault(info);
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

  /// A worktree the person browsed to: the harness works in it, on its branch.
  bool get _inWorktree => _repository?.mainFolder != null;

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
      : isTerminalEngine(id)
      ? terminalIdentity.label
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
      _model == null &&
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
    _exactFolder = chosen;
    unawaited(_loadGit(chosen));
  }

  /// Waits for the Git answer about the folder Start is about to use, and says whether Start may go
  /// on. False has already put the form back, with the reason on it.
  ///
  /// ⚠️ **Start does not go without the answer**, as the desktop's `create` does not
  /// (`state/new_harness.dart`). The request is built from it: with no answer there is no
  /// repository on hand, [_create] takes the plain path, and the harness starts on a bare `cwd` with
  /// no worktree and no branch. The form reads Git after its first frame, so a Start pressed as it
  /// opened used to land in exactly that gap.
  ///
  /// A machine that could not answer is asked again, once per Start, as the desktop asks; failing
  /// again refuses rather than starting in the folder anyway, because whether the folder is a
  /// repository is exactly what is not known. A folder that is simply NOT one was answered, and
  /// starts there as it always has.
  Future<bool> _gitSettled() async {
    final folder = _folder;
    if (folder == null || _project != null) return true;
    // Never read for this folder — a draft left while its read was out — counts as unread.
    if (!_gitLoading && (_gitFailed || _gitFolder != folder)) {
      unawaited(_loadGit(folder));
    }
    // The newest read, not the first: one about a folder the form has since left ends without an
    // answer (see [_gitFolder]), and the folder only changes by starting another.
    Future<void>? waited;
    while (_gitLoading &&
        _folder != null &&
        _project == null &&
        !identical(waited, _gitRead)) {
      waited = _gitRead;
      try {
        await waited;
      } catch (_) {
        // A read that threw has no answer either; it is refused below like one that failed.
      }
      if (!mounted) return false;
    }
    if (_folder == null && _project == null) {
      setState(() => _creating = false);
      return false;
    }
    if (_project == null && (_gitLoading || _gitFailed)) {
      final machine = _machine?.machine.displayName ?? 'the computer';
      setState(() {
        _creating = false;
        // The desktop's words, so the two say the same thing about the same machine.
        _error =
            'Could not check Git on $machine. Check the connection and Harness '
            'CLI, then retry.';
      });
      return false;
    }
    return true;
  }

  /// Why Start may not move [folder] onto another branch, or null when nothing stops it. [info] is
  /// [folder]'s repository, as the machine answered for it.
  ///
  /// ⚠️ **With Worktree off the machine switches the folder's own branch, and nothing there asks
  /// what else is working in it.** `cli/src/lib/gitProject.ts` runs `git switch` in a folder with
  /// nothing uncommitted, or makes a typed new branch there — and a harness already at work in that
  /// checkout had its files change branch under it, then went on editing and committing on a branch
  /// nobody chose for it. The easy way in was the branch row's default: Worktree starts on with the
  /// default branch picked, turning it off kept that pick, and Start moved a folder on another
  /// branch to `main`. The desktop refuses before sending (`state/new_harness.dart`, `create`); this
  /// is its check, in its words. Like the Git-read refusal in [_gitSettled], it leaves the button
  /// saying Start: nothing was sent, so there is nothing to try again.
  ///
  /// What counts, and why:
  /// - Only a choice that moves the folder ([switchesFolderBranch]). The branch it is already on, a
  ///   branch with a worktree of its own (opened there instead) and Worktree on all start as before.
  /// - Only harnesses on THIS machine. The same path on another computer is another folder.
  /// - Every harness the machine lists, a stopped one included, as the desktop counts them:
  ///   resumed, it would carry on in a checkout that changed branch while it was away.
  /// - A harness anywhere in the checkout ([GitProjectInfo.root]), a subfolder as much as the root,
  ///   because the switch moves every file in it. A machine that names no root leaves the folder
  ///   itself, as the desktop does.
  /// - Where a harness works is read as the desktop reads it: where its machine last saw it working
  ///   ([Agent.displayProject]), which is where it was started until it is seen anywhere else.
  ///
  /// "Stay on" names the branch the folder is on now, since that is what keeping it there means; a
  /// folder on no branch is called what the desktop's branch row calls it, Detached HEAD.
  String? _branchSwitchRefusal(String folder, GitProjectInfo info) {
    if (!switchesFolderBranch(
      info,
      worktree: _worktree,
      branchRef: _branchRef,
      branchName: _branchName,
    )) {
      return null;
    }
    final root = info.root ?? folder;
    final busy = (_machine?.agents ?? const <Agent>[]).any((agent) {
      final cwd = agent.displayProject?.cwd;
      return cwd != null && withinCheckout(root, cwd);
    });
    if (!busy) return null;
    return 'A harness is working in this folder, so its branch can’t be '
        'switched. Turn Worktree on, or stay on '
        '${info.branch ?? 'Detached HEAD'}.';
  }

  Future<void> _create() async {
    final engine = _engine;
    if ((_folder == null && _project == null && !_terminal) ||
        engine == null ||
        _creating) {
      return;
    }
    // A request still waiting on its answer is asked about, never made again — see [_creation].
    final pending = _checking ? _creation : null;
    setState(() {
      _creating = true;
      _checkingLaunch = pending != null;
      _error = null;
    });
    if (pending != null) {
      _answered(
        pending,
        engine,
        await widget.notifier.checkAgentCreation(pending),
      );
      return;
    }
    if (isTerminalEngine(engine)) {
      // No Git wait and no branch guard: a terminal is sent its folder alone, never a branch or a
      // worktree, so there is nothing to read first and nothing it could switch. No task either —
      // the shell is typed into once it opens. See [_terminal].
      final creation = _creation = AgentCreationAttempt();
      final error = await widget.notifier.createAgent(
        _machineId,
        engine: engine,
        // The folder chosen, or none for home — never [_project], which a terminal cannot make.
        folder: _folder,
        deskTabId: widget.deskTabId,
        newDeskTab: widget.newDeskTab,
        attempt: creation,
      );
      _answered(creation, engine, error);
      return;
    }
    if (!await _gitSettled()) return;
    // Taken after the wait, not before it: the answer can move the form to the folder's own
    // repository (a worktree's main checkout), and Start goes where the form says now.
    final folder = _folder, project = _project;
    // Read after the wait for the same reason, and before the first task is looked at — the
    // desktop's order. Only a folder sent with its repository can be switched; `New project` and
    // `Git…` make a folder nothing is working in yet.
    final switchRefusal =
        project == null && folder != null && _repository != null
        ? _branchSwitchRefusal(folder, _repository!)
        : null;
    if (switchRefusal != null) {
      setState(() {
        _creating = false;
        _error = switchRefusal;
      });
      return;
    }
    // The first task as it is sent, read after the wait too: the field stays open through it. An
    // engine that cannot take one is sent none.
    final task = takesFirstTask(engine) ? _task.text.trim() : '';
    // Shortened by the person, never cut here: a machine refuses a longer one, and a task cut to
    // fit is not the one that was written. The desktop's check, in its words.
    if (firstTaskLengthError(task) case final tooLong?) {
      setState(() {
        _creating = false;
        _error = _lengthError = tooLong;
      });
      return;
    }
    // Files ride into the live terminal after creation, and the task follows them there (see
    // [deliverAttachedTask]), so neither is a launch argument then — the desktop's order.
    final files = _attachments.files;
    // Files picked before the agent or the machine changed under them: said, never dropped.
    final cannotTake = files.isEmpty
        ? null
        : !takesFirstTask(engine)
        ? 'This agent cannot be handed files. Remove them to start it.'
        : !canAttachFiles(widget.notifier, _machineId)
        ? 'Update Harness CLI on '
              '${_machine?.machine.displayName ?? 'this computer'} to attach '
              'files, or remove them.'
        : null;
    if (cannotTake != null) {
      setState(() {
        _creating = false;
        _error = cannotTake;
      });
      return;
    }
    // Held so the id of what it starts comes back here — see
    // [AgentCreationAttempt.agentId] — and kept as [_creation] for as long as
    // its answer is outstanding.
    final creation = _creation = AgentCreationAttempt();
    _delivery = files.isEmpty
        ? null
        : (creation: creation, files: files, task: task);
    // A folder in a repository is not sent as a bare `cwd`: the branch and the
    // worktree travel with it, and [gitFolderRequest] is the desktop's own rule
    // for turning the rows above into what the machine is asked to do. A folder
    // that is not a repository, or one this form never read, falls through to
    // the plain path — and `New project` / `Git…` keep the request they made.
    // A New folder is named after the first task when there is one to send — the phone has no name
    // field, and five `codex-2026-…` folders told nobody which was which (openharness#94).
    final namedByTask =
        project != null &&
        project.repository == null &&
        project.gitSource == null &&
        taskProjectSlug(task) != null;
    final request = namedByTask
        ? ProjectFolderRequest.forTask(task)
        : project ??
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
      model: _model,
      deskTabId: widget.deskTabId,
      newDeskTab: widget.newDeskTab,
      attempt: creation,
      prompt: task.isEmpty || files.isNotEmpty ? null : task,
      // Whenever a first task is sent, the harness is called by its words until the engine titles
      // the session — in any project, the desktop's rule. Named only for a New folder, a second
      // harness in an existing one read "Untitled Pane" until then. Nothing to say leaves the name
      // to the machine.
      name: task.isEmpty ? null : taskProjectTitle(task),
    );
    _answered(creation, engine, error);
  }

  /// Cancel request: the held request called off. Confirmed, the form is free for a new one and
  /// says so; otherwise the reason stands under the task and the request stays to be checked.
  Future<void> _cancelPending() async {
    final creation = _creation;
    if (creation == null || _creating || creation.cancelling) return;
    // Called off: no more asking by itself; whatever comes of the cancel, the person checks.
    _holdCheck?.cancel();
    setState(() {});
    final problem = await widget.notifier.cancelAgentCreation(creation);
    if (!mounted) return;
    if (problem == null) {
      if (identical(_creation, creation)) _creation = null;
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(const SnackBar(content: Text('Creation cancelled.')));
    }
    setState(() {
      _held = null;
      _error = problem;
      _failure = null;
    });
  }

  /// What the machine said to [creation], on the form: inside the new harness when one started,
  /// otherwise the reason under the task.
  void _answered(AgentCreationAttempt creation, String engine, String? error) {
    if (!mounted) return;
    // Started, or refused for good: done with. The next press is a new request with an id of its
    // own, made from the rows as they read then.
    if (!creation.awaitingConfirmation) _creation = null;
    if (error == null) {
      _held = null;
      _holdCheck?.cancel();
      // The harness exists: the draft that described it would be a second one waiting to be made
      // by accident. See [NewAgentDraft].
      newAgentDraft = null;
      unawaited(widget.notifier.agentPreference.select(engine));
      _deliverFiles(creation);
      _open(creation.agentId);
      return;
    }
    // Held before anything started — an engine the machine is installing, a model waking: not a
    // failure. Said as a wait, not in red, and asked again by itself until the harness starts, is
    // refused, or is called off; Cancel request stays.
    if (creation.canCancelPending) {
      setState(() {
        _creating = false;
        _error = null;
        _failure = null;
        _held = error;
      });
      _holdCheck?.cancel();
      _holdCheck = Timer(const Duration(seconds: 4), () {
        if (mounted &&
            identical(_creation, creation) &&
            !_creating &&
            !creation.cancelling &&
            _held != null) {
          unawaited(_start());
        }
      });
      return;
    }
    setState(() {
      _creating = false;
      _held = null;
      _error = error;
      _failure = error;
    });
  }

  /// What the machine holds the request on, while it does (an engine installing): shown as a wait.
  String? _held;
  Timer? _holdCheck;

  /// The files [creation] is to be handed once it exists, and the task that follows them — kept
  /// beside [_creation] so a Check status that finds it started still hands them over.
  ({AgentCreationAttempt creation, List<HarnessAttachment> files, String task})?
  _delivery;

  /// Hands a started harness its files and then its task, detached from this form, which is
  /// replaced by the harness's page at once — the desktop's `_deliverFiles`. A problem is said on
  /// the app's own messenger, which outlives the form.
  void _deliverFiles(AgentCreationAttempt creation) {
    final delivery = _delivery;
    if (delivery == null || !identical(delivery.creation, creation)) return;
    _delivery = null;
    _attachments.clear();
    final messenger = ScaffoldMessenger.maybeOf(context);
    void report(String message) =>
        messenger?.showSnackBar(SnackBar(content: Text(message)));
    final agentId = creation.agentId;
    if (agentId == null) {
      report('The harness started without its files. Attach them in its pane.');
      return;
    }
    unawaited(
      deliverAttachedTask(
        widget.notifier,
        machineId: _machineId,
        agentId: agentId,
        files: delivery.files,
        task: delivery.task,
      ).then((problem) {
        if (problem != null) report(problem);
      }),
    );
  }

  /// The last request this form made, kept while the machine has not said whether it started —
  /// the desktop's `_attempt` (`state/new_harness.dart`).
  ///
  /// ⚠️ **A lost reply is not a refusal.** "Has not confirmed the new harness yet" and "still
  /// starting your harness" both mean a harness may exist. Pressed again with a fresh attempt,
  /// the button sent a new `creationId` and could start a second one; with this one it asks
  /// `agent_create_status` about the first. Dropped by [_answered] once the answer is final.
  ///
  /// Only for the open form. Closing it lets the request go, and the draft it leaves is a new
  /// request the next time — the desktop keeps the receipt in its draft, but its drafts are kept
  /// per place, and the phone's one draft would keep every later New on Check status, with
  /// nothing on the form to let it go.
  AgentCreationAttempt? _creation;

  /// [_creation] is waiting on its answer: the button checks on it, and the choices it was made
  /// with are held — the desktop's `checking` and `locked`.
  bool get _checking => _creation?.awaitingConfirmation ?? false;

  /// The rows take no taps: a request is on its way, or one is waiting to be checked on.
  bool get _locked => _creating || _checking;

  /// The press under way is a check on [_creation], not a new request — the desktop's
  /// `_checkingLaunch`, so the button says Checking rather than Starting.
  bool _checkingLaunch = false;

  /// What the last press was answered with. The button says Try Again while that answer is still
  /// the line under the task; a choice changed since clears the line, and the button goes back to
  /// saying what it will do.
  String? _failure;
  bool get _failed => _failure != null && _failure == _error;

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
      // A terminal needs no project: with none it opens at home.
      final ready =
          _engine != null && (_terminal || _folder != null || _project != null);
      // Only an agent's form is missing its project; a terminal's says where it opens.
      final needsProject = !_terminal && _folder == null && _project == null;
      final nothingRunning = _machines.every((m) => m.agents.isEmpty);
      final count = _task.text.trim().length;
      // Typing the task, the keyboard leaves room for one line of the choices, not four cut ones.
      final typing = MediaQuery.viewInsetsOf(context).bottom > 0;
      final summary = [
        if (_folder != null || _project != null) _projectValue,
        if (_engine != null) _engineName(_engine!),
      ].join(' · ');
      return Scaffold(
        backgroundColor: tty.ground,
        body: SafeArea(
          // ⚠️ **A swipe right ANYWHERE goes back to Focus.** New comes in from the right (Find's
          // New Harness), and the way home is the same swipe the other way — not only the
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
                // The way back where a thumb looks for it — Find's button is a tap, not a swipe, so
                // the swipe right alone was a way out nobody was shown. Above the title, as on
                // Computers and Settings.
                Align(
                  alignment: Alignment.centerLeft,
                  child: TtyBackButton(
                    onPressed: () => Navigator.of(context).maybePop(),
                  ),
                ),
                Padding(
                  // No right padding: Settings' box puts its glyph on the gutter itself.
                  padding: const EdgeInsets.fromLTRB(Tty.origin, 0, 0, 0),
                  child: Row(
                    children: [
                      Expanded(
                        child: TtyText(
                          'New Harness',
                          size: TtySize.title,
                          weight: FontWeight.w600,
                        ),
                      ),
                      if (SampleMode.ofNotifier(widget.notifier) != null)
                        Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: TtyText(
                            'Sample',
                            color: tty.faint,
                            size: TtySize.meta,
                          ),
                        ),
                      // Settings at the top right, as on Computers — its box keeps the row 44 tall.
                      PhoneSettingsButton(notifier: widget.notifier),
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
                    // Where "harness" is taught: the moment somebody makes their first one. The agent
                    // is Claude Code or Codex; a harness is one session of it — the owner: "you have
                    // 1 agent codex but you have multiple harnesses (sessions) with it."
                    child: TtyText(
                      'A harness is one session of an agent. Start your first.',
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
                  ),
                // ⚠️ **The dock scrolls once nothing else can give way.** The rows above it go first,
                // as they always have; with none left, a dock taller than what is left used to
                // overflow — an SE typing its task at the largest text size lost the foot of the
                // field and Start with it. Held to the height below the header, it scrolls instead,
                // pinned to its foot, so the field being typed into and Start stay on the keys.
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, box) => Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (typing)
                          const Spacer()
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
                                  valueColor: _engine == null
                                      ? tty.green
                                      : null,
                                  detail: _engine == null
                                      ? null
                                      : _engineNote(_engine!),
                                  onTap: _locked
                                      ? null
                                      : () => unawaited(_chooseAgent()),
                                ),
                                TtyFormRow(
                                  label: 'computer',
                                  value:
                                      _machine?.machine.displayName ??
                                      'Choose a computer',
                                  valueColor: _machine == null
                                      ? tty.green
                                      : null,
                                  detail: _machineNote,
                                  onTap: _locked
                                      ? null
                                      : () => unawaited(_chooseComputer()),
                                ),
                                TtyFormRow(
                                  label: 'project',
                                  value: needsProject
                                      ? 'Choose a project'
                                      : _projectName,
                                  valueColor: needsProject ? tty.green : null,
                                  detail: null,
                                  onTap: _locked
                                      ? null
                                      : () => unawaited(_chooseProject()),
                                ),
                                // The owner's default flow matches desktop: choose agent and project.
                                // Worktree, approvals and profile stay behind Options. A terminal has
                                // none of them ([_terminal]), so it has no Options either: a row that
                                // opened onto nothing, or onto rows that would be ignored, is noise.
                                if (!_terminal)
                                  TtyFormRow(
                                    label: 'options',
                                    value: _optionsOpen ? '[-]' : '[+]',
                                    chevron: false,
                                    onTap: _locked
                                        ? null
                                        : () => setState(
                                            () => _optionsOpen = !_optionsOpen,
                                          ),
                                  ),
                                if (_optionsOpen &&
                                    _engine != null &&
                                    !_terminal)
                                  TtyFormRow(
                                    label: 'model',
                                    value:
                                        _model?.id ??
                                        modelSubscriptionLabel(_engine!),
                                    detail: _model?.node,
                                    onTap: _locked
                                        ? null
                                        : () => unawaited(_chooseModel()),
                                  ),
                                if (_optionsOpen && _permissionModes.isNotEmpty)
                                  TtyFormRow(
                                    label: 'approvals',
                                    value: mode?.label ?? 'Auto-approve',
                                    detail: mode?.detail,
                                    valueColor: (mode?.risky ?? false)
                                        ? tty.red
                                        : null,
                                    onTap: _locked
                                        ? null
                                        : () => unawaited(_chooseApprovals()),
                                  ),
                                if (_optionsOpen && _showsCodexProfile)
                                  TtyFormRow(
                                    label: 'profile',
                                    value: _codexProfile?.label ?? 'Default',
                                    onTap: _locked
                                        ? null
                                        : () => unawaited(_chooseProfile()),
                                  ),
                                if (_optionsOpen && !_terminal) ...[
                                  TtyFormRow(
                                    label: 'branch',
                                    valueColor: info == null ? tty.faint : null,
                                    value: _gitLoading
                                        ? 'Reading…'
                                        : _gitFailed
                                        ? 'No answer from the computer'
                                        : info != null
                                        ? _branchTitle
                                        : _project != null
                                        ? 'Available after creation'
                                        : _folder == null
                                        ? 'Choose a project'
                                        : 'Not a Git repository',
                                    detail: info == null ? null : _branchNote,
                                    onTap: info == null || _locked
                                        ? null
                                        : () => unawaited(_pickBranch(info)),
                                  ),
                                  Semantics(
                                    checked: info != null && _worktree,
                                    child: TtyFormRow(
                                      label: 'worktree',
                                      value: info != null && _worktree
                                          ? '[x]'
                                          : '[ ]',
                                      valueColor: info == null
                                          ? tty.faint
                                          : null,
                                      chevron: false,
                                      detail: _inWorktree
                                          ? 'Already a worktree'
                                          : null,
                                      onTap:
                                          info == null || _locked || _inWorktree
                                          ? null
                                          : () => setState(() {
                                              _worktree = !_worktree;
                                              _error = null;
                                            }),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        // The dock: the task, then Start. It rides the keyboard.
                        ConstrainedBox(
                          constraints: BoxConstraints(maxHeight: box.maxHeight),
                          child: SingleChildScrollView(
                            reverse: true,
                            child: Padding(
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
                                  // Only for a first harness — once something is
                                  // running, somebody knows what to ask, and the
                                  // chips were filler over the form.
                                  if (nothingRunning &&
                                      !_terminal &&
                                      _task.text.trim().isEmpty &&
                                      !_creating)
                                    Padding(
                                      padding: const EdgeInsets.only(bottom: 8),
                                      child: Wrap(
                                        spacing: 8,
                                        runSpacing: 8,
                                        children: [
                                          for (final idea in firstTaskIdeas)
                                            FirstTaskSuggestion(
                                              text: idea,
                                              onTap: () => setState(() {
                                                _task.value = TextEditingValue(
                                                  text: idea,
                                                  selection:
                                                      TextSelection.collapsed(
                                                        offset: idea.length,
                                                      ),
                                                );
                                              }),
                                            ),
                                        ],
                                      ),
                                    ),
                                  // A shell has no first task: in place of a field whose words would
                                  // never be sent, the desktop's line for it. What was typed stays in
                                  // [_task], so picking an agent again finds it — the desktop's rule.
                                  if (_terminal)
                                    TtyText(
                                      'A terminal opens straight on your shell; '
                                      'type there.',
                                      color: tty.faint,
                                      size: TtySize.meta,
                                    )
                                  else ...[
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
                                      action: TextInputAction.newline,
                                      onChanged: _taskEdited,
                                      trailing: [
                                        if (_canAttach)
                                          Align(
                                            alignment: Alignment.bottomRight,
                                            child: AttachmentButton(
                                              onTap: _creating
                                                  ? null
                                                  : () => unawaited(_attach()),
                                            ),
                                          ),
                                        Align(
                                          alignment: Alignment.bottomRight,
                                          child: ListenableBuilder(
                                            listenable:
                                                _voiceIfAny ?? const _Silent(),
                                            builder: (context, _) {
                                              final status =
                                                  _voiceIfAny?.status;
                                              return TtyFieldMic(
                                                live:
                                                    status ==
                                                        VoiceInputStatus
                                                            .listening ||
                                                    status ==
                                                        VoiceInputStatus
                                                            .starting,
                                                onTap: _creating ? null : _talk,
                                              );
                                            },
                                          ),
                                        ),
                                      ],
                                    ),
                                    // Shown while there are files even where none can go now — the
                                    // machine or the agent changed under them — so they can be taken
                                    // back off.
                                    if (_canAttach || !_attachments.isEmpty)
                                      Padding(
                                        padding: const EdgeInsets.only(top: 4),
                                        child: AttachmentList(
                                          attachments: _attachments,
                                          enabled: !_creating,
                                        ),
                                      ),
                                  ],
                                  if (_held != null && _error == null)
                                    Padding(
                                      key: const ValueKey('new-agent-held'),
                                      padding: const EdgeInsets.only(top: 8),
                                      child: Row(
                                        children: [
                                          SizedBox.square(
                                            dimension: 12,
                                            child: CircularProgressIndicator(
                                              strokeWidth: 1.6,
                                              color: tty.dim,
                                            ),
                                          ),
                                          const SizedBox(width: 10),
                                          Expanded(
                                            child: Text(
                                              _held!,
                                              style: tty.style(
                                                color: tty.dim,
                                                size: TtySize.meta,
                                              ),
                                            ),
                                          ),
                                        ],
                                      ),
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
                                    // Says what it will do: check on a request still unanswered, start,
                                    // or choose what is still missing first.
                                    label: _checking
                                        ? 'Check status'
                                        : _failed
                                        ? 'Try Again'
                                        : ready
                                        ? 'Start'
                                        : _engine == null
                                        ? 'Choose an agent'
                                        : 'Choose a project',
                                    busy: _creating,
                                    busyLabel: _checkingLaunch
                                        ? 'Checking…'
                                        : 'Starting…',
                                    // Never a dead button: with a choice missing, Start opens its chooser.
                                    onPressed: () => unawaited(_start()),
                                  ),
                                  // A request the machine holds before starting anything (an engine it is
                                  // installing) can still be called off — the desktop's Cancel request.
                                  if (_creation?.canCancelPending == true &&
                                      !_creating)
                                    Center(
                                      child: TtyTextButton(
                                        key: const ValueKey(
                                          'cancel-pending-creation',
                                        ),
                                        label: 'Cancel request',
                                        size: TtySize.meta,
                                        onPressed: _creation!.cancelling
                                            ? null
                                            : () => unawaited(_cancelPending()),
                                      ),
                                    ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );

  Future<void> _chooseModel() async {
    final engine = _engine;
    if (engine == null) return;
    final machineId = _machineId;
    final choice = await showNewAgentModelSheet(
      context,
      notifier: widget.notifier,
      machineId: machineId,
      engine: engine,
      selected: _model,
      profileLabel: engine == 'codex' ? _codexProfile?.label : null,
    );
    if (choice == null ||
        !mounted ||
        machineId != _machineId ||
        engine != _engine) {
      return;
    }
    setState(() {
      _model = choice.model;
      _error = null;
    });
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
    // The folder the page was opened for is a path on ITS computer, never on one the row moved to.
    final folder =
        (_machineId == widget.machineId ? widget.folder : null) ??
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

  /// The project row: the project's name alone, as the desktop's project pill writes it — the
  /// computer has a row of its own above, and `computer:name` there spent the row on a long
  /// hostname and cut the name off. Most repositories live in a folder of the same name; the full
  /// path is in the chooser.
  String get _projectName {
    if (_folder case final folder?) return _basename(folder);
    // Where a terminal with no folder opens, as the desktop's project pill writes it. Before
    // [_project]: a terminal never makes one, so naming it would say where the shell will not be.
    if (_terminal) return '~';
    if (_project?.repository case final repository?) return repository.name;
    if (_project != null) return 'New folder';
    return 'Choose project';
  }

  /// The project as the one-line summary writes it while typing, where the computer row is hidden:
  /// `computer:name`, as the title on Focus and every Find row write it.
  String get _projectValue {
    final machine = _machine?.machine.displayName;
    return machine == null ? _projectName : '$machine:$_projectName';
  }

  /// Why the chosen computer cannot take a harness, under its name — or nothing while it can.
  ///
  /// Only for the two states Start would fail on. `Connecting…` is a socket redialling for a moment
  /// (every return to the app), and a note flashing on each redial would teach nobody anything.
  String? get _machineNote {
    final machine = _machine;
    if (machine == null) return null;
    return switch (phoneMachineStatusOf(machine)) {
      PhoneMachineStatus.offline ||
      PhoneMachineStatus.needsPassword => phoneMachineSummary(machine).label,
      PhoneMachineStatus.connecting || PhoneMachineStatus.ready => null,
    };
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
    if (_folder == null && _project == null && !_terminal) {
      setState(() => _error = 'Choose a project.');
      await _chooseProject();
      return;
    }
    await _create();
  }

  Future<void> _chooseAgent() async {
    await widget.notifier.agentPreference.load();
    if (!mounted) return;
    final machine = _machine;
    final recent = widget.notifier.agentPreference.recent;
    final ids = {
      for (final identity in _engines) identity.id,
      ?_engine,
      kTerminalEngine,
    };
    final ordered = [
      ?_engine,
      for (final id in recent)
        if (ids.contains(id) && id != _engine) id,
      ...ids.where(
        (id) => id != _engine && !recent.contains(id) && !isTerminalEngine(id),
      ),
      // After every agent, as the desktop lists it: a plain shell, for when none of them is wanted.
      // Among the recents instead once it has been started here, as any agent is.
      if (_engine != kTerminalEngine && !recent.contains(kTerminalEngine))
        kTerminalEngine,
    ];
    final picked = await showNewAgentChooser<String>(
      context,
      title: 'Agent',
      hint: 'Search agents',
      items: [
        for (final id in ordered)
          ChooserItem(
            value: id,
            title: _engineName(id),
            // The desktop's line for it: every machine has a shell, so there is never a note to give.
            subtitle: isTerminalEngine(id)
                ? 'Your shell on ${machine?.machine.displayName ?? 'the computer'}'
                : _engineNote(id),
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

  /// The computer row: every computer on the account, ready ones first — the desktop header's
  /// Computer menu. One that cannot take a harness now is listed greyed, with why, rather than
  /// left out: a computer missing from the list reads as one the phone does not know.
  ///
  /// Moving keeps nothing of the old computer's folder (see [_selectMachine]). The new one gets back
  /// what was chosen on it earlier in this form, else its own last project, as on the desktop.
  Future<void> _chooseComputer() async {
    final picked = await showNewAgentChooser<String>(
      context,
      title: 'Computer',
      hint: 'Search computers',
      items: [
        for (final machine in filterableMachines(widget.notifier))
          ChooserItem(
            value: machine.machine.machineId,
            title: machine.machine.displayName,
            subtitle: phoneMachineSummary(machine).label,
            icon: LucideIcons.laptopMinimal300,
            selected: machine.machine.machineId == _machineId,
            enabled: phoneMachineStatusOf(machine) == PhoneMachineStatus.ready,
          ),
      ],
    );
    if (picked == null || !mounted || picked == _machineId) return;
    // Rechecked: the sheet is a picture of the moment it opened, and a computer can drop off while
    // it is up.
    final machine = widget.notifier.stateOf(picked);
    if (machine == null ||
        phoneMachineStatusOf(machine) != PhoneMachineStatus.ready) {
      setState(() => _error = 'That computer is no longer available.');
      return;
    }
    _selectMachine(picked);
    final kept = _projectsByMachine[picked];
    setState(() {
      _folder = kept?.folder;
      _project = kept?.project;
      _projectLabel = kept?.label;
      // Nothing kept: the next build's [_applyDefaultProject] takes this computer's last project.
      _projectDefaulted = kept != null;
    });
    if (kept?.folder case final folder?) unawaited(_loadGit(folder));
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
            ?(agent.project?.root ?? agent.project?.cwd),
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
    // A terminal opens in a folder that is there; the machine refuses to make one for it
    // (INVALID_PROJECT_SOURCE), so Clone and New Folder are not offered to one — the chooser leaves
    // an action that cannot be taken out rather than drawing it dead.
    final canMake = _canMakeProject && !_terminal;
    final picked = await showNewAgentChooser<_ProjectChoice>(
      context,
      title: 'Project',
      hint: 'Search projects',
      autofocusSearch: true,
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
    final picked = await showNewAgentChooser<_ProfileChoice>(
      context,
      title: 'Profile',
      hint: 'Search profiles',
      items: [
        ChooserItem(
          value: const _ProfileChoice(null),
          title: 'Default',
          subtitle: _codexProfilesLoaded ? null : 'Looking for others…',
          icon: LucideIcons.user300,
          selected: _codexProfile == null,
        ),
        for (final profile in _codexProfiles)
          ChooserItem(
            value: _ProfileChoice(profile),
            title: profile.label,
            subtitle: profile.path,
            icon: LucideIcons.user300,
            selected: _codexProfile == profile,
          ),
      ],
    );
    // Put away without a pick: the profile stays what it was. Default is a pick, of no profile.
    if (picked == null || !mounted) return;
    setState(() => _codexProfile = picked.profile);
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

/// What the Profile chooser hands back: a profile, or none for Default. Wrapped because the sheet
/// answers null when it is put away, and Default read that way reset a profile nobody unchose — the
/// model sheet's [NewAgentModelChoice] for the same reason.
class _ProfileChoice {
  const _ProfileChoice(this.profile);

  final LocalCodexProfile? profile;
}

/// A computer's project choice, held while the form is on another computer — see
/// `_projectsByMachine`.
typedef _KeptProject = ({
  String? folder,
  ProjectFolderRequest? project,
  String? label,
});

/// A listenable that never speaks — the mic's before a recorder exists.
class _Silent implements Listenable {
  const _Silent();

  @override
  void addListener(VoidCallback listener) {}

  @override
  void removeListener(VoidCallback listener) {}
}
