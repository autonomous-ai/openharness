import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_icon_button.dart';
import '../../shared/widgets/skeleton.dart';
import '../../shared/widgets/toolbar_pill.dart';
import '../../widgets/desktop_chrome.dart';
import '../controller.dart';
import '../identity.dart';
import '../model.dart';
import 'format.dart';
import 'shipping.dart';

/// The Swarm's leaderboard (anh Dee, 2026-11-09: "encourage people to build more agents that actually make an impact on the
/// organization"): people ranked by how many of their agents ship, this week or all time. An empty board shows nothing. The board
/// is the Swarm view's, which its left pane's Top Teams shows too; opening the page reads it again.
class SuperTabLeaderboardPage extends StatefulWidget {
  const SuperTabLeaderboardPage({
    super.key,
    required this.controller,
    required this.reader,
    required this.machineName,
  });

  final SuperTabController controller;
  final SuperTabShippingReader reader;

  /// A computer's name as its person knows it, for a failed reading's line.
  final String Function(String machineId) machineName;

  @override
  State<SuperTabLeaderboardPage> createState() => _LeaderboardState();
}

class _LeaderboardState extends State<SuperTabLeaderboardPage> {
  static const _rowHeight = 56.0;

  /// The places that carry a mark, as their mark says them.
  static const _places = {1: 'one', 2: 'two', 3: 'three'};
  SuperTabController get c => widget.controller;
  SuperTabShippingReader get _reader => widget.reader;

  @override
  void initState() {
    super.initState();
    // After this frame: the left pane's Top Teams listens to the same board, and is not rebuilt in the middle of a build. A
    // read already on its way is the fresh one.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !_reader.loading) unawaited(_reader.refresh());
    });
  }

  @override
  void dispose() {
    // All time is this page's choice: the board goes back to this week when it closes.
    if (_reader.allTime) {
      final reader = _reader;
      scheduleMicrotask(() => unawaited(reader.showAllTime(false)));
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: _reader,
      builder: (context, _) {
        final board = _reader.board;
        return ColoredBox(
          color: grid.AppPalette.swarmWelcome,
          child: Padding(
            padding: const EdgeInsets.all(DesktopChrome.panelPadding),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _header(),
                const SizedBox(height: 24),
                if (_reader.error case final error? when board == null)
                  Expanded(child: _failed(error))
                else if (board == null && _reader.loading)
                  const Expanded(child: _Loading())
                else if (board != null) ...[
                  if (_reader.error case final error?) ...[
                    Row(
                      children: [
                        Flexible(
                          child: Text(error, style: DesktopChrome.text()),
                        ),
                        TextButton(
                          key: const ValueKey('leaderboard-retry'),
                          onPressed: _reader.refresh,
                          child: const Text('Retry'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                  ],
                  for (final failure in board.failures) _failure(failure),
                  Expanded(child: _table(board)),
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _header() => Row(
    children: [
      // Beside an open thread the page is narrow: the title gives way before the pills do.
      Flexible(
        child: Text(
          'Leaderboard',
          overflow: TextOverflow.ellipsis,
          style: DesktopChrome.text(medium: true),
        ),
      ),
      const SizedBox(width: 16),
      for (final (label, all) in [
        ('This week', false),
        ('All time', true),
      ]) ...[
        ToolbarPill(
          key: ValueKey('leaderboard-${all ? 'all' : 'week'}'),
          tinted: _reader.allTime == all,
          onTap: () => unawaited(_reader.showAllTime(all)),
          child: Text(
            label,
            style: grid.AppType.caption(
              color: ToolbarPill.tint(
                tinted: _reader.allTime == all,
                enabled: true,
              ),
            ),
          ),
        ),
        const SizedBox(width: 6),
      ],
      const Spacer(),
      AppIconButton(
        icon: AppIcons.refreshCw,
        tooltip: 'Refresh leaderboard',
        onPressed: _reader.loading ? null : _reader.refresh,
        spinning: _reader.loading,
      ),
    ],
  );

  Widget _failed(String error) => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(error, textAlign: TextAlign.center, style: DesktopChrome.text()),
        TextButton(
          key: const ValueKey('leaderboard-retry'),
          onPressed: _reader.refresh,
          child: const Text('Retry'),
        ),
      ],
    ),
  );

  /// A reading of GitHub that failed on one of this person's computers, which only they are told: the numbers stay.
  Widget _failure(ShippingFailure failure) => Container(
    // One computer may say two reasons, one for each of its agents.
    key: ValueKey('leaderboard-failure-${failure.machineId}-${failure.code}'),
    height: 24,
    alignment: Alignment.centerLeft,
    child: Row(
      children: [
        Icon(
          AppIcons.triangleAlert,
          size: 14,
          color: grid.AppPalette.textSecondary,
          semanticLabel: 'Reading paused',
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            '${widget.machineName(failure.machineId)} · ${shippingFailureText(failure.code)}',
            overflow: TextOverflow.ellipsis,
            style: grid.AppType.caption(color: grid.AppPalette.textSecondary),
          ),
        ),
      ],
    ),
  );

  Widget _table(SuperTabShipping board) {
    final people = {
      for (final person in c.snapshot?.people ?? const <SuperTabPerson>[])
        person.id: person,
    };
    return ListView.builder(
      itemExtent: _rowHeight,
      itemCount: board.people.length,
      itemBuilder: (context, index) {
        final score = board.people[index];
        final person = people[score.personId];
        // By account, never by name: two teammates can share one.
        final own = score.personId == c.accountId;
        return Container(
          key: ValueKey('leaderboard-row-${score.personId}'),
          height: _rowHeight,
          padding: const EdgeInsets.symmetric(
            horizontal: DesktopChrome.panelPadding / 2,
          ),
          decoration: BoxDecoration(
            color: own ? grid.AppSurface.selectedFill : null,
            border: Border(bottom: BorderSide(color: grid.AppPalette.divider)),
          ),
          child: Row(
            children: [
              SizedBox(
                width: 48,
                child: Row(
                  children: [
                    Text(
                      '${score.rank}',
                      style: grid.AppType.label(
                        color: grid.AppPalette.textSecondary,
                        fontWeight: FontWeight.w700,
                        fontFeatures: grid.AppFont.tabularFigures,
                      ),
                    ),
                    // The top three's mark sits beside their place, never in place of it (Team and celebration, design
                    // system); the numeral says which.
                    if (_places[score.rank] case final place?) ...[
                      const SizedBox(width: 4),
                      Icon(
                        AppIcons.trophy,
                        size: 14,
                        color: score.rank == 1
                            ? grid.AppPalette.swarmAccent
                            : grid.AppPalette.textSecondary,
                        semanticLabel:
                            'Number $place ${board.week == null ? 'of all time' : 'this week'}',
                      ),
                    ],
                  ],
                ),
              ),
              if (person != null) SuperTabAvatar.person(person, size: 28),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            person?.shownName ?? score.displayName,
                            key: ValueKey(
                              'leaderboard-person-${score.personId}',
                            ),
                            overflow: TextOverflow.ellipsis,
                            style: DesktopChrome.text(medium: score.rank == 1),
                          ),
                        ),
                        if (own) ...[
                          const SizedBox(width: 8),
                          Text(
                            'You',
                            style: grid.AppType.caption(
                              color: grid.AppPalette.textSecondary,
                            ),
                          ),
                        ],
                      ],
                    ),
                    Text(
                      '${plural(score.agentsShipping, 'agent')} shipping · Level ${score.level}',
                      key: ValueKey('leaderboard-detail-${score.personId}'),
                      overflow: TextOverflow.ellipsis,
                      style: grid.AppType.caption(
                        color: grid.AppPalette.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
              SizedBox(
                width: 72,
                child: Text(
                  shippingPoints(score.points),
                  key: ValueKey('leaderboard-points-${score.personId}'),
                  textAlign: TextAlign.right,
                  style: grid.AppType.label(
                    color: grid.AppPalette.textPrimary,
                    fontWeight: grid.AppFont.semibold,
                    fontFeatures: grid.AppFont.tabularFigures,
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Rows of the shape of the answer while it is on its way.
class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) => Column(
    children: [
      for (var i = 0; i < 3; i++)
        const SizedBox(
          height: 56,
          child: Align(alignment: Alignment.centerLeft, child: SkeletonLine()),
        ),
    ],
  );
}
