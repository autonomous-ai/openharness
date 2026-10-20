import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../theme/app_theme.dart';
import '../finder_controller.dart';
import '../finder_files.dart';
import '../finder_git.dart';
import '../local_finder_files.dart';
import '../local_finder_git.dart';
import 'finder_editor_area.dart';
import 'finder_header.dart';
import 'finder_sidebar.dart';
import 'finder_tab_close.dart';

/// A Finder tile: a folder's files and Git changes on the left, its open
/// files and diffs in tabs on the right — Orca's explorer, source control
/// and editor, in one pane.
///
/// It owns its [FinderController] for the tile's life; the grid keys cells by
/// a GlobalKey, so moving the tile keeps its tabs and edits.
class FinderPanePanel extends StatefulWidget {
  const FinderPanePanel({
    super.key,
    required this.root,
    this.files = const LocalFinderFiles(),
    this.git = const LocalFinderGit(),
    this.onClose,
    this.onGuardClose,
    this.compactHeader = false,
  });

  final String root;
  final FinderFiles files;
  final FinderGit git;
  final VoidCallback? onClose;

  /// Handed the check the pane's close must pass while this panel is
  /// mounted — unsaved tabs are asked about first — and null when it goes.
  final void Function(Future<bool> Function()? guard)? onGuardClose;
  final bool compactHeader;

  @override
  State<FinderPanePanel> createState() => _FinderPanePanelState();
}

class _FinderPanePanelState extends State<FinderPanePanel> {
  late final FinderController _controller = FinderController(
    root: widget.root,
    files: widget.files,
    git: widget.git,
  );
  double _sidebar = 260;

  @override
  void initState() {
    super.initState();
    _controller.start();
    widget.onGuardClose?.call(() => closeAllFinderTabs(context, _controller));
  }

  @override
  void dispose() {
    widget.onGuardClose?.call(null);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ColoredBox(
      color: grid.AppPalette.windowBg,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ListenableBuilder(
            listenable: _controller.git,
            builder: (context, _) => FinderHeader(
              controller: _controller,
              compact: widget.compactHeader,
              onClose: widget.onClose,
            ),
          ),
          Divider(height: 1, color: AppColors.border),
          Expanded(child: _body()),
        ],
      ),
    );
  }

  Widget _body() => LayoutBuilder(
    builder: (context, constraints) {
      final width = _sidebar.clamp(160.0, constraints.maxWidth * .6);
      return Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: width,
            child: ListenableBuilder(
              listenable: Listenable.merge([_controller, _controller.git]),
              builder: (context, _) => FinderSidebar(controller: _controller),
            ),
          ),
          _Splitter(onDrag: (dx) => setState(() => _sidebar = width + dx)),
          Expanded(child: FinderEditorArea(controller: _controller)),
        ],
      );
    },
  );
}

/// The line between the sidebar and the tabs, dragged to resize them.
class _Splitter extends StatelessWidget {
  const _Splitter({required this.onDrag});

  final ValueChanged<double> onDrag;

  @override
  Widget build(BuildContext context) => MouseRegion(
    cursor: SystemMouseCursors.resizeColumn,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onHorizontalDragUpdate: (details) => onDrag(details.delta.dx),
      child: SizedBox(
        width: 5,
        child: Center(
          child: VerticalDivider(width: 1, color: AppColors.border),
        ),
      ),
    ),
  );
}
