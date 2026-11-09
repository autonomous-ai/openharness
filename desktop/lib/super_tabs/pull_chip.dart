import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/swarm_layout.dart';
import '../widgets/desktop_chrome.dart';
import 'github_pulls.dart';

/// A task's pull request as its number and one word, in the colour of where it stands ([SwarmPullStatus]): on its card
/// beside the task's number, and in its task's panel.
class SwarmPullChip extends StatelessWidget {
  const SwarmPullChip({super.key, required this.pull});

  final SwarmPull pull;

  /// The colour each status is said in: grey while it is not yet for a reader, the accent while it waits for one, red for
  /// what its builder must fix, amber for a HOLD, green for what Harness merges.
  static Color colorOf(BuildContext context, SwarmPullStatus status) =>
      switch (status) {
        SwarmPullStatus.draft || SwarmPullStatus.checks => DesktopChrome.muted,
        SwarmPullStatus.review => grid.AppPalette.accentOnSurface,
        SwarmPullStatus.failing ||
        SwarmPullStatus.conflict => Theme.of(context).colorScheme.error,
        SwarmPullStatus.held => grid.AppPalette.warn,
        SwarmPullStatus.merging => grid.AppPalette.online,
      };

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final color = colorOf(context, pull.status);
    return Semantics(
      label: 'Pull request ${pull.number}, ${pull.status.word}',
      excludeSemantics: true,
      child: Container(
        key: ValueKey('swarm-pull-${pull.number}'),
        padding: SwarmLayout.capsulePadding,
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.14),
          borderRadius: BorderRadius.circular(SwarmLayout.capsuleRadius),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(AppIcons.gitPullRequest, size: 12, color: color),
            const SizedBox(width: 4),
            Flexible(
              child: Text(
                '#${pull.number} ${pull.status.word}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.metadata().copyWith(
                  color: color,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
