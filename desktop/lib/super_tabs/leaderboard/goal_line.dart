import 'package:flutter/material.dart';

import '../../widgets/desktop_chrome.dart';
import 'format.dart';
import 'model.dart';

/// The team's total at the top of Humans, as quiet text: "N shipped this
/// week" for the week shown (Dee, 2026-10-28: no open count). The week before
/// and the median time to ship are on hover.
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
      key: const ValueKey('leaderboard-goal'),
      padding: const EdgeInsets.fromLTRB(
        DesktopChrome.groupGap,
        0,
        DesktopChrome.groupGap,
        DesktopChrome.controlGap / 2,
      ),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Tooltip(
          message: ['${before.shipped} shipped $earlier', ?median].join('\n'),
          child: Text(
            '${now.shipped} shipped $weekName',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.metadata(),
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
