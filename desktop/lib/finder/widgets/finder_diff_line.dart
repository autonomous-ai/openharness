import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../theme/app_theme.dart';
import '../finder_diff_rows.dart';
import '../finder_models.dart';
import 'finder_code_theme.dart';

/// Every diff row is this tall, so Previous/Next can scroll to a row by
/// arithmetic.
const kDiffRowHeight = 20.0;

/// One row of a diff: a line (inline), a pair of lines (side by side), or a
/// fold of unchanged lines to open.
class FinderDiffLine extends StatelessWidget {
  const FinderDiffLine({
    super.key,
    required this.row,
    required this.language,
    required this.gutterDigits,
    required this.onUnfold,
  });

  final DiffRow row;
  final String? language;
  final int gutterDigits;
  final ValueChanged<int> onUnfold;

  @override
  Widget build(BuildContext context) => switch (row) {
    DiffSingleRow(:final line) => _Side(
      line: line,
      numbers: [line.oldLine, line.newLine],
      language: language,
      digits: gutterDigits,
    ),
    DiffPairRow(:final left, :final right) => Row(
      children: [
        Expanded(
          child: _Side(
            line: left,
            numbers: [left?.oldLine],
            language: language,
            digits: gutterDigits,
          ),
        ),
        VerticalDivider(width: 1, color: AppColors.border),
        Expanded(
          child: _Side(
            line: right,
            numbers: [right?.newLine],
            language: language,
            digits: gutterDigits,
          ),
        ),
      ],
    ),
    DiffFoldRow(:final key, :final count) => InkWell(
      onTap: () => onUnfold(key),
      child: ColoredBox(
        color: AppColors.accent.withValues(alpha: .07),
        child: Row(
          children: [
            const SizedBox(width: 12),
            Icon(AppIcons.chevronsDownUp, size: 12, color: AppColors.muted),
            const SizedBox(width: 8),
            Text(
              count == 1 ? '1 unchanged line' : '$count unchanged lines',
              style: grid.AppType.caption(color: AppColors.muted),
            ),
          ],
        ),
      ),
    ),
  };
}

/// One side of a row: its number(s), and the line coloured for its language
/// on the wash of its change. A missing side is a blank, hatched quietly.
class _Side extends StatelessWidget {
  const _Side({
    required this.line,
    required this.numbers,
    required this.language,
    required this.digits,
  });

  final DiffLine? line;
  final List<int?> numbers;
  final String? language;
  final int digits;

  @override
  Widget build(BuildContext context) {
    final brightness = grid.AppTheme.watch(context);
    final line = this.line;
    final base = grid.AppType.mono(color: AppColors.text, height: 1.2);
    final gutter = grid.AppType.mono(color: AppColors.muted, height: 1.2);
    return ColoredBox(
      color: switch (line?.kind) {
        null => AppColors.border.withValues(alpha: .25),
        DiffLineKind.added => AppColors.success.withValues(alpha: .16),
        DiffLineKind.removed => AppColors.danger.withValues(alpha: .16),
        _ => Colors.transparent,
      },
      child: Row(
        children: [
          for (final number in numbers)
            SizedBox(
              width: digits * 8.0 + 14,
              child: Text(
                number?.toString() ?? '',
                textAlign: TextAlign.right,
                style: gutter,
              ),
            ),
          SizedBox(
            width: 18,
            child: Text(
              switch (line?.kind) {
                DiffLineKind.added => '+',
                DiffLineKind.removed => '−',
                _ => '',
              },
              textAlign: TextAlign.center,
              style: gutter,
            ),
          ),
          if (line != null)
            Expanded(
              child: Text.rich(
                line.kind == DiffLineKind.meta
                    ? TextSpan(text: line.text, style: gutter)
                    : highlightLine(line.text, language, base, brightness),
                maxLines: 1,
                softWrap: false,
                overflow: TextOverflow.clip,
              ),
            ),
        ],
      ),
    );
  }
}
