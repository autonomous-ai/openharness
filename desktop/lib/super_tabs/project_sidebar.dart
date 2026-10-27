import 'dart:async';

import 'package:flutter/material.dart';

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

  /// A project row opens the project's chat and shows its workgroups; clicked
  /// again while open, it hides them. It has no chevron (Dee, 2026-10-27).
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
    final style = DesktopChrome.control(
      medium: unread || selected,
      color: selected || unread || project != null || label != null
          ? DesktopChrome.foreground
          : DesktopChrome.muted,
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: selected ? grid.AppSurface.selectedFill : Colors.transparent,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: ValueKey(key ?? 'super-group-${group.id}'),
          onTap: project == null
              ? () => onSelect(group.id)
              : () {
                  if (selected || !expanded) {
                    controller.toggleProject(project.id);
                  }
                  if (!selected) onSelect(group.id);
                },
          hoverColor: grid.AppSurface.hoverFill,
          focusColor: grid.AppSurface.hoverFill,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          child: Row(
            children: [
              SizedBox(width: SuperTabSectionHeading.indentFor(0)),
              SizedBox(
                width: _iconColumn,
                child: project != null || label != null ? _channelMark() : null,
              ),
              Expanded(
                child: Semantics(
                  label: project?.isPrivate == true ? 'Private project' : null,
                  selected: selected,
                  expanded: project == null ? null : expanded,
                  child: Tooltip(
                    message:
                        label ??
                        project?.name ??
                        SuperTabWorkgroupName.plain(group),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 36),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Row(
                          children: [
                            Expanded(
                              child: label == null && project == null
                                  ? SuperTabWorkgroupName(group, style: style)
                                  : Text(
                                      label ?? project!.name,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: style,
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
                    key: ValueKey('super-project-pm-unread-${project!.id}'),
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
