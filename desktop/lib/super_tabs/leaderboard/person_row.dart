import 'package:flutter/material.dart';

import '../../widgets/desktop_chrome.dart';
import 'format.dart';
import 'model.dart';
import 'progress_bar.dart';

const _medals = {
  SuperTabMedal.gold: '🏆',
  SuperTabMedal.silver: '🥈',
  SuperTabMedal.bronze: '🥉',
};

/// One person: medal, name, points bar and their three numbers; tapped, their week.
class LeaderboardPersonRow extends StatelessWidget {
  const LeaderboardPersonRow({
    super.key,
    required this.score,
    required this.name,
    required this.topPoints,
    required this.open,
    required this.onTap,
  });
  final SuperTabPersonScore score;
  final String name;
  final int topPoints;
  final bool open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final lent = score.lentMachines == 0
        ? '—'
        : plural(score.lentMachines, 'machine');
    return InkWell(
      key: ValueKey('leaderboard-person-${score.personId}'),
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                SizedBox(width: 24, child: Text(_medals[score.medal] ?? '')),
                Flexible(
                  child: Text(
                    name,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.control(medium: true),
                  ),
                ),
                if (score.streakDays > 1) ...[
                  const SizedBox(width: 6),
                  Text(
                    '🔥 ${score.streakDays}',
                    style: DesktopChrome.metadata(),
                  ),
                ],
                const SizedBox(width: 8),
                Expanded(
                  child: LeaderboardProgressBar(
                    fraction: topPoints == 0 ? 0 : score.points / topPoints,
                  ),
                ),
                const SizedBox(width: 8),
                Text('${score.points} pts', style: DesktopChrome.control()),
              ],
            ),
            Padding(
              padding: const EdgeInsets.only(left: 24, top: 2),
              child: Text(
                '🚀 ${score.shipped} shipped   🔓 ${score.unblocked}   ⚡ $lent',
                style: DesktopChrome.metadata(),
              ),
            ),
            AnimatedSize(
              duration: const Duration(milliseconds: 200),
              curve: Curves.easeOutCubic,
              alignment: Alignment.topCenter,
              child: open
                  ? _Detail(score: score)
                  : const SizedBox(width: double.infinity),
            ),
          ],
        ),
      ),
    );
  }
}

/// A person's week, as the mockup's "Tap a name" card.
class _Detail extends StatelessWidget {
  const _Detail({required this.score});
  final SuperTabPersonScore score;

  @override
  Widget build(BuildContext context) {
    String median(int? ms, String what) =>
        ms == null ? '' : ' · median ${leaderboardDuration(ms)}$what';
    final rows = [
      (
        '🚀 Shipped',
        score.shipped == 0
            ? 'Nothing landed yet'
            : '${plural(score.shipped, 'ask')} landed${median(score.medianAskToShipMs, ' to ship')}',
      ),
      (
        '🔓 Unblocked',
        score.unblocked == 0
            ? 'Nothing answered yet'
            : '${score.unblocked} answered${median(score.medianAnswerMs, '')} · ${leaderboardHours(score.unblockedMs)} agent-hours freed',
      ),
      (
        '⚡ Lent',
        score.lentMachines == 0
            ? 'Nothing lent yet'
            : '${plural(score.lentMachines, 'machine')} · ${leaderboardHours(score.lentMs)} slot-hours',
      ),
      (
        '🔥 Streak',
        score.streakDays == 0
            ? 'No streak yet'
            : '${plural(score.streakDays, 'day')} shipping',
      ),
    ];
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(left: 24, top: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: DesktopChrome.field,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        border: Border.all(color: DesktopChrome.rim),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final (label, value) in rows)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 96,
                    child: Text(
                      label,
                      style: DesktopChrome.metadata(
                        color: DesktopChrome.foreground,
                      ),
                    ),
                  ),
                  Expanded(child: Text(value, style: DesktopChrome.metadata())),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
