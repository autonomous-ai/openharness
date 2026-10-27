import 'package:flutter/material.dart';

import '../../widgets/desktop_chrome.dart';
import 'format.dart';
import 'model.dart';

/// The shared reward on one line at the top of Humans: what shipped in the
/// week shown, everyone's points together and the project's open requests.
/// The week before and the median time to ship are on hover.
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
    final line =
        'Team goal: ${now.shipped} shipped · ${now.points} pts · ${goal.openRequests} open';
    final median = _median(now.medianAskToShipMs, before.medianAskToShipMs);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
      child: Tooltip(
        message: [
          line,
          '${before.shipped} shipped $earlier',
          ?median,
        ].join('\n'),
        child: Text(
          line,
          key: const ValueKey('leaderboard-goal'),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: DesktopChrome.metadata(),
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
