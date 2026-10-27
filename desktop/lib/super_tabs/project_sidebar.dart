import 'dart:async';

import 'package:flutter/material.dart';

import '../core/machine_resources.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'local_models.dart';
import 'machines.dart';
import 'model.dart';
import 'pm_chat.dart';
import 'section_heading.dart';

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
                  child: _countBadge(badge),
                ),
            ],
          ),
        ),
      ),
    ),
  );

  Widget _countBadge(int count) => Container(
    constraints: const BoxConstraints(minWidth: 18),
    padding: const EdgeInsets.symmetric(horizontal: 5),
    decoration: BoxDecoration(
      color: grid.AppPalette.warn.withValues(alpha: .16),
      borderRadius: BorderRadius.circular(9),
    ),
    child: Text(
      '$count',
      textAlign: TextAlign.center,
      style: DesktopChrome.metadata(color: grid.AppPalette.warn),
    ),
  );

  /// A PM chat's unread count; [onTap] opens the chat.
  Widget _pmUnread(int count, {Key? key, VoidCallback? onTap}) => Tooltip(
    message: pmUnreadLabel(count),
    child: Semantics(
      button: onTap != null,
      label: pmUnreadLabel(count),
      excludeSemantics: true,
      child: InkWell(
        key: key,
        onTap: onTap,
        borderRadius: BorderRadius.circular(9),
        child: _countBadge(count),
      ),
    ),
  );

  void _openPmChat(String projectId) => onOpenPmChat != null
      ? onOpenPmChat!(projectId)
      : unawaited(controller.openPmChat(projectId));

  /// Project names open their PM chat; only the trailing control expands them.
  Widget _row(
    SuperTabConversation group, {
    SuperTabProject? project,
    String? label,
    IconData? icon,
    String? key,
    int pmUnread = 0,
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
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: selected ? grid.AppSurface.selectedFill : Colors.transparent,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        clipBehavior: Clip.antiAlias,
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
                child: project == null && icon == null
                    ? null
                    : Icon(
                        icon ??
                            (expanded ? AppIcons.folderOpen : AppIcons.folder),
                        size: AppIcons.inlineSize,
                        color: DesktopChrome.muted,
                      ),
              ),
              Expanded(
                child: Semantics(
                  label: project?.isPrivate == true ? 'Private project' : null,
                  selected: selected,
                  child: Tooltip(
                    message: label ?? project?.name ?? group.label,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 36),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                label ?? project?.name ?? group.label,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: DesktopChrome.control(
                                  medium: unread || selected,
                                  color:
                                      selected ||
                                          unread ||
                                          project != null ||
                                          label != null
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
                  child: _pmUnread(
                    projectPmUnread,
                    key: ValueKey('super-project-pm-unread-${project!.id}'),
                    onTap: () => _openPmChat(project.id),
                  ),
                ),
              SizedBox(
                width: _iconColumn,
                child: Center(
                  child: pmUnread > 0
                      ? _pmUnread(pmUnread)
                      : waiting
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
              if (project != null)
                Semantics(
                  expanded: expanded,
                  child: AppIconButton(
                    key: ValueKey('super-project-expand-${project.id}'),
                    icon: expanded
                        ? AppIcons.chevronDown
                        : AppIcons.chevronRight,
                    color: DesktopChrome.muted,
                    hoverFill: Colors.transparent,
                    tooltip:
                        '${expanded ? 'Collapse' : 'Expand'} ${project.name}',
                    onPressed: () => controller.toggleProject(project.id),
                  ),
                )
              else
                const SizedBox(width: _iconColumn),
            ],
          ),
        ),
      ),
    );
  }

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
  /// Manager, pinned above everything else so a collapsed project never hides
  /// it; the first click opens it. Named after the project when there are
  /// several.
  List<Widget> _pmChats(List<SuperTabProject> projects) => [
    for (final project in projects)
      ?_pmChat(
        project,
        projects.length > 1 ? '$kChatWithPm · ${project.name}' : kChatWithPm,
      ),
  ];

  Widget? _pmChat(SuperTabProject project, String label) {
    final key = 'super-pm-chat-${project.id}';
    if (controller.pmChat(project.id) case final chat?) {
      return _row(
        chat,
        label: label,
        icon: AppIcons.messageSquare,
        key: key,
        pmUnread: controller.unreadCount(chat),
      );
    }
    if (!controller.canWrite) return null;
    return _navigationRow(
      key: key,
      label: label,
      icon: AppIcons.messageSquare,
      onTap: controller.saving || controller.hasPendingAction
          ? null
          : () => _openPmChat(project.id),
    );
  }

  List<Widget> _workgroups(SuperTabProject project) {
    final pmChat = controller.pmChat(project.id)?.id;
    final groups = controller.snapshot!.conversations.where(
      (g) =>
          g.projectId == project.id &&
          g.id != project.leadConversationId &&
          g.id != pmChat &&
          !g.closed,
    );
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
        : [for (final group in groups) _row(group)];
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = controller.snapshot;
    final pmChats = _pmChats(snapshot?.projects ?? const []);
    return Material(
      color: DesktopChrome.surface,
      child: ListView(
        padding: const EdgeInsets.all(8),
        children: [
          if (pmChats.isNotEmpty) ...[...pmChats, const SizedBox(height: 16)],
          if (onNewProject != null)
            _navigationRow(
              key: 'super-new-project',
              label: 'New project',
              icon: AppIcons.plus,
              onTap: controller.canWrite ? onNewProject : null,
            ),
          // The Swarm's models (docs/plans/2026-10-23-swarm-local-models.md), for everyone: the owner sets them up here,
          // and everyone runs and shares models here once they are. What each machine offers is on the machine.
          if (snapshot != null)
            _navigationRow(
              key: 'super-local-models',
              label: 'Manage models',
              icon: AppIcons.brain,
              onTap: () =>
                  showSwarmLocalModels(context, controller, app: app, now: now),
            ),
          if (onYourDevices != null)
            _navigationRow(
              key: 'super-your-devices',
              label: 'Your devices',
              icon: AppIcons.circle,
              onTap: onYourDevices,
              selected: devicesSelected,
            ),
          if (onNotifications != null)
            _navigationRow(
              key: 'super-notifications',
              label: 'Notifications',
              icon: AppIcons.bell,
              onTap: onNotifications,
              selected: notificationsSelected,
              badge: snapshot?.mentionsWaiting ?? 0,
            ),
          if (onNewProject != null ||
              onYourDevices != null ||
              onNotifications != null ||
              controller.isOwner ||
              snapshot?.localModels?.enabled == true)
            const SizedBox(height: 20),
          // Every person in the Swarm reads where the Product Managers talk.
          if (snapshot?.conversation(snapshot.leadsConversationId ?? '')
              case final leads?) ...[
            _row(leads, label: 'Product Managers', icon: AppIcons.users),
            const SizedBox(height: 16),
          ],
          SuperTabSectionHeading(
            'Projects',
            onAdd: controller.canWrite ? onNewProject : null,
            addTooltip: 'New project',
            endInset: 0,
            collapsed: !controller.projectsGroupOpen,
            onToggleCollapsed: controller.toggleProjectsGroup,
          ),
          if (controller.projectsGroupOpen)
            for (final project
                in snapshot?.projects ?? const <SuperTabProject>[])
              if (snapshot?.conversation(project.leadConversationId)
                  case final lead?)
                Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _row(lead, project: project),
                    if (controller.expandedProjects.contains(project.id)) ...[
                      ..._workgroups(project),
                      ..._closed(project),
                    ],
                  ],
                ),
          const SizedBox(height: 16),
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
