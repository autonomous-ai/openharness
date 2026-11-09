import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/swarm_layout.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../widgets/desktop_chrome.dart';
import 'agent_details.dart' show SuperTabAgentInfo;
import 'controller.dart';
import 'github_issues.dart';
import 'model.dart';
import 'task_board.dart';

/// An agent's engine as its chat's bar names it: `Claude Code`, `Codex`, any other engine as it is, null when it has none.
String? swarmEngineName(SuperTabAgent agent) =>
    switch (agent.configuration['engine']) {
      'codex' => 'Codex',
      'claude' => 'Claude Code',
      final String other when other.trim().isNotEmpty => other,
      _ => null,
    };

/// What the app already knows of an agent, beside its chat (Swarm v4, anh Dee 2026-11-09: "we need more info on the agent"):
/// its person, the projects it is in and its part in each, the computer it runs on and whether that is up, its engine and
/// model, what it is doing, the task it holds, and its folder, one short row each. A row the app has no value for is not
/// drawn. The task is read from its projects' boards, the issues [SwarmTaskBoard] reads, with what was read last shown at
/// once; the rest comes from the Swarm and from this computer's view of the agent's machine.
class SwarmAgentInfo extends StatefulWidget {
  const SwarmAgentInfo({
    super.key,
    required this.controller,
    required this.agent,
    required this.machineName,
    required this.github,
    required this.onClose,
    this.app,
  });

  final SuperTabController controller;
  final SuperTabAgent agent;

  /// The name of the computer the agent runs on.
  final String machineName;
  final SwarmGitHub github;
  final VoidCallback onClose;

  /// This computer's view of the agent's machine; without it, the rows only it knows are not drawn.
  final AppNotifier? app;

  @override
  State<SwarmAgentInfo> createState() => _SwarmAgentInfoState();
}

class _SwarmAgentInfoState extends State<SwarmAgentInfo> {
  /// The issues its projects' boards say it holds: taken, and labelled for it.
  List<SwarmIssue> _held = const [];

  /// Why a board could not be read, in the words GitHub's reader gives; null once every board read.
  String? _error;

  /// Which read is the latest: an older answer that comes after it is dropped.
  int _reading = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_read());
  }

  @override
  void didUpdateWidget(SwarmAgentInfo old) {
    super.didUpdateWidget(old);
    if (old.agent.id != widget.agent.id) {
      _held = const [];
      _error = null;
      unawaited(_read());
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

  /// The issues of [issues] this agent holds: taken, with its `builder:<name>` label, matched without case as the board does.
  List<SwarmIssue> _heldIn(List<SwarmIssue> issues) {
    final names = {
      widget.agent.name.toLowerCase(),
      ?widget.agent.displayName?.toLowerCase(),
    };
    return [
      for (final issue in issues)
        if (issue.taken && names.contains(issue.agent?.toLowerCase())) issue,
    ];
  }

  Future<void> _read() async {
    final agent = widget.agent, turn = ++_reading;
    final repositories = {
      for (final (:project, pm: _) in _projects())
        ?SwarmTaskBoard.repositoryOf(
          widget.controller,
          project.leadConversationId,
        ),
    };
    if (repositories.isEmpty) return;
    // What the boards read last, at once.
    setState(() {
      _held = [
        for (final repository in repositories)
          ..._heldIn(widget.github.kept(repository) ?? const []),
      ];
    });
    final held = <SwarmIssue>[];
    String? error;
    for (final repository in repositories) {
      try {
        held.addAll(_heldIn(await widget.github.issues(repository)));
      } on SwarmGitHubError catch (failure) {
        error = failure.message;
        held.addAll(_heldIn(widget.github.kept(repository) ?? const []));
      }
      if (!mounted || agent.id != widget.agent.id || turn != _reading) return;
    }
    setState(() {
      _held = held;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ColoredBox(
      key: const ValueKey('swarm-agent-info'),
      color: DesktopChrome.surface,
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
              listenable: Listenable.merge([widget.controller, ?widget.app]),
              builder: (context, _) => SelectionArea(
                child: ListView(
                  padding: SwarmLayout.infoPadding,
                  children: _rows(),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// The state in a word, or null for what the app cannot say.
  static String? _state(HarnessActivity? activity) => switch (activity) {
    HarnessActivity.working => 'Working',
    HarnessActivity.idle || HarnessActivity.done => 'Idle',
    HarnessActivity.needsInput => 'Waiting',
    HarnessActivity.starting => 'Starting',
    HarnessActivity.paused => 'Stopped',
    HarnessActivity.offline => 'Offline',
    HarnessActivity.failed => 'Failed',
    HarnessActivity.unknown || null => null,
  };

  static String? _text(String? value) =>
      value == null || value.trim().isEmpty ? null : value.trim();

  List<Widget> _rows() {
    final agent = widget.agent, app = widget.app;
    final snapshot = widget.controller.snapshot;
    // The model, the folder and what it is doing, as the rest of the app reads them.
    final known = SuperTabAgentInfo(widget.controller, app, agent);
    final machine = app?.machines
        .where((m) => m.machineId == agent.machineId)
        .firstOrNull;
    final owner = _text(
      snapshot?.people
          .where((p) => p.id == agent.contributorId)
          .firstOrNull
          ?.shownName,
    );
    // A session the Swarm says is down is offline, whatever this computer last heard.
    final state = _state(
      agent.downSince != null ? HarnessActivity.offline : known.activity,
    );
    final projects = _projects();
    final computer = [
      ?_text(widget.machineName),
      ?switch (machine?.reportedOnline) {
        true => 'online',
        false => 'offline',
        null => null,
      },
    ];
    return [
      if (owner != null) _Fact('owner', 'Owner', Text(owner)),
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
      if (known.model case final model?) _Fact('model', 'Model', Text(model)),
      if (state != null) _Fact('state', 'State', Text(state)),
      if (_held.isNotEmpty)
        _Fact(
          'task',
          _held.length == 1 ? 'Task' : 'Tasks',
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final issue in _held)
                Text('#${issue.number} ${issue.title}'),
            ],
          ),
        )
      else if (_error case final error?)
        _Fact('task', 'Task', Text(error)),
      if (known.folder case final folder?)
        _Fact('folder', 'Folder', Text(folder, style: grid.AppType.mono())),
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
