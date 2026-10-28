import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../widgets/desktop_chrome.dart';
import 'format.dart';
import 'model.dart';

/// The shared reward at the top of Humans: a small "🚀 N shipped" chip for
/// the week shown (Dee, 2026-10-28: no open count). The week before and the
/// median time to ship are on hover.
class LeaderboardGoalLine extends StatelessWidget {
  const LeaderboardGoalLine({
    super.key,
    required this.goal,
    required this.weekName,
  });
  final SuperTabTeamGoal goal;

  /// "this week", "last week", …: the week the board shows.
  final String weekName;

  @override
  Widget build(BuildContext context) {
    final now = goal.thisWeek, before = goal.lastWeek;
    final earlier = weekName == 'this week' ? 'last week' : 'the week before';
    final median = _median(now.medianAskToShipMs, before.medianAskToShipMs);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Tooltip(
          message: ['${before.shipped} shipped $earlier', ?median].join('\n'),
          child: Container(
            key: const ValueKey('leaderboard-goal'),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              color: grid.AppSurface.hoverFill,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              '🚀 ${now.shipped} shipped $weekName',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.metadata(color: DesktopChrome.foreground),
            ),
          ),
        ),
      ),
    );
  }

  static String? _median(int? now, int? before) {
    if (now == null) return null;
    final text = 'Median ask to ship ${leaderboardDuration(now)}';
    if (before == null) return text;
    if (leaderboardDuration(now) == leaderboardDuration(before)) {
      return '$text, as before';
    }
    return '$text, ${now < before ? 'down' : 'up'} from ${leaderboardDuration(before)}';
  }
}
