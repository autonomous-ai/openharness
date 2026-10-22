import 'dart:async';

import 'package:flutter/material.dart';

import '../core/machine_resources.dart';
import '../core/test_run.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../state/app_state.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'identity.dart';
import 'machines.dart';
import 'model.dart';
import 'pull_request_entry.dart';
import 'pull_requests.dart';
import 'section_heading.dart';
import 'sidebar_pull_requests.dart';
import 'task_status.dart';

class ProjectSidebar extends StatefulWidget {
  const ProjectSidebar({
    super.key,
    required this.controller,
    required this.onSelect,
    required this.needsHuman,
    required this.onAddAgent,
    this.app,
    this.onNewProject,
    this.onYourDevices,
    this.readLocal,
    this.readPullRequests,
    this.now = DateTime.now,
  });
  final SuperTabController controller;
  final ValueChanged<String> onSelect;
  final int Function(SuperTabConversation group) needsHuman;
  final ValueChanged<SuperTabConversation> onAddAgent;
  final AppNotifier? app;
  final VoidCallback? onNewProject;
  final VoidCallback? onYourDevices;

  /// Forwarded to the embedded [SuperTabMachines]; a test gives it to have
  /// the Machines group's readings taken without a real machine.
  @visibleForTesting
  final Future<MachineResources?> Function(String machineId)? readLocal;

  /// Reads the state of the pull requests the workgroups link to, in one batch, in place of
  /// [AppNotifier.readPullRequestsStatus]. A test gives it to have them read without a computer's GitHub login.
  @visibleForTesting
  final Future<Map<String, dynamic>> Function(List<String> urls)?
  readPullRequests;

  /// The clock the machines' readings and the workgroups' last activity are aged against; a test pins it.
  @visibleForTesting
  final DateTime Function() now;

  /// A row's chevron (or the room for one), at its level's indent; its name starts right after.
  static const _iconColumn = SuperTabSectionHeading.actionWidth;
  static const _dotSize = 6.0;

  /// The space after a row's trailing unread dot: it centers the dot on the
  /// headings' + ([SuperTabSectionHeading.endInset] 0), whatever the width.
  static const markerInset =
      SuperTabSectionHeading.actionWidth / 2 - _dotSize / 2;

  @override
  State<ProjectSidebar> createState() => _ProjectSidebarState();
}

class _ProjectSidebarState extends State<ProjectSidebar> {
  static const _iconColumn = ProjectSidebar._iconColumn;
  static const _dotSize = ProjectSidebar._dotSize;
  static const markerInset = ProjectSidebar.markerInset;

  SuperTabController get controller => widget.controller;
  ValueChanged<String> get onSelect => widget.onSelect;
  int Function(SuperTabConversation group) get needsHuman => widget.needsHuman;

  late SidebarPullRequests _pullRequests = _newPullRequests();
  Timer? _tick;

  SidebarPullRequests _newPullRequests() => SidebarPullRequests(
    read: widget.readPullRequests ?? widget.app?.readPullRequestsStatus,
    active: () => widget.app?.foreground.value ?? true,
  )..addListener(_changed);

  void _changed() {
    if (mounted) setState(() {});
  }

  void _foreground() {
    if (widget.app?.foreground.value == true) {
      unawaited(_pullRequests.refresh());
    }
  }

  @override
  void initState() {
    super.initState();
    widget.app?.foreground.addListener(_foreground);
    // The ages ("12 min ago") follow the clock between the Swarm's reads; not under `flutter test`, where a
    // periodic timer would keep the tree from ever settling.
    if (!kUnderTest) {
      _tick = Timer.periodic(const Duration(seconds: 30), (_) => _changed());
    }
  }

  @override
  void didUpdateWidget(ProjectSidebar old) {
    super.didUpdateWidget(old);
    if (old.app != widget.app) {
      old.app?.foreground.removeListener(_foreground);
      widget.app?.foreground.addListener(_foreground);
    }
    if (old.app != widget.app ||
        old.readPullRequests != widget.readPullRequests) {
      _pullRequests.dispose();
      _pullRequests = _newPullRequests();
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    widget.app?.foreground.removeListener(_foreground);
    _pullRequests.dispose();
    super.dispose();
  }

  /// The pull request a workgroup links to, if its task result, a check's evidence or a loaded message names one:
  /// the last one named, which is the newest. The rows not opened have no messages loaded, and the
  /// reader asks for none.
  String? _pullRequestLink(SuperTabConversation group) {
    String? link;
    void scan(String? text) {
      if (text == null) return;
      final found = superTabPullRequestLinks(text);
      if (found.isNotEmpty) link = found.last.toString();
    }

    for (final check in group.checks) {
      scan(check['evidence'] as String?);
    }
    for (final message in controller.messages(group.id)) {
      scan(message.text);
    }
    scan(group.assignment?['result'] as String?);
    return link;
  }

  /// What a workgroup's row says of its task.
  ({
    SuperTabTaskStatus? status,
    String? agentId,
    String? agentName,
    DateTime? activeAt,
    SuperTabPullRequestEntry? pullRequest,
    String? pullRequestLink,
  })
  _task(SuperTabConversation group) {
    final agentId = group.assignment?['agentId'] as String?;
    final known = agentId == null ? null : controller.snapshot?.agent(agentId);
    final link = _pullRequestLink(group);
    return (
      status: SuperTabTaskStatus.of(group),
      agentId: known?.id,
      agentName: known == null
          ? null
          : controller.snapshot!.agentName(known.id),
      activeAt: group.lastActivityAt,
      pullRequest: link == null ? null : _pullRequests.of(link),
      pullRequestLink: link,
    );
  }

  /// A project's lead row (level 1, under the heading) or a workgroup (level 2, under its project; level 3 under
  /// its "Finished" row).
  Widget _row(
    SuperTabConversation group, {
    SuperTabProject? project,
    bool finished = false,
  }) {
    final level = project != null ? 1 : (finished ? 3 : 2);
    final task = project == null ? _task(group) : null;
    final selected = controller.selectedId == group.id;
    final groups = project == null
        ? [group]
        : controller.snapshot!.conversations.where(
            (g) => g.projectId == project.id && !g.archived,
          );
    final waiting = groups.any((g) => needsHuman(g) > 0);
    final unread = groups.any(controller.unread);
    final expanded =
        project != null && controller.expandedProjects.contains(project.id);
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: selected ? grid.AppSurface.selectedFill : Colors.transparent,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: ValueKey('super-group-${group.id}'),
          onTap: () => onSelect(group.id),
          hoverColor: grid.AppSurface.hoverFill,
          focusColor: grid.AppSurface.hoverFill,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          child: Row(
            children: [
              SizedBox(width: SuperTabSectionHeading.indentFor(level)),
              if (project != null)
                IconButton(
                  key: ValueKey('super-project-expand-${project.id}'),
                  icon: Icon(
                    expanded ? AppIcons.chevronDown : AppIcons.chevronRight,
                    size: AppIcons.inlineSize,
                  ),
                  color: DesktopChrome.muted,
                  // The row owns hover/press feedback. Keep the themed focus
                  // boundary for this independent disclosure action.
                  style: const ButtonStyle(
                    minimumSize: WidgetStatePropertyAll(Size.square(32)),
                    padding: WidgetStatePropertyAll(EdgeInsets.all(6)),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    visualDensity: VisualDensity.standard,
                    overlayColor: WidgetStatePropertyAll(Colors.transparent),
                    backgroundColor: WidgetStatePropertyAll(Colors.transparent),
                  ),
                  tooltip:
                      '${expanded ? 'Collapse' : 'Expand'} ${project.name}',
                  onPressed: () => controller.toggleProject(project.id),
                )
              else
                const SizedBox(width: _iconColumn),
              Expanded(
                child: Semantics(
                  label: project?.isPrivate == true
                      ? 'Private project'
                      : task == null
                      ? null
                      : _taskLabel(group, task, unread: unread),
                  selected: selected,
                  excludeSemantics: task != null,
                  child: Tooltip(
                    message: project?.name ?? group.label,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 36),
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(
                          0,
                          8,
                          markerInset,
                          8,
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    project?.name ?? group.label,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: DesktopChrome.control(
                                      medium: unread || selected,
                                      color:
                                          selected || unread || project != null
                                          ? DesktopChrome.foreground
                                          : DesktopChrome.muted,
                                    ),
                                  ),
                                ),
                                if (project?.isPrivate == true) ...[
                                  const SizedBox(width: 8),
                                  Tooltip(
                                    message: 'Private project',
                                    child: Icon(
                                      AppIcons.lock,
                                      size: 14,
                                      color: DesktopChrome.muted,
                                    ),
                                  ),
                                ],
                                if (waiting) ...[
                                  const SizedBox(width: 8),
                                  Tooltip(
                                    message: 'Needs a human',
                                    child: Text(
                                      '?',
                                      style: DesktopChrome.control(
                                        color: grid.AppPalette.warn,
                                        medium: true,
                                      ),
                                    ),
                                  ),
                                ] else if (unread) ...[
                                  const SizedBox(width: 8),
                                  Semantics(
                                    label: 'Unread messages',
                                    child: Container(
                                      width: _dotSize,
                                      height: _dotSize,
                                      decoration: BoxDecoration(
                                        shape: BoxShape.circle,
                                        color: DesktopChrome.accent,
                                      ),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                            if (task != null) _taskMeta(group, task),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// "12 min ago": how long since the group last had a message or its assignment changed.
  String? _age(DateTime? at) =>
      at == null ? null : superTabAgo(widget.now().difference(at));

  /// The pull request's state in a few words: "#1557 Draft".
  String _pullRequestText(SuperTabPullRequestEntry entry) =>
      '#${entry.number} ${entry.state == 'Merged' ? 'Merged' : entry.label}';

  /// What a screen reader is told of a workgroup's row: its name, state, agent, age and pull request, in one
  /// sentence, so that none of them is only a colour or a picture.
  String _taskLabel(
    SuperTabConversation group,
    ({
      SuperTabTaskStatus? status,
      String? agentId,
      String? agentName,
      DateTime? activeAt,
      SuperTabPullRequestEntry? pullRequest,
      String? pullRequestLink,
    })
    task, {
    required bool unread,
  }) => [
    group.label,
    ?task.status?.label,
    if (task.agentName != null) 'with ${task.agentName}',
    if (_age(task.activeAt) case final age?) 'updated $age',
    if (task.pullRequest case final pr?) 'pull request ${_pullRequestText(pr)}',
    if (unread) 'unread',
  ].join(', ');

  /// The second and last line of a workgroup's row: its status chip, the avatar of the agent on it, how long since
  /// it was last active and, at the end, its pull request's state when it has one ("#1557 Draft"), shortened with
  /// an ellipsis when the sidebar is narrow. One line, so that a long list of groups stays a short one.
  Widget _taskMeta(
    SuperTabConversation group,
    ({
      SuperTabTaskStatus? status,
      String? agentId,
      String? agentName,
      DateTime? activeAt,
      SuperTabPullRequestEntry? pullRequest,
      String? pullRequestLink,
    })
    task,
  ) {
    final age = _age(task.activeAt);
    final pr = task.pullRequest;
    final kind = pr?.kind;
    final cluster = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (task.status case final status?)
          SuperTabTaskChip(
            key: ValueKey('super-task-chip-${group.id}'),
            status: status,
          ),
        if (task.agentId case final agentId?) ...[
          const SizedBox(width: 6),
          Tooltip(
            message: task.agentName!,
            child: SuperTabAvatar(
              key: ValueKey('super-task-agent-${group.id}'),
              identity: 'agent:$agentId',
              name: task.agentName!,
              size: 16,
            ),
          ),
        ],
        if (age != null) ...[
          const SizedBox(width: 6),
          Text(
            age,
            key: ValueKey('super-task-age-${group.id}'),
            maxLines: 1,
            style: DesktopChrome.metadata().copyWith(fontSize: 11),
          ),
        ],
      ],
    );
    return Padding(
      padding: const EdgeInsets.only(top: 3),
      child: LayoutBuilder(
        builder: (context, box) => Row(
          children: [
            // The chip, the avatar and the age come first, at their size; only a sidebar too narrow for them
            // and a little of the pull request shrinks them, rather than overflowing (a large text size
            // does that).
            ConstrainedBox(
              constraints: BoxConstraints(
                maxWidth: (box.maxWidth - (pr == null ? 0 : _prReserve)).clamp(
                  0,
                  double.infinity,
                ),
              ),
              child: FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: cluster,
              ),
            ),
            if (pr != null) ...[
              const SizedBox(width: 8),
              Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: switch (kind) {
                    PullRequestKind.ready ||
                    PullRequestKind.merged => grid.AppPalette.online,
                    PullRequestKind.failed ||
                    PullRequestKind.conflicts ||
                    PullRequestKind.changes => grid.AppPalette.usageCritical,
                    _ => DesktopChrome.muted,
                  },
                ),
              ),
              const SizedBox(width: 4),
              Expanded(
                child: Tooltip(
                  message:
                      'Pull request #${pr.number}: ${pr.state == 'Merged' ? 'Merged' : pr.label}',
                  child: Text(
                    _pullRequestText(pr),
                    key: ValueKey('super-task-pr-${group.id}'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.metadata().copyWith(fontSize: 11),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// The room kept at the end of a workgroup's meta line for its pull request when the line is too narrow for all of it.
  static const _prReserve = 76.0;

  /// What needs a person first: Needs you, Blocked, Review, then Working, Not started and anything this build
  /// does not know; finished work last.
  static int _rank(SuperTabConversation group) =>
      switch (SuperTabTaskStatus.of(group)) {
        SuperTabTaskStatus.needsYou => 0,
        SuperTabTaskStatus.blocked => 1,
        SuperTabTaskStatus.review => 2,
        SuperTabTaskStatus.working => 3,
        SuperTabTaskStatus.notStarted => 4,
        null => 5,
        _ => 6,
      };

  /// [groups] in that order, the most recently active first within each, a group with no time after those with
  /// one, and by number where they tie.
  List<SuperTabConversation> _ordered(List<SuperTabConversation> groups) =>
      [...groups]..sort((a, b) {
        final byRank = _rank(a).compareTo(_rank(b));
        if (byRank != 0) return byRank;
        final x = a.lastActivityAt, y = b.lastActivityAt;
        if (x != y) {
          if (x == null) return 1;
          if (y == null) return -1;
          return y.compareTo(x);
        }
        return (a.number ?? 0).compareTo(b.number ?? 0);
      });

  /// A project's workgroups that are not archived, apart from its lead's conversation.
  List<SuperTabConversation> _groupsOf(SuperTabProject project) => controller
      .snapshot!
      .conversations
      .where(
        (g) =>
            g.projectId == project.id &&
            g.id != project.leadConversationId &&
            !g.archived,
      )
      .toList();

  bool _isFinished(SuperTabConversation group) =>
      SuperTabTaskStatus.of(group)?.finished == true;

  /// A project's workgroups in progress, narrowed to the chosen status, and its "Finished (N)" row (with the finished
  /// ones under it when it is open).
  List<Widget> _workgroups(SuperTabProject project, Set<String> links) {
    final groups = _groupsOf(project);
    final active = _ordered(groups.where((g) => !_isFinished(g)).toList());
    final finished = _ordered(groups.where(_isFinished).toList());
    final filter = controller.statusFilter;
    final shown = filter == null
        ? active
        : active.where((g) => SuperTabTaskStatus.of(g) == filter).toList();
    for (final group in shown) {
      if (_pullRequestLink(group) case final link?) links.add(link);
    }
    final rows = <Widget>[
      if (groups.isEmpty)
        _note('No workgroups yet')
      else if (filter != null && shown.isEmpty)
        _note('No ${filter.label} workgroups')
      else
        for (final group in shown) _row(group),
      // Finished work is gathered behind one row; narrowing to a status is about work in progress.
      if (filter == null && finished.isNotEmpty)
        ..._finished(project, finished, links),
    ];
    return rows;
  }

  Widget _note(String text) => Padding(
    padding: EdgeInsets.fromLTRB(
      SuperTabSectionHeading.indentFor(2) + _iconColumn,
      8,
      12,
      10,
    ),
    child: Align(
      alignment: Alignment.centerLeft,
      child: Text(text, style: DesktopChrome.metadata()),
    ),
  );

  /// The "Finished (N)" row of a project, and under it, when it is open, its done, stopped and cancelled workgroups.
  /// It is open when the group on screen is one of them, so that the selected row is never hidden.
  List<Widget> _finished(
    SuperTabProject project,
    List<SuperTabConversation> finished,
    Set<String> links,
  ) {
    final open =
        controller.finishedOpenProjects.contains(project.id) ||
        finished.any((g) => g.id == controller.selectedId);
    if (open) {
      for (final group in finished) {
        if (_pullRequestLink(group) case final link?) links.add(link);
      }
    }
    return [
      Padding(
        padding: const EdgeInsets.only(bottom: 2),
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          clipBehavior: Clip.antiAlias,
          child: Semantics(
            button: true,
            expanded: open,
            child: InkWell(
              key: ValueKey('super-finished-${project.id}'),
              onTap: () => controller.toggleFinished(project.id),
              hoverColor: grid.AppSurface.hoverFill,
              focusColor: grid.AppSurface.hoverFill,
              borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
              child: Row(
                children: [
                  SizedBox(width: SuperTabSectionHeading.indentFor(2)),
                  SizedBox(
                    width: _iconColumn,
                    child: Icon(
                      open ? AppIcons.chevronDown : AppIcons.chevronRight,
                      size: AppIcons.inlineSize,
                      color: DesktopChrome.muted,
                    ),
                  ),
                  Expanded(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 36),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          'Finished (${finished.length})',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.control(
                            color: DesktopChrome.muted,
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
      if (open)
        for (final group in finished) _row(group, finished: true),
    ];
  }

  /// How many workgroups in progress have each status, across the Swarm's projects.
  Map<SuperTabTaskStatus, int> _counts() {
    final counts = <SuperTabTaskStatus, int>{};
    for (final project
        in controller.snapshot?.projects ?? const <SuperTabProject>[]) {
      for (final group in _groupsOf(project)) {
        final status = SuperTabTaskStatus.of(group);
        if (status != null && !status.finished) {
          counts[status] = (counts[status] ?? 0) + 1;
        }
      }
    }
    return counts;
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = controller.snapshot;
    // The links the rows on screen name, for the one batched read of their pull requests.
    final links = <String>{};
    final counts = snapshot == null ? <SuperTabTaskStatus, int>{} : _counts();
    final projects = controller.projectsGroupOpen
        ? [
            for (final project
                in snapshot?.projects ?? const <SuperTabProject>[])
              if (snapshot?.conversation(project.leadConversationId)
                  case final lead?)
                Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _row(lead, project: project),
                    if (controller.expandedProjects.contains(project.id))
                      ..._workgroups(project, links),
                  ],
                ),
          ]
        : const <Widget>[];
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _pullRequests.want(links);
    });
    return Material(
      color: DesktopChrome.surface,
      child: ListView(
        padding: const EdgeInsets.all(8),
        children: [
          SuperTabSectionHeading(
            'Projects',
            onAdd: controller.canWrite ? widget.onNewProject : null,
            addTooltip: 'New project',
            endInset: 0,
            collapsed: !controller.projectsGroupOpen,
            onToggleCollapsed: controller.toggleProjectsGroup,
          ),
          // The filter is for telling what is running, waiting and stuck apart: it needs more than one thing to
          // tell apart, or a choice already made to undo.
          if (controller.projectsGroupOpen &&
              (counts.length > 1 || controller.statusFilter != null))
            SuperTabTaskFilter(
              counts: counts,
              selected: controller.statusFilter,
              onSelect: controller.filterByStatus,
            ),
          ...projects,
          const SizedBox(height: 16),
          // Machine online/offline, unread marks and theme changes do not touch
          // the controller the rest of this sidebar rebuilds on, so this group
          // watches them itself — the same sources the roster merged before the
          // move (roster.dart).
          ListenableBuilder(
            listenable: Listenable.merge([
              controller,
              if (widget.app != null) ...[widget.app!, widget.app!.agentUnread],
              terminalThemeStore,
              appearancePrefsStore,
            ]),
            builder: (context, _) {
              grid.AppTheme.watch(context);
              return SuperTabMachines(
                controller: controller,
                app: widget.app,
                onAddAgent: widget.onAddAgent,
                embedded: true,
                collapsed: !controller.machinesGroupOpen,
                onToggleCollapsed: controller.toggleMachinesGroup,
                onYourDevices: widget.onYourDevices,
                readLocal: widget.readLocal,
                now: widget.now,
              );
            },
          ),
        ],
      ),
    );
  }
}
