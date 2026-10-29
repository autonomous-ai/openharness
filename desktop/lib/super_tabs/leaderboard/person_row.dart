import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

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
TextStyle leaderboardRankStyle() => grid.AppType.label(
  fontWeight: FontWeight.w700,
  color: grid.AppPalette.textSecondary,
  fontFeatures: grid.AppFont.tabularFigures,
);
TextStyle leaderboardPointsStyle() => grid.AppType.label(
  fontWeight: grid.AppFont.semibold,
  color: grid.AppPalette.textPrimary,
  fontFeatures: grid.AppFont.tabularFigures,
);

/// A person as the leaderboard names them: the board's display name, else the
/// email's first part, as before the board had names.
String leaderboardName(SuperTabPerson person, SuperTabPersonScore? score) =>
    score?.displayName ?? superTabPersonName(person.email);

/// Whether a person wears the crown: first on the board, with points. At the
/// start of a week everyone ties at 0, and no one has taken #1 yet.
bool leaderboardCrowned(SuperTabPersonScore? score) =>
    score != null && score.rank == 1 && score.points > 0;

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
/// the current text size, so rank and points line up on every row.
class LeaderboardColumns {
  const LeaderboardColumns({required this.rank, required this.points});

  factory LeaderboardColumns.of(
    BuildContext context,
    List<SuperTabPersonScore> scores,
  ) => LeaderboardColumns.measure(
    context,
    ranks: scores.map((score) => score.rank),
    points: scores.map((score) => score.points),
  );

  /// The columns for any ranked list: people, agents or models.
  factory LeaderboardColumns.measure(
    BuildContext context, {
    required Iterable<int> ranks,
    required Iterable<int> points,
  }) {
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
    return LeaderboardColumns(
      rank: width(widest(ranks), leaderboardRankStyle()),
      points: width(widest(points), leaderboardPointsStyle()),
    );
  }

  final double rank, points;
}

/// One person in the Humans section: their rank as a bold numeral in its own
/// column, avatar, name (number one's with a crown beside it) and status, and
/// a quiet line of their non-zero numbers beneath; at the right their points,
/// the one number (Dee, 2026-10-29). The viewer's own row carries the selected
/// fill. Without a [score] (no board yet, or a server without
/// one) only the name and status.
class LeaderboardPersonRow extends StatelessWidget {
  const LeaderboardPersonRow({
    super.key,
    required this.person,
    required this.score,
    required this.onTap,
    this.columns,
    this.own = false,
    this.weekName = 'this week',
  });
  final SuperTabPerson person;
  final SuperTabPersonScore? score;
  final VoidCallback onTap;

  /// The numeric columns, the same on every row; null without a board.
  final LeaderboardColumns? columns;

  /// Whether this is the viewer's own row.
  final bool own;

  /// The week the board shows, "this week", "last week", …, as the crown says it.
  final String weekName;

  @override
  Widget build(BuildContext context) {
    final score = this.score;
    final columns = this.columns;
    final numbers = score == null
        ? const <String>[]
        : leaderboardNumbers(score);
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
                              style: leaderboardRankStyle(),
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
                          LeaderboardNumbers(
                            key: ValueKey('leaderboard-meta-${person.id}'),
                            parts: numbers,
                          ),
                      ],
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
                          style: leaderboardPointsStyle(),
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

  /// The name, number one's crown, then the status quietly; on hover the whole name, which a long one cut short
  /// needs, and the email. The crown is content artwork beside the name, said in words, at the metadata size so a
  /// crowned row is as tall as any other (Team and celebration, design system).
  Widget _name() => Tooltip(
    message: '${leaderboardName(person, score)}\n${person.email}',
    child: SuperTabUntil(
      until: person.status?.until,
      builder: (context) => Text.rich(
        TextSpan(
          text: leaderboardName(person, score),
          children: [
            if (leaderboardCrowned(score))
              WidgetSpan(
                alignment: PlaceholderAlignment.middle,
                child: LeaderboardCrown(id: person.id, weekName: weekName),
              ),
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

/// Number one's crown beside their name: content artwork, said in words, at
/// the metadata size so a crowned row is as tall as any other (Team and
/// celebration, design system). [id] keys it per row.
class LeaderboardCrown extends StatelessWidget {
  const LeaderboardCrown({super.key, required this.id, required this.weekName});
  final String id;

  /// The week the board shows, as the crown says it: "Number one last week".
  final String weekName;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(left: _halfGap),
    child: Semantics(
      key: ValueKey('leaderboard-crown-$id'),
      label: 'Number one $weekName',
      excludeSemantics: true,
      child: Text('\u{1F451}', style: DesktopChrome.metadata()),
    ),
  );
}

/// A person's numbers joined by a spaced middle dot. Where the line does not
/// fit, whole items fall off its end, never part of a word; the whole line,
/// lent in agent-hours, is on hover.
class LeaderboardNumbers extends StatelessWidget {
  const LeaderboardNumbers({
    super.key,
    required this.parts,
    this.tooltip,
    this.lines = 1,
  });
  final List<String> parts;

  /// How many lines whole items may take: a model's numbers are the routing
  /// measurement, so its row gives them two.
  final int lines;

  /// What hovering shows; the whole line, lent in agent-hours, when not given.
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final style = DesktopChrome.metadata();
    final scaler = MediaQuery.textScalerOf(context);
    return Tooltip(
      message:
          tooltip ??
          parts
              .map((part) => part.replaceFirst(' hour', ' agent-hour'))
              .join(' · '),
      child: LayoutBuilder(
        builder: (context, constraints) {
          bool fits(String text) {
            final painter = TextPainter(
              text: TextSpan(text: text, style: style),
              textDirection: TextDirection.ltr,
              textScaler: scaler,
              maxLines: lines,
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
            maxLines: wraps ? lines + 1 : lines,
            overflow: TextOverflow.ellipsis,
            style: style,
          );
        },
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
