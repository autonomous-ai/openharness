import 'package:flutter/material.dart';

import '../../widgets/desktop_chrome.dart';
import 'format.dart';
import 'model.dart';
import 'progress_bar.dart';

/// The shared reward on top: the project's open requests and this week against
/// the one before. Everyone's points count toward it.
class LeaderboardGoalBar extends StatelessWidget {
  const LeaderboardGoalBar({
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
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: DesktopChrome.field,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        border: Border.all(color: DesktopChrome.rim),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Team goal · ${plural(goal.openRequests, 'open request')}',
            style: DesktopChrome.control(medium: true),
          ),
          const SizedBox(height: 6),
          LeaderboardProgressBar(
            fraction: now.points == 0
                ? 0
                : now.points /
                      (now.points > before.points ? now.points : before.points),
          ),
          const SizedBox(height: 6),
          Text(
            '${now.shipped} shipped $weekName (${before.shipped} $earlier) · ${plural(now.points, 'point')}',
            style: DesktopChrome.metadata(),
          ),
          if (median != null) Text(median, style: DesktopChrome.metadata()),
        ],
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
