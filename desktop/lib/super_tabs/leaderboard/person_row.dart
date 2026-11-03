import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../widgets/desktop_chrome.dart';
import '../identity.dart';
import '../model.dart';
import '../until.dart';
import 'format.dart';
import 'member_row.dart';
import 'model.dart';

/// The gap between a row's columns, and half of it: the spacing scale's 8
/// and 4.
const _gap = grid.AppDesktop.controlGap;
const _halfGap = _gap / 2;

/// The avatar People and Agents rows both draw, in one column.
const _avatarSize = SuperTabAvatar.rowSize;

/// Numbers (desktop design system): the points the one emphasized number, in
/// a column of one width so it holds row under row.
TextStyle leaderboardPointsStyle() => grid.AppType.label(
  fontWeight: grid.AppFont.semibold,
  color: grid.AppPalette.textPrimary,
  fontFeatures: grid.AppFont.tabularFigures,
);

/// A person as the leaderboard names them: as everywhere in the Swarm, the
/// name they set, else their username (the board's account display name was
/// a long one).
String leaderboardName(SuperTabPerson person, SuperTabPersonScore? score) =>
    person.shownName;

/// Whether a person wears the crown: first on the board, with points. At the
/// start of a week everyone ties at 0, and no one has taken #1 yet.
bool leaderboardCrowned(SuperTabPersonScore? score) =>
    score != null && score.rank == 1 && score.points > 0;

/// A person's card's numbers (Quiet Swarm, screen 5), each said even at 0:
/// "111 shipped · 40 unblocked · 411 hours" (hours lent).
String leaderboardCardNumbers(SuperTabPersonScore score) => [
  '${score.shipped} shipped',
  '${score.unblocked} unblocked',
  plural(int.parse(leaderboardHours(score.lentMs)), 'hour'),
].join(' · ');

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

/// The board's points column, as wide as its widest value at the current text
/// size, so the points line up on every row.
class LeaderboardColumns {
  const LeaderboardColumns({required this.points});

  factory LeaderboardColumns.measure(
    BuildContext context, {
    required Iterable<int> points,
  }) {
    // Digits are of one width, so the longest number is the widest.
    final widest = points
        .map((value) => '$value')
        .fold('0', (a, b) => b.length > a.length ? b : a);
    final painter = TextPainter(
      text: TextSpan(text: widest, style: leaderboardPointsStyle()),
      textDirection: TextDirection.ltr,
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final width = painter.width;
    painter.dispose();
    return LeaderboardColumns(points: width);
  }

  final double points;
}

/// One person in the People section, on one line (Quiet Swarm, screen 4):
/// avatar, name (number one's with a crown beside it) and their points at the
/// right, the period on hover. Their numbers and status are on their card.
/// No rank. The viewer's own row carries the selected fill. Without a [score]
/// (no board yet, or a server without one) only the name.
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

  /// The points column, the same on every row; null without a board.
  final LeaderboardColumns? columns;

  /// Whether this is the viewer's own row.
  final bool own;

  @override
  Widget build(BuildContext context) {
    final score = this.score;
    final columns = this.columns;
    return SuperTabMemberRow(
      rowKey: ValueKey('super-person-${person.id}'),
      onTap: onTap,
      selected: own,
      avatar: SuperTabAvatar.person(person, size: _avatarSize),
      name: _name(),
      trailing: columns == null || score == null
          ? null
          : Tooltip(
              message: 'Points ${score.spanName}',
              child: SizedBox(
                key: ValueKey('leaderboard-points-${person.id}'),
                width: columns.points,
                child: Align(
                  alignment: Alignment.centerRight,
                  child: Semantics(
                    label: '${score.points} points',
                    excludeSemantics: true,
                    child: Text(
                      '${score.points}',
                      maxLines: 1,
                      style: leaderboardPointsStyle(),
                    ),
                  ),
                ),
              ),
            ),
    );
  }

  /// The name and number one's crown; on hover the whole name, which a long
  /// one cut short needs, the email and their status. The crown is content
  /// artwork beside the name, said in words, at the metadata size so a
  /// crowned row is as tall as any other (Team and celebration, design
  /// system).
  Widget _name() => SuperTabUntil(
    until: person.status?.until,
    builder: (context) => Tooltip(
      message: [
        leaderboardName(person, score),
        if (person.name != null) '@${person.username}',
        person.email,
        ?person.statusAt(clock.now())?.text,
      ].join('\n'),
      child: Text.rich(
        TextSpan(
          text: leaderboardName(person, score),
          children: [
            if (leaderboardCrowned(score))
              WidgetSpan(
                alignment: PlaceholderAlignment.middle,
                child: LeaderboardCrown(
                  id: person.id,
                  weekName: score!.spanName,
                ),
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
  const LeaderboardPersonWeek({
    super.key,
    required this.score,
    this.summary = true,
  });
  final SuperTabPersonScore score;

  /// Whether it says the points first; a card that shows them and the
  /// three numbers in its heading leaves them out, and from a server without
  /// details shows nothing more.
  final bool summary;

  @override
  Widget build(BuildContext context) {
    if (score.details case final details?) {
      return _LeaderboardPersonDetails(
        score: score,
        details: details,
        summary: summary,
      );
    }
    String median(int? ms, String what) =>
        ms == null ? '' : ' · median ${leaderboardDuration(ms)}$what';
    // A card says the points and the three numbers itself.
    if (!summary) return const SizedBox.shrink();
    final rows = [
      (
        'Points',
        score.medal == null
            ? '${score.points} ${score.spanName}'
            : '${score.points} ${score.spanName} · place ${score.rank}',
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
  const _LeaderboardPersonDetails({
    required this.score,
    required this.details,
    required this.summary,
  });
  final SuperTabPersonScore score;
  final SuperTabPersonDetails details;
  final bool summary;

  @override
  State<_LeaderboardPersonDetails> createState() =>
      _LeaderboardPersonDetailsState();
}

/// How Brought names a subscription's engine, as the Swarm's other lines do.
const _engineNames = {'claude': 'Claude', 'codex': 'Codex'};

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
        if (widget.summary)
          Text(
            [
              '${plural(score.points, 'point')} ${score.spanName}',
              if (before != null) '$before ${score.earlierName}',
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
        // What each machine the person brought did (contributor view, #2444);
        // a server before it says only Lent.
        if (details.brought case final brought?)
          section('Brought', 'No machines brought yet', [
            for (final machine in brought)
              Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  item(
                    line(superTabMachineName(machine.machineName)),
                    '${machine.shipped} shipped · '
                    '${broughtHours(machine.busyHours)} for others',
                  ),
                  for (final sub in machine.subscriptions)
                    Padding(
                      padding: const EdgeInsetsDirectional.only(
                        start: _gap * 2,
                      ),
                      child: item(
                        line(
                          _engineNames[sub.engine] ?? capitalized(sub.engine),
                          style: quiet,
                        ),
                        switch (sub) {
                          (
                            usedPercent: final used?,
                            resetsAt: final at?,
                            engine: _,
                          ) =>
                            '$used% used · resets in ${resetsIn(DateTime.fromMillisecondsSinceEpoch(at), clock.now())}',
                          (
                            usedPercent: final used?,
                            resetsAt: null,
                            engine: _,
                          ) =>
                            '$used% used',
                          _ => 'not read yet',
                        },
                      ),
                    ),
                ],
              ),
          ])
        else
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
