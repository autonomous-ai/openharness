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
    final expanded = controller.expandedProjects.contains(project?.id);
    final hasChildren =
        project != null &&
        groups.any((g) => g.id != project.leadConversationId);
    return Padding(
      padding: EdgeInsets.only(left: project == null ? 40 : 0, bottom: 2),
      child: Material(
        color: selected ? grid.AppSurface.selectedFill : Colors.transparent,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        clipBehavior: Clip.antiAlias,
        child: Row(
          children: [
            if (project != null && hasChildren)
              AppIconButton(
                key: ValueKey('super-project-expand-${project.id}'),
                icon: expanded ? AppIcons.chevronDown : AppIcons.chevronRight,
                tooltip: '${expanded ? 'Collapse' : 'Expand'} ${project.name}',
                onPressed: () => controller.toggleProject(project.id),
              )
            else if (project != null)
              const SizedBox(width: 32),
            Expanded(
              child: Semantics(
                label: project?.isPrivate == true ? 'Private project' : null,
                selected: selected,
                child: Tooltip(
                  message: project?.name ?? group.label,
                  child: InkWell(
                    key: ValueKey('super-group-${group.id}'),
                    onTap: () => onSelect(group.id),
                    hoverColor: grid.AppSurface.hoverFill,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 36),
                      child: Padding(
                        padding: EdgeInsets.fromLTRB(
                          project == null ? 12 : 4,
                          8,
                          12,
                          8,
                        ),
                        child: Row(
                          children: [
                            if (project?.isPrivate == true) ...[
                              Icon(
                                AppIcons.lock,
                                size: 14,
                                color: DesktopChrome.muted,
                              ),
                              const SizedBox(width: 6),
                            ],
                            Expanded(
                              child: Text(
                                project?.name ?? group.label,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: DesktopChrome.control(
                                  medium: project != null || unread || selected,
                                  color: selected || unread || project != null
                                      ? DesktopChrome.foreground
                                      : DesktopChrome.muted,
                                ),
                              ),
                            ),
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
                                  width: 6,
                                  height: 6,
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
            ),
          ],
        ),
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
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 12),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'Projects',
                style: DesktopChrome.metadata().copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              children: [
                for (final project
                    in snapshot?.projects ?? const <SuperTabProject>[])
                  if (snapshot?.conversation(project.leadConversationId)
                      case final lead?)
                    Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _row(lead, project: project),
                        if (controller.expandedProjects.contains(project.id))
                          for (final group in snapshot!.conversations)
                            if (group.projectId == project.id &&
                                group.id != project.leadConversationId &&
                                !group.archived)
                              _row(group),
                      ],
                    ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 16),
            child: TextButton(
              key: const ValueKey('super-new-project'),
              onPressed: controller.canWrite ? onNewProject : null,
              style: TextButton.styleFrom(
                foregroundColor: DesktopChrome.muted,
                backgroundColor: Colors.transparent,
                disabledBackgroundColor: Colors.transparent,
                alignment: Alignment.centerLeft,
                side: BorderSide.none,
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                ),
                textStyle: DesktopChrome.control(),
              ),
              child: const Row(
                children: [
                  Icon(AppIcons.plus, size: 16),
                  SizedBox(width: 8),
                  Flexible(child: Text('New project')),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
