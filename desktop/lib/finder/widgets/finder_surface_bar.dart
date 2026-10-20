import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../theme/app_theme.dart';

/// The strip over a tab's content: what it shows, and what can be done to
/// it — a file's path and Preview/Source, a diff's sides and its changes.
class FinderSurfaceBar extends StatelessWidget {
  const FinderSurfaceBar({
    super.key,
    required this.label,
    this.actions = const [],
  });

  final String label;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return SizedBox(
      height: 32,
      child: Padding(
        padding: const EdgeInsets.only(left: 14, right: 6),
        child: Row(
          children: [
            Expanded(
              child: Text(
                label,
                key: const ValueKey('finder-surface-label'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: grid.AppType.monoLabel(color: AppColors.mutedStrong),
              ),
            ),
            ...actions,
          ],
        ),
      ),
    );
  }
}
