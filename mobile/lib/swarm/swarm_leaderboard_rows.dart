/// The leaderboard's rows, the design system's Numbers and rankings at phone
/// sizes: a list's heading, a person's, an agent's and a model's row, rank
/// and points each in a column as wide as the list's widest; the page is
/// `swarm_leaderboard.dart`.
library;

import 'package:clock/clock.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/widgets/engine_identity.dart' show EngineMark;

import 'model.dart';
import 'swarm_leaderboard_reader.dart';
import 'swarm_row.dart';
import 'swarm_style.dart';

/// Figures of one width, so a column of numbers holds row under row.
const _figures = [FontFeature.tabularFigures()];

/// Numbers and rankings: the rank a bold numeral in secondary ink, the points
/// the one emphasized number, 0 included.
TextStyle _rankStyle() => AppType.label(
  fontWeight: FontWeight.w700,
  color: AppPalette.textSecondary,
  fontFeatures: _figures,
);
TextStyle _pointsStyle() => AppType.label(
  fontWeight: FontWeight.w600,
  color: AppPalette.textPrimary,
  fontFeatures: _figures,
);

/// An agent's engine beside its points, at the size of an icon in a line.
const _markSize = 16.0;

/// A list's name over its rows, in a caption's quiet ink, with maybe what
/// sets it at its right: Humans and the week picker.
class SwarmLeaderboardHeading extends StatelessWidget {
  const SwarmLeaderboardHeading(
    this.text, {
    super.key,
    this.trailing,
    this.first = false,
  });

  final String text;
  final Widget? trailing;

  /// The first thing on the screen: less room above it.
  final bool first;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      key: ValueKey('swarm-leaderboard-heading-${text.toLowerCase()}'),
      padding: EdgeInsets.fromLTRB(
        AppSpace.s,
        first ? 0 : AppSpace.l,
        0,
        trailing == null ? AppSpace.xs : 0,
      ),
      child: Row(
        children: [
          Expanded(
            child: Semantics(
              container: true,
              header: true,
              child: Text(
                text,
                style: AppType.caption(
                  color: Color.lerp(
                    AppPalette.textFaint,
                    AppPalette.textSecondary,
                    .5,
                  ),
                ),
              ),
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

/// A list with nothing to show that week, said as quiet text where the rows'
/// content starts.
class SwarmLeaderboardEmpty extends StatelessWidget {
  const SwarmLeaderboardEmpty(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
    child: SwarmRow.line(text, lines: 2),
  );
}

/// The board's fixed numeric columns, each as wide as its widest value at the
/// current text size, so rank and points line up on every row of a list.
class SwarmLeaderboardColumns {
  const SwarmLeaderboardColumns({required this.rank, required this.points});

  factory SwarmLeaderboardColumns.measure(
    BuildContext context, {
    required Iterable<int> ranks,
    required Iterable<String> points,
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

    // Digits are of one width, so the longest value is the widest.
    String widest(Iterable<String> values) =>
        values.fold('0', (a, b) => b.length > a.length ? b : a);
    return SwarmLeaderboardColumns(
      rank: width(widest(ranks.map((rank) => '$rank')), _rankStyle()),
      points: width(widest(points), _pointsStyle()),
    );
  }

  final double rank, points;
}

/// What a ranked row is drawn of, people's and agents' alike: the rank in
/// its column, a face, the name over a quiet line, maybe an engine's mark,
/// and the points in theirs, at least a thumb tall.
Widget _rankedRow({
  required String id,
  required int rank,
  required int points,
  required SwarmLeaderboardColumns columns,
  required Widget identity,
  required Widget name,
  required Widget? numbers,
  Widget? mark,
}) {
  Widget column(String kind, double width, Widget child) => SizedBox(
    key: ValueKey('swarm-leaderboard-$kind-$id'),
    width: width,
    child: Align(alignment: Alignment.centerRight, child: child),
  );
  return ConstrainedBox(
    constraints: const BoxConstraints(minHeight: minTouchTarget),
    child: Padding(
      padding: const EdgeInsets.all(AppSpace.s),
      child: Row(
        children: [
          column(
            'rank',
            columns.rank,
            Text('$rank', maxLines: 1, style: _rankStyle()),
          ),
          const SizedBox(width: AppSpace.m),
          identity,
          const SizedBox(width: AppSpace.m),
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [name, ?numbers],
            ),
          ),
          const SizedBox(width: AppSpace.s),
          if (mark != null) ...[mark, const SizedBox(width: AppSpace.s)],
          column(
            'points',
            columns.points,
            Text('$points', maxLines: 1, style: _pointsStyle()),
          ),
        ],
      ),
    ),
  );
}

/// A row's name in the body face, number one's crown after it, then maybe a
/// quiet tag: "PM", "Buddy · ken", a person's status.
Widget _name(String name, {String? crownId, String? tag}) => Text.rich(
  TextSpan(
    text: name,
    children: [
      if (crownId != null)
        WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: _Crown(id: crownId),
        ),
      if (tag != null)
        TextSpan(
          text: '  $tag',
          style: AppType.caption(color: AppPalette.textSecondary),
        ),
    ],
  ),
  maxLines: 1,
  overflow: TextOverflow.ellipsis,
  style: AppType.body(color: AppPalette.textPrimary),
);

/// Number one's crown beside their name: content artwork at the caption
/// size, so a crowned row is as tall as any other (the desktop's
/// `LeaderboardCrown`). The row says it in words.
class _Crown extends StatelessWidget {
  const _Crown({required this.id});

  final String id;

  @override
  Widget build(BuildContext context) => Padding(
    key: ValueKey('swarm-leaderboard-crown-$id'),
    padding: const EdgeInsets.only(left: AppSpace.xs),
    child: Text('\u{1F451}', style: AppType.caption()),
  );
}

/// One person on the board: rank, face, name and status over their numbers,
/// and points; the viewer's own row in the selected fill. Tapped, their week.
class SwarmLeaderboardPersonRow extends StatelessWidget {
  const SwarmLeaderboardPersonRow({
    super.key,
    required this.score,
    required this.person,
    required this.name,
    required this.own,
    required this.columns,
    required this.week,
    required this.onTap,
  });

  final SwarmScore score;

  /// Null for someone who has left.
  final SuperTabPerson? person;
  final String name;
  final bool own;
  final SwarmLeaderboardColumns columns;

  /// "This week", "Last week", …: the week shown, as the crown says it.
  final String week;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final id = score.personId;
    final numbers = swarmNumbers(score);
    final crowned = swarmCrowned(rank: score.rank, points: score.points);
    final status = person?.statusAt(clock.now());
    final radius = BorderRadius.circular(AppControl.radius);
    return Material(
      color: own ? AppSurface.selectedFill : Colors.transparent,
      borderRadius: radius,
      clipBehavior: Clip.antiAlias,
      child: Semantics(
        key: ValueKey('swarm-leaderboard-person-$id'),
        button: true,
        // What the row shows, the numbers in full: none at zero.
        label: [
          '$name, place ${score.rank}, ${score.points} points',
          if (crowned) 'number one ${week.toLowerCase()}',
          ?status?.text,
          ...numbers,
        ].join(', '),
        excludeSemantics: true,
        child: InkWell(
          borderRadius: radius,
          onTap: () {
            HapticFeedback.selectionClick();
            onTap();
          },
          child: _rankedRow(
            id: id,
            rank: score.rank,
            points: score.points,
            columns: columns,
            identity: SwarmAvatar(
              id: id,
              name: name,
              picture: person?.avatar,
              status: status,
            ),
            name: _name(name, crownId: crowned ? id : null, tag: status?.text),
            numbers: numbers.isEmpty
                ? null
                : _Numbers(
                    key: ValueKey('swarm-leaderboard-meta-$id'),
                    parts: numbers,
                  ),
          ),
        ),
      ),
    );
  }
}

/// One agent on the board, read only: rank, its face, its name and role
/// over the line its Team row gives it, its engine's mark, and points (the
/// desktop's member list: "Agent rows stay as before and add only the rank
/// and points").
class SwarmLeaderboardAgentRow extends StatelessWidget {
  const SwarmLeaderboardAgentRow({
    super.key,
    required this.id,
    required this.rank,
    required this.points,
    required this.columns,
    required this.identity,
    required this.name,
    required this.tag,
    required this.line,
    required this.engine,
  });

  final String id, name, tag;
  final int rank, points;
  final SwarmLeaderboardColumns columns;
  final Widget identity;

  /// "Idle", "Mac Studio", "Opus · xhigh": empty for an agent the Swarm no
  /// longer shows in this project.
  final List<String> line;

  /// Null where the Swarm does not say what it runs on.
  final String? engine;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      key: ValueKey('swarm-leaderboard-row-$id'),
      container: true,
      label: [name, tag, 'place $rank, $points points', ...line].join(', '),
      excludeSemantics: true,
      child: _rankedRow(
        id: id,
        rank: rank,
        points: points,
        columns: columns,
        identity: identity,
        name: _name(name, tag: tag),
        numbers: line.isEmpty
            ? null
            : _Numbers(
                key: ValueKey('swarm-leaderboard-line-$id'),
                parts: line,
              ),
        mark: switch (engine) {
          final engine? => EngineMark(
            key: ValueKey('swarm-leaderboard-engine-$id'),
            engine: engine,
            size: _markSize,
          ),
          null => null,
        },
      ),
    );
  }
}

/// One model in the Models list: its name, and the share of its work this
/// week that passed its first review, the one number (Dee, 10-29: "keep it
/// simple"). Its name starts where the faces do. A screen reader hears the
/// counts behind the share.
class SwarmLeaderboardModelRow extends StatelessWidget {
  const SwarmLeaderboardModelRow({
    super.key,
    required this.approval,
    required this.columns,
  });

  final SwarmModelApproval approval;
  final SwarmLeaderboardColumns columns;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final (:name, :reviewed, :passed, :percent) = approval;
    return Semantics(
      key: ValueKey('swarm-leaderboard-model-$name'),
      container: true,
      label:
          '$name, $percent% approved, $passed of $reviewed passed first '
          'review',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.all(AppSpace.s),
        child: Row(
          children: [
            SizedBox(width: columns.rank + AppSpace.m),
            Expanded(
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppType.body(color: AppPalette.textPrimary),
              ),
            ),
            const SizedBox(width: AppSpace.s),
            SizedBox(
              width: columns.points,
              child: Align(
                alignment: Alignment.centerRight,
                child: Text('$percent%', maxLines: 1, style: _pointsStyle()),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A row's quiet line, its parts joined by a spaced middle dot. Where the
/// line does not fit, whole parts fall off its end, never part of a word; a
/// person's sheet has them all, and a screen reader hears them all. A first
/// part too wide even alone wraps between its words.
class _Numbers extends StatelessWidget {
  const _Numbers({super.key, required this.parts});

  final List<String> parts;

  @override
  Widget build(BuildContext context) {
    final style = AppType.caption(color: AppPalette.textSecondary);
    final scaler = MediaQuery.textScalerOf(context);
    return LayoutBuilder(
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
        return Text(
          text,
          maxLines: fits(text) ? 1 : 2,
          overflow: TextOverflow.ellipsis,
          style: style,
        );
      },
    );
  }
}
