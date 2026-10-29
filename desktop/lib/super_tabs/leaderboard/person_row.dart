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

/// The gap between a row's columns, and half of it: the spacing scale's 8
/// and 4.
const _gap = grid.AppDesktop.controlGap;
const _halfGap = _gap / 2;

/// The avatar the Agents rows below draw, so without a rank column a person's
/// name starts where an agent's does.
const _avatarSize = SuperTabAvatar.rowSize;

/// Numbers and rankings (desktop design system): the rank a bold numeral in
/// secondary ink, the points the one emphasized number, every figure in a
/// column of one width so the column holds row under row.
TextStyle _rankStyle() => grid.AppType.label(
  fontWeight: FontWeight.w700,
  color: grid.AppPalette.textSecondary,
  fontFeatures: grid.AppFont.tabularFigures,
);
TextStyle _pointsStyle() => grid.AppType.label(
  fontWeight: grid.AppFont.semibold,
  color: grid.AppPalette.textPrimary,
  fontFeatures: grid.AppFont.tabularFigures,
);

TextStyle _trendStyle(Color color) =>
    DesktopChrome.metadata(color: color)
        .copyWith(fontFeatures: grid.AppFont.tabularFigures);

/// A person as the leaderboard names them: their username, as everywhere in
/// the Swarm (the board's account display name was a long one).
String leaderboardName(SuperTabPerson person, SuperTabPersonScore? score) =>
    person.username;

/// "Up 6 from last week", "down 7 …"; null when level, or from a server
/// without last week.
String? leaderboardTrend(SuperTabPersonScore score) {
  final before = score.prevWeekPoints;
  if (before == null || before == score.points) return null;
  final change = score.points - before;
  return '${change > 0 ? 'up' : 'down'} ${change.abs()} from last week';
}

/// "16 shipped", "1 unblocked", "43 hours lent": each number that would not
/// read zero, in words; empty when all would.
List<String> leaderboardNumbers(SuperTabPersonScore score) {
  final hours = leaderboardHours(score.lentMs);
  return [
    if (score.shipped > 0) '${score.shipped} shipped',
    if (score.unblocked > 0) '${score.unblocked} unblocked',
    if (hours != '0') '${plural(int.parse(hours), 'hour')} lent',
  ];
}

/// The board's fixed numeric columns, each as wide as its widest value at
/// the current text size, so rank, trend and points line up on every row.
class LeaderboardColumns {
  const LeaderboardColumns({
    required this.rank,
    required this.points,
    this.trend,
  });

  factory LeaderboardColumns.of(
    BuildContext context,
    List<SuperTabPersonScore> scores,
  ) {
    final scaler = MediaQuery.textScalerOf(context);
    double width(String text, TextStyle style) {
      final painter = TextPainter(
        text: TextSpan(text: text, style: style),
        textDirection: TextDirection.ltr,
        textScaler: scaler,
      )..layout();
      final width = painter.width;
      painter.dispose();
      return width;
    }

    // Digits are of one width, so the longest number is the widest.
    String widest(Iterable<int> values) => values
        .map((value) => '$value')
        .fold('0', (a, b) => b.length > a.length ? b : a);
    final changes = [
      for (final score in scores)
        if (score.prevWeekPoints case final before? when before != score.points)
          (score.points - before).abs(),
    ];
    return LeaderboardColumns(
      rank: width(widest(scores.map((score) => score.rank)), _rankStyle()),
      points: width(
        widest(scores.map((score) => score.points)),
        _pointsStyle(),
      ),
      trend: changes.isEmpty
          ? null
          : AppIcons.metadataSize +
                width(widest(changes), _trendStyle(DesktopChrome.muted)),
    );
  }

  final double rank, points;

  /// Null when no one on the board moved against last week.
  final double? trend;
}

/// One person in the Humans section: their rank as a bold numeral in its own
/// column, avatar, name and status, and a quiet line of their non-zero
/// numbers beneath; at the right the change against last week, then their
/// points, the one emphasized number. The viewer's own row carries
/// the selected fill. Without a [score] (no board yet, or a server without
/// one) only the name and status.
class LeaderboardPersonRow extends StatelessWidget {
  const LeaderboardPersonRow({
    super.key,
    required this.person,
    required this.score,
    required this.onTap,
    this.columns,
    this.own = false,
  });
  final SuperTabPerson person;
  final SuperTabPersonScore? score;
  final VoidCallback onTap;

  /// The numeric columns, the same on every row; null without a board.
  final LeaderboardColumns? columns;

  /// Whether this is the viewer's own row.
  final bool own;

  @override
  Widget build(BuildContext context) {
    final score = this.score;
    final columns = this.columns;
    final numbers = score == null
        ? const <String>[]
        : leaderboardNumbers(score);
    final trend = score == null ? null : leaderboardTrend(score);
    final radius = BorderRadius.circular(DesktopChrome.rowRadius);
    Widget column(String kind, double width, Widget? child) => Padding(
      padding: const EdgeInsets.only(left: _gap),
      child: SizedBox(
        key: ValueKey('leaderboard-$kind-${person.id}'),
        width: width,
        child: Align(alignment: Alignment.centerRight, child: child),
      ),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: _gap),
      child: Material(
        color: own ? grid.AppSurface.selectedFill : Colors.transparent,
        borderRadius: radius,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: ValueKey('super-person-${person.id}'),
          onTap: onTap,
          // Hover and focus keep their treatment over the viewer's own fill.
          hoverColor: grid.AppSurface.hoverFill,
          focusColor: grid.AppSurface.hoverFill,
          borderRadius: radius,
          child: ConstrainedBox(
            // A phone's row is a finger's height; a mouse keeps a field's.
            constraints: BoxConstraints(
              minHeight: fingerHeight(
                grid.AppControl.heightField,
                enabled: workspaceIsCompact(context),
              ),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: _gap,
                vertical: _halfGap,
              ),
              child: Row(
                children: [
                  if (columns != null) ...[
                    SizedBox(
                      key: ValueKey('leaderboard-rank-${person.id}'),
                      width: columns.rank,
                      child: score == null
                          ? null
                          : Text(
                              '${score.rank}',
                              maxLines: 1,
                              textAlign: TextAlign.right,
                              style: _rankStyle(),
                            ),
                    ),
                    const SizedBox(width: _gap),
                  ],
                  SuperTabAvatar.person(person, size: _avatarSize),
                  const SizedBox(width: _gap),
                  Expanded(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _name(),
                        if (numbers.isNotEmpty)
                          _Numbers(
                            key: ValueKey('leaderboard-meta-${person.id}'),
                            parts: numbers,
                          ),
                      ],
                    ),
                  ),
                  if (columns?.trend case final width?)
                    column(
                      'trend-column',
                      width,
                      trend == null || score == null
                          ? null
                          : _Trend(
                              personId: person.id,
                              score: score,
                              trend: trend,
                            ),
                    ),
                  if (columns != null && score != null)
                    column(
                      'points',
                      columns.points,
                      Semantics(
                        label: '${score.points} points',
                        excludeSemantics: true,
                        child: Text(
                          '${score.points}',
                          maxLines: 1,
                          style: _pointsStyle(),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// The name, then the status quietly; on hover the whole name, which a long one cut short needs, and the email.
  Widget _name() => Tooltip(
    message: '${leaderboardName(person, score)}\n${person.email}',
    child: SuperTabUntil(
      until: person.status?.until,
      builder: (context) => Text.rich(
        TextSpan(
          text: leaderboardName(person, score),
          children: [
            if (person.statusAt(clock.now()) case final status?)
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
  );
}

/// A person's numbers joined by a spaced middle dot. Where the line does not
/// fit, whole items fall off its end, never part of a word; the whole line,
/// lent in agent-hours, is on hover.
class _Numbers extends StatelessWidget {
  const _Numbers({super.key, required this.parts});
  final List<String> parts;

  @override
  Widget build(BuildContext context) {
    final style = DesktopChrome.metadata();
    final scaler = MediaQuery.textScalerOf(context);
    return Tooltip(
      message: parts
          .map((part) => part.replaceFirst(' hour', ' agent-hour'))
          .join(' · '),
      child: LayoutBuilder(
        builder: (context, constraints) {
          bool fits(String text) {
            final painter = TextPainter(
              text: TextSpan(text: text, style: style),
              textDirection: TextDirection.ltr,
              textScaler: scaler,
              maxLines: 1,
            )..layout(maxWidth: constraints.maxWidth);
            final fits = !painter.didExceedMaxLines;
            painter.dispose();
            return fits;
          }

          var shown = parts.length;
          while (shown > 1 && !fits(parts.take(shown).join(' · '))) {
            shown--;
          }
          final text = parts.take(shown).join(' · ');
          // A first item too wide even alone (enlarged text in a narrow
          // pane) wraps between its words rather than losing one.
          final wraps = !fits(text);
          return Text(
            text,
            maxLines: wraps ? 2 : 1,
            overflow: TextOverflow.ellipsis,
            style: style,
          );
        },
      ),
    );
  }
}

/// An arrow and the change against last week, by shape and colour both: up in
/// the online green, down in the theme's error ink.
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
    final color = up
        ? grid.AppPalette.online
        : Theme.of(context).colorScheme.error;
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
              size: AppIcons.metadataSize,
              color: color,
            ),
            Text(
              '${(score.points - score.prevWeekPoints!).abs()}',
              style: DesktopChrome.metadata(color: color)
                  .copyWith(fontFeatures: grid.AppFont.tabularFigures),
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
    // Labels take their natural width, so a longer word never clips.
    return Table(
      columnWidths: const {0: IntrinsicColumnWidth(), 1: FlexColumnWidth()},
      children: [
        for (final (label, value) in rows)
          TableRow(
            children: [
              Padding(
                padding: const EdgeInsets.only(
                  right: _gap * 2,
                  bottom: _halfGap,
                ),
                child: Text(
                  label,
                  style: DesktopChrome.metadata(
                    color: DesktopChrome.foreground,
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(bottom: _halfGap),
                child: Text(value, style: DesktopChrome.metadata()),
              ),
            ],
          ),
      ],
    );
  }
}

/// The three lists behind a person's numbers, each with its count, its newest
/// five and the rest one click away, and saying so when empty. The dialog
/// around it scrolls (Ken, 2026-10-28).
class _LeaderboardPersonDetails extends StatefulWidget {
  const _LeaderboardPersonDetails({required this.score, required this.details});
  final SuperTabPersonScore score;
  final SuperTabPersonDetails details;

  @override
  State<_LeaderboardPersonDetails> createState() =>
      _LeaderboardPersonDetailsState();
}

class _LeaderboardPersonDetailsState extends State<_LeaderboardPersonDetails> {
  /// The newest a list shows before Show all.
  static const _shown = 5;
  final _expanded = <String>{};

  @override
  Widget build(BuildContext context) {
    final score = widget.score, details = widget.details;
    final quiet = DesktopChrome.metadata();
    final figures = quiet.copyWith(fontFeatures: grid.AppFont.tabularFigures);
    Widget section(String title, String empty, List<Widget> items) {
      final all = _expanded.contains(title) || items.length <= _shown;
      return Padding(
        padding: const EdgeInsets.only(top: _gap * 2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text(
                  title,
                  style: DesktopChrome.control(
                    color: DesktopChrome.foreground,
                    medium: true,
                  ),
                ),
                if (items.isNotEmpty) ...[
                  const SizedBox(width: _gap),
                  Text('${items.length}', style: figures),
                ],
              ],
            ),
            const SizedBox(height: _halfGap),
            if (items.isEmpty)
              Text(empty, style: quiet)
            else ...[
              ...all ? items : items.take(_shown),
              if (!all)
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: TextButton(
                    style: TextButton.styleFrom(
                      backgroundColor: Colors.transparent,
                      side: BorderSide.none,
                      padding: EdgeInsets.zero,
                      minimumSize: Size.zero,
                    ),
                    onPressed: () => setState(() => _expanded.add(title)),
                    child: Text('Show all ${items.length}'),
                  ),
                ),
            ],
          ],
        ),
      );
    }

    // One line each, the whole title on hover; items stand the spacing scale's smallest step apart.
    Widget item(Widget title, String trailing) => Padding(
      padding: const EdgeInsets.symmetric(vertical: _halfGap / 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(child: title),
          if (trailing.isNotEmpty) ...[
            const SizedBox(width: _gap + _halfGap),
            Text(trailing, style: figures),
          ],
        ],
      ),
    );
    final text = DesktopChrome.control();
    Widget line(String value, {TextStyle? style}) => Tooltip(
      message: value,
      excludeFromSemantics: true,
      child: Text(
        value,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: style ?? text,
      ),
    );
    final before = score.prevWeekPoints;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          [
            '${plural(score.points, 'point')} this week',
            if (before != null) '$before last week',
          ].join(' · '),
          style: quiet,
        ),
        section('Shipped', 'No pull requests merged yet', [
          for (final shipped in details.shipped)
            item(switch (Uri.tryParse(shipped.prUrl ?? '')) {
              // Only a web page opens: a link from the server is data,
              // and any other scheme could open a file or an app.
              final link? when const {'http', 'https'}.contains(link.scheme) =>
                Semantics(
                  link: true,
                  child: InkWell(
                    onTap: () =>
                        launchUrl(link, mode: LaunchMode.externalApplication),
                    child: line(
                      shipped.title,
                      style: text.copyWith(color: DesktopChrome.accent),
                    ),
                  ),
                ),
              _ => line(shipped.title),
            }, ''),
        ]),
        section('Unblocked', 'No questions answered yet', [
          for (final unblocked in details.unblocked)
            item(
              line(unblocked.title),
              'waited ${leaderboardDuration(unblocked.waitedMinutes * 60000)}',
            ),
        ]),
        section('Lent', 'No machines lent yet', [
          for (final lent in details.lent)
            item(
              line(superTabMachineName(lent.machineName)),
              '${leaderboardDuration((lent.busyHours * 3600000).round())} busy',
            ),
        ]),
      ],
    );
  }
}
