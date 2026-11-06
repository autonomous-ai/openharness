import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_icon_button.dart';
import '../../widgets/desktop_chrome.dart';
import '../controller.dart';
import '../identity.dart';
import 'model.dart';

/// The weekly org board, refreshed by the Swarm's existing change feed.
/// It owns no poll timer and reads only while this page is mounted.
class SuperTabWeeklyLeaderboardPage extends StatefulWidget {
  const SuperTabWeeklyLeaderboardPage({super.key, required this.controller});
  final SuperTabController controller;

  @override
  State<SuperTabWeeklyLeaderboardPage> createState() => _WeeklyBoardState();
}

class _WeeklyBoardState extends State<SuperTabWeeklyLeaderboardPage> {
  SuperTabLeaderboard? _board;
  String? _error;
  Object? _stamp;
  bool _busy = false, _again = false;
  int _generation = 0;
  SuperTabController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.addListener(_follow);
    _follow();
  }

  @override
  void didUpdateWidget(SuperTabWeeklyLeaderboardPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller == c) return;
    oldWidget.controller.removeListener(_follow);
    c.addListener(_follow);
    _stamp = null;
    _follow();
  }

  void _follow() {
    final stamp = (
      c.lastChangedAt,
      c.accessRevoked,
      c.snapshot?.projects.map((p) => p.id).join(','),
    );
    if (stamp == _stamp) return;
    _stamp = stamp;
    _refresh();
  }

  void _refresh() {
    _generation++;
    // Clear old audience data immediately, including while a request is in flight.
    setState(() {
      _board = null;
      _error = null;
    });
    if (_busy) {
      _again = true;
      return;
    }
    unawaited(_load());
  }

  Future<void> _load() async {
    if (c.accessRevoked) {
      setState(() => _error = 'This leaderboard is no longer available.');
      return;
    }
    final project = c.snapshot?.projects.firstOrNull?.id;
    if (project == null) return;
    final generation = _generation;
    final controller = c;
    setState(() => _busy = true);
    try {
      final answer = await controller
          .request(
            'GET',
            '/api/super-tabs/${Uri.encodeComponent(controller.tabId)}/leaderboard'
                '?projectId=${Uri.encodeQueryComponent(project)}&scope=all',
          )
          .timeout(const Duration(seconds: 15));
      if (!mounted || generation != _generation) return;
      final board = SuperTabLeaderboard.fromJson(answer);
      if (!board.allProjects ||
          board.period != null ||
          board.people.any(
            (p) => p.accepted == null || p.agentsBrought == null,
          )) {
        _error = 'The weekly org leaderboard needs a newer server.';
      } else {
        _board = board;
      }
    } on SuperTabFailure catch (failure) {
      if (!mounted || generation != _generation) return;
      _error = failure.statusCode == 403 || failure.statusCode == 404
          ? 'This leaderboard is no longer available.'
          : failure.message;
    } catch (_) {
      if (!mounted || generation != _generation) return;
      _error = "Couldn't load the leaderboard. Try again.";
    } finally {
      if (mounted) {
        setState(() => _busy = false);
        if (_again) {
          _again = false;
          unawaited(_load());
        }
      }
    }
  }

  @override
  void dispose() {
    c.removeListener(_follow);
    _generation++;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final board = _board;
    return ColoredBox(
      color: grid.AppPalette.swarmWelcome,
      child: Padding(
        padding: const EdgeInsets.all(DesktopChrome.panelPadding),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'This week',
                        style: DesktopChrome.text(medium: true),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Across the projects you can read',
                        style: DesktopChrome.metadata(
                          color: DesktopChrome.muted,
                        ),
                      ),
                    ],
                  ),
                ),
                AppIconButton(
                  icon: AppIcons.refreshCw,
                  tooltip: 'Refresh leaderboard',
                  onPressed: _busy ? null : _refresh,
                  spinning: _busy,
                ),
              ],
            ),
            const SizedBox(height: 24),
            if (_error case final error?)
              Expanded(
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        error,
                        textAlign: TextAlign.center,
                        style: DesktopChrome.text(),
                      ),
                      TextButton(
                        onPressed: _refresh,
                        child: const Text('Retry'),
                      ),
                    ],
                  ),
                ),
              )
            else if (_busy)
              const Expanded(
                child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
              )
            else if (board == null || board.people.isEmpty)
              Expanded(
                child: Center(
                  child: Text(
                    c.snapshot?.projects.isEmpty == true
                        ? 'No projects to show yet.'
                        : 'A fresh week. Pick up a task and start shipping.',
                    style: DesktopChrome.text(),
                    textAlign: TextAlign.center,
                  ),
                ),
              )
            else
              Expanded(child: _table(board)),
            const SizedBox(height: 16),
            Text(
              'Agents brought earn no points.',
              style: DesktopChrome.metadata(color: DesktopChrome.muted),
            ),
          ],
        ),
      ),
    );
  }

  Widget _table(SuperTabLeaderboard board) => LayoutBuilder(
    builder: (context, constraints) {
      return SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: SizedBox(
          width: math.max(860, constraints.maxWidth),
          height: constraints.maxHeight,
          child: Column(
            children: [
              _line([
                const SizedBox(width: 40),
                Expanded(
                  child: Text(
                    'Teammate',
                    style: DesktopChrome.metadata(color: DesktopChrome.muted),
                  ),
                ),
                for (final title in [
                  'Shipped',
                  'Accepted',
                  'Unblocked',
                  'Streak',
                  'Agents',
                  'Points',
                ])
                  _cell(title, heading: true),
              ], heading: true),
              Expanded(
                child: ListView.builder(
                  itemCount: board.people.length,
                  itemBuilder: (context, index) {
                    final score = board.people[index];
                    final person = c.snapshot?.people
                        .where((p) => p.id == score.personId)
                        .firstOrNull;
                    return _line([
                      SizedBox(
                        width: 40,
                        child: score.rank == 1 && score.points > 0
                            ? Icon(
                                AppIcons.trophy,
                                size: 18,
                                color: grid.AppPalette.swarmAccent,
                              )
                            : Text(
                                '${score.rank}',
                                style: DesktopChrome.metadata(
                                  color: DesktopChrome.muted,
                                ),
                              ),
                      ),
                      Expanded(
                        child: Row(
                          children: [
                            if (person != null)
                              SuperTabAvatar.person(person, size: 28),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                score.displayName ??
                                    person?.shownName ??
                                    'Teammate',
                                key: ValueKey(
                                  'weekly-person-${score.personId}',
                                ),
                                overflow: TextOverflow.ellipsis,
                                style: DesktopChrome.text(
                                  medium: score.rank == 1 && score.points > 0,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      _cell('${score.shipped}', strong: true),
                      _cell('${score.accepted}'),
                      _cell('${score.unblocked}'),
                      _cell('${score.streakDays}d'),
                      _cell(
                        '${score.agentsBrought}',
                        key: ValueKey('weekly-agents-${score.personId}'),
                      ),
                      _cell('${score.points}', strong: true),
                    ]);
                  },
                ),
              ),
            ],
          ),
        ),
      );
    },
  );

  Widget _cell(
    String text, {
    bool heading = false,
    bool strong = false,
    Key? key,
  }) => SizedBox(
    width: 84,
    child: Text(
      text,
      key: key,
      textAlign: TextAlign.right,
      style: heading
          ? DesktopChrome.metadata(color: DesktopChrome.muted)
          : grid.AppType.label(
              color: grid.AppPalette.textPrimary,
              fontWeight: strong ? grid.AppFont.semibold : grid.AppFont.regular,
              fontFeatures: grid.AppFont.tabularFigures,
            ),
    ),
  );

  Widget _line(List<Widget> children, {bool heading = false}) => Container(
    height: heading ? 36 : 56,
    padding: const EdgeInsets.symmetric(
      horizontal: DesktopChrome.panelPadding / 2,
    ),
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: grid.AppPalette.divider)),
    ),
    child: Row(children: children),
  );
}
