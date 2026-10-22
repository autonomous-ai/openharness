import 'package:flutter/material.dart';

import '../core/machine_resources.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../state/app_state.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'machines.dart';
import 'model.dart';
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

  /// Forwarded to the embedded [SuperTabMachines]; a test gives it to have
  /// the Machines group's readings taken without a real machine.
  @visibleForTesting
  final Future<MachineResources?> Function(String machineId)? readLocal;

  /// Forwarded to the embedded [SuperTabMachines]; a test gives it to pin
  /// the clock its readings' ages are counted against.
  @visibleForTesting
  final DateTime Function() now;

  /// A row's chevron (or the room for one), at its level's indent; its name starts right after.
  static const _iconColumn = SuperTabSectionHeading.actionWidth;
  static const _dotSize = 6.0;

  /// The space after a row's trailing unread dot: it centers the dot on the
  /// headings' + ([SuperTabSectionHeading.endInset] 0), whatever the width.
  static const markerInset =
      SuperTabSectionHeading.actionWidth / 2 - _dotSize / 2;

  /// A project's lead row (level 1, under the heading) or a workgroup (level 2, under its project).
  Widget _row(SuperTabConversation group, {SuperTabProject? project}) {
    final level = project == null ? 2 : 1;
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
                  label: project?.isPrivate == true ? 'Private project' : null,
                  selected: selected,
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
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                project?.name ?? group.label,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: DesktopChrome.control(
                                  medium: unread || selected,
                                  color: selected || unread || project != null
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

  List<Widget> _workgroups(SuperTabProject project) {
    final groups = controller.snapshot!.conversations.where(
      (g) =>
          g.projectId == project.id &&
          g.id != project.leadConversationId &&
          !g.archived,
    );
    return groups.isEmpty
        ? [
            Padding(
              padding: EdgeInsets.fromLTRB(
                SuperTabSectionHeading.indentFor(2) + _iconColumn,
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
    return Material(
      color: DesktopChrome.surface,
      child: ListView(
        padding: const EdgeInsets.all(8),
        children: [
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
                    if (controller.expandedProjects.contains(project.id))
                      ..._workgroups(project),
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
                embedded: true,
                collapsed: !controller.machinesGroupOpen,
                onToggleCollapsed: controller.toggleMachinesGroup,
                onYourDevices: onYourDevices,
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
