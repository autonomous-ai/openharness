import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../../theme/app_theme.dart';
import '../finder_controller.dart';
import '../finder_language.dart';
import '../finder_models.dart';
import '../finder_tabs.dart';
import 'finder_diff_view.dart';
import 'finder_file_surface.dart';
import 'finder_tab_bar.dart';
import 'finder_tab_close.dart';

/// The tile's right side: its tabs, and the front one's file or diff.
class FinderEditorArea extends StatelessWidget {
  const FinderEditorArea({super.key, required this.controller});

  final FinderController controller;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    // The controller too: Inline/Side by side is the tile's, not a tab's.
    listenable: Listenable.merge([controller.tabs, controller]),
    builder: (context, _) {
      final active = controller.tabs.active;
      // Shown only while a tab is open (FinderPanePanel); no tab, nothing.
      if (active == null) return const SizedBox.shrink();
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FinderTabBar(
            tabs: controller.tabs,
            onClose: (tab) => closeFinderTab(context, controller, tab),
          ),
          Divider(height: 1, color: AppColors.border),
          Expanded(child: _surface(active)),
        ],
      );
    },
  );

  Widget _surface(FinderTab tab) {
    if (tab.document case final document?) {
      return FinderFileSurface(
        key: ValueKey(tab.id),
        document: document,
        label: p.relative(document.path, from: controller.root),
        onOpenExternally: () => controller.files.open(document.path),
      );
    }
    final diff = tab.diff!;
    final change = diff.change;
    return ListenableBuilder(
      key: ValueKey(tab.id),
      listenable: diff,
      builder: (context, _) => FinderDiffView(
        label: change.originalPath == null
            ? change.path
            : '${change.originalPath} → ${change.path}',
        diff: diff.diff,
        language: finderLanguageOf(change.path),
        sideBySide: controller.sideBySide,
        onToggleSideBySide: controller.toggleSideBySide,
        onOpenFile: change.kind == GitChangeKind.deleted
            ? null
            : () => controller.openFile(diff.path, preview: false),
      ),
    );
  }
}
