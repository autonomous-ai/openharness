import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
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

/// A person as the leaderboard names them: the board's display name, else the
/// email's first part, as before the board had names.
String leaderboardName(SuperTabPerson person, SuperTabPersonScore? score) =>
    score?.displayName ?? superTabPersonName(person.email);

/// "Up 6 from last week", "down 7 …"; null when level, or from a server
/// without last week.
String? leaderboardTrend(SuperTabPersonScore score) {
  final before = score.prevWeekPoints;
  if (before == null || before == score.points) return null;
  final change = score.points - before;
  return '${change > 0 ? 'up' : 'down'} ${change.abs()} from last week';
}

/// The cup's colour and name, by place.
(Color, String) _cup(SuperTabMedal medal) => switch (medal) {
  SuperTabMedal.gold => (grid.AppPalette.brandBolt, 'Gold cup: 1st'),
  SuperTabMedal.silver => (
    grid.AppTheme.pick(const Color(0xFF6E7681), const Color(0xFFC0C6CF)),
    'Silver cup: 2nd',
  ),
  SuperTabMedal.bronze => (
    grid.AppTheme.pick(const Color(0xFF8C5A2B), const Color(0xFFD08A4E)),
    'Bronze cup: 3rd',
  ),
};

/// One person in the Humans section: avatar, name, status, their cup and
/// their change against last week, and this week's points in fixed columns,
/// with Shipped, Unblocked and Lent as icons on a quiet line beneath. Without
/// a [score] (no board yet, or a server without one) only the name and status.
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
    Widget cell(double width, String text, String label) => SizedBox(
      width: scale.scale(width),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Tooltip(
          message: label,
          child: Text(
            text,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: quiet,
          ),
        ),
      ),
    );
    final medal = score?.medal;
    final trend = score == null ? null : leaderboardTrend(score);
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
                            text: leaderboardName(person, score),
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
                  if (medal != null) ...[
                    const SizedBox(width: 6),
                    _Cup(personId: person.id, medal: medal),
                  ],
                  if (trend != null && score != null) ...[
                    const SizedBox(width: 6),
                    _Trend(personId: person.id, score: score, trend: trend),
                  ],
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
                      cell(
                        56,
                        '🚀 ${score.shipped}',
                        '${score.shipped} shipped',
                      ),
                      cell(
                        56,
                        '🔓 ${score.unblocked}',
                        '${score.unblocked} unblocked',
                      ),
                      cell(
                        72,
                        '💻 ${leaderboardHours(score.lentMs)} h',
                        '${leaderboardHours(score.lentMs)} agent-hours lent',
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

/// A top-three cup in its place's colour; #1's sparkles once as the board
/// opens, never with Reduce Motion.
class _Cup extends StatelessWidget {
  const _Cup({required this.personId, required this.medal});
  final String personId;
  final SuperTabMedal medal;

  @override
  Widget build(BuildContext context) {
    final (color, name) = _cup(medal);
    final cup = Icon(AppIcons.trophy, size: 14, color: color);
    return Tooltip(
      key: ValueKey('leaderboard-cup-$personId'),
      message: '$name this week',
      excludeFromSemantics: true,
      child: Semantics(
        label: '$name this week',
        child:
            medal == SuperTabMedal.gold &&
                !MediaQuery.disableAnimationsOf(context)
            ? _Sparkle(color: color, child: cup)
            : cup,
      ),
    );
  }
}

/// A light sparkle over [child] that plays once and then is gone.
class _Sparkle extends StatefulWidget {
  const _Sparkle({required this.color, required this.child});
  final Color color;
  final Widget child;

  @override
  State<_Sparkle> createState() => _SparkleState();
}

class _SparkleState extends State<_Sparkle>
    with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..forward();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    child: widget.child,
    builder: (context, child) {
      if (_controller.isCompleted) return child!;
      // Up and back down: a glint, not a blink.
      final t = Curves.easeInOut.transform(_controller.value);
      final glint = 1 - (2 * t - 1).abs();
      return Stack(
        clipBehavior: Clip.none,
        children: [
          child!,
          Positioned(
            right: -7,
            top: -7,
            child: Opacity(
              key: const ValueKey('leaderboard-sparkle'),
              opacity: glint,
              child: Transform.scale(
                scale: .6 + .4 * glint,
                child: Icon(AppIcons.sparkles, size: 11, color: widget.color),
              ),
            ),
          ),
        ],
      );
    },
  );
}

/// An arrow and the change against last week: up in green, down quietly.
class _Trend extends StatelessWidget {
  const _Trend({
    required this.personId,
    required this.score,
    required this.trend,
  });
  final String personId;
  final SuperTabPersonScore score;
  final String trend;

  @override
  Widget build(BuildContext context) {
    final up = score.points > score.prevWeekPoints!;
    final color = up ? grid.AppPalette.online : DesktopChrome.muted;
    return Tooltip(
      key: ValueKey('leaderboard-trend-$personId'),
      message: capitalized(trend),
      excludeFromSemantics: true,
      child: Semantics(
        label: capitalized(trend),
        excludeSemantics: true,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              up ? AppIcons.arrowUp : AppIcons.arrowDown,
              size: 12,
              color: color,
            ),
            Text(
              '${(score.points - score.prevWeekPoints!).abs()}',
              style: _figures(DesktopChrome.metadata(color: color)),
            ),
          ],
        ),
      ),
    );
  }
}

/// A person's week, shown when their name is tapped: what they shipped, what
/// they unblocked and what they lent, item by item. From a server without
/// details, the medians, the time freed and lent, and their shipping streak.
class LeaderboardPersonWeek extends StatelessWidget {
  const LeaderboardPersonWeek({super.key, required this.score});
  final SuperTabPersonScore score;

  @override
  Widget build(BuildContext context) {
    if (score.details case final details?) {
      return _LeaderboardPersonDetails(score: score, details: details);
    }
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

/// The three lists behind a person's numbers, each saying so when empty. A
/// long week scrolls inside the window.
class _LeaderboardPersonDetails extends StatelessWidget {
  const _LeaderboardPersonDetails({required this.score, required this.details});
  final SuperTabPersonScore score;
  final SuperTabPersonDetails details;

  @override
  Widget build(BuildContext context) {
    final trend = leaderboardTrend(score);
    final quiet = DesktopChrome.metadata();
    Widget section(String title, String empty, List<Widget> items) => Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: DesktopChrome.control(
              color: DesktopChrome.foreground,
              medium: true,
            ),
          ),
          const SizedBox(height: 4),
          if (items.isEmpty) Text(empty, style: quiet) else ...items,
        ],
      ),
    );
    Widget item(Widget title, String trailing) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(child: title),
          if (trailing.isNotEmpty) ...[
            const SizedBox(width: 12),
            Text(trailing, style: _figures(quiet)),
          ],
        ],
      ),
    );
    final text = DesktopChrome.control();
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * .5,
      ),
      child: SizedBox(
        width: 380,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                trend == null
                    ? '${score.points} pts'
                    : '${score.points} pts · $trend',
                style: quiet,
              ),
              section('🚀 Shipped', 'No pull requests merged yet', [
                for (final shipped in details.shipped)
                  item(switch (Uri.tryParse(shipped.prUrl ?? '')) {
                    final link? when link.hasScheme => Semantics(
                      link: true,
                      child: InkWell(
                        onTap: () => launchUrl(
                          link,
                          mode: LaunchMode.externalApplication,
                        ),
                        child: Text(
                          shipped.title,
                          style: text.copyWith(color: DesktopChrome.accent),
                        ),
                      ),
                    ),
                    _ => Text(shipped.title, style: text),
                  }, ''),
              ]),
              section('🔓 Unblocked', 'No questions answered yet', [
                for (final unblocked in details.unblocked)
                  item(
                    Text(unblocked.title, style: text),
                    'waited ${leaderboardDuration(unblocked.waitedMinutes * 60000)}',
                  ),
              ]),
              section('💻 Lent', 'No machines lent yet', [
                for (final lent in details.lent)
                  item(
                    Text(superTabMachineName(lent.machineName), style: text),
                    '${leaderboardDuration((lent.busyHours * 3600000).round())} busy',
                  ),
              ]),
            ],
          ),
        ),
      ),
    );
  }
}
