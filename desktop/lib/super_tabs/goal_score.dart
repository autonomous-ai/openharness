import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../logging/app_log.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/swarm_layout.dart';
import '../shared/widgets/app_menu.dart';
import '../widgets/desktop_chrome.dart';
import 'github_issues.dart';
import 'goal.dart';
import 'visible_tick.dart';

/// How far a project's goal is, in its bar after its name (Swarm plan, rule 1; docs/design/2026-11-11-swarm-goal, option
/// A): `Goal 41 of 60`, the milestones of `agents/GOAL.md` that pass on the default branch out of those it lists.
///
/// A dropdown that stays plain text until hovered (Swarm elements, rule 5). Its menu lists the milestones that do not pass
/// yet, those that fail first, and a row opens its check run on GitHub, or the goal file when nothing ran for it. With
/// every milestone passing there is nothing to list, so it is text alone; a project that states no goal shows nothing.
///
/// It reads the goal itself with `gh`, and only while it is on screen: when its project's bar shows, every [refreshEvery]
/// after that, and when its menu opens. Only this widget redraws when the score moves, never the chat beside it.
class SwarmGoalScore extends StatefulWidget {
  const SwarmGoalScore({
    super.key,
    required this.repository,
    required this.github,
    this.refreshEvery,
  });

  /// The project's repository on GitHub, `owner/name`.
  final String repository;
  final SwarmGitHub github;

  /// How often the goal is read again while it shows; null under test, where nothing ticks.
  final Duration? refreshEvery;

  /// How old a reading may be before the bar coming on screen, or the menu opening, reads again: a person moving between
  /// chats would otherwise spend their GitHub rate limit on a score that has not moved.
  static const freshFor = Duration(minutes: 1);

  @override
  State<SwarmGoalScore> createState() => _SwarmGoalScoreState();
}

class _SwarmGoalScoreState extends State<SwarmGoalScore>
    with WidgetsBindingObserver, VisibleTick<SwarmGoalScore> {
  SwarmGoal? _goal;

  /// Why the last read failed, while the score from before it still shows.
  String? _error;

  /// When the last read started, or the kept score was read.
  DateTime? _readAt;
  String? _shown;
  bool _hovered = false, _focused = false;
  final _menu = MenuController();

  @override
  void initState() {
    super.initState();
    if (widget.refreshEvery case final every?) visibleTick(every);
  }

  @override
  void didChangeDependencies() {
    // Whether it is on screen is known from here on.
    super.didChangeDependencies();
    if (_shown != widget.repository) _show();
  }

  @override
  void didUpdateWidget(SwarmGoalScore old) {
    super.didUpdateWidget(old);
    if (_shown != widget.repository) _show();
  }

  /// The repository's last score shows at once, and GitHub is asked only when that is old.
  void _show() {
    final kept = widget.github.keptGoal(widget.repository);
    _shown = widget.repository;
    _goal = kept?.goal;
    _error = null;
    _readAt = kept?.readAt;
    _readIfOld();
  }

  @override
  void onTick() => unawaited(_read());

  @override
  void onScreenChanged(bool onScreen) => _readIfOld();

  /// Reads when the last reading is older than [SwarmGoalScore.freshFor], and never out of sight.
  void _readIfOld() {
    final readAt = _readAt;
    if (onScreen &&
        (readAt == null ||
            clock.now().difference(readAt) >= SwarmGoalScore.freshFor)) {
      unawaited(_read());
    }
  }

  Future<void> _read() async {
    final repository = widget.repository;
    _readAt = clock.now();
    try {
      final goal = await widget.github.goal(repository);
      if (!mounted || widget.repository != repository) return;
      setState(() {
        _goal = goal;
        _error = null;
      });
    } on SwarmGitHubError catch (error) {
      if (!mounted || widget.repository != repository) return;
      // The last score stays, and its menu says why it may be old.
      setState(() => _error = error.message);
    } catch (error) {
      // A gh that could not be run for a reason it has no words for: the last score stays, and the log names it.
      appLog.warn('super-tabs', 'GitHub goal not read: ${error.runtimeType}');
    }
  }

  void _open(String url) => unawaited(
    launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
  );

  TextStyle _style(Color color) =>
      DesktopChrome.metadata(color: color)
          .copyWith(fontFeatures: const [FontFeature.tabularFigures()]);

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final goal = _goal;
    if (goal == null) return const SizedBox.shrink();
    final words = 'Goal ${goal.passed} of ${goal.total}';
    final rows = goal.notPassing;
    if (rows.isEmpty) {
      return Padding(
        padding: SwarmLayout.goalMargin + SwarmLayout.goalPadding,
        child: Tooltip(
          // With no menu to say it in, a read that failed says why here.
          message:
              _error ??
              'Goal: all ${goal.total} milestones pass on ${goal.branch}',
          child: Text(
            words,
            key: const ValueKey('swarm-goal'),
            maxLines: 1,
            style: _style(DesktopChrome.muted),
          ),
        ),
      );
    }
    final active = _hovered || _focused || _menu.isOpen;
    return Padding(
      padding: SwarmLayout.goalMargin,
      child: AppDropdown(
        controller: _menu,
        width: SwarmLayout.goalMenuWidth,
        consumeOutsideTap: false,
        onOpen: () {
          setState(() {});
          _readIfOld();
        },
        onClose: () {
          if (mounted) setState(() {});
        },
        children: [
          if (_error case final error?)
            Padding(
              padding: SwarmLayout.goalNotePadding,
              child: Text(
                error,
                key: const ValueKey('swarm-goal-stale'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.metadata(),
              ),
            ),
          for (final milestone in rows)
            Tooltip(
              message: milestone.url == null
                  ? 'Opens $goalFile on GitHub'
                  : 'Opens $goalCheck${milestone.name} on GitHub',
              child: AppMenuItem(
                label: milestone.name,
                state: milestone.state == SwarmMilestoneState.fails
                    ? 'fails'
                    : 'not run',
                stateFailed: milestone.state == SwarmMilestoneState.fails,
                onPressed: () => _open(
                  milestone.url ??
                      'https://github.com/${widget.repository}/blob/HEAD/$goalFile',
                ),
              ),
            ),
        ],
        builder: (context, menu, _) => Tooltip(
          message:
              'Goal: ${goal.passed} of ${goal.total} milestones pass on ${goal.branch}',
          child: Semantics(
            button: true,
            child: InkWell(
              key: const ValueKey('swarm-goal'),
              borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
              // Hover is the ink and the chevron, as a quiet heading's is: no fill.
              hoverColor: Colors.transparent,
              onTap: () => menu.isOpen ? menu.close() : menu.open(),
              onHover: (hovered) => setState(() => _hovered = hovered),
              onFocusChange: (focused) => setState(() => _focused = focused),
              child: Padding(
                padding: SwarmLayout.goalPadding,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      words,
                      maxLines: 1,
                      style: _style(
                        active ? DesktopChrome.foreground : DesktopChrome.muted,
                      ),
                    ),
                    const SizedBox(width: SwarmLayout.goalChevronGap),
                    // Its room is kept at rest, so hover moves nothing.
                    Visibility.maintain(
                      visible: active,
                      child: Icon(
                        AppIcons.chevronDown,
                        size: AppIcons.closeSize,
                        color: DesktopChrome.foreground,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
