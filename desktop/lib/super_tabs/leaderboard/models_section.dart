import 'package:flutter/material.dart';

import '../../core/runtime_model_name.dart';
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

/// Fewer first reviews than this say nothing about a model.
const leaderboardModelMinReviewed = 3;

/// How many models the sidebar lists until its heading shows them all.
const leaderboardModelsShown = 3;

/// A model as the sidebar's Models lists it: every engine and effort it ran
/// at as one, and how many of its attempts reviewers approved on first review.
class LeaderboardModelShare {
  const LeaderboardModelShare({
    required this.name,
    required this.reviewed,
    required this.passed,
  });

  /// "Opus 5.5", "GPT-6.1 Sol"; the engine's name when it reported no model.
  final String name;
  final int reviewed, passed;

  int get percent => (passed * 100 / reviewed).round();
}

/// The week's models with at least [leaderboardModelMinReviewed] first
/// reviews, the most often approved first; of two alike, the one reviewed
/// more, then by name.
List<LeaderboardModelShare> leaderboardModelShares(SuperTabLeaderboard board) {
  final merged = <String, ({String name, int reviewed, int passed})>{};
  for (final score in board.byModel) {
    final name = switch (score.model) {
      final String model => modelDisplayName(model),
      null => engineIdentity(score.engine).label,
    };
    // One row per model, whichever engine ran it at whichever effort:
    // rows are keyed by name.
    final before = merged[name];
    merged[name] = (
      name: name,
      reviewed: (before?.reviewed ?? 0) + score.reviewed,
      passed: (before?.passed ?? 0) + score.passed,
    );
  }
  final shares = [
    for (final model in merged.values)
      if (model.reviewed >= leaderboardModelMinReviewed)
        LeaderboardModelShare(
          name: model.name,
          reviewed: model.reviewed,
          passed: model.passed,
        ),
  ];
  shares.sort((a, b) {
    final share = b.passed * a.reviewed - a.passed * b.reviewed;
    if (share != 0) return share;
    final reviewed = b.reviewed - a.reviewed;
    return reviewed != 0 ? reviewed : a.name.compareTo(b.name);
  });
  return shares;
}

/// The left sidebar's Models, after Machines (Dee, 2026-10-29): the models
/// whose work reviewers approved most often on first review in the week the
/// right pane shows, each as a bare percentage, the counts in words on hover
/// and to a screen reader. The heading shows them all. Nothing shows without
/// a board of [projectId], or when no model has enough first reviews.
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
            'Models',
            key: const ValueKey('super-models-heading'),
            endInset: 0,
            startInset: SuperTabSectionHeading.indentFor(0),
            collapsed: more ? !_all : null,
            onToggleCollapsed: more ? () => setState(() => _all = !_all) : null,
          ),
          for (final share
              in _all ? shares : shares.take(leaderboardModelsShown))
            _row(share, week, style, column),
        ],
      );
    },
  );

  Widget _row(
    LeaderboardModelShare share,
    String week,
    TextStyle style,
    double column,
  ) {
    final words =
        '${share.passed} of ${share.reviewed} approved on first review $week';
    return Tooltip(
      key: ValueKey('super-model-${share.name}'),
      message: words,
      excludeFromSemantics: true,
      child: Semantics(
        container: true,
        label: '${share.name}: $words',
        excludeSemantics: true,
        child: Padding(
          padding: const EdgeInsets.only(bottom: grid.AppDesktop.listRowGap),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: _rowHeight),
            child: Padding(
              // The sidebar's rows: names after the icon column, the number
              // where their badges end.
              padding: EdgeInsets.fromLTRB(
                SuperTabSectionHeading.indentFor(0) +
                    SuperTabSectionHeading.actionWidth,
                _gap,
                _gap + _gap / 2,
                _gap,
              ),
              child: Row(
                children: [
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
