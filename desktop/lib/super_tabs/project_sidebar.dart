import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
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
    this.onYourDevices,
  });
  final SuperTabController controller;
  final ValueChanged<String> onSelect;
  final int Function(SuperTabConversation group) needsHuman;
  final VoidCallback? onNewProject;
  final VoidCallback? onYourDevices;

  // Actions, project names and workgroup names share one text column.
  static const _iconColumn = 32.0;
  static const _textGap = 4.0;

  Widget _row(SuperTabConversation group, {SuperTabProject? project}) {
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
                        padding: const EdgeInsets.fromLTRB(_textGap, 8, 12, 8),
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
            ],
          ),
        ),
      ),
    );
  }

  Widget _action({
    required String key,
    required IconData icon,
    required String label,
    required VoidCallback? onPressed,
  }) => TextButton(
    key: ValueKey(key),
    onPressed: onPressed,
    style:
        TextButton.styleFrom(
          foregroundColor: DesktopChrome.foreground,
          backgroundColor: Colors.transparent,
          disabledBackgroundColor: Colors.transparent,
          minimumSize: const Size(0, 36),
          padding: const EdgeInsets.symmetric(vertical: 8),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          alignment: Alignment.centerLeft,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          ),
          textStyle: DesktopChrome.control(),
        ).copyWith(
          side: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.focused)
                ? BorderSide(color: DesktopChrome.accent, width: 1.5)
                : BorderSide.none,
          ),
        ),
    child: Row(
      children: [
        SizedBox(
          width: _iconColumn,
          child: Icon(icon, size: AppIcons.inlineSize),
        ),
        const SizedBox(width: _textGap),
        Expanded(child: Text(label)),
        const SizedBox(width: 12),
      ],
    ),
  );

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
              padding: const EdgeInsets.fromLTRB(
                _iconColumn + _textGap,
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
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
            child: Column(
              children: [
                _action(
                  key: 'super-new-project',
                  icon: AppIcons.plus,
                  label: 'New project',
                  onPressed: controller.canWrite ? onNewProject : null,
                ),
                const SizedBox(height: 2),
                _action(
                  key: 'super-your-devices',
                  icon: AppIcons.circle,
                  label: 'Your devices',
                  onPressed: onYourDevices,
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.all(8),
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
                          ..._workgroups(project),
                      ],
                    ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
