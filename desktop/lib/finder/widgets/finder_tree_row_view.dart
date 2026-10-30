import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/file_type_icon.dart';
import '../../theme/app_theme.dart';
import '../finder_git_state.dart';
import '../finder_load.dart';
import '../finder_tree.dart';
import 'finder_context_menu.dart';
import 'finder_row.dart';
import 'git_change_mark.dart';

/// One entry of the tree: its name in Git's colour (a folder in its most
/// pressing child's), faint when Git ignores it, its status letter, and the
/// right-click menu.
class FinderTreeRowView extends StatelessWidget {
  const FinderTreeRowView({
    super.key,
    required this.row,
    required this.git,
    required this.selected,
    required this.menu,
    required this.onTap,
  });

  final FinderTreeRow row;
  final FinderGitState git;
  final bool selected;
  final List<Widget> Function() menu;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final entry = row.entry;
    final status = entry.isDirectory
        ? git.folderStatus(entry.path)
        : git.fileStatus(entry.path);
    return FinderContextMenu(
      items: menu,
      child: FinderRow(
        indent: row.depth,
        icon: entry.isDirectory
            ? row.expanded
                  ? AppIcons.folderOpen
                  : AppIcons.folder
            : fileTypeIcon(entry.name),
        label: entry.name,
        labelColor: status == null ? null : gitChangeStyle(status).color,
        faint: git.isIgnored(entry.path),
        selected: selected,
        leading: entry.isDirectory
            ? Icon(
                row.expanded ? AppIcons.chevronDown : AppIcons.chevronRight,
                size: 12,
                color: AppColors.muted,
              )
            : null,
        trailing: switch (row.listing) {
          FinderFailed(:final message) => Tooltip(
            message: message,
            child: Icon(
              AppIcons.circleAlert,
              size: 12,
              color: AppColors.danger,
            ),
          ),
          _ when !entry.isDirectory && status != null => GitChangeMark(status),
          _ => null,
        },
        onTap: onTap,
      ),
    );
  }
}
