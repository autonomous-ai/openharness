import 'dart:async';

import 'package:clock/clock.dart';
import 'package:collection/collection.dart' show mergeSort;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/machine_resources.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../state/app_state.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'identity.dart';
import 'local_models.dart';
import 'buddies.dart';
import 'machines.dart';
import 'model.dart';
import 'pm_chat_rows.dart';
import 'section_heading.dart';
import 'task_status.dart';
import 'workgroup_name.dart';
import 'project_github.dart';

/// The Swarm's Product Managers' conversation, listed as a channel among the projects.
const kProductManagersChannel = 'product-managers';

/// A project's Product Manager by name, as its Chat with PM is listed;
/// [lead] is the project's Lead conversation when the caller holds it.
String pmChatName(
  SuperTabSnapshot snapshot,
  SuperTabProject project, {
  SuperTabConversation? lead,
}) {
  final pmId =
      (lead ?? snapshot.conversation(project.leadConversationId))?.leadId;
  return pmId == null
      ? 'Product Manager'
      : snapshot.agentName(pmId, fallback: 'Product Manager');
}

class ProjectSidebar extends StatelessWidget {
  const ProjectSidebar({
    super.key,
    required this.controller,
    required this.onSelect,
    required this.needsHuman,
    required this.onAddAgent,
    this.app,
    this.onNewProject,
    this.onYourDevices,
    this.devicesSelected = false,
    this.onNotifications,
    this.notificationsSelected = false,
    this.onOpenAgent,
    this.onOpenPmChat,
    this.readLocal,
    this.now = DateTime.now,
  });
  final SuperTabController controller;
  final ValueChanged<String> onSelect;
  final int Function(SuperTabConversation group) needsHuman;
  final ValueChanged<SuperTabConversation> onAddAgent;
  final AppNotifier? app;
  final VoidCallback? onNewProject;
  final VoidCallback? onYourDevices;
  final bool devicesSelected;

  /// The reader's tags from every project's Lead; its count is what waits.
  final VoidCallback? onNotifications;
  final bool notificationsSelected;
  final ValueChanged<SuperTabAgent>? onOpenAgent;

  /// Opens a project's Chat with PM, by project id; the controller's
  /// [SuperTabController.openPmChat] when not given.
  final ValueChanged<String>? onOpenPmChat;

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
                      style: DesktopChrome.control(
                        medium: selected,
                        color: onTap == null
                            ? DesktopChrome.muted
                            : DesktopChrome.foreground,
                      ),
                    ),
                  ),
                ),
              ),
              if (badge > 0)
                Padding(
                  padding: const EdgeInsets.only(right: 10),
                  child: SuperTabCountBadge(badge),
                ),
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

  void _openPmChat(String projectId) => onOpenPmChat != null
      ? onOpenPmChat!(projectId)
      : unawaited(controller.openPmChat(projectId));

  /// A project row's name opens the project's chat; only the chevron at its
  /// right end shows or hides its conversations (Dee, 2026-10-28).
  Widget _row(
    SuperTabConversation group, {
    _ProjectReading? reading,
    String? label,
    String? key,
  }) {
    final project = reading?.project;
    final selected =
        !devicesSelected &&
        !notificationsSelected &&
        controller.selectedId == group.id;
    final waiting = reading == null
        ? needsHuman(group) > 0
        : reading.waiting.isNotEmpty;
    // A project's PM chat shows its own count rather than a bold name.
    final pmChat = reading?.pmChat;
    final projectPmUnread = reading?.pmUnread ?? 0;
    final unread = reading == null
        ? controller.unread(group)
        : reading.unread.any((id) => projectPmUnread == 0 || id != pmChat?.id);
    return _drawRow(
      group,
      project: project,
      label: label,
      key: key,
      selected: selected,
      waiting: waiting,
      unread: unread,
      pmChat: pmChat,
      projectPmUnread: projectPmUnread,
      selectedProjectId: reading?.sidebar.selectedProjectId,
    );
  }

  /// A workgroup's row from what its project's reading already asked.
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
        selected:
            !devicesSelected &&
            !notificationsSelected &&
            controller.selectedId == group.id,
        waiting: reading.waiting.contains(group.id),
        unread: reading.unread.contains(group.id),
      );

  Widget _drawRow(
    SuperTabConversation group, {
    SuperTabProject? project,
    String? label,
    String? key,
    required bool selected,
    required bool waiting,
    required bool unread,
    SuperTabConversation? pmChat,
    int projectPmUnread = 0,
    String? selectedProjectId,
  }) {
    final expanded =
        project != null && controller.expandedProjects.contains(project.id);
    // A collapsed project shows as selected while one of its conversations it
    // hides is open; its Chat with PM has a row of its own.
    final highlighted =
        selected ||
        (project != null &&
            !expanded &&
            !devicesSelected &&
            !notificationsSelected &&
            selectedProjectId == project.id &&
            controller.selectedId != pmChat?.id);
    // Unread is the name in bold and nothing else, no dot (Dee, 2026-10-29).
    final style = DesktopChrome.control(
      medium: highlighted,
      color: highlighted || unread || project != null || label != null
          ? DesktopChrome.foreground
          : DesktopChrome.muted,
    ).copyWith(fontWeight: unread ? grid.AppFont.semibold : null);
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: highlighted ? grid.AppSurface.selectedFill : Colors.transparent,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        clipBehavior: Clip.antiAlias,
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
                  hoverColor: grid.AppSurface.hoverFill,
                  focusColor: grid.AppSurface.hoverFill,
                  borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                  child: Row(
                    children: [
                      SizedBox(width: SuperTabSectionHeading.indentFor(0)),
                      SizedBox(
                        width: _iconColumn,
                        child: project != null || label != null
                            ? _channelMark()
                            : null,
                      ),
                      Expanded(
                        child: Semantics(
                          label: project?.isPrivate == true
                              ? 'Private project'
                              : null,
                          selected: selected,
                          child: Tooltip(
                            message:
                                label ??
                                project?.name ??
                                [
                                  SuperTabWorkgroupName.plain(group),
                                  ?superTabTaskStatus(
                                    group,
                                    clock.now(),
                                    personName: _personName,
                                  )?.line,
                                ].join('\n'),
                            child: ConstrainedBox(
                              constraints: const BoxConstraints(minHeight: 36),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 8,
                                ),
                                child: Row(
                                  children: [
                                    Expanded(
                                      child: label == null && project == null
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
                                                SuperTabTaskLine(
                                                  group,
                                                  personName: _personName,
                                                ),
                                              ],
                                            )
                                          : Column(
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.start,
                                              mainAxisSize: MainAxisSize.min,
                                              children: [
                                                Text(
                                                  label ?? project!.name,
                                                  maxLines: 1,
                                                  overflow:
                                                      TextOverflow.ellipsis,
                                                  style: style,
                                                ),
                                                // Teammates' agents cannot push to its repository yet (project_github.dart).
                                                if (project != null)
                                                  ProjectGitHubLine(
                                                    controller: controller,
                                                    project: project,
                                                  ),
                                              ],
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
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                      if (projectPmUnread > 0)
                        Padding(
                          padding: const EdgeInsets.only(left: 4),
                          child: SuperTabPmUnread(
                            projectPmUnread,
                            key: ValueKey(
                              'super-project-pm-unread-${project!.id}',
                            ),
                            onTap: () => _openPmChat(project.id),
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
                                : label == null && project == null
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
          hoverColor: grid.AppSurface.hoverFill,
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
    final pmChat = reading.pmChat?.id;
    final groups = reading.conversations
        .where(
          (g) =>
              g.id != project.leadConversationId &&
              g.id != pmChat &&
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

  /// The signed-in person's private chat with each project's Product
  /// Manager, as direct messages below the projects so a collapsed project
  /// never hides them; the first click opens one.
  List<Widget> _pmChats(
    List<SuperTabProject> projects,
    _SidebarReading reading,
  ) => [
    for (final project in projects)
      ?_pmChat(reading.of(project), named: projects.length > 1),
  ];

  Widget? _pmChat(_ProjectReading reading, {required bool named}) {
    final snapshot = controller.snapshot!;
    final project = reading.project;
    final lead = reading.lead;
    final chat = reading.pmChat;
    if (chat == null && !controller.canWrite) return null;
    return SuperTabPmChatRow(
      key: ValueKey('super-pm-chat-${project.id}'),
      agentId: lead?.leadId,
      name: pmChatName(snapshot, project, lead: lead),
      project: named ? project.name : null,
      selected:
          chat != null &&
          !devicesSelected &&
          !notificationsSelected &&
          controller.selectedId == chat.id,
      unread: chat != null && controller.unread(chat),
      unreadCount: reading.pmUnread,
      onTap: chat != null
          ? () => onSelect(chat.id)
          : controller.saving || controller.hasPendingAction
          ? null
          : () => _openPmChat(project.id),
    );
  }

  /// The signed-in person's Buddies, one row per project where they have one
  /// or its chat stays, the project in brackets once there are several.
  List<Widget> _buddies(List<SuperTabProject> projects) {
    final listed = [
      for (final project in projects)
        if (controller.buddyChat(project.id) case final chat?) (project, chat),
    ];
    return [
      for (final (project, chat) in listed)
        _buddy(project, chat, named: listed.length > 1),
    ];
  }

  Widget _buddy(
    SuperTabProject project,
    SuperTabConversation chat, {
    required bool named,
  }) {
    final snapshot = controller.snapshot!;
    final agent = controller.buddy(project.id);
    // A removed Buddy's chat stays; it reads as plain "Buddy" until one is
    // added again (its title names the owner, which the reader is).
    final name = agent == null
        ? 'Buddy'
        : snapshot.agentName(agent.id, fallback: agent.name);
    return SuperTabPmChatRow(
      key: ValueKey('super-buddy-${project.id}'),
      agentId: agent?.id,
      name: name,
      project: named ? project.name : null,
      tooltip: 'Your Buddy · ${project.name}',
      note: switch ((agent, controller.buddyStart(project.id))) {
        (null, {'error': String _}) => 'not started',
        (null, {'harnessId': null}) => 'starting',
        (null, _) => 'removed',
        (final agent?, _) when agent.downSince != null => 'offline',
        _ => null,
      },
      selected:
          !devicesSelected &&
          !notificationsSelected &&
          controller.selectedId == chat.id,
      unread: controller.unread(chat),
      unreadCount: controller.unreadCount(chat),
      onTap: () => onSelect(chat.id),
    );
  }

  /// A project's open conversations, newest first: the most recently created
  /// has the highest number, and one without a number predates numbering.
  List<SuperTabConversation> _newestFirst(_ProjectReading reading) {
    final project = reading.project;
    final pmChat = reading.pmChat?.id;
    final groups = reading.conversations
        .where(
          (g) =>
              g.id != project.leadConversationId &&
              g.id != pmChat &&
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
                if (!devicesSelected && !notificationsSelected)
                  controller.selectedId,
                for (final group in groups)
                  if (reading.unread.contains(group.id) ||
                      reading.waiting.contains(group.id))
                    group.id,
              },
              more: (hidden, onTap) => _moreRow(project, hidden, onTap),
            ),
          ];
  }

  /// Every project with its workgroups, and the Product Managers'
  /// conversation, which every person in the Swarm reads, by name from A to Z.
  List<(String, Widget)> _channels(
    SuperTabSnapshot? snapshot,
    _SidebarReading reading,
  ) => [
    if (snapshot?.conversation(snapshot.leadsConversationId ?? '')
        case final leads?)
      (kProductManagersChannel, _row(leads, label: kProductManagersChannel)),
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
  Widget build(BuildContext context) {
    final snapshot = controller.snapshot;
    final projects = snapshot?.projects ?? const <SuperTabProject>[];
    final buddiesOn = controller.buddiesOn;
    final reading = _SidebarReading(controller, needsHuman);
    final pmChats = buddiesOn ? const <Widget>[] : _pmChats(projects, reading);
    return Material(
      color: DesktopChrome.surface,
      child: ListView(
        padding: const EdgeInsets.all(8),
        children: [
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
          if (pmChats.isNotEmpty) ...[
            SuperTabSectionHeading(
              'Direct messages',
              endInset: 0,
              startInset: SuperTabSectionHeading.indentFor(0),
            ),
            ...pmChats,
            const SizedBox(height: 16),
          ],
          // Buddies take Chat with PM's place (spec: Buddies, 10-28).
          if (buddiesOn) ...[
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
              startInset: SuperTabSectionHeading.indentFor(0),
            ),
            ..._buddies(projects),
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
        ],
      ),
    );
  }
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
  _SidebarReading(this.controller, this.needsHuman);
  final SuperTabController controller;
  final int Function(SuperTabConversation group) needsHuman;
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
  late final pmChat = sidebar.controller.pmChat(project.id);
  late final pmUnread = switch (pmChat) {
    final chat? => sidebar.controller.unreadCount(chat),
    null => 0,
  };

  /// The open conversations that need a human, and those with unread messages.
  Set<String> get waiting => _open.waiting;
  Set<String> get unread => _open.unread;
  late final _open = () {
    final waiting = <String>{}, unread = <String>{};
    for (final g in conversations) {
      if (g.closed) continue;
      if (sidebar.needsHuman(g) > 0) waiting.add(g.id);
      if (sidebar.controller.unread(g)) unread.add(g.id);
    }
    return (waiting: waiting, unread: unread);
  }();
}
