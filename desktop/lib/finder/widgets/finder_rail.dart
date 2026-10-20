import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_pane_icon.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_icon_button.dart';
import '../../theme/app_theme.dart';
import '../../widgets/agent_drag.dart' show PaneHeaderButton;
import '../finder_controller.dart';

/// How wide a folded Finder is: one column of buttons.
const kFinderRailWidth = 44.0;

/// A Finder folded to its edge, as Orca folds a sidebar: Expand, and the
/// Files and Changes lists one click away, each opening the Finder on it.
class FinderRail extends StatelessWidget {
  const FinderRail({
    super.key,
    required this.controller,
    required this.headerHeight,
    required this.onExpand,
  });

  final FinderController controller;
  final double headerHeight;
  final VoidCallback onExpand;

  void _open(FinderMode mode) {
    controller.setMode(mode);
    onExpand();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final mode = controller.mode;
    return ColoredBox(
      key: const ValueKey('finder-rail'),
      color: grid.AppPalette.windowBg,
      child: Column(
        children: [
          SizedBox(
            height: headerHeight,
            child: Center(
              child: PaneHeaderButton(
                key: const ValueKey('finder-expand'),
                label: 'Expand Finder',
                icon: AppPaneSymbol.expandLeft,
                onPressed: onExpand,
              ),
            ),
          ),
          Divider(height: 1, color: AppColors.border),
          const SizedBox(height: 6),
          AppIconButton(
            key: const ValueKey('finder-rail-files'),
            icon: AppIcons.folder,
            tooltip: 'Files',
            selected: mode == FinderMode.files,
            onPressed: () => _open(FinderMode.files),
          ),
          AppIconButton(
            key: const ValueKey('finder-rail-changes'),
            icon: AppIcons.gitBranch,
            tooltip: 'Changes',
            selected: mode == FinderMode.changes,
            onPressed: () => _open(FinderMode.changes),
          ),
        ],
      ),
    );
  }
}
