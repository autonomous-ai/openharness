import 'dart:async';

import 'package:clock/clock.dart';

import 'package:flutter/foundation.dart' show setEquals;
import 'package:flutter/material.dart';

import '../core/runtime_model_name.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/swarm_layout.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import 'agent_details.dart' show SuperTabAgentInfo;
import 'controller.dart';
import 'github_issues.dart';
import 'model.dart';
import 'task_board.dart';
import 'visible_tick.dart';

/// An agent's engine as its chat's bar names it: `Claude Code`, else the app's one name for the engine (`Codex`, `OpenCode`),
/// null when it has none.
String? swarmEngineName(SuperTabAgent agent) => switch (agent.engine.trim()) {
  '' => null,
  'claude' => 'Claude Code',
  final engine => engineIdentity(engine).label,
};

/// What the app already knows of an agent, beside its chat (Swarm v4, anh Dee 2026-11-09: "we need more info on the agent"):
/// its person, the projects it is in and its part in each, the computer it runs on and whether that is up, its engine and
/// model, what it is doing, the task it holds, and its folder, one short row each. A row the app has no value for is not
/// drawn. The task is what its projects' boards hold for it, from the issues [SwarmTaskBoard] reads: what was read last at
/// once, read again on opening and each minute while it is open; the rest comes from the Swarm and from this computer's
/// view of the agent's machine, in the words the rest of the app uses ([SuperTabAgentInfo]).
class SwarmAgentInfo extends StatefulWidget {
  const SwarmAgentInfo({
    super.key,
    required this.controller,
    required this.agent,
    required this.machineName,
    required this.github,
    required this.onClose,
    this.app,
    this.refreshEvery,
  });

  final SuperTabController controller;
  final SuperTabAgent agent;

  /// The name of the computer the agent runs on.
  final String machineName;
  final SwarmGitHub github;
  final VoidCallback onClose;

  /// This computer's view of the agent's machine; without it, the rows only it knows are not drawn.
  final AppNotifier? app;

  /// How often the boards are read again while Info is open, as the board does; null reads only on opening.
  final Duration? refreshEvery;

  @override
  State<SwarmAgentInfo> createState() => _SwarmAgentInfoState();
}

class _SwarmAgentInfoState extends State<SwarmAgentInfo>
    with WidgetsBindingObserver, VisibleTick<SwarmAgentInfo> {
  /// Why each board that could not be read was not, by repository, in the words GitHub's reader gives.
  Map<String, String> _errors = const {};

  /// The repositories last read, to read again when the agent's projects change.
  Set<String> _read = const {};

  /// Which read is the latest: an older answer that comes after it is dropped.
  int _reading = 0;

  /// When Info last read each repository with a reader: opening it again within [_fresh] reads nothing new.
  static final _readAtBy = Expando<Map<String, DateTime>>();
  Map<String, DateTime> get _readAt =>
      _readAtBy[widget.github] ??= <String, DateTime>{};
  static const _fresh = Duration(seconds: 30);

  late Listenable _changes;

  @override
  void initState() {
    super.initState();
    _changes = Listenable.merge([widget.controller, ?widget.app]);
    unawaited(_readBoards(_repositories()));
    // Its clock runs only while it shows, as the board's: hidden, it would spend the person's GitHub rate limit on nobody.
    if (widget.refreshEvery case final every?) visibleTick(every);
  }

  @override
  void onTick() => unawaited(_readBoards(_repositories(), always: true));

  /// Back in sight: read what was not read in the last [_fresh].
  @override
  void onScreenChanged(bool onScreen) {
    if (onScreen) unawaited(_readBoards(_repositories()));
  }

  @override
  void didUpdateWidget(SwarmAgentInfo old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller || old.app != widget.app) {
      _changes = Listenable.merge([widget.controller, ?widget.app]);
    }
    if (old.agent.id != widget.agent.id) {
      _errors = const {};
      unawaited(_readBoards(_repositories()));
    }
  }

  /// The projects the agent is in, each with whether it is that project's PM: the project the agent names, or whose channel
  /// lists it or has it as PM.
  List<({SuperTabProject project, bool pm})> _projects() {
    final snapshot = widget.controller.snapshot, agent = widget.agent;
    if (snapshot == null) return const [];
    return [
      for (final project in snapshot.projects)
        if (snapshot.conversation(project.leadConversationId)
            case final channel?
            when agent.projectId == project.id ||
                channel.leadId == agent.id ||
                channel.agentIds.contains(agent.id))
          (project: project, pm: channel.leadId == agent.id),
    ];
  }

  /// Its projects' repositories on GitHub.
  Set<String> _repositories() => {
    for (final (:project, pm: _) in _projects())
      ?SwarmTaskBoard.repositoryOf(
        widget.controller,
        project.leadConversationId,
      ),
  };

  /// The issues its boards hold for it, as they were last read: taken, with its `builder:<name>` label, the name the board
  /// matches a label against.
  List<SwarmIssue> _held(Set<String> repositories) {
    final name = (widget.agent.displayName ?? widget.agent.name).toLowerCase();
    return [
      for (final repository in repositories)
        for (final issue in widget.github.kept(repository) ?? const [])
          if (issue.taken && issue.agent?.toLowerCase() == name) issue,
    ];
  }

  /// Reads [repositories]' boards, all at once; one read within [_fresh] by another Info is not made again unless [always].
  Future<void> _readBoards(
    Set<String> repositories, {
    bool always = false,
  }) async {
    _read = repositories;
    final now = clock.now();
    final due = [
      for (final repository in repositories)
        if (always ||
            !(_readAt[repository]?.isAfter(now.subtract(_fresh)) ?? false))
          repository,
    ];
    if (due.isEmpty) return;
    final agent = widget.agent, turn = ++_reading;
    for (final repository in due) {
      _readAt[repository] = now;
    }
    final answers = await Future.wait([
      for (final repository in due)
        widget.github
            .issues(repository)
            .then<String?>((_) => null)
            .catchError(
              (Object failure) => (failure as SwarmGitHubError).message,
              test: (failure) => failure is SwarmGitHubError,
            ),
    ]);
    if (!mounted || agent.id != widget.agent.id || turn != _reading) return;
    setState(() {
      _errors = {
        for (final (i, repository) in due.indexed) repository: ?answers[i],
        // A board not read this time keeps what it said last.
        for (final MapEntry(:key, :value) in _errors.entries)
          if (!due.contains(key) && repositories.contains(key)) key: value,
      };
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ColoredBox(
      key: const ValueKey('swarm-agent-info'),
      // The Swarm's one ground, beside the chat or in its place (design system, One surface).
      color: grid.AppPalette.swarmField,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 52,
            padding: const EdgeInsets.symmetric(
              horizontal: SwarmLayout.barSide,
            ),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text('Info', style: DesktopChrome.text(medium: true)),
                ),
                AppIconButton(
                  key: const ValueKey('swarm-info-close'),
                  icon: AppIcons.close,
                  tooltip: 'Close',
                  onPressed: widget.onClose,
                ),
              ],
            ),
          ),
          Expanded(
            child: ListenableBuilder(
              listenable: _changes,
              builder: (context, _) => SelectionArea(
                // At most eight short rows: one scrolling column, nothing to lay out lazily.
                child: SingleChildScrollView(
                  padding: SwarmLayout.infoPadding,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: _rows(),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _rows() {
    final agent = widget.agent, app = widget.app;
    final snapshot = widget.controller.snapshot;
    // The model, the folder and what it is doing, in the words the rest of the app uses.
    final known = SuperTabAgentInfo(widget.controller, app, agent);
    final machine = app?.machines
        .where((m) => m.machineId == agent.machineId)
        .firstOrNull;
    final owner = snapshot?.people
        .where((p) => p.id == agent.contributorId)
        .firstOrNull
        ?.shownName
        .trim();
    // What this computer knows of the session first; else the Swarm's word that it is down.
    final state = known.status ?? (agent.downSince != null ? 'Offline' : null);
    final projects = _projects();
    final repositories = _repositories();
    if (!setEquals(repositories, _read)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !setEquals(_repositories(), _read)) {
          unawaited(_readBoards(_repositories()));
        }
      });
    }
    final held = _held(repositories);
    final errors = {
      for (final MapEntry(:key, :value) in _errors.entries)
        if (repositories.contains(key)) value,
    };
    final computer = [
      if (widget.machineName.trim() case final name when name.isNotEmpty) name,
      ?switch (machine?.reportedOnline) {
        true => 'online',
        false => 'offline',
        null => null,
      },
    ];
    return [
      if (owner != null && owner.isNotEmpty)
        _Fact('owner', 'Owner', Text(owner)),
      if (projects.isNotEmpty)
        _Fact(
          'projects',
          projects.length == 1 ? 'Project' : 'Projects',
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final (:project, :pm) in projects)
                Text('${project.name} · ${pm ? 'PM' : 'Builder'}'),
            ],
          ),
        ),
      if (computer.isNotEmpty)
        _Fact('computer', 'Computer', Text(computer.join(' · '))),
      if (swarmEngineName(agent) case final engine?)
        _Fact('engine', 'Engine', Text(engine)),
      if (known.model case final model?)
        _Fact(
          'model',
          'Model',
          Text(modelLabelWithEffort(model, known.effort)),
        ),
      if (state != null) _Fact('state', 'State', Text(state)),
      // What the boards held when last read, and why one could not be read now: never stale without saying so.
      if (held.isNotEmpty || errors.isNotEmpty)
        _Fact(
          'task',
          held.length > 1 ? 'Tasks' : 'Task',
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final issue in held) Text('#${issue.number} ${issue.title}'),
              for (final error in errors)
                Text(error, style: DesktopChrome.metadata()),
            ],
          ),
        ),
      if (known.folder case final folder?)
        _Fact('folder', 'Folder', Text(folder, style: grid.AppType.mono())),
      if (known.workspace case final workspace?)
        _Fact(
          'workspace',
          'Workspace',
          Text(workspace, style: grid.AppType.mono()),
        ),
    ];
  }
}

/// One row: a short label in metadata grey, its value beside it.
class _Fact extends StatelessWidget {
  const _Fact(this.id, this.label, this.value);

  final String id, label;
  final Widget value;

  @override
  Widget build(BuildContext context) => Padding(
    key: ValueKey('swarm-info-$id'),
    padding: SwarmLayout.infoRowPadding,
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: SwarmLayout.infoLabelWidth,
          child: Text(label, style: DesktopChrome.metadata()),
        ),
        Expanded(
          child: DefaultTextStyle.merge(
            style: DesktopChrome.control(),
            child: value,
          ),
        ),
      ],
    ),
  );
}
