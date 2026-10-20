import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'model.dart';

class ProjectSidebar extends StatelessWidget {
  const ProjectSidebar({
    super.key,
    required this.controller,
    required this.onSelect,
    required this.needsHuman,
    this.onNewProject,
  });
  final SuperTabController controller;
  final ValueChanged<String> onSelect;
  final int Function(SuperTabConversation group) needsHuman;
  final VoidCallback? onNewProject;

  Widget _row(SuperTabConversation group, {SuperTabProject? project}) {
    final selected = controller.selectedId == group.id;
    final groups = project == null
        ? [group]
        : controller.snapshot!.conversations.where(
            (g) => g.projectId == project.id && !g.archived,
          );
    final waiting = groups.any((g) => needsHuman(g) > 0);
    final unread = groups.any(controller.unread);
    return Semantics(
      selected: selected,
      child: ListTile(
        key: ValueKey('super-group-${group.id}'),
        dense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 10),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        ),
        selected: selected,
        selectedTileColor: DesktopChrome.activeSelection,
        title: Row(
          children: [
            if (project?.isPrivate == true) ...[
              Icon(
                AppIcons.lock,
                size: 14,
                color: selected
                    ? DesktopChrome.onSelection
                    : DesktopChrome.muted,
              ),
              const SizedBox(width: 6),
            ],
            Expanded(
              child: Text(
                project?.name ?? group.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.control(
                  medium: project != null || unread,
                  color: selected ? DesktopChrome.onSelection : null,
                ),
              ),
            ),
          ],
        ),
        trailing: waiting
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
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: selected
                        ? DesktopChrome.onSelection
                        : DesktopChrome.accent,
                  ),
                ),
              )
            : null,
        onTap: () => onSelect(group.id),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = controller.snapshot;
    return Material(
      color: DesktopChrome.surface,
      child: Column(
        children: [
          Expanded(
            child: ListView(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
              children: [
                for (final project
                    in snapshot?.projects ?? const <SuperTabProject>[])
                  if (snapshot?.conversation(project.leadConversationId)
                      case final lead?)
                    Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Row(
                          children: [
                            AppIconButton(
                              key: ValueKey(
                                'super-project-expand-${project.id}',
                              ),
                              icon:
                                  controller.expandedProjects.contains(
                                    project.id,
                                  )
                                  ? AppIcons.chevronDown
                                  : AppIcons.chevronRight,
                              tooltip:
                                  '${controller.expandedProjects.contains(project.id) ? 'Collapse' : 'Expand'} ${project.name}',
                              onPressed: () =>
                                  controller.toggleProject(project.id),
                            ),
                            Expanded(child: _row(lead, project: project)),
                          ],
                        ),
                        if (controller.expandedProjects.contains(project.id))
                          for (final group in snapshot!.conversations)
                            if (group.projectId == project.id &&
                                group.id != project.leadConversationId &&
                                !group.archived)
                              Padding(
                                padding: const EdgeInsets.only(
                                  left: 32,
                                  bottom: 2,
                                ),
                                child: _row(group),
                              ),
                      ],
                    ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
            child: Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                key: const ValueKey('super-new-project'),
                onPressed: controller.canWrite ? onNewProject : null,
                icon: const Icon(AppIcons.plus, size: 16),
                label: const Text('Project'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
