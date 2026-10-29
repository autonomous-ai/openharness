import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../widgets/desktop_chrome.dart';
import '../section_heading.dart';
import 'format.dart';
import 'model.dart';
import 'person_row.dart';

/// The gap between a row's columns, and half of it: the spacing scale's 8
/// and 4.
const _gap = grid.AppDesktop.controlGap;
const _halfGap = _gap / 2;

/// How much faster the week's requests shipped than the week before's, in
/// whole percent: positive is faster. Null without both weeks' times.
int? fasterChange(List<SuperTabTeamWeek> weeks) {
  final now = weeks.firstOrNull?.medianRequestMs;
  final before = weeks.elementAtOrNull(1)?.medianRequestMs;
  if (now == null || before == null || before == 0) return null;
  return ((before - now) * 100 / before).round();
}

/// How many points more of the week's attempts passed their first review
/// than the week before's: positive is better. Null without both weeks'.
int? betterChange(List<SuperTabTeamWeek> weeks) {
  final now = weeks.firstOrNull?.passedPercent;
  final before = weeks.elementAtOrNull(1)?.passedPercent;
  if (now == null || before == null) return null;
  return now - before;
}

/// One row's trend: the arrow means better in both directions, up in the
/// online green, down in the error ink (Numbers and rankings).
typedef _Trend = ({bool better, String figure, String words});

/// This week at the top of the right sidebar (Dee, 2026-10-29): Faster,
/// Better and Cheaper against the week before, each a label, a quiet caption,
/// the change and the week's figure at the trailing edge. The tooltip names
/// the last four weeks.
class LeaderboardWeekSummary extends StatelessWidget {
  const LeaderboardWeekSummary({
    super.key,
    required this.weeks,
    required this.weekNames,
  });

  /// The board's week first, then the three before it.
  final List<SuperTabTeamWeek> weeks;

  /// Each week's name, as the week picker says it: "this week", "last
  /// week", "2 weeks ago".
  final List<String> weekNames;

  String get _before => weekNames.first == 'this week'
      ? 'last week'
      : (weekNames.elementAtOrNull(1) ?? 'the week before');

  String _history(String Function(SuperTabTeamWeek) value) => [
    for (var i = 0; i < weeks.length && i < weekNames.length; i++)
      '${capitalized(weekNames[i])}: ${value(weeks[i])}',
  ].join('\n');

  @override
  Widget build(BuildContext context) {
    final week = weeks.first;
    final faster = fasterChange(weeks), better = betterChange(weeks);
    final fasterTrend = faster == null || faster == 0
        ? null
        : (
            better: faster > 0,
            figure: '${faster.abs()}%',
            words:
                '${faster.abs()}% ${faster > 0 ? 'faster' : 'slower'} than $_before',
          );
    final betterTrend = better == null || better == 0
        ? null
        : (
            better: better > 0,
            figure: '${better.abs()} pts',
            words:
                '${plural(better.abs(), 'point')} ${better > 0 ? 'more' : 'fewer'} than $_before',
          );
    final time = week.medianRequestMs;
    final passed = week.passedPercent;
    final rows = [
      (
        key: 'faster',
        label: 'Faster',
        caption: 'time to ship',
        value: time == null ? 'None shipped' : leaderboardDuration(time),
        spoken: time == null
            ? 'Faster: none shipped'
            : 'Faster: ${leaderboardDuration(time)} to ship',
        trend: fasterTrend,
        history: _history(
          (w) => w.medianRequestMs == null
              ? 'none shipped'
              : leaderboardDuration(w.medianRequestMs!),
        ),
      ),
      (
        key: 'better',
        label: 'Better',
        caption: 'passed review the first time',
        value: passed == null ? 'None reviewed' : '$passed%',
        spoken: passed == null
            ? 'Better: none reviewed'
            : 'Better: $passed% passed review the first time',
        trend: betterTrend,
        history: _history(
          (w) =>
              w.passedPercent == null ? 'none reviewed' : '${w.passedPercent}%',
        ),
      ),
      // Spend per attempt is not recorded yet: no number and no arrow until a
      // full week is (Lead, 2026-10-29).
      (
        key: 'cheaper',
        label: 'Cheaper',
        caption: 'per shipped change',
        value: 'Measuring',
        spoken:
            'Cheaper: measuring, shown once a full week of spend is recorded',
        trend: null as _Trend?,
        history: 'Spend per shipped change shows once a full week of it is recorded.',
      ),
    ];
    // One trend column and one value column, each as wide as its widest
    // entry at the current text size, so the figures line up row under row.
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

    TextStyle valueStyle(String key) =>
        key == 'cheaper' ? DesktopChrome.metadata() : leaderboardPointsStyle();
    final trendWidth = [
      for (final row in rows)
        if (row.trend case final trend?)
          AppIcons.metadataSize + width(trend.figure, _TrendMark.style()),
    ].fold(0.0, (a, b) => a > b ? a : b);
    // Cheaper's word sits outside the figures' column: it is no number.
    final valueWidth = [
      for (final row in rows)
        if (row.key != 'cheaper') width(row.value, valueStyle(row.key)),
    ].fold(0.0, (a, b) => a > b ? a : b);
    return Column(
      key: const ValueKey('week-summary'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        SuperTabSectionHeading(capitalized(weekNames.first)),
        for (final row in rows)
          Padding(
            key: ValueKey('week-summary-${row.key}'),
            padding: const EdgeInsets.symmetric(
              horizontal: _gap * 2,
              vertical: _halfGap,
            ),
            child: Tooltip(
              message: [?row.trend?.words, row.history].join('\n'),
              excludeFromSemantics: true,
              child: Semantics(
                container: true,
                label: [row.spoken, ?row.trend?.words].join(', '),
                excludeSemantics: true,
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            row.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: DesktopChrome.control(),
                          ),
                          // A long caption wraps rather than losing its end.
                          Text(
                            row.caption,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: DesktopChrome.metadata(),
                          ),
                        ],
                      ),
                    ),
                    if (trendWidth > 0)
                      SizedBox(
                        width: trendWidth,
                        child: Align(
                          alignment: Alignment.centerRight,
                          child: row.trend == null
                              ? null
                              : _TrendMark(row.trend!),
                        ),
                      ),
                    const SizedBox(width: _gap),
                    if (row.key == 'cheaper')
                      Text(row.value, maxLines: 1, style: valueStyle(row.key))
                    else
                      SizedBox(
                        width: valueWidth,
                        child: Text(
                          row.value,
                          maxLines: 1,
                          textAlign: TextAlign.right,
                          style: valueStyle(row.key),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// The arrow and the change beside it, by shape and colour both.
class _TrendMark extends StatelessWidget {
  const _TrendMark(this.trend);
  final _Trend trend;

  /// The change's figure: caption size, tabular, in the trend's colour.
  static TextStyle style([Color? color]) =>
      DesktopChrome.metadata(color: color)
          .copyWith(fontFeatures: grid.AppFont.tabularFigures);

  @override
  Widget build(BuildContext context) {
    final color = trend.better
        ? grid.AppPalette.online
        : Theme.of(context).colorScheme.error;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          trend.better ? AppIcons.arrowUp : AppIcons.arrowDown,
          size: AppIcons.metadataSize,
          color: color,
        ),
        Text(trend.figure, style: style(color)),
      ],
    );
  }
}
