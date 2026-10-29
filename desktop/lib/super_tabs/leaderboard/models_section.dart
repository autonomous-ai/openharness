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

/// How many models the sidebar lists until its heading shows them all.
const leaderboardModelsShown = 3;

/// A model as the sidebar's Models lists it: every engine and effort it ran
/// at as one, its share of the week's tasks, and how many of its tasks
/// reviewers approved on first review.
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

  /// "Opus 5.5", "GPT-6.1 Sol"; the engine's name when it reported no model.
  final String name;

  /// The engine that ran most of its tasks: its icon leads the row. Null for
  /// [LeaderboardModelShare.other], which no one engine ran.
  final String? engine;

  /// Its tasks, of the [total] every model ran.
  final int attempts, total;

  /// Its share of [total], rounded so the week's rows add up to 100.
  final int percent;
  final int reviewed, passed;

  /// The models behind the heading as one row, so the rows shown add up to
  /// 100 too: its percent is the sum of theirs, never a rounding of its own.
  factory LeaderboardModelShare.other(List<LeaderboardModelShare> rest) =>
      LeaderboardModelShare(
        name: 'Other',
        engine: null,
        attempts: rest.fold(0, (sum, share) => sum + share.attempts),
        total: rest.first.total,
        percent: rest.fold(0, (sum, share) => sum + share.percent),
        reviewed: rest.fold(0, (sum, share) => sum + share.reviewed),
        passed: rest.fold(0, (sum, share) => sum + share.passed),
      );
}

/// The week's models that ran tasks, the largest share first, then by name.
/// Shares round by largest remainder: the floors, then one more point each
/// to the largest remainders until they add up to 100.
List<LeaderboardModelShare> leaderboardModelShares(SuperTabLeaderboard board) {
  final merged =
      <
        String,
        ({Map<String, int> engines, int attempts, int reviewed, int passed})
      >{};
  for (final score in board.byModel) {
    final name = switch (score.model) {
      final String model => modelDisplayName(model),
      null => engineIdentity(score.engine).label,
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

/// The left sidebar's Models, after Machines (Dee, 2026-10-29): each model's
/// share of the tasks of the week the right pane shows, behind its engine's
/// icon, the counts and its first-review pass rate in words on hover and to a
/// screen reader. Behind the first [leaderboardModelsShown] the rest are one
/// Other row, so the rows shown add up to 100%; the heading names them all.
/// Nothing shows without a board of [projectId], or when no model ran a task
/// that week.
class LeaderboardModelsSection extends StatefulWidget {
  const LeaderboardModelsSection({
    super.key,
    required this.board,
    required this.projectId,
    this.now = DateTime.now,
  });
  final SuperTabLeaderboardReader board;

  /// The open project; a board of any other shows nothing.
  final String? projectId;
  final DateTime Function() now;

  @override
  State<LeaderboardModelsSection> createState() =>
      _LeaderboardModelsSectionState();
}

class _LeaderboardModelsSectionState extends State<LeaderboardModelsSection> {
  var _all = false;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.board,
    builder: (context, _) {
      final board = widget.board.board;
      if (board == null || board.projectId != widget.projectId) {
        return const SizedBox.shrink();
      }
      final shares = leaderboardModelShares(board);
      if (shares.isEmpty) return const SizedBox.shrink();
      final more = shares.length > leaderboardModelsShown;
      final week = weekName(widget.board.week, leaderboardWeekOf(widget.now()));
      final style = leaderboardPointsStyle();
      final column = _width(context, '100%', style);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SuperTabSectionHeading(
            'Models · $week',
            key: const ValueKey('super-models-heading'),
            endInset: 0,
            startInset: SuperTabSectionHeading.indentFor(0),
            collapsed: more ? !_all : null,
            onToggleCollapsed: more ? () => setState(() => _all = !_all) : null,
          ),
          for (final share
              in _all ? shares : shares.take(leaderboardModelsShown))
            _row(share, week, style, column),
          if (more && !_all)
            _row(
              LeaderboardModelShare.other(
                shares.sublist(leaderboardModelsShown),
              ),
              week,
              style,
              column,
              key: const ValueKey('super-models-other'),
            ),
        ],
      );
    },
  );

  Widget _row(
    LeaderboardModelShare share,
    String week,
    TextStyle style,
    double column, {
    Key? key,
  }) {
    final reviews = share.reviewed == 0
        ? 'no first review yet'
        : '${(share.passed * 100 / share.reviewed).round()}% passed first review';
    final words =
        '${share.name}: ${share.attempts} of ${share.total} tasks $week · $reviews';
    return Tooltip(
      key: key ?? ValueKey('super-model-${share.name}'),
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
                    // Other has no engine: its icon column stays empty.
                    child: share.engine == null
                        ? null
                        : Center(
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
                      '${share.percent}%',
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
