import 'package:flutter/material.dart';

import '../../core/runtime_model_name.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../widgets/desktop_chrome.dart';
import '../../widgets/engine_identity.dart';
import '../../widgets/finger_target.dart';
import '../identity.dart';
import '../model.dart';
import 'format.dart';
import 'model.dart';
import 'person_row.dart';

/// The gap between a row's columns, and half of it: the spacing scale's 8
/// and 4.
const _gap = grid.AppDesktop.controlGap;
const _halfGap = _gap / 2;

/// One ranked row of the Agents or Models list, built like a person's
/// (Numbers and rankings): the rank as a bold numeral in its column, the
/// identity, the name with a quiet tag and, for number one, the crown, a quiet
/// line of non-zero numbers in words, and the points at the trailing edge.
class _ScoreRow extends StatelessWidget {
  const _ScoreRow({
    required this.id,
    required this.rank,
    required this.points,
    required this.columns,
    required this.identity,
    required this.name,
    required this.tag,
    required this.numbers,
    required this.crowned,
    required this.weekName,
    this.numbersTooltip,
    this.numberLines = 1,
  });
  final String id, name, weekName;
  final int rank, points;
  final LeaderboardColumns columns;
  final Widget identity;

  /// Quietly after the name: "PM · Mac Studio", "grid".
  final String? tag;
  final List<String> numbers;
  final String? numbersTooltip;
  final int numberLines;
  final bool crowned;

  @override
  Widget build(BuildContext context) => Padding(
    key: ValueKey('leaderboard-row-$id'),
    padding: const EdgeInsets.symmetric(horizontal: _gap),
    child: ConstrainedBox(
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
            SizedBox(
              width: columns.rank,
              child: Text(
                '$rank',
                maxLines: 1,
                textAlign: TextAlign.right,
                style: leaderboardRankStyle(),
              ),
            ),
            const SizedBox(width: _gap),
            SizedBox.square(
              dimension: SuperTabAvatar.rowSize,
              child: Center(child: identity),
            ),
            const SizedBox(width: _gap),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text.rich(
                    TextSpan(
                      text: name,
                      children: [
                        if (crowned)
                          WidgetSpan(
                            alignment: PlaceholderAlignment.middle,
                            child: LeaderboardCrown(id: id, weekName: weekName),
                          ),
                        if (tag case final tag?)
                          TextSpan(
                            text: '  $tag',
                            style: DesktopChrome.metadata(),
                          ),
                      ],
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.control(),
                  ),
                  if (numbers.isNotEmpty)
                    LeaderboardNumbers(
                      key: ValueKey('leaderboard-numbers-$id'),
                      parts: numbers,
                      tooltip: numbersTooltip,
                      lines: numberLines,
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(left: _gap),
              child: SizedBox(
                width: columns.points,
                child: Align(
                  alignment: Alignment.centerRight,
                  child: Semantics(
                    label: plural(points, 'point'),
                    excludeSemantics: true,
                    child: Text(
                      '$points',
                      maxLines: 1,
                      style: leaderboardPointsStyle(),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

/// The PM or a Buddy, by name like a person: "PM · openharness" (the project
/// it leads) or "Buddy · dee" beside the name, and what they shipped beneath.
class LeaderboardAgentRow extends StatelessWidget {
  const LeaderboardAgentRow({
    super.key,
    required this.score,
    required this.agent,
    required this.columns,
    required this.weekName,
    this.projectName,
    this.ownerName,
  });
  final SuperTabAgentScore score;

  /// The agent as the Swarm shows it, for its avatar; null once it left.
  final SuperTabAgent? agent;
  final LeaderboardColumns columns;
  final String weekName;

  /// The project the PM leads, and a Buddy's person, as the Swarm names them.
  final String? projectName, ownerName;

  @override
  Widget build(BuildContext context) {
    final agent = this.agent;
    return _ScoreRow(
      id: 'agent-${score.agentId}',
      rank: score.rank,
      points: score.points,
      columns: columns,
      weekName: weekName,
      crowned: score.rank == 1 && score.points > 0,
      identity: agent == null
          ? SuperTabAvatar(
              identity: 'agent:${score.agentId}',
              name: score.displayName,
              size: SuperTabAvatar.rowSize,
              pattern: true,
            )
          : SuperTabAvatar.agent(agent, size: SuperTabAvatar.rowSize),
      name: score.displayName,
      tag: score.buddy
          ? ['Buddy', ?ownerName].join(' · ')
          : ['PM', ?projectName].join(' · '),
      numbers: [
        if (score.shipped > 0)
          score.buddy
              ? plural(score.shipped, 'proposal shipped', 'proposals shipped')
              : '${score.shipped} shipped',
      ],
    );
  }
}

/// A model the temporary workers ran on, never an agent: "Opus · high", its
/// engine's mark, and its numbers in words; the time from the request's first
/// attempt on hover.
class LeaderboardModelRow extends StatelessWidget {
  const LeaderboardModelRow({
    super.key,
    required this.score,
    required this.columns,
    required this.weekName,
  });
  final SuperTabModelScore score;
  final LeaderboardColumns columns;
  final String weekName;

  @override
  Widget build(BuildContext context) {
    final score = this.score;
    final name = [
      switch (score.model) {
        final String model => modelDisplayName(model),
        null => engineIdentity(score.engine).label,
      },
      ?score.effort,
    ].join(' · ');
    return _ScoreRow(
      id: score.key,
      rank: score.rank,
      points: score.points,
      columns: columns,
      weekName: weekName,
      crowned: score.rank == 1 && score.points > 0,
      identity: EngineMark(engine: score.engine),
      name: name,
      tag: score.grid ? 'grid' : null,
      numbers: leaderboardModelNumbers(score),
      numbersTooltip: leaderboardModelNumbers(score, full: true).join(' · '),
      numberLines: 2,
    );
  }
}

/// A model's numbers in words, each left out at zero: "31 shipped", "82%
/// passed first review", "47 min to ship", "5 reviews". [full] is the hover
/// text: the counts behind the share, and the time from the request's first
/// attempt beside the shipping attempt's.
List<String> leaderboardModelNumbers(
  SuperTabModelScore score, {
  bool full = false,
}) {
  final attempt = score.medianAttemptMs, request = score.medianRequestMs;
  return [
    if (score.shipped > 0) '${score.shipped} shipped',
    if (score.reviewed > 0)
      full
          ? '${score.passed} of ${score.reviewed} passed first review'
          : '${(score.passed * 100 / score.reviewed).round()}% passed first review',
    if (attempt != null)
      full
          ? [
              '${leaderboardDuration(attempt)} from the shipping attempt',
              if (request != null)
                '${leaderboardDuration(request)} from the first',
            ].join(', ')
          : '${leaderboardDuration(attempt)} to ship',
    if (score.reviews > 0) plural(score.reviews, 'review'),
  ];
}

/// A list with nothing to show this week, said as quiet text.
class LeaderboardEmpty extends StatelessWidget {
  const LeaderboardEmpty(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(
      DesktopChrome.groupGap,
      0,
      DesktopChrome.groupGap,
      DesktopChrome.controlGap / 2,
    ),
    child: Text(text, style: DesktopChrome.metadata()),
  );
}
