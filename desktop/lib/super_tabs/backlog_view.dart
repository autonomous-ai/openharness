import 'package:collection/collection.dart';
import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_select_field.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'backlog.dart';
import 'controller.dart';
import 'machine_status.dart';
import 'model.dart';
import 'pull_request_facts.dart';
import 'task_status.dart';

/// Manage ▸ Backlog (Scholes, task #2355): every task of the Swarm the reader
/// can read, across projects, in the groups of its state, two lines a row. It
/// reads only what the controller already holds; the checks of open tasks'
/// pull requests come from [facts], watched only while it shows.
class SuperTabBacklogView extends StatefulWidget {
  const SuperTabBacklogView({
    super.key,
    required this.controller,
    required this.onOpenConversation,
    this.facts,
    this.now = DateTime.now,
  });

  final SuperTabController controller;
  final ValueChanged<String> onOpenConversation;
  final SuperTabPullRequestFacts? facts;
  final DateTime Function() now;

  @override
  State<SuperTabBacklogView> createState() => _SuperTabBacklogViewState();
}

class _SuperTabBacklogViewState extends State<SuperTabBacklogView> {
  String? _project;
  bool _mine = false;
  SuperTabBacklogGroup? _group;

  /// The pull requests watched for their checks: open tasks' alone.
  Set<String> _watched = const {};

  @override
  void dispose() {
    widget.facts?.unwatch(_watched);
    super.dispose();
  }

  void _watch(Iterable<SuperTabConversation> open) {
    final facts = widget.facts;
    if (facts == null) return;
    final next = {for (final task in open) ?_pullRequest(task)};
    if (const SetEquality<String>().equals(next, _watched)) return;
    facts
      ..watch(next.difference(_watched))
      ..unwatch(_watched.difference(next));
    _watched = next;
  }

  // Rebuilt when GitHub's answer lands, as the live cards are: Manage rebuilds
  // only on the controller (review of #2776).
  @override
  Widget build(BuildContext context) => switch (widget.facts) {
    final facts? => ListenableBuilder(
      listenable: facts,
      builder: (context, _) => _build(context),
    ),
    null => _build(context),
  };

  Widget _build(BuildContext context) {
    grid.AppTheme.watch(context);
    final c = widget.controller, snapshot = c.snapshot;
    final all = superTabBacklogTasks(c);
    final placed = [
      for (final task in all)
        if (superTabBacklogGroupOf(task) case final group?) (task, group),
    ];
    // Watched after the frame: a build changes nothing outside itself.
    final open = [
      for (final (task, group) in placed)
        if (group != SuperTabBacklogGroup.shipped) task,
    ];
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _watch(open);
    });
    final shown = [
      for (final (task, group) in placed)
        if ((_project == null || task.projectId == _project) &&
            (!_mine || task.requesterId == c.accountId) &&
            (_group == null || group == _group))
          (task, group),
    ];
    final entries = <Object>[
      for (final group in SuperTabBacklogGroup.values)
        if (shown.where((e) => e.$2 == group).toList() case final tasks
            when tasks.isNotEmpty) ...[
          (group, tasks.length),
          for (final (task, _) in tasks) task,
        ],
    ];
    final projects = snapshot?.projects ?? const <SuperTabProject>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
            grid.AppDesktop.groupGap,
            grid.AppDesktop.controlGap,
            grid.AppDesktop.groupGap,
            grid.AppDesktop.controlGap,
          ),
          child: Row(
            children: [
              AppSelectField<String?>(
                key: const ValueKey('super-backlog-project'),
                semanticLabel: 'Project',
                width: AppSelectField.fitWidth(
                  context,
                  labels: ['All projects', for (final p in projects) p.name],
                ),
                value: _project,
                options: [
                  const SelectOption(value: null, label: 'All projects'),
                  for (final project in projects)
                    SelectOption(value: project.id, label: project.name),
                ],
                onChanged: (value) => setState(() => _project = value),
              ),
              const SizedBox(width: grid.AppDesktop.controlGap),
              DesktopPill(
                key: const ValueKey('super-backlog-mine'),
                label: 'Mine',
                selected: _mine,
                tooltip: 'Only the tasks you asked for',
                onPressed: () => setState(() => _mine = !_mine),
              ),
              const SizedBox(width: grid.AppDesktop.controlGap),
              AppSelectField<SuperTabBacklogGroup?>(
                key: const ValueKey('super-backlog-state'),
                semanticLabel: 'State',
                width: AppSelectField.fitWidth(
                  context,
                  labels: [
                    'All states',
                    for (final group in SuperTabBacklogGroup.values)
                      group.label,
                  ],
                ),
                value: _group,
                options: [
                  const SelectOption(value: null, label: 'All states'),
                  for (final group in SuperTabBacklogGroup.values)
                    SelectOption(value: group, label: group.label),
                ],
                onChanged: (value) => setState(() => _group = value),
              ),
              const Spacer(),
              Text(
                shown.length == 1 ? '1 task' : '${shown.length} tasks',
                style: DesktopChrome.metadata(color: DesktopChrome.muted),
              ),
            ],
          ),
        ),
        Expanded(
          child: entries.isEmpty
              ? Center(
                  child: Text(
                    _mine && all.isNotEmpty
                        ? 'No tasks you asked for'
                        : 'No tasks',
                    style: DesktopChrome.control(color: DesktopChrome.muted),
                  ),
                )
              : LaidOutListView.builder(
                  padding: const EdgeInsets.symmetric(
                    horizontal: grid.AppDesktop.groupGap,
                  ),
                  itemCount: entries.length,
                  itemBuilder: (context, i) => switch (entries[i]) {
                    (final SuperTabBacklogGroup group, final int count) =>
                      _Heading(group: group, count: count),
                    final SuperTabConversation task => _Row(
                      task: task,
                      controller: c,
                      facts: widget.facts,
                      now: widget.now(),
                      onOpen: () => widget.onOpenConversation(task.id),
                    ),
                    _ => const SizedBox.shrink(),
                  },
                ),
        ),
      ],
    );
  }
}

/// The task's pull request the row shows: the newest one it names.
String? _pullRequest(SuperTabConversation task) =>
    task.cards.pullRequests.lastOrNull?.url ?? task.pullRequestUrls.lastOrNull;

class _Heading extends StatelessWidget {
  const _Heading({required this.group, required this.count});
  final SuperTabBacklogGroup group;
  final int count;

  @override
  Widget build(BuildContext context) => Padding(
    key: ValueKey('super-backlog-group-${group.name}'),
    padding: const EdgeInsets.only(
      top: grid.AppDesktop.groupGap,
      bottom: grid.AppDesktop.menuInset,
    ),
    child: Text(
      '${group.label} · $count',
      style: DesktopChrome.control(medium: true),
    ),
  );
}

/// One task: its number and title, project and who asked; then its agent and
/// machine, its pull request and checks, and what it waits on; how long since
/// it last changed at the right.
class _Row extends StatelessWidget {
  const _Row({
    required this.task,
    required this.controller,
    required this.facts,
    required this.now,
    required this.onOpen,
  });

  final SuperTabConversation task;
  final SuperTabController controller;
  final SuperTabPullRequestFacts? facts;
  final DateTime now;
  final VoidCallback onOpen;

  String? _personName(String id) => controller.snapshot?.people
      .where((p) => p.id == id)
      .firstOrNull
      ?.username;

  String get _pullRequestText {
    final url = _pullRequest(task);
    if (url == null) return '';
    final number = Uri.parse(url).pathSegments.elementAtOrNull(3) ?? '';
    final merged =
        task.cards.pullRequests.firstWhereOrNull((p) => p.url == url)?.merged ==
        true;
    final entry = facts?.of(url);
    final checks = merged
        ? 'merged'
        : entry == null
        ? ''
        : entry.finalState
        ? entry.state.toLowerCase()
        : entry.total > 0
        ? entry.checksLabel
        : '';
    return ['PR #$number', if (checks.isNotEmpty) checks].join(' ');
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = controller.snapshot!;
    final assignment = task.assignment;
    final agentId = assignment?['agentId'];
    final agent = agentId is String ? snapshot.agent(agentId) : null;
    final execution = assignment?['execution'];
    final machineId = execution is Map && execution['machineId'] is String
        ? execution['machineId'] as String
        : agent?.machineId;
    final status = superTabTaskStatus(task, now, personName: _personName);
    final second = [
      if (agentId is! String)
        'No agent yet'
      else ...[
        snapshot.agentName(agentId, fallback: 'Agent unavailable'),
        if (machineId != null) ?controller.sessionMachineName(machineId),
      ],
      if (_pullRequestText case final pr when pr.isNotEmpty) pr,
      if (status != null) status.reason,
    ].join(' · ');
    final first = [
      snapshot.projectById(task.projectId)?.name,
      if (task.requesterId case final id?) _personName(id),
    ].nonNulls.join(' · ');
    final changed = controller.groupChangedAt(task.id);
    final muted = DesktopChrome.metadata(color: DesktopChrome.muted);
    return InkWell(
      key: ValueKey('super-backlog-row-${task.id}'),
      onTap: onOpen,
      hoverColor: grid.AppSurface.hoverFill,
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: grid.AppDesktop.controlGap,
          vertical: grid.AppDesktop.menuInset,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          task.label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.control(),
                        ),
                      ),
                      if (first.isNotEmpty) ...[
                        const SizedBox(width: grid.AppDesktop.controlGap),
                        Text(first, maxLines: 1, style: muted),
                      ],
                    ],
                  ),
                  Text(
                    second,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: muted,
                  ),
                ],
              ),
            ),
            if (changed != null) ...[
              const SizedBox(width: grid.AppDesktop.controlGap),
              Text(superTabAgoShort(now.difference(changed)), style: muted),
            ],
          ],
        ),
      ),
    );
  }
}
