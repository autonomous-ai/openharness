import 'package:flutter/material.dart';

import '../../core/runtime_model_name.dart';
import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../widgets/desktop_chrome.dart';
import '../../widgets/engine_identity.dart';
import '../section_heading.dart';
import 'format.dart';
import 'model.dart';
import 'person_row.dart';
import 'reader.dart';

/// The spacing scale's 8, and the sidebar rows' height.
const _gap = DesktopChrome.controlGap;
const _rowHeight = 36.0;

/// A model as the sidebar's Models lists it: every engine and effort it ran
/// at as one, its share of the tasks, and how many of its tasks reviewers
/// approved on first review.
class LeaderboardModelShare {
  const LeaderboardModelShare({
    required this.name,
    required this.engine,
    required this.attempts,
    required this.total,
    required this.percent,
    required this.reviewed,
    required this.passed,
  });

  /// "Opus 5.5", "GPT-6.1 Sol"; "Codex, model not reported" when the agent
  /// reported none.
  final String name;

  /// The engine that ran most of its tasks: its icon leads the row.
  final String engine;

  /// Its tasks, of the [total] every model ran.
  final int attempts, total;

  /// Its share of [total], rounded so the rows add up to 100.
  final int percent;
  final int reviewed, passed;

  /// The share as the row says it: under 1% says so, never 0% (it ran
  /// tasks) nor the 1% rounding gave some of several alike to reach 100.
  String get percentLabel => attempts * 100 < total ? '<1%' : '$percent%';
}

/// The models that ran tasks in the last 7 days, or the board's week from a
/// server before those, the largest share first, then by name. Shares round
/// by largest remainder: the floors, then one more point each to the largest
/// remainders until they add up to 100.
List<LeaderboardModelShare> leaderboardModelShares(SuperTabLeaderboard board) {
  final merged =
      <
        String,
        ({Map<String, int> engines, int attempts, int reviewed, int passed})
      >{};
  for (final score in board.recentModels ?? board.byModel) {
    final name = switch (score.model) {
      final String model => modelDisplayName(model),
      null => '${engineIdentity(score.engine).label}, model not reported',
    };
    // One row per model, whichever engine ran it at whichever effort:
    // rows are keyed by name.
    final before = merged[name];
    final engines = before?.engines ?? <String, int>{};
    engines[score.engine] = (engines[score.engine] ?? 0) + score.attempts;
    merged[name] = (
      engines: engines,
      attempts: (before?.attempts ?? 0) + score.attempts,
      reviewed: (before?.reviewed ?? 0) + score.reviewed,
      passed: (before?.passed ?? 0) + score.passed,
    );
  }
  final ran =
      [
        for (final MapEntry(key: name, :value) in merged.entries)
          if (value.attempts > 0) (name: name, model: value),
      ]..sort((a, b) {
        final share = b.model.attempts - a.model.attempts;
        return share != 0 ? share : a.name.compareTo(b.name);
      });
  final total = ran.fold<int>(0, (sum, row) => sum + row.model.attempts);
  final percents = [for (final row in ran) row.model.attempts * 100 ~/ total];
  final short = 100 - percents.fold<int>(0, (sum, p) => sum + p);
  // Of equal remainders, the one listed first.
  int remainder(int i) => ran[i].model.attempts * 100 % total;
  final byRemainder = [for (var i = 0; i < ran.length; i++) i]
    ..sort((a, b) {
      final larger = remainder(b) - remainder(a);
      return larger != 0 ? larger : a - b;
    });
  for (final i in byRemainder.take(short)) {
    percents[i]++;
  }
  return [
    for (var i = 0; i < ran.length; i++)
      LeaderboardModelShare(
        name: ran[i].name,
        // Of two engines alike, the one listed first.
        engine: ran[i].model.engines.entries
            .reduce((a, b) => b.value > a.value ? b : a)
            .key,
        attempts: ran[i].model.attempts,
        total: total,
        percent: percents[i],
        reviewed: ran[i].model.reviewed,
        passed: ran[i].model.passed,
      ),
  ];
}

/// The left sidebar's Models, after Machines (Dee, 2026-10-29 and 10-30):
/// every model by its exact name with its share of the agents' tasks of the
/// last 7 days, largest first, behind its engine's icon; the counts and its
/// first-review pass rate in words on hover and to a screen reader. Its
/// chevron collapses it like every other section. A server before the last
/// 7 days gives the board's week instead, under the same heading. Nothing
/// shows without a board of [projectId], or when no model ran a task.
class LeaderboardModelsSection extends StatelessWidget {
  const LeaderboardModelsSection({
    super.key,
    required this.board,
    required this.projectId,
    required this.collapsed,
    required this.onToggleCollapsed,
    this.now = DateTime.now,
  });
  final SuperTabLeaderboardReader board;

  /// The open project; a board of any other shows nothing.
  final String? projectId;
  final bool collapsed;
  final VoidCallback onToggleCollapsed;
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: board,
    builder: (context, _) {
      final read = board.board;
      if (read == null || read.projectId != projectId) {
        return const SizedBox.shrink();
      }
      final shares = leaderboardModelShares(read);
      if (shares.isEmpty) return const SizedBox.shrink();
      final span = read.recentModels != null
          ? 'in the last 7 days'
          : weekName(board.week, leaderboardWeekOf(now()));
      final style = leaderboardPointsStyle();
      final column = _width(context, '100%', style);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SuperTabSectionHeading(
            'Models',
            key: const ValueKey('super-models-heading'),
            endInset: 0,
            collapsed: collapsed,
            onToggleCollapsed: onToggleCollapsed,
            titleTooltip: read.recentModels != null
                ? 'Share of agent work, last 7 days'
                : 'Share of agent work, $span',
          ),
          if (!collapsed)
            for (final share in shares) _row(share, span, style, column),
        ],
      );
    },
  );

  Widget _row(
    LeaderboardModelShare share,
    String span,
    TextStyle style,
    double column,
  ) {
    final reviews = share.reviewed == 0
        ? 'no first review yet'
        : '${(share.passed * 100 / share.reviewed).round()}% passed first review';
    final words =
        '${share.name}: ${share.attempts} of ${share.total} tasks $span · $reviews';
    return Tooltip(
      key: ValueKey('super-model-${share.name}'),
      message: words,
      excludeFromSemantics: true,
      child: Semantics(
        container: true,
        label: words,
        excludeSemantics: true,
        child: Padding(
          padding: const EdgeInsets.only(bottom: grid.AppDesktop.listRowGap),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: _rowHeight),
            child: Padding(
              // The sidebar's rows: the engine in the icon column, the number
              // where their badges end.
              padding: EdgeInsets.fromLTRB(
                SuperTabSectionHeading.indentFor(0),
                _gap,
                _gap + _gap / 2,
                _gap,
              ),
              child: Row(
                children: [
                  SizedBox(
                    width: SuperTabSectionHeading.actionWidth,
                    child: Center(
                      child: EngineMark(
                        engine: share.engine,
                        size: AppIcons.inlineSize,
                      ),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      share.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.control(
                        color: DesktopChrome.foreground,
                      ),
                    ),
                  ),
                  const SizedBox(width: DesktopChrome.controlGap),
                  SizedBox(
                    width: column,
                    child: Text(
                      share.percentLabel,
                      maxLines: 1,
                      textAlign: TextAlign.right,
                      style: style,
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

  /// The widest percentage at the current text size, so the column holds.
  static double _width(BuildContext context, String text, TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: TextDirection.ltr,
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final width = painter.width;
    painter.dispose();
    return width;
  }
}
