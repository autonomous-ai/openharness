import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_select_field.dart';
import '../../shared/widgets/skeleton.dart';
import '../../widgets/desktop_chrome.dart';
import 'format.dart';
import 'goal_bar.dart';
import 'person_row.dart';
import 'reader.dart';
import 'waiting_line.dart';

/// The Swarm's human leaderboard, a fixed-width column on the right: the team
/// goal, everyone's three numbers this week with medals for the top three, and
/// who agents wait on now. People compete for fun; the reward is shared.
class SuperTabLeaderboardColumn extends StatefulWidget {
  const SuperTabLeaderboardColumn({
    super.key,
    required this.reader,
    required this.projectId,
    required this.viewerId,
    required this.nameOf,
    required this.onAnswer,
    this.now = DateTime.now,
  });

  static const width = 300.0;

  final SuperTabLeaderboardReader reader;
  final String projectId, viewerId;
  final String Function(String personId) nameOf;

  /// Opens a conversation where an agent waits on a person.
  final ValueChanged<String> onAnswer;
  final DateTime Function() now;

  @override
  State<SuperTabLeaderboardColumn> createState() =>
      _SuperTabLeaderboardColumnState();
}

class _SuperTabLeaderboardColumnState extends State<SuperTabLeaderboardColumn> {
  String? _open;

  @override
  void initState() {
    super.initState();
    unawaited(widget.reader.show(widget.projectId));
  }

  @override
  void didUpdateWidget(SuperTabLeaderboardColumn old) {
    super.didUpdateWidget(old);
    if (old.reader != widget.reader) old.reader.hide();
    if (old.projectId != widget.projectId || old.reader != widget.reader) {
      _open = null;
      unawaited(widget.reader.show(widget.projectId));
    }
  }

  @override
  void dispose() {
    widget.reader.hide();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: widget.reader,
      builder: (context, _) {
        final reader = widget.reader, board = reader.board;
        final current = leaderboardWeekOf(widget.now());
        final top = board?.people.firstOrNull?.points ?? 0;
        return ColoredBox(
          color: DesktopChrome.surface,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _Header(
                week: reader.week,
                current: current,
                onWeek: (week) =>
                    reader.showWeek(week == current ? null : week),
              ),
              if (reader.error != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                  child: Text(reader.error!, style: DesktopChrome.metadata()),
                ),
              if (board == null)
                const Expanded(
                  child: SkeletonList(
                    rows: 5,
                    padding: EdgeInsets.symmetric(horizontal: 16),
                  ),
                )
              else ...[
                LeaderboardGoalBar(
                  goal: board.goal,
                  weekName: weekName(reader.week, current),
                ),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    children: [
                      for (final person in board.people)
                        LeaderboardPersonRow(
                          score: person,
                          name: widget.nameOf(person.personId),
                          topPoints: top,
                          open: _open == person.personId,
                          onTap: () => setState(
                            () => _open = _open == person.personId
                                ? null
                                : person.personId,
                          ),
                        ),
                    ],
                  ),
                ),
                LeaderboardWaitingLine(
                  waiting: board.waiting,
                  viewerId: widget.viewerId,
                  nameOf: widget.nameOf,
                  onAnswer: widget.onAnswer,
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({
    required this.week,
    required this.current,
    required this.onWeek,
  });
  final int? week;
  final int current;
  final ValueChanged<int> onWeek;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 12, 12, 8),
    child: Row(
      children: [
        Expanded(
          child: Text(
            'Humans · ${weekName(week, current)}',
            style: DesktopChrome.heading(),
          ),
        ),
        AppSelectField<int>(
          key: const ValueKey('leaderboard-week'),
          value: week ?? current,
          width: 120,
          height: DesktopChrome.compactControlHeight,
          semanticLabel: 'Week',
          options: [
            for (var back = 0; back < 4; back++)
              SelectOption(
                value: current - back * weekMs,
                label: capitalized(weekName(current - back * weekMs, current)),
              ),
          ],
          onChanged: onWeek,
        ),
      ],
    ),
  );
}
