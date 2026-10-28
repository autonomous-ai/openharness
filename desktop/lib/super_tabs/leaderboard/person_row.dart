import 'package:clock/clock.dart';
import 'package:flutter/material.dart';

import '../../widgets/desktop_chrome.dart';
import '../../widgets/finger_target.dart';
import '../identity.dart';
import '../model.dart';
import '../until.dart';
import 'format.dart';
import 'model.dart';

/// Where the name and the quiet line start: after the avatar (24) and its gap (8).
const _nameInset = 32.0;

/// Figures of one width, so the numbers of one column line up row under row.
TextStyle _figures(TextStyle style) =>
    style.copyWith(fontFeatures: const [FontFeature.tabularFigures()]);

/// One person in the Humans section: avatar, name, status and this week's
/// points in fixed columns, with Shipped, Unblocked and Lent on a quiet line
/// beneath. Without a [score] (no board yet, or a server without one) only the
/// name and status.
class LeaderboardPersonRow extends StatelessWidget {
  const LeaderboardPersonRow({
    super.key,
    required this.person,
    required this.score,
    required this.onTap,
  });
  final SuperTabPerson person;
  final SuperTabPersonScore? score;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context);
    final score = this.score;
    final quiet = _figures(DesktopChrome.metadata());
    Widget cell(double width, String text) => SizedBox(
      width: scale.scale(width),
      child: Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: quiet,
      ),
    );
    return InkWell(
      key: ValueKey('super-person-${person.id}'),
      onTap: onTap,
      child: ConstrainedBox(
        // A phone's row is a finger's height; a mouse keeps 36.
        constraints: BoxConstraints(
          minHeight: fingerHeight(36, enabled: workspaceIsCompact(context)),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  SuperTabAvatar.person(person, size: 24),
                  const SizedBox(width: _nameInset - 24),
                  Expanded(
                    child: Tooltip(
                      message: person.email,
                      child: SuperTabUntil(
                        until: person.status?.until,
                        builder: (context) => Text.rich(
                          TextSpan(
                            text: superTabPersonName(person.email),
                            children: [
                              if (person.statusAt(clock.now())
                                  case final status?)
                                TextSpan(
                                  text: '  ${status.text}',
                                  style: DesktopChrome.metadata(),
                                ),
                            ],
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.control(),
                        ),
                      ),
                    ),
                  ),
                  if (score != null)
                    SizedBox(
                      width: scale.scale(64),
                      child: Text(
                        '${score.points} pts',
                        maxLines: 1,
                        textAlign: TextAlign.right,
                        style: _figures(DesktopChrome.control(medium: true)),
                      ),
                    ),
                ],
              ),
              if (score != null)
                Padding(
                  padding: const EdgeInsets.only(left: _nameInset, top: 2),
                  child: Row(
                    children: [
                      cell(72, '${score.shipped} shipped'),
                      cell(88, '${score.unblocked} unblocked'),
                      Expanded(
                        child: Text(
                          '${leaderboardHours(score.lentMs)} h lent',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: quiet,
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A person's week, shown when their name is tapped: the medians, the time
/// freed and lent, and their shipping streak.
class LeaderboardPersonWeek extends StatelessWidget {
  const LeaderboardPersonWeek({super.key, required this.score});
  final SuperTabPersonScore score;

  @override
  Widget build(BuildContext context) {
    String median(int? ms, String what) =>
        ms == null ? '' : ' · median ${leaderboardDuration(ms)}$what';
    final rows = [
      (
        'Points',
        score.medal == null
            ? '${score.points} this week'
            : '${score.points} this week · place ${score.rank}',
      ),
      (
        'Shipped',
        score.shipped == 0
            ? 'Nothing landed yet'
            : '${plural(score.shipped, 'ask')} landed${median(score.medianAskToShipMs, ' to ship')}',
      ),
      (
        'Unblocked',
        score.unblocked == 0
            ? 'Nothing answered yet'
            : '${score.unblocked} answered${median(score.medianAnswerMs, '')} · ${leaderboardDuration(score.unblockedMs)} of agent time freed',
      ),
      (
        'Lent',
        score.lentMachines == 0
            ? 'Nothing lent yet'
            : '${plural(score.lentMachines, 'machine')} · ${leaderboardHours(score.lentMs)} agent-hours',
      ),
      (
        'Streak',
        score.streakDays == 0
            ? 'No streak yet'
            : '${plural(score.streakDays, 'day')} shipping',
      ),
    ];
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final (label, value) in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 88,
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
    );
  }
}
