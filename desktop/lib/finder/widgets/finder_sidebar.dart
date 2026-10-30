import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_icon_button.dart';
import '../../theme/app_theme.dart';
import '../finder_controller.dart';
import 'finder_changes_view.dart';
import 'finder_tree_view.dart';

/// The tile's left column: Files or Changes — Orca's Explorer and Source
/// Control, side by side in one switch — with the list for the one chosen.
class FinderSidebar extends StatefulWidget {
  const FinderSidebar({super.key, required this.controller});

  final FinderController controller;

  @override
  State<FinderSidebar> createState() => _FinderSidebarState();
}

class _FinderSidebarState extends State<FinderSidebar> {
  final _tree = GlobalKey<FinderTreeViewState>();

  FinderController get _controller => widget.controller;

  /// Where New File and New Folder make things: the folder on the keyboard's
  /// row, the folder of the file there, or the top.
  String get _targetFolder {
    final at = _tree.currentState?.cursor ?? _controller.activePath;
    if (at == null) return _controller.root;
    final folder = _controller.tree.rows.any(
      (row) => row.entry.path == at && row.entry.isDirectory,
    );
    return folder ? at : p.dirname(at);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final files = _controller.mode == FinderMode.files;
    final count = _controller.git.repository?.changes.length ?? 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.all(6),
          child: Row(
            children: [
              Expanded(
                child: _ModeTab(
                  key: const ValueKey('finder-mode-files'),
                  label: 'Files',
                  selected: files,
                  onTap: () => _controller.setMode(FinderMode.files),
                ),
              ),
              Expanded(
                child: _ModeTab(
                  key: const ValueKey('finder-mode-changes'),
                  label: count == 0 ? 'Changes' : 'Changes  $count',
                  selected: !files,
                  onTap: () => _controller.setMode(FinderMode.changes),
                ),
              ),
            ],
          ),
        ),
        if (files) _toolbar(),
        Divider(height: 1, color: AppColors.border),
        Expanded(
          child: files
              ? FinderTreeView(key: _tree, controller: _controller)
              : FinderChangesView(controller: _controller),
        ),
        if (_controller.notice case final notice?)
          Container(
            key: const ValueKey('finder-notice'),
            color: AppColors.danger.withValues(alpha: .12),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: Text(
              notice,
              style: grid.AppType.caption(color: AppColors.text),
            ),
          ),
      ],
    );
  }

  /// The Files toolbar, on its own row as Orca's Explorer has it: the
  /// folder's name, and New File, New Folder and Collapse All.
  Widget _toolbar() => Padding(
    padding: const EdgeInsets.only(left: 12, right: 4),
    child: Row(
      children: [
        Expanded(
          child: Text(
            p.basename(_controller.root).toUpperCase(),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: grid.AppType.caption(
              color: AppColors.muted,
              fontWeight: FontWeight.w600,
              letterSpacing: .6,
            ),
          ),
        ),
        AppIconButton(
          key: const ValueKey('finder-new-file'),
          icon: AppIcons.filePlus,
          tooltip: 'New File',
          onPressed: () =>
              _tree.currentState?.startCreate(_targetFolder, asFolder: false),
        ),
        AppIconButton(
          icon: AppIcons.folderPlus,
          tooltip: 'New Folder',
          onPressed: () =>
              _tree.currentState?.startCreate(_targetFolder, asFolder: true),
        ),
        AppIconButton(
          icon: AppIcons.chevronsDownUp,
          tooltip: 'Collapse All',
          onPressed: _controller.tree.collapseAll,
        ),
      ],
    ),
  );
}

class _ModeTab extends StatelessWidget {
  const _ModeTab({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    selected: selected,
    button: true,
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      hoverColor: AppColors.rowHover,
      child: Container(
        height: 26,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: selected ? AppColors.selected : null,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text(
          label,
          style: grid.AppType.label(
            color: selected ? AppColors.text : AppColors.mutedStrong,
            fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
          ),
        ),
      ),
    ),
  );
}
