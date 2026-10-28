import 'dart:async';

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
import 'local_models.dart';
import 'machines.dart';
import 'model.dart';
import 'pm_chat_rows.dart';
import 'section_heading.dart';
import 'workgroup_name.dart';
import 'workspace_menu.dart';
import 'workspace_settings.dart';
import 'workspaces.dart';
import 'project_github.dart';

/// The Swarm's Product Managers' conversation, listed as a channel among the projects.
const kProductManagersChannel = 'product-managers';

/// A project's Product Manager by name, as its Chat with PM is listed.
String pmChatName(SuperTabSnapshot snapshot, SuperTabProject project) {
  final pmId = snapshot.conversation(project.leadConversationId)?.leadId;
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
    this.workspaces,
    this.onWorkspaceSettings,
    this.onNewWorkspace,
    this.onNewSwarmIn,
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

  /// The person's Workspaces for the menu at the top: the app's account's
  /// unless a test gives its own.
  final SwarmWorkspaces? workspaces;
  final ValueChanged<SwarmWorkspace>? onWorkspaceSettings;
  final VoidCallback? onNewWorkspace;

  /// Starts a new Swarm in a Workspace.
  final ValueChanged<SwarmWorkspace>? onNewSwarmIn;

  /// Projects and workgroups share a text column. Only projects use its icon.
  static const _iconColumn = SuperTabSectionHeading.actionWidth;
  static const _dotSize = 6.0;

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
    SuperTabProject? project,
    String? label,
    String? key,
  }) {
    final selected =
        !devicesSelected &&
        !notificationsSelected &&
        controller.selectedId == group.id;
    final groups = project == null
        ? [group]
        : controller.snapshot!.conversations.where(
            (g) => g.projectId == project.id && !g.closed,
          );
    final waiting = groups.any((g) => needsHuman(g) > 0);
    // A project's PM chat shows its own count rather than the dot.
    final pmChat = project == null ? null : controller.pmChat(project.id);
    final projectPmUnread = pmChat == null ? 0 : controller.unreadCount(pmChat);
    final unread = groups.any(
      (g) =>
          controller.unread(g) && (projectPmUnread == 0 || g.id != pmChat?.id),
    );
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
            controller.selected?.projectId == project.id &&
            controller.selectedId != pmChat?.id);
    final style = DesktopChrome.control(
      medium: unread || highlighted,
      color: highlighted || unread || project != null || label != null
          ? DesktopChrome.foreground
          : DesktopChrome.muted,
    );
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
                                SuperTabWorkgroupName.plain(group),
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
                                          ? SuperTabWorkgroupName(
                                              group,
                                              style: style,
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
                              : unread
                              ? Semantics(
                                  label: 'Unread messages',
                                  child: Container(
                                    width: _dotSize,
                                    height: _dotSize,
                                    decoration: BoxDecoration(
                                      shape: BoxShape.circle,
                                      color: DesktopChrome.accent,
                                    ),
                                  ),
                                )
                              : null,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            // At the far right edge, since it is always there and the dot
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
  List<Widget> _closed(SuperTabProject project) {
    final groups = controller.snapshot!.conversations
        .where(
          (g) =>
              g.projectId == project.id &&
              g.id != project.leadConversationId &&
              g.id != controller.pmChat(project.id)?.id &&
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
  List<Widget> _pmChats(List<SuperTabProject> projects) => [
    for (final project in projects)
      ?_pmChat(project, named: projects.length > 1),
  ];

  Widget? _pmChat(SuperTabProject project, {required bool named}) {
    final snapshot = controller.snapshot!;
    final pmId = snapshot.conversation(project.leadConversationId)?.leadId;
    final chat = controller.pmChat(project.id);
    if (chat == null && !controller.canWrite) return null;
    return SuperTabPmChatRow(
      key: ValueKey('super-pm-chat-${project.id}'),
      agentId: pmId,
      name: pmChatName(snapshot, project),
      project: named ? project.name : null,
      selected:
          chat != null &&
          !devicesSelected &&
          !notificationsSelected &&
          controller.selectedId == chat.id,
      unread: chat != null && controller.unread(chat),
      unreadCount: chat == null ? 0 : controller.unreadCount(chat),
      onTap: chat != null
          ? () => onSelect(chat.id)
          : controller.saving || controller.hasPendingAction
          ? null
          : () => _openPmChat(project.id),
    );
  }

  /// A project's open conversations, newest first: the most recently created
  /// has the highest number, and one without a number predates numbering.
  List<SuperTabConversation> _newestFirst(SuperTabProject project) {
    final pmChat = controller.pmChat(project.id)?.id;
    final groups = controller.snapshot!.conversations
        .where(
          (g) =>
              g.projectId == project.id &&
              g.id != project.leadConversationId &&
              g.id != pmChat &&
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

  List<Widget> _workgroups(SuperTabProject project) {
    final groups = _newestFirst(project);
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
              rows: [for (final group in groups) (group.id, _row(group))],
              // Never behind "… N more": the open one, and those with
              // something to read or answer.
              kept: {
                if (!devicesSelected && !notificationsSelected)
                  controller.selectedId,
                for (final group in groups)
                  if (controller.unread(group) || needsHuman(group) > 0)
                    group.id,
              },
              more: (hidden, onTap) => _moreRow(project, hidden, onTap),
            ),
          ];
  }

  /// Every project with its workgroups, and the Product Managers'
  /// conversation, which every person in the Swarm reads, by name from A to Z.
  List<(String, Widget)> _channels(SuperTabSnapshot? snapshot) => [
    if (snapshot?.conversation(snapshot.leadsConversationId ?? '')
        case final leads?)
      (kProductManagersChannel, _row(leads, label: kProductManagersChannel)),
    for (final project in snapshot?.projects ?? const <SuperTabProject>[])
      if (snapshot?.conversation(project.leadConversationId) case final lead?)
        (
          project.name,
          Column(
            key: ValueKey('super-project-${project.id}'),
            mainAxisSize: MainAxisSize.min,
            children: [
              _row(lead, project: project),
              if (controller.expandedProjects.contains(project.id)) ...[
                ..._workgroups(project),
                ..._closed(project),
              ],
            ],
          ),
        ),
  ]..sort((a, b) => a.$1.toLowerCase().compareTo(b.$1.toLowerCase()));

  @override
  Widget build(BuildContext context) {
    final snapshot = controller.snapshot;
    final pmChats = _pmChats(snapshot?.projects ?? const []);
    final workspaces =
        this.workspaces ??
        (app == null ? null : SwarmWorkspaces.of(app!.superTabs));
    return Material(
      color: DesktopChrome.surface,
      child: ListView(
        padding: const EdgeInsets.all(8),
        children: [
          if (workspaces != null && app != null)
            SwarmWorkspaceMenu(
              workspaces: workspaces,
              tabId: controller.tabId,
              onOpenSwarm: app!.openSuperTab,
              onSettings:
                  onWorkspaceSettings ??
                  (workspace) => unawaited(
                    showSwarmWorkspaceSettings(context, workspaces, workspace),
                  ),
              onNewWorkspace: onNewWorkspace,
              onNewSwarm: onNewSwarmIn,
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
            for (final (_, channel) in _channels(snapshot)) channel,
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

  /// Each conversation's id and row, newest first.
  final List<(String, Widget)> rows;

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
        for (final (_, row) in visible) row,
        if (visible.length < rows.length)
          widget.more(
            rows.length - visible.length,
            () => setState(() => _all = true),
          ),
      ],
    );
  }
}
