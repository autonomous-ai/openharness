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
import 'finder_rail.dart';
import 'finder_sidebar.dart';
import 'finder_tab_close.dart';

/// A Finder tile: a folder's files and Git changes on the left, its open
/// files and diffs in tabs on the right — Orca's explorer, source control
/// and editor, in one pane.
///
/// With no file open it is only as wide as its file list, and folded it is a
/// rail ([FinderRail]): it asks the grid for that width ([onFixedWidth]), so
/// the chat beside it gets the room the empty editor would have taken.
///
/// It owns its [FinderController] for the tile's life; the grid keys cells by
/// a GlobalKey, so moving the tile keeps its tabs and edits.
class FinderPanePanel extends StatefulWidget {
  const FinderPanePanel({
    super.key,
    required this.root,
    this.files = const LocalFinderFiles(),
    this.git = const LocalFinderGit(),
    this.onGuardClose,
    this.compactHeader = false,
    this.onFixedWidth,
  });

  final String root;
  final FinderFiles files;
  final FinderGit git;

  /// Handed the check the pane's close must pass while this panel is
  /// mounted — unsaved tabs are asked about first — and null when it goes.
  final void Function(Future<bool> Function()? guard)? onGuardClose;
  final bool compactHeader;

  /// Told the width in pixels the tile wants while it shows no editor, and
  /// null when it takes its share of the tab again.
  final ValueChanged<double?>? onFixedWidth;

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
  bool _collapsed = false;
  bool _editing = false;
  double? _reported;

  double get _headerHeight => widget.compactHeader ? 38 : 46;

  /// Folded, the rail; with no file open, the file list and its splitter;
  /// otherwise its share of the tab.
  double? get _fixedWidth => _collapsed
      ? kFinderRailWidth
      : _editing
      ? null
      : _sidebar + _Splitter.width;

  @override
  void initState() {
    super.initState();
    _controller.start();
    _controller.tabs.addListener(_onTabs);
    widget.onGuardClose?.call(() => closeAllFinderTabs(context, _controller));
    WidgetsBinding.instance.addPostFrameCallback((_) => _report());
  }

  @override
  void dispose() {
    _controller.tabs.removeListener(_onTabs);
    widget.onGuardClose?.call(null);
    _controller.dispose();
    super.dispose();
  }

  void _onTabs() {
    final editing = _controller.tabs.tabs.isNotEmpty;
    if (editing == _editing) return;
    // Opening a file unfolds a folded Finder: it is where the file shows.
    setState(() {
      _editing = editing;
      if (editing) _collapsed = false;
    });
    _report();
  }

  void _setCollapsed(bool collapsed) {
    setState(() => _collapsed = collapsed);
    _report();
  }

  void _report() {
    final width = _fixedWidth;
    if (!mounted || width == _reported) return;
    _reported = width;
    widget.onFixedWidth?.call(width);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    if (_collapsed) {
      return FinderRail(
        controller: _controller,
        headerHeight: _headerHeight,
        onExpand: () => _setCollapsed(false),
      );
    }
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
              onCollapse: () => _setCollapsed(true),
            ),
          ),
          Divider(height: 1, color: AppColors.border),
          Expanded(child: _editing ? _body() : _filesOnly()),
        ],
      ),
    );
  }

  Widget _sidebarList() => ListenableBuilder(
    listenable: Listenable.merge([_controller, _controller.git]),
    builder: (context, _) => FinderSidebar(controller: _controller),
  );

  /// No file open: the file list is the whole tile, and its edge sets how
  /// wide the tile asks to be.
  Widget _filesOnly() => Row(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Expanded(child: _sidebarList()),
      _Splitter(
        onDrag: (dx) {
          setState(() => _sidebar = (_sidebar + dx).clamp(160.0, 640.0));
          _report();
        },
      ),
    ],
  );

  Widget _body() => LayoutBuilder(
    builder: (context, constraints) {
      final width = _sidebar.clamp(160.0, constraints.maxWidth * .6);
      return Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(width: width, child: _sidebarList()),
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

  static const width = 5.0;

  final ValueChanged<double> onDrag;

  @override
  Widget build(BuildContext context) => MouseRegion(
    cursor: SystemMouseCursors.resizeColumn,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onHorizontalDragUpdate: (details) => onDrag(details.delta.dx),
      child: SizedBox(
        width: width,
        child: Center(
          child: VerticalDivider(width: 1, color: AppColors.border),
        ),
      ),
    ),
  );
}
