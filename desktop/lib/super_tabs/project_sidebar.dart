import 'dart:async';

import 'package:collection/collection.dart' show mergeSort;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/machine_resources.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/harness_activity_mark.dart';
import 'attention.dart';
import 'controller.dart';
import 'identity.dart';
import 'leaderboard/models_section.dart';
import 'leaderboard/reader.dart';
import 'local_models.dart';
import 'buddies.dart';
import 'machines.dart';
import 'model.dart';
import 'buddy_rows.dart';
import 'section_heading.dart';
import 'swarm_switcher.dart';
import 'task_status.dart';
import 'workgroup_name.dart';
import 'project_github.dart';

class ProjectSidebar extends StatelessWidget {
  const ProjectSidebar({
    super.key,
    required this.controller,
    required this.onSelect,
    required this.needsHuman,
    required this.onAddAgent,
    this.app,
    this.onNewProject,
    this.onNewSwarm,
    this.onYourDevices,
    this.devicesSelected = false,
    this.onNotifications,
    this.notificationsSelected = false,
    this.attention,
    this.onThreads,
    this.threadsSelected = false,
    this.onOpenAgent,
    this.onOpenBuddyChat,
    this.readLocal,
    this.board,
    this.now = DateTime.now,
  });
  final SuperTabController controller;
  final ValueChanged<String> onSelect;
  final int Function(SuperTabConversation group) needsHuman;
  final ValueChanged<SuperTabConversation> onAddAgent;
  final AppNotifier? app;
  final VoidCallback? onNewProject;

  /// The existing New Swarm. Given, the bar starts with the Swarm dropdown
  /// ([SwarmSwitcher]), which offers it last.
  final VoidCallback? onNewSwarm;
  final VoidCallback? onYourDevices;
  final bool devicesSelected;

  /// The reader's tags from every project's Lead; its count is what waits.
  final VoidCallback? onNotifications;
  final bool notificationsSelected;

  /// What needs the reader, as Slack shows it: each row's red number counts
  /// only tags of them (decisions asked of them among them), and Threads is
  /// bold while a thread they follow has replies they have not read. Without
  /// it rows carry no number.
  final SuperTabAttention? attention;

  /// Opens the Threads view; no Threads row without it.
  final VoidCallback? onThreads;
  final bool threadsSelected;

  /// Whether a row other than a conversation (devices, Notifications,
  /// Threads) holds the main pane.
  bool get _paneCovered =>
      devicesSelected || notificationsSelected || threadsSelected;
  final ValueChanged<SuperTabAgent>? onOpenAgent;

  /// Opens the reader's Buddy chat in a project, by project id; the
  /// controller's [SuperTabController.openBuddyChat] when not given.
  final ValueChanged<String>? onOpenBuddyChat;

  /// The open project's week board the right pane shows, for Models; none
  /// without it.
  final SuperTabLeaderboardReader? board;

  /// Forwarded to the embedded [SuperTabMachines]; a test gives it to have
  /// the Machines group's readings taken without a real machine.
  @visibleForTesting
  final Future<MachineResources?> Function(String machineId)? readLocal;

  /// Forwarded to the embedded [SuperTabMachines]; a test gives it to pin
  /// the clock its readings' ages are counted against.
  @visibleForTesting
  final DateTime Function() now;

  /// Projects and workgroups share a text column. Only projects use its icon.
  static const _iconColumn = SuperTabSectionHeading.actionWidth;

  Widget _navigationRow({
    required String key,
    required String label,
    required IconData icon,
    required VoidCallback? onTap,
    bool selected = false,
    int badge = 0,
    Widget? trailing,
    bool? unread,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 2),
    child: Material(
      color: selected ? grid.AppSurface.selectedFill : Colors.transparent,
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      clipBehavior: Clip.antiAlias,
      child: Semantics(
        button: true,
        selected: selected,
        child: InkWell(
          key: ValueKey(key),
          onTap: onTap,
          hoverColor: grid.AppSurface.hoverFill,
          focusColor: grid.AppSurface.hoverFill,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          child: Row(
            children: [
              SizedBox(width: SuperTabSectionHeading.indentFor(0)),
              SizedBox(
                width: _iconColumn,
                child: Icon(
                  icon,
                  size: AppIcons.inlineSize,
                  color: onTap == null
                      ? DesktopChrome.muted
                      : DesktopChrome.foreground,
                ),
              ),
              Expanded(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 36),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(0, 8, 12, 8),
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      // A row that reads or not ([unread] given) is drawn as
                      // conversations are: muted when read, full strength
                      // and bold when not.
                      style:
                          DesktopChrome.control(
                            medium: selected,
                            color:
                                onTap == null || (unread == false && !selected)
                                ? DesktopChrome.muted
                                : DesktopChrome.foreground,
                          ).copyWith(
                            fontWeight: unread == true
                                ? grid.AppFont.semibold
                                : null,
                          ),
                    ),
                  ),
                ),
              ),
              if (trailing ?? (badge > 0 ? SuperTabCountBadge(badge) : null)
                  case final mark?)
                Padding(padding: const EdgeInsets.only(right: 10), child: mark),
            ],
          ),
        ),
      ),
    ),
  );

  /// A project, or the Product Managers' conversation, reads as a channel: "# openharness".
  Widget _channelMark() => Text(
    '#',
    textAlign: TextAlign.center,
    style: DesktopChrome.control(color: DesktopChrome.muted, medium: true),
  );

  void _openBuddyChat(String projectId) => onOpenBuddyChat != null
      ? onOpenBuddyChat!(projectId)
      : unawaited(controller.openBuddyChat(projectId));

  /// A project row's name opens the project's chat; only the chevron at its
  /// right end shows or hides its conversations (Dee, 2026-10-28).
  Widget _row(
    SuperTabConversation group, {
    _ProjectReading? reading,
    String? key,
  }) {
    final project = reading?.project;
    final selected = !_paneCovered && controller.selectedId == group.id;
    final waiting = reading == null
        ? needsHuman(group) > 0
        : reading.waiting.isNotEmpty;
    // Open, a project's row is its own chat's, as each workgroup under it
    // has its own; collapsed, it is bold for anything it hides.
    final unread =
        reading == null || controller.expandedProjects.contains(project?.id)
        ? controller.unread(group)
        : reading.unread.isNotEmpty;
    // A collapsed project counts the tags in the conversations it hides, as
    // Slack's collapsed section does; open, each row has its own.
    final badge = attention == null
        ? 0
        : reading == null || controller.expandedProjects.contains(project?.id)
        ? attention!.mentionsIn(group.id)
        : reading.mentions;
    return _drawRow(
      group,
      project: project,
      key: key,
      selected: selected,
      waiting: waiting,
      unread: unread,
      badge: badge,
      buddyChat: reading?.buddyChat,
      selectedProjectId: reading?.sidebar.selectedProjectId,
    );
  }

  /// A workgroup's row from what its project's reading already asked.
  /// A task row's status, kept current by its own clock, for its line and
  /// its tooltip alike; any other row is built without one.
  Widget _withTaskStatus(
    SuperTabConversation group,
    Widget Function(SuperTabTaskStatus? status) build, {
    required bool task,
  }) => task
      ? SuperTabTaskClock(
          group: group,
          personName: _personName,
          builder: (_, status) => build(status),
        )
      : build(null);

  /// A member as the Humans list names them, for a task's "Waiting on …".
  String? _personName(String personId) => switch (controller.snapshot?.people
      .where((p) => p.id == personId)
      .firstOrNull) {
    final person? => superTabPersonName(person.email),
    null => null,
  };

  Widget _workgroupRow(SuperTabConversation group, _ProjectReading reading) =>
      _drawRow(
        group,
        selected: !_paneCovered && controller.selectedId == group.id,
        waiting: reading.waiting.contains(group.id),
        unread: reading.unread.contains(group.id),
        badge: attention?.mentionsIn(group.id) ?? 0,
      );

  Widget _drawRow(
    SuperTabConversation group, {
    SuperTabProject? project,
    String? key,
    required bool selected,
    required bool waiting,
    required bool unread,
    int badge = 0,
    SuperTabConversation? buddyChat,
    String? selectedProjectId,
  }) {
    final expanded =
        project != null && controller.expandedProjects.contains(project.id);
    // A collapsed project shows as selected while one of its conversations it
    // hides is open; the reader's Buddy chat has a row of its own.
    final highlighted =
        selected ||
        (project != null &&
            !expanded &&
            !_paneCovered &&
            selectedProjectId == project.id &&
            controller.selectedId != buddyChat?.id);
    // As Slack draws it (Dee, 10-31): a read row in the muted text colour, an
    // unread one at full strength and bold, no dot; the open row keeps its
    // highlight.
    final style = DesktopChrome.control(
      medium: highlighted,
      color: highlighted || unread
          ? DesktopChrome.foreground
          : DesktopChrome.muted,
    ).copyWith(fontWeight: unread ? grid.AppFont.semibold : null);
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      // Hover lights the whole row, chevron included, in the selected
      // highlight's shape (Dee, 10-31): the row draws it, not each click.
      child: _RowSurface(
        selected: highlighted,
        // The chevron stands beside the row's own click, not inside it: the
        // name opens and the chevron toggles.
        child: Row(
          children: [
            Expanded(
              child: _arrowToggles(
                project,
                expanded: expanded,
                child: InkWell(
                  key: ValueKey(key ?? 'super-group-${group.id}'),
                  onTap: () => onSelect(group.id),
                  hoverColor: Colors.transparent,
                  focusColor: grid.AppSurface.hoverFill,
                  borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                  child: Row(
                    children: [
                      SizedBox(width: SuperTabSectionHeading.indentFor(0)),
                      SizedBox(
                        width: _iconColumn,
                        child: project != null ? _channelMark() : null,
                      ),
                      Expanded(
                        child: Semantics(
                          label: project?.isPrivate == true
                              ? 'Private project'
                              : null,
                          selected: selected,
                          child: _withTaskStatus(
                            group,
                            task: project == null,
                            (status) => Tooltip(
                              message:
                                  project?.name ??
                                  [
                                    SuperTabWorkgroupName.plain(group),
                                    if (status != null)
                                      superTabTaskStatusText(status),
                                  ].join('\n'),
                              child: ConstrainedBox(
                                constraints: const BoxConstraints(
                                  minHeight: 36,
                                ),
                                child: Padding(
                                  padding: const EdgeInsets.symmetric(
                                    vertical: 8,
                                  ),
                                  child: Row(
                                    children: [
                                      Expanded(
                                        child: project == null
                                            ? Column(
                                                crossAxisAlignment:
                                                    CrossAxisAlignment.start,
                                                mainAxisSize: MainAxisSize.min,
                                                children: [
                                                  SuperTabWorkgroupName(
                                                    group,
                                                    style: style,
                                                  ),
                                                  // Moving, waiting and on what, or stuck (#957).
                                                  if (status != null)
                                                    SuperTabTaskLineView(
                                                      status,
                                                      key: ValueKey(
                                                        'super-task-line-${group.id}',
                                                      ),
                                                    ),
                                                ],
                                              )
                                            : Column(
                                                crossAxisAlignment:
                                                    CrossAxisAlignment.start,
                                                mainAxisSize: MainAxisSize.min,
                                                children: [
                                                  Text(
                                                    project.name,
                                                    maxLines: 1,
                                                    overflow:
                                                        TextOverflow.ellipsis,
                                                    style: style,
                                                  ),
                                                  // Teammates' agents cannot push to its repository yet (project_github.dart).
                                                  ProjectGitHubLine(
                                                    controller: controller,
                                                    project: project,
                                                  ),
                                                ],
                                              ),
                                      ),
                                      if (badge > 0) ...[
                                        const SizedBox(width: 8),
                                        Semantics(
                                          label: badge == 1
                                              ? '1 mention'
                                              : '$badge mentions',
                                          excludeSemantics: true,
                                          child: SuperTabCountBadge(
                                            badge,
                                            key: ValueKey(
                                              'super-mentions-${group.id}',
                                            ),
                                          ),
                                        ),
                                      ],
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
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                      SizedBox(
                        width: _iconColumn,
                        // Unread is drawn as a bold name; a screen reader
                        // hears it said, as it heard the dot it replaces.
                        child: Semantics(
                          label: unread ? 'Unread messages' : null,
                          child: Center(
                            child: waiting
                                ? Tooltip(
                                    message: 'Needs a human',
                                    child: Text(
                                      '?',
                                      style: DesktopChrome.control(
                                        color: grid.AppPalette.warn,
                                        medium: true,
                                      ),
                                    ),
                                  )
                                : project == null
                                ? SuperTabTaskMark(group)
                                : null,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            // At the far right edge, since it is always there and the mark
            // beside it comes and goes (Dee, 2026-10-28).
            if (project != null) _toggle(project, expanded: expanded),
          ],
        ),
      ),
    );
  }

  /// On a focused project name, → shows its conversations and ← hides them.
  /// An arrow that would change nothing moves focus as it does elsewhere.
  Widget _arrowToggles(
    SuperTabProject? project, {
    required bool expanded,
    required Widget child,
  }) => project == null
      ? child
      : Focus(
          canRequestFocus: false,
          skipTraversal: true,
          onKeyEvent: (node, event) {
            final keyboard = HardwareKeyboard.instance;
            final toggles =
                event is! KeyUpEvent &&
                !keyboard.isShiftPressed &&
                !keyboard.isControlPressed &&
                !keyboard.isAltPressed &&
                !keyboard.isMetaPressed &&
                (event.logicalKey == LogicalKeyboardKey.arrowRight
                    ? !expanded
                    : event.logicalKey == LogicalKeyboardKey.arrowLeft &&
                          expanded);
            if (!toggles) return KeyEventResult.ignored;
            controller.toggleProject(project.id);
            return KeyEventResult.handled;
          },
          child: child,
        );

  /// The chevron that shows or hides a project's conversations: '>' while
  /// they are hidden, 'v' while shown. Focused, Enter or Space toggles it; on
  /// the focused name, → shows them and ← hides them.
  Widget _toggle(SuperTabProject project, {required bool expanded}) =>
      Semantics(
        button: true,
        expanded: expanded,
        child: InkWell(
          key: ValueKey('super-project-toggle-${project.id}'),
          onTap: () => controller.toggleProject(project.id),
          // Its row lights whole on hover (_RowSurface).
          hoverColor: Colors.transparent,
          focusColor: grid.AppSurface.hoverFill,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          child: Tooltip(
            message: expanded ? 'Hide conversations' : 'Show conversations',
            child: SizedBox(
              width: _iconColumn,
              height: 36,
              child: Icon(
                expanded ? AppIcons.chevronDown : AppIcons.chevronRight,
                size: AppIcons.inlineSize,
                color: DesktopChrome.muted,
              ),
            ),
          ),
        ),
      );

  /// A project's "Closed (N)" row and, when it is open, the closed groups under it: archived ones and finished
  /// ones that left the active set, as read for the project so far.
  List<Widget> _closed(_ProjectReading reading) {
    final project = reading.project;
    final groups = reading.conversations
        .where(
          (g) =>
              g.id != project.leadConversationId &&
              !g.isBuddyChat &&
              !controller.hiddenByBuddies(g) &&
              g.closed,
        )
        .toList();
    if (groups.isEmpty) return const [];
    final open = controller.closedOpenProjects.contains(project.id);
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
              key: ValueKey('super-closed-${project.id}'),
              onTap: () => controller.toggleClosed(project.id),
              hoverColor: grid.AppSurface.hoverFill,
              focusColor: grid.AppSurface.hoverFill,
              borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
              child: Row(
                children: [
                  SizedBox(width: SuperTabSectionHeading.indentFor(0)),
                  const SizedBox(width: _iconColumn),
                  Expanded(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 36),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          'Closed (${groups.length})',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.control(
                            color: DesktopChrome.muted,
                          ),
                        ),
                      ),
                    ),
                  ),
                  SizedBox(
                    width: _iconColumn,
                    child: Icon(
                      open ? AppIcons.chevronDown : AppIcons.chevronRight,
                      size: AppIcons.inlineSize,
                      color: DesktopChrome.muted,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
      if (open) ...[
        for (final group in groups) _row(group),
        if (controller.hasEarlierDormant(project.id))
          _navigationRow(
            key: 'super-closed-earlier-${project.id}',
            label: controller.dormantLoading(project.id)
                ? 'Loading…'
                : 'Show earlier',
            icon: AppIcons.chevronDown,
            onTap: controller.dormantLoading(project.id)
                ? null
                : () => unawaited(
                    controller.loadDormant(project.id, earlier: true),
                  ),
          ),
      ],
    ];
  }

  /// The signed-in person's Buddy chat in each project, there from the start
  /// (Lead's ruling, 10-29): the PM's private lines to them land there, and it
  /// offers to start their Buddy. A viewer, who opens nothing, sees only the
  /// chats they have. The project is in brackets once there are several.
  List<Widget> _buddies(
    List<SuperTabProject> projects,
    _SidebarReading reading,
  ) {
    final listed = [
      for (final project in projects)
        if (reading.of(project) case final read
            when read.buddyChat != null || controller.canWrite)
          read,
    ];
    return [for (final read in listed) _buddy(read, named: listed.length > 1)];
  }

  Widget _buddy(_ProjectReading reading, {required bool named}) {
    final snapshot = controller.snapshot!;
    final project = reading.project;
    final chat = reading.buddyChat;
    final agent = controller.buddy(project.id);
    // With no Buddy running it reads as the name the reader chose for it, or
    // plain "Buddy" (its chat's default title names the owner, which the
    // reader is): one name everywhere is the point of renaming (Lead, 10-29).
    final name = agent == null
        ? chat?.buddyName ?? 'Buddy'
        : snapshot.agentName(agent.id, fallback: agent.name);
    return SuperTabBuddyRow(
      key: ValueKey('super-buddy-${project.id}'),
      agentId: agent?.id,
      name: name,
      project: named ? project.name : null,
      tooltip: 'Your Buddy · ${project.name}',
      // Where it runs, as the Agents list once showed every Buddy: only its
      // person reads this line now. The project is in the name when several.
      detail: agent == null
          ? null
          : [
              if (!named) project.name,
              '${buddyEngineName(agent.engine)} on ${buddyMachineName(controller, agent.machineId, app: app)}',
            ].join(' · '),
      status: agent == null ? null : _buddyMark(agent),
      note: switch ((agent, controller.buddyStart(project.id))) {
        (null, {'harnessId': null, 'error': null}) => 'starting',
        (null, _) => 'not started',
        (final agent?, _) when agent.downSince != null => 'offline',
        _ => null,
      },
      selected:
          chat != null && !_paneCovered && controller.selectedId == chat.id,
      unread: chat != null && controller.unread(chat),
      badge: chat == null ? 0 : attention?.mentionsIn(chat.id) ?? 0,
      onTap: chat != null
          ? () => onSelect(chat.id)
          : controller.saving || controller.hasPendingAction
          ? null
          : () => _openBuddyChat(project.id),
    );
  }

  /// The Buddy's activity mark, drawn as the Agents list draws an agent's.
  Widget? _buddyMark(SuperTabAgent agent) {
    final app = this.app;
    if (app == null) return null;
    final theme = terminalThemeFor(
      grid.AppTheme.surfacePalette,
      terminalThemeStore.value,
    );
    final activity = agent.downSince != null
        ? HarnessActivity.offline
        : harnessActivity(app, agent.machineId, agent.harnessId) ??
              HarnessActivity.unknown;
    return ActivityMark(
      activity: activity,
      tooltip: false,
      showIdle: true,
      color: activityColor(
        activity,
        theme,
        color: appearancePrefsStore.value.prompt.color,
      ),
    );
  }

  /// A project's open conversations, newest first: the most recently created
  /// has the highest number, and one without a number predates numbering.
  List<SuperTabConversation> _newestFirst(_ProjectReading reading) {
    final project = reading.project;
    final groups = reading.conversations
        .where(
          (g) =>
              g.id != project.leadConversationId &&
              !g.isBuddyChat &&
              !controller.hiddenByBuddies(g) &&
              !g.closed,
        )
        .toList();
    // A stable sort keeps the backend's order among unnumbered ones.
    mergeSort(
      groups,
      compare: (a, b) => (b.number ?? 0).compareTo(a.number ?? 0),
    );
    return groups;
  }

  /// The "… N more" row under a project's newest conversations.
  Widget _moreRow(SuperTabProject project, int hidden, VoidCallback onTap) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 2),
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          clipBehavior: Clip.antiAlias,
          child: Semantics(
            button: true,
            child: InkWell(
              key: ValueKey('super-project-more-${project.id}'),
              onTap: onTap,
              hoverColor: grid.AppSurface.hoverFill,
              focusColor: grid.AppSurface.hoverFill,
              borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
              child: Row(
                children: [
                  SizedBox(width: SuperTabSectionHeading.indentFor(0)),
                  const SizedBox(width: _iconColumn),
                  Expanded(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 36),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          '… $hidden more',
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
      );

  List<Widget> _workgroups(_ProjectReading reading) {
    final project = reading.project;
    final groups = _newestFirst(reading);
    return groups.isEmpty
        ? [
            Padding(
              padding: EdgeInsets.fromLTRB(
                SuperTabSectionHeading.indentFor(0) + _iconColumn,
                8,
                12,
                10,
              ),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  'No workgroups yet',
                  style: DesktopChrome.metadata(),
                ),
              ),
            ),
          ]
        : [
            _NewestConversations(
              key: ValueKey('super-project-list-${project.id}'),
              rows: [
                for (final group in groups)
                  (group.id, () => _workgroupRow(group, reading)),
              ],
              // Never behind "… N more": the open one, and those with
              // something to read or answer.
              kept: {
                if (!_paneCovered) controller.selectedId,
                for (final group in groups)
                  if (reading.unread.contains(group.id) ||
                      reading.waiting.contains(group.id))
                    group.id,
              },
              more: (hidden, onTap) => _moreRow(project, hidden, onTap),
            ),
          ];
  }

  /// Every project with its workgroups, by name from A to Z.
  List<(String, Widget)> _channels(
    SuperTabSnapshot? snapshot,
    _SidebarReading reading,
  ) => [
    for (final project in snapshot?.projects ?? const <SuperTabProject>[])
      if (reading.of(project) case final read when read.lead != null)
        (
          project.name,
          Column(
            key: ValueKey('super-project-${project.id}'),
            mainAxisSize: MainAxisSize.min,
            children: [
              _row(read.lead!, reading: read),
              if (controller.expandedProjects.contains(project.id)) ...[
                ..._workgroups(read),
                ..._closed(read),
              ],
            ],
          ),
        ),
  ]..sort((a, b) => a.$1.toLowerCase().compareTo(b.$1.toLowerCase()));

  @override
  Widget build(BuildContext context) => switch (attention) {
    final attention? => ListenableBuilder(
      listenable: attention,
      builder: (context, _) => _build(context),
    ),
    null => _build(context),
  };

  Widget _build(BuildContext context) {
    final snapshot = controller.snapshot;
    final projects = snapshot?.projects ?? const <SuperTabProject>[];
    final reading = _SidebarReading(controller, needsHuman, attention);
    return Material(
      color: DesktopChrome.surface,
      child: ListView(
        padding: const EdgeInsets.all(8),
        children: [
          if ((app, onNewSwarm) case (final app?, final onNewSwarm?))
            SwarmSwitcher(
              app: app,
              controller: controller,
              onNewSwarm: onNewSwarm,
              row:
                  ({
                    required label,
                    required icon,
                    required onTap,
                    required trailing,
                  }) => _navigationRow(
                    key: 'super-swarm-switcher',
                    label: label,
                    icon: icon,
                    onTap: onTap,
                    trailing: trailing,
                  ),
            ),
          if (onNewProject != null)
            _navigationRow(
              key: 'super-new-project',
              label: 'New project',
              icon: AppIcons.plus,
              onTap: controller.canWrite ? onNewProject : null,
            ),
          if (onYourDevices != null)
            _navigationRow(
              key: 'super-your-devices',
              label: 'Your devices',
              icon: AppIcons.circle,
              onTap: onYourDevices,
              selected: devicesSelected,
            ),
          // The Swarm's models (docs/plans/2026-10-23-swarm-local-models.md), for everyone: the owner sets them up here,
          // and everyone runs and shares models here once they are. What each machine offers is on the machine.
          if (snapshot != null)
            _navigationRow(
              key: 'super-local-models',
              label: 'Your models',
              icon: AppIcons.brain,
              onTap: () =>
                  showSwarmLocalModels(context, controller, app: app, now: now),
            ),
          if (onThreads != null)
            _navigationRow(
              key: 'super-threads',
              label: 'Threads',
              icon: AppIcons.messagesSquare,
              onTap: onThreads,
              selected: threadsSelected,
              unread: attention?.threadsUnread ?? false,
              badge: attention?.threadMentions ?? 0,
            ),
          if (onNotifications != null)
            _navigationRow(
              key: 'super-notifications',
              label: 'Notifications',
              icon: AppIcons.bell,
              onTap: onNotifications,
              selected: notificationsSelected,
              badge:
                  (snapshot?.mentionsWaiting ?? 0) +
                  (snapshot?.decisionsWaiting ?? 0),
            ),
          if (onNewProject != null ||
              onYourDevices != null ||
              onNotifications != null ||
              onThreads != null ||
              controller.isOwner ||
              snapshot?.localModels?.enabled == true)
            const SizedBox(height: 20),
          SuperTabSectionHeading(
            'Projects',
            onAdd: controller.canWrite ? onNewProject : null,
            addTooltip: 'New project',
            endInset: 0,
            collapsed: !controller.projectsGroupOpen,
            onToggleCollapsed: controller.toggleProjectsGroup,
          ),
          if (controller.projectsGroupOpen)
            for (final (_, channel) in _channels(snapshot, reading)) channel,
          const SizedBox(height: 16),
          // Buddies replaced Chat with PM in every Swarm (Ken, 10-29).
          ...[
            SuperTabSectionHeading(
              'Buddies',
              onAdd:
                  controller.canWrite &&
                      !controller.saving &&
                      !controller.hasPendingAction &&
                      buddyProjects(controller).isNotEmpty
                  ? () => unawaited(showAddBuddy(context, controller, app: app))
                  : null,
              addTooltip: 'Add a Buddy',
              endInset: 0,
              collapsed: !controller.buddiesGroupOpen,
              onToggleCollapsed: controller.toggleBuddiesGroup,
            ),
            if (controller.buddiesGroupOpen) ..._buddies(projects, reading),
            const SizedBox(height: 16),
          ],
          // Machine online/offline, unread marks and theme changes do not touch
          // the controller the rest of this sidebar rebuilds on, so this group
          // watches them itself — the same sources the roster merged before the
          // move (roster.dart).
          ListenableBuilder(
            listenable: Listenable.merge([
              controller,
              if (app != null) ...[app!, app!.agentUnread],
              terminalThemeStore,
              appearancePrefsStore,
            ]),
            builder: (context, _) {
              grid.AppTheme.watch(context);
              return SuperTabMachines(
                controller: controller,
                app: app,
                onAddAgent: onAddAgent,
                onOpenAgent: onOpenAgent,
                embedded: true,
                collapsed: !controller.machinesGroupOpen,
                onToggleCollapsed: controller.toggleMachinesGroup,
                readLocal: readLocal,
                now: now,
              );
            },
          ),
          if (board case final board?) ...[
            const SizedBox(height: 16),
            LeaderboardModelsSection(
              board: board,
              projectId: snapshot?.projectFor(controller.selectedId)?.id,
              collapsed: !controller.modelsGroupOpen,
              onToggleCollapsed: controller.toggleModelsGroup,
              now: now,
            ),
          ],
        ],
      ),
    );
  }
}

/// A sidebar row's ground: the selected fill, or the hover fill while the
/// pointer is anywhere over it, one shape across the row's whole width.
class _RowSurface extends StatefulWidget {
  const _RowSurface({required this.selected, required this.child});
  final bool selected;
  final Widget child;

  @override
  State<_RowSurface> createState() => _RowSurfaceState();
}

class _RowSurfaceState extends State<_RowSurface> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) => MouseRegion(
    onEnter: (_) => setState(() => _hovered = true),
    onExit: (_) => setState(() => _hovered = false),
    child: Material(
      color: widget.selected
          ? grid.AppSurface.selectedFill
          : _hovered
          ? grid.AppSurface.hoverFill
          : Colors.transparent,
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      clipBehavior: Clip.antiAlias,
      child: widget.child,
    ),
  );
}

/// A project's open conversations, newest first: the first
/// [_NewestConversations.shown] and the [_NewestConversations.kept] ones, then
/// a "… N more" row that shows the rest. Showing the rest lasts until the
/// project is collapsed.
class _NewestConversations extends StatefulWidget {
  const _NewestConversations({
    super.key,
    required this.rows,
    required this.kept,
    required this.more,
  });

  static const shown = 8;

  /// Each conversation's id and how its row is built, newest first: only the
  /// rows shown are built.
  final List<(String, Widget Function())> rows;

  /// Listed even when older than the newest.
  final Set<String> kept;
  final Widget Function(int hidden, VoidCallback onTap) more;

  @override
  State<_NewestConversations> createState() => _NewestConversationsState();
}

class _NewestConversationsState extends State<_NewestConversations> {
  bool _all = false;

  @override
  Widget build(BuildContext context) {
    final rows = widget.rows;
    final visible = _all || rows.length <= _NewestConversations.shown
        ? rows
        : [
            for (final (index, row) in rows.indexed)
              if (index < _NewestConversations.shown ||
                  widget.kept.contains(row.$1))
                row,
          ];
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final (_, row) in visible) row(),
        if (visible.length < rows.length)
          widget.more(
            rows.length - visible.length,
            () => setState(() => _all = true),
          ),
      ],
    );
  }
}

/// What one build of the sidebar reads, each piece once: per row, a Swarm's
/// thousands of conversations were scanned again on every rebuild (Diego,
/// 10-29).
class _SidebarReading {
  _SidebarReading(this.controller, this.needsHuman, this.attention);
  final SuperTabController controller;
  final int Function(SuperTabConversation group) needsHuman;
  final SuperTabAttention? attention;
  final _projects = <String, _ProjectReading>{};

  _ProjectReading of(SuperTabProject project) =>
      _projects.putIfAbsent(project.id, () => _ProjectReading(this, project));

  /// The project of the open conversation.
  late final selectedProjectId = controller.selected?.projectId;
}

/// One build's reading of a project, each part asked once and only when a
/// row needs it.
class _ProjectReading {
  _ProjectReading(this.sidebar, this.project);
  final _SidebarReading sidebar;
  final SuperTabProject project;

  late final conversations = sidebar.controller.projectConversations(
    project.id,
  );
  late final SuperTabConversation? lead =
      conversations
          .where((g) => g.id == project.leadConversationId)
          .firstOrNull ??
      sidebar.controller.snapshot?.conversation(project.leadConversationId);
  late final buddyChat = sidebar.controller.buddyChat(project.id);

  /// The open conversations that need a human, and those with unread messages;
  /// never the reader's Buddy chat, which has its own row under Buddies.
  Set<String> get waiting => _open.waiting;
  Set<String> get unread => _open.unread;

  /// Tags of the reader in the project's chat and its open workgroups: a
  /// collapsed project's number.
  late final int mentions = switch (sidebar.attention) {
    null => 0,
    final attention =>
      attention.mentionsIn(project.leadConversationId) +
          [
            for (final g in conversations)
              if (!g.closed &&
                  !g.isBuddyChat &&
                  g.audience == null &&
                  g.id != project.leadConversationId)
                attention.mentionsIn(g.id),
          ].fold(0, (a, b) => a + b),
  };
  late final _open = () {
    final waiting = <String>{}, unread = <String>{};
    for (final g in conversations) {
      if (g.closed || g.isBuddyChat || g.audience != null) continue;
      if (sidebar.needsHuman(g) > 0) waiting.add(g.id);
      if (sidebar.controller.unread(g)) unread.add(g.id);
    }
    return (waiting: waiting, unread: unread);
  }();
}
