import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../theme/app_theme.dart';
import '../finder_models.dart';

/// The letter Git's own short status uses for [kind], and the ink for it —
/// one table, so the tree and the Changes list never disagree.
({String letter, String label, Color color}) gitChangeStyle(
  GitChangeKind kind,
) => switch (kind) {
  GitChangeKind.modified => (
    letter: 'M',
    label: 'Modified',
    color: AppColors.warning,
  ),
  GitChangeKind.added => (
    letter: 'A',
    label: 'Added',
    color: AppColors.success,
  ),
  GitChangeKind.deleted => (
    letter: 'D',
    label: 'Deleted',
    color: AppColors.danger,
  ),
  GitChangeKind.renamed => (
    letter: 'R',
    label: 'Renamed',
    color: AppColors.accent,
  ),
  GitChangeKind.copied => (
    letter: 'C',
    label: 'Copied',
    color: AppColors.accent,
  ),
  GitChangeKind.typeChanged => (
    letter: 'T',
    label: 'Type changed',
    color: AppColors.warning,
  ),
  GitChangeKind.untracked => (
    letter: 'U',
    label: 'Untracked',
    color: AppColors.success,
  ),
  GitChangeKind.conflicted => (
    letter: '!',
    label: 'Conflicted',
    color: AppColors.danger,
  ),
};

/// A change's letter, at the end of a row.
class GitChangeMark extends StatelessWidget {
  const GitChangeMark(this.kind, {super.key});

  final GitChangeKind kind;

  @override
  Widget build(BuildContext context) {
    final style = gitChangeStyle(kind);
    return Tooltip(
      message: style.label,
      waitDuration: const Duration(milliseconds: 500),
      child: Text(
        style.letter,
        style: grid.AppType.monoLabel(
          color: style.color,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

/// The dot a closed folder wears when something inside it changed.
class GitChangeDot extends StatelessWidget {
  const GitChangeDot({super.key});

  @override
  Widget build(BuildContext context) => Container(
    width: 6,
    height: 6,
    decoration: BoxDecoration(color: AppColors.warning, shape: BoxShape.circle),
  );
}
