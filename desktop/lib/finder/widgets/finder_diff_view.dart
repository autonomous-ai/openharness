import 'dart:math';

import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_icon_button.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/skeleton.dart';
import '../../theme/app_theme.dart';
import '../finder_diff_rows.dart';
import '../finder_load.dart';
import '../finder_models.dart';
import 'finder_diff_keys.dart';
import 'finder_diff_line.dart';
import 'finder_surface_bar.dart';

/// A change's diff, as Orca's diff tab shows it: inline or side by side,
/// unchanged runs folded, and Previous/Next change (⇧F7/F7) between edits.
class FinderDiffView extends StatefulWidget {
  const FinderDiffView({
    super.key,
    required this.label,
    required this.diff,
    required this.language,
    required this.sideBySide,
    required this.onToggleSideBySide,
    this.onOpenFile,
  });

  final String label;
  final FinderLoad<List<DiffLine>> diff;
  final String? language;
  final bool sideBySide;
  final VoidCallback onToggleSideBySide;

  /// Opens the file to edit; null for a deleted one.
  final VoidCallback? onOpenFile;

  @override
  State<FinderDiffView> createState() => _FinderDiffViewState();
}

class _FinderDiffViewState extends State<FinderDiffView> {
  final _scroll = ScrollController();
  final _unfolded = <int>{};
  int _change = -1;

  /// Whether the diff has been taken to its first change, as Orca's does
  /// once when it opens.
  bool _revealed = false;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final lines = switch (widget.diff) {
      FinderLoaded(:final value) => value,
      _ => null,
    };
    final rows = lines == null
        ? const <DiffRow>[]
        : widget.sideBySide
        ? sideBySideDiffRows(lines, _unfolded)
        : inlineDiffRows(lines, _unfolded);
    final starts = diffChangeStarts(rows);
    if (!_revealed && starts.isNotEmpty) {
      _revealed = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _go(starts, 1);
      });
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FinderSurfaceBar(
          label: widget.label,
          actions: [
            Text(
              starts.isEmpty ? '' : '${_change + 1} of ${starts.length}',
              style: grid.AppType.caption(color: AppColors.muted),
            ),
            AppIconButton(
              key: const ValueKey('finder-diff-previous'),
              icon: AppIcons.arrowUp,
              tooltip: 'Previous change · ⇧F7',
              onPressed: starts.isEmpty ? null : () => _go(starts, -1),
            ),
            AppIconButton(
              key: const ValueKey('finder-diff-next'),
              icon: AppIcons.arrowDown,
              tooltip: 'Next change · F7',
              onPressed: starts.isEmpty ? null : () => _go(starts, 1),
            ),
            AppIconButton(
              key: const ValueKey('finder-diff-layout'),
              icon: widget.sideBySide ? AppIcons.rows2 : AppIcons.columns2,
              tooltip: widget.sideBySide
                  ? 'Switch to inline diff'
                  : 'Switch to side-by-side diff',
              onPressed: widget.onToggleSideBySide,
            ),
            if (widget.onOpenFile case final open?)
              AppIconButton(
                key: const ValueKey('finder-diff-open-file'),
                icon: AppIcons.pencil,
                tooltip: 'Open file to edit',
                onPressed: open,
              ),
          ],
        ),
        Divider(height: 1, color: AppColors.border),
        Expanded(child: _body(rows)),
      ],
    );
  }

  Widget _body(List<DiffRow> rows) => switch (widget.diff) {
    FinderLoading() => const SkeletonList(
      rows: 10,
      padding: EdgeInsets.all(16),
    ),
    FinderFailed(:final message) => EmptyState(
      icon: AppIcons.circleAlert,
      title: 'Can’t show this change',
      message: message,
      compact: true,
    ),
    FinderLoaded() when rows.isEmpty => const EmptyState(
      icon: AppIcons.fileDiff,
      title: 'No differences to show',
      message: 'Only the file’s mode or name changed.',
      compact: true,
    ),
    FinderLoaded() => FinderDiffKeys(
      onPrevious: () => _go(diffChangeStarts(rows), -1),
      onNext: () => _go(diffChangeStarts(rows), 1),
      child: ListView.builder(
        key: const ValueKey('finder-diff'),
        controller: _scroll,
        itemExtent: kDiffRowHeight,
        padding: const EdgeInsets.symmetric(vertical: 6),
        itemCount: rows.length,
        itemBuilder: (context, index) => FinderDiffLine(
          row: rows[index],
          language: widget.language,
          gutterDigits: _digits(rows),
          onUnfold: (key) => setState(() => _unfolded.add(key)),
        ),
      ),
    ),
  };

  void _go(List<int> starts, int step) {
    if (starts.isEmpty) return;
    setState(() => _change = (_change + step) % starts.length);
    if (_scroll.hasClients) {
      _scroll.animateTo(
        max(0, starts[_change] - 3) * kDiffRowHeight,
        duration: const Duration(milliseconds: 160),
        curve: Curves.easeOut,
      );
    }
  }

  int _digits(List<DiffRow> rows) => switch (widget.diff) {
    FinderLoaded(:final value) =>
      value
          .fold(0, (n, l) => max(n, max(l.oldLine ?? 0, l.newLine ?? 0)))
          .toString()
          .length,
    _ => 1,
  };
}
