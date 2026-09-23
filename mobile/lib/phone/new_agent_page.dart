import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/codex_profiles.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';
import 'package:harness_mobile/core/git_project.dart';
import 'package:harness_mobile/core/project_folder.dart';
import 'package:harness_mobile/widgets/remote_folder_picker.dart';

import 'agent_index.dart';
import 'branch_picker_sheet.dart';
import 'phone_header.dart';
import 'phone_navigation.dart';
import 'phone_status.dart';
import 'settings_row.dart';

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
  });

  final AppNotifier notifier;
  final String machineId;

  @override
  State<NewAgentPage> createState() => _NewAgentPageState();
}

class _NewAgentPageState extends State<NewAgentPage> {
  /// The machine the agent is created on. Starts on the one the page was opened with, and the
  /// MACHINE rows change it.
  late String _machineId = widget.machineId;

  /// Whether the MACHINE row is folded open onto the other machines.
  bool _machinesOpen = false;

  /// Whether the engines past [_primaryEngines] are shown.
  bool _moreEnginesOpen = false;

  /// Whether PROJECT and ENGINE are folded open onto their choices. BRANCH
  /// opens a sheet of its own instead — see [showBranchPickerSheet] — because
  /// its list is the one that needs searching.
  ///
  /// ⚠️ **Shut by default, and that is what makes this a form rather than a
  /// list of everything.** Laid out flat it ran to ten rows with four sources
  /// and five engines always on screen, so the two rows that matter — where the
  /// work is and what runs it — read as items in a catalogue, and Branch had
  /// nowhere to go. Folded, the page says what is chosen; opening a section is
  /// how it is changed. It is the idiom MACHINE above already uses.
  bool _projectOpen = false;
  bool _engineOpen = false;

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

  /// Whether the Recent row is folded open.
  ///
  /// Starts shut every time, and closes again on a pick: what it lists are answers, and once one is
  /// taken the list has nothing left to say.
  bool _recentOpen = false;

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
    if (machineId == _machineId) {
      setState(() => _machinesOpen = false);
      return;
    }
    setState(() {
      _machineId = machineId;
      _machinesOpen = false;
      _folder = null;
      _project = null;
      _projectLabel = null;
      _recentOpen = false;
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
    final info = GitProjectInfo.fromJson(raw);
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

  /// The PROJECT row's own line: the folder's last segment, or the name of the
  /// source that will make one.
  String get _projectTitle => _folder != null
      ? _basename(_folder!)
      : (_projectLabel ?? 'Choose a folder');

  /// Under it: the whole path, or why there is none yet.
  String? get _projectDetail =>
      _folder ??
      (_project?.repository != null
          ? 'Cloned on the machine'
          : _project != null
          ? 'A fresh folder, made on the machine'
          : null);

  String get _engineLabel => _engine == null
      ? 'Choose an agent'
      : allEngines
                .where((identity) => identity.id == _engine)
                .firstOrNull
                ?.label ??
            _engine!;

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

  /// Folders agents have been started in on THIS machine, newest first.
  ///
  /// ⚠️ A stored history, not a reading of what exists now. It survives the agent that put it
  /// there, which is what makes "recent" honest — the list that came from `machine.agents` emptied
  /// itself when an agent was deleted, and called that "recent" too.
  ///
  /// Scoped per machine because the paths are: a folder on one computer means nothing on another.
  List<String> get _recent => widget.notifier.projectHistory.recent(_machineId);

  /// Whether the chosen folder came from the browser rather than from Recent.
  bool get _browsed => _folder != null && !_recent.contains(_folder);

  /// The recent folder currently chosen, for the folded row to show, or null.
  String? get _pickedRecent =>
      _folder != null && _recent.contains(_folder) ? _folder : null;

  String get _recentCount =>
      _recent.length == 1 ? '1 folder' : '${_recent.length} folders';

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

  /// The engines shown before "More". The rest fold behind it: fourteen rows put the Create button's
  /// neighbours out of reach, and most people start with one of these.
  static const _primaryEngines = {'claude', 'codex', 'opencode', 'hermes'};

  /// The engine rows on screen: the primary ones, then the rest once unfolded. A chosen engine from
  /// the folded part stays visible, so the tick is never hidden behind "More".
  List<EngineIdentity> get _shownEngines => [
    for (final identity in _engines)
      if (_primaryEngines.contains(identity.id) ||
          _moreEnginesOpen ||
          identity.id == _engine)
        identity,
  ];

  int get _hiddenEngineCount => _engines.length - _shownEngines.length;

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
      // Only for Codex, and only when chosen: omitted, the machine launches
      // with its own default CODEX_HOME.
      codexHome: _showsCodexProfile ? _codexProfile?.path : null,
      attempt: creation,
    );
    if (!mounted) return;
    if (error == null) {
      _open(creation.agentId);
      return;
    }
    setState(() {
      _creating = false;
      _error = error;
    });
  }

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
      AppTheme.watch(context);
      final machine = _machine;
      final machines = _machines;
      // "New project" is the folder until one is chosen. Applied here rather than in `initState`
      // because it can only be offered once the machine has said it can make one, and that answer
      // lands after the page opens. Nothing but a machine switch leaves both unset again, so this
      // never overrides a choice — and a switch re-applies it on the new machine.
      if (_folder == null && _project == null && _canMakeProject) {
        _project = const ProjectFolderRequest.newProject();
        _projectLabel = 'New project';
      }
      final ready =
          (_folder != null || _project != null) &&
          _engine != null &&
          !_creating;
      return Scaffold(
        backgroundColor: AppPalette.windowBg,
        body: SafeArea(
          child: Column(
            children: [
              // No machine under the title any more: the MACHINE rows below say it, and are where it
              // is changed.
              const PhoneHeader(title: 'New Harness'),
              Expanded(
                child: ListView(
                  // ⚠️ **A side inset, where this list had none.** The cards
                  // ran edge to edge while every other list on the phone sits
                  // 16 in ([phoneListPadding]), so a form of three rows read as
                  // three bands across the screen rather than as cards on it.
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                  children: [
                    const SettingsCaption('MACHINE'),
                    SettingsGroup(
                      children: [
                        // Folded like Recent: the chosen machine is the answer most of the time,
                        // and the others only matter to somebody about to change it.
                        SettingsRow(
                          title: machine?.machine.displayName ?? 'Machine',
                          leading: Icon(
                            LucideIcons.laptopMinimal300,
                            size: 18,
                            color: AppPalette.textSecondary,
                          ),
                          trailing: machines.length < 2
                              ? null
                              : Icon(
                                  _machinesOpen
                                      ? LucideIcons.chevronUp300
                                      : LucideIcons.chevronDown300,
                                  size: 18,
                                  color: AppPalette.textFaint,
                                ),
                          onTap: machines.length < 2
                              ? null
                              : () => setState(
                                  () => _machinesOpen = !_machinesOpen,
                                ),
                        ),
                        if (_machinesOpen)
                          for (final other in machines)
                            SettingsRow(
                              title: other.machine.displayName,
                              nested: true,
                              trailing: _check(
                                other.machine.machineId == _machineId,
                              ),
                              onTap: () =>
                                  _selectMachine(other.machine.machineId),
                            ),
                      ],
                    ),
                    const SettingsCaption('PROJECT'),
                    SettingsGroup(
                      children: [
                        // What is chosen, and the way into changing it. Its
                        // detail is the full path: the title is only the last
                        // segment, and two machines' `mobile` folders are told
                        // apart by everything before it.
                        SettingsRow(
                          title: _projectTitle,
                          detail: _projectDetail,
                          leading: Icon(
                            LucideIcons.folder300,
                            size: 18,
                            color: AppPalette.textSecondary,
                          ),
                          trailing: Icon(
                            _projectOpen
                                ? LucideIcons.chevronUp300
                                : LucideIcons.chevronDown300,
                            size: 18,
                            color: AppPalette.textFaint,
                          ),
                          onTap: () =>
                              setState(() => _projectOpen = !_projectOpen),
                        ),
                        if (_projectOpen) ...[
                          SettingsRow(
                            title: 'New project',
                            nested: true,
                            detail:
                                _projectSourceNote ??
                                'A fresh folder, made on the machine',
                            leading: Icon(
                              LucideIcons.folderPlus300,
                              size: 18,
                              color: AppPalette.textSecondary,
                            ),
                            trailing: _check(
                              _project != null && _project!.repository == null,
                            ),
                            onTap: !_canMakeProject
                                ? null
                                : () => setState(() {
                                    _project =
                                        const ProjectFolderRequest.newProject();
                                    _projectLabel = 'New project';
                                    _folder = null;
                                    _git = null;
                                    _gitFolder = null;
                                    _error = null;
                                  }),
                          ),
                          // Shows its path only when the choice is this row's own. A folder picked
                          // from RECENT below is already named there, and printing it here too would
                          // put one answer under two ticks.
                          SettingsRow(
                            title: 'Browse…',
                            nested: true,
                            detail: _browsed ? _folder : null,
                            leading: Icon(
                              LucideIcons.folderSearch300,
                              size: 18,
                              color: AppPalette.textSecondary,
                            ),
                            trailing: _check(_browsed),
                            onTap: () => unawaited(_browse()),
                          ),
                          SettingsRow(
                            title: 'Git…',
                            nested: true,
                            detail:
                                _projectSourceNote ??
                                (_project?.repository == null
                                    ? 'Clone a GitHub repository'
                                    : _projectLabel),
                            leading: Icon(
                              LucideIcons.gitBranch300,
                              size: 18,
                              color: AppPalette.textSecondary,
                            ),
                            trailing: _check(_project?.repository != null),
                            onTap: !_canMakeProject
                                ? null
                                : () => unawaited(_pickRepository()),
                          ),
                          // The fourth source, folded shut. Its entries are answers already given
                          // rather than a way of choosing, so they stay out of sight until asked
                          // for — a machine used for months would otherwise bury the three rows
                          // above under its own history.
                          //
                          // ⚠️ Absent entirely when there is no history, rather than opening onto
                          // nothing. Nobody's first agent has a recent folder.
                          if (_recent.isNotEmpty)
                            SettingsRow(
                              title: 'Recent',
                              nested: true,
                              detail: _recentOpen
                                  ? null
                                  : (_pickedRecent ?? _recentCount),
                              leading: Icon(
                                LucideIcons.history300,
                                size: 18,
                                color: AppPalette.textSecondary,
                              ),
                              trailing: Icon(
                                _recentOpen
                                    ? LucideIcons.chevronUp300
                                    : LucideIcons.chevronDown300,
                                size: 18,
                                color: AppPalette.textFaint,
                              ),
                              onTap: () =>
                                  setState(() => _recentOpen = !_recentOpen),
                            ),
                          if (_recentOpen)
                            for (final path in _recent)
                              SettingsRow(
                                title: _basename(path),
                                detail: path,
                                nested: true,
                                // No leading glyph: the indent under an open Recent is what says
                                // these belong to it, and a second icon column would put them back
                                // level with the sources above.
                                trailing: _check(_folder == path),
                                onTap: () {
                                  setState(() {
                                    _folder = path;
                                    _project = null;
                                    _projectLabel = null;
                                    _recentOpen = false;
                                    _error = null;
                                  });
                                  unawaited(_loadGit(path));
                                },
                              ),
                        ],
                      ],
                    ),
                    ..._branchSection(),
                    // ⚠️ **"Agent" here means the ENGINE — Claude Code, Codex —
                    // and that is the desktop's word, not a slip back into the
                    // one this app spent a rename getting rid of.** The desktop
                    // calls a running instance a HARNESS and the program it
                    // runs an AGENT (`NewHarnessField.agent => 'Agent'`), so on
                    // this form the two words sit one above the other meaning
                    // two different things. Anywhere else in this app, a
                    // harness is a harness.
                    const SettingsCaption('AGENT'),
                    SettingsGroup(
                      children: [
                        // The engine in one row, the rest behind it — see
                        // [_projectOpen] for why nothing here is laid out flat.
                        SettingsRow(
                          title: _engineLabel,
                          detail: _engine == null
                              ? null
                              : _engineNote(_engine!),
                          leading: _engine == null
                              ? Icon(
                                  LucideIcons.cpu300,
                                  size: 18,
                                  color: AppPalette.textSecondary,
                                )
                              : EngineMark(engine: _engine!, size: 18),
                          trailing: Icon(
                            _engineOpen
                                ? LucideIcons.chevronUp300
                                : LucideIcons.chevronDown300,
                            size: 18,
                            color: AppPalette.textFaint,
                          ),
                          onTap: () =>
                              setState(() => _engineOpen = !_engineOpen),
                        ),
                        if (_engineOpen)
                          for (final identity in _shownEngines) ...[
                            SettingsRow(
                              title: identity.label,
                              nested: true,
                              detail: _engineNote(identity.id),
                              leading: EngineMark(
                                engine: identity.id,
                                size: 18,
                              ),
                              trailing: _check(_engine == identity.id),
                              onTap: () => setState(() {
                                _engine = identity.id;
                                _error = null;
                              }),
                            ),
                            // Codex's profiles belong UNDER Codex, not in a section of their own at
                            // the foot of the page. They are a detail of one engine — a section
                            // separated from the row that summons it reads as a second question,
                            // and appearing at the bottom of a long list is how it went unnoticed.
                            //
                            // ⚠️ Only for the engine that has them, and only once the machine has
                            // said it understands CODEX_HOME. Every other engine shows nothing here,
                            // which is why this is a list inside the loop rather than a block after
                            // it.
                            if (identity.id == 'codex' &&
                                _showsCodexProfile) ...[
                              SettingsRow(
                                title: 'Default profile',
                                nested: true,
                                detail: _codexProfilesLoaded
                                    ? null
                                    : 'Looking for others…',
                                trailing: _check(_codexProfile == null),
                                onTap: () =>
                                    setState(() => _codexProfile = null),
                              ),
                              for (final profile in _codexProfiles)
                                SettingsRow(
                                  title: profile.label,
                                  detail: profile.path,
                                  nested: true,
                                  trailing: _check(_codexProfile == profile),
                                  onTap: () =>
                                      setState(() => _codexProfile = profile),
                                ),
                            ],
                          ],
                        // The rest of the engines, behind one row. It stays once opened: there is
                        // nothing to fold back to that the person would want.
                        if (_engineOpen &&
                            !_moreEnginesOpen &&
                            _hiddenEngineCount > 0)
                          SettingsRow(
                            title: '$_hiddenEngineCount more',
                            leading: Icon(
                              LucideIcons.ellipsis300,
                              size: 18,
                              color: AppPalette.textSecondary,
                            ),
                            onTap: () =>
                                setState(() => _moreEnginesOpen = true),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              // ⚠️ The refusal belongs BESIDE the button, not at the end of the list above it.
              // It used to sit after the engines and the Codex profile — past nine rows and well
              // below the fold — while the button is pinned here. Pressing Create and being
              // refused looked exactly like pressing Create and nothing happening, because the
              // answer rendered somewhere nobody was looking.
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
                  child: Text(
                    _error!,
                    style: TextStyle(color: AppPalette.offline, fontSize: 13),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: SizedBox(
                  width: double.infinity,
                  // ⚠️ **The rows' width and the rows' corner, but not their
                  // height.** It sat narrower than the cards, shorter, and
                  // rounder — three small differences that together read as
                  // something from another screen, so the inset (16, the
                  // list's) and the radius ([AppCard.radius]) are theirs. The
                  // height is not: a solid accent bar as tall as a row is the
                  // heaviest thing on a page whose other three items are
                  // outlines, and it read as the page being built around the
                  // button. 44 is what the folder sheet gives the controls a
                  // thumb aims at, so every button in this flow is one height.
                  height: 44,
                  child: FilledButton(
                    style: FilledButton.styleFrom(
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(AppCard.radius),
                      ),
                    ),
                    onPressed: ready ? () => unawaited(_create()) : null,
                    child: Text(
                      _creating ? 'Starting…' : 'Create Harness',
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );

  /// BRANCH and Worktree, or nothing at all.
  ///
  /// ⚠️ **Absent rather than empty for a folder with no repository.** Most of
  /// what a phone starts is a fresh project or a clone, and a Branch row that
  /// could never be tapped would be two thirds of this form saying "not
  /// applicable". It appears the moment a folder turns out to be a checkout,
  /// which is also the moment it has something to offer.
  ///
  /// While the machine is still answering, the section is drawn with the row
  /// dimmed instead of appearing late under the thumb — a form that grows a
  /// section between reading it and pressing Create is how people press the
  /// wrong thing.
  List<Widget> _branchSection() {
    final info = _repository;
    if (info == null && !_gitLoading && !_gitFailed) return const [];
    if (info == null && _gitFailed) {
      return [
        const SettingsCaption('BRANCH'),
        SettingsGroup(
          children: [
            SettingsRow(
              title: 'Could not read the repository',
              detail:
                  'The machine did not answer. The harness still starts in '
                  'the folder, on the branch it is on.',
              leading: Icon(
                LucideIcons.gitBranch300,
                size: 18,
                color: AppPalette.textFaint,
              ),
            ),
          ],
        ),
      ];
    }
    return [
      const SettingsCaption('BRANCH'),
      SettingsGroup(
        children: [
          SettingsRow(
            title: _gitLoading ? 'Reading the repository…' : _branchTitle,
            detail: _gitLoading ? null : _branchNote,
            leading: Icon(
              LucideIcons.gitBranch300,
              size: 18,
              color: AppPalette.textSecondary,
            ),
            // A chevron pointing RIGHT, not a fold arrow: this row opens a
            // sheet rather than unfolding under itself.
            trailing: _gitLoading
                ? null
                : Icon(
                    LucideIcons.chevronRight300,
                    size: 18,
                    color: AppPalette.textFaint,
                  ),
            onTap: _gitLoading || info == null
                ? null
                : () => unawaited(_pickBranch(info)),
          ),
          // ⚠️ Beside the branch row, never inside what opens from it. It
          // changes what that row MEANS — with it off the folder itself moves
          // to the branch, with it on the harness gets a checkout of its own —
          // so it has to be readable at the same time as the answer it
          // qualifies.
          if (info != null)
            SettingsRow(
              title: 'Worktree',
              detail: _worktree
                  ? 'A checkout of its own, beside the folder'
                  : 'Work in the folder itself',
              leading: Icon(
                LucideIcons.gitFork300,
                size: 18,
                color: AppPalette.textSecondary,
              ),
              trailing: Switch.adaptive(
                value: _worktree,
                onChanged: (value) => setState(() {
                  _worktree = value;
                  // The base a branch starts from is read differently by each
                  // — see [defaultBranchRef] — so a ref chosen for one is not
                  // an answer to the other.
                  _branchRef = defaultBranchRef(info, worktree: value);
                  _error = null;
                }),
              ),
              onTap: () => setState(() {
                _worktree = !_worktree;
                _branchRef = defaultBranchRef(info, worktree: _worktree);
                _error = null;
              }),
            ),
        ],
      ),
    ];
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

  Widget? _check(bool selected) => selected
      ? Icon(LucideIcons.check300, size: 18, color: AppPalette.accent)
      : null;
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
