import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';

import 'identity.dart';
import 'model.dart';
import 'swarm_leaderboard_reader.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// Opens [projectId]'s leaderboard over [context]'s page.
void openSwarmLeaderboard(
  BuildContext context,
  String swarmId,
  String projectId,
) => unawaited(
  Navigator.of(context).push(
    phoneRoute(
      (_) => SwarmLeaderboardPage(swarmId: swarmId, projectId: projectId),
      listensForItself: true,
    ),
  ),
);

/// One project's leaderboard, in the Team first design Tony chose: the
/// team's week leads — what it shipped, big, and the week before — with the
/// week picker in its corner; then "Who moved it", a card for each person
/// with their initial, name and cup, what they shipped, unblocked and lent in
/// words, and their points. A card opens the person's week in a sheet. First
/// place sparkles once as the page opens, unless Reduce Motion is on.
///
/// People are named from the members its Swarm already read; the board
/// itself is read on open, on a pull, on another week, and every few minutes
/// while the app is in front ([SwarmLeaderboardReader]).
class SwarmLeaderboardPage extends StatefulWidget {
  const SwarmLeaderboardPage({
    super.key,
    required this.swarmId,
    required this.projectId,
    this.now = DateTime.now,
  });

  final String swarmId, projectId;

  /// What tells this week from the ones before.
  final DateTime Function() now;

  @override
  State<SwarmLeaderboardPage> createState() => _SwarmLeaderboardPageState();
}

class _SwarmLeaderboardPageState extends State<SwarmLeaderboardPage> {
  SwarmSession? _session;

  /// The Swarm's reader, for the members' names; null until it is listed.
  SwarmReader? _swarm;
  SwarmLeaderboardReader? _board;

  /// Whether the first board since the page opened has landed, and whether
  /// first place sparkles for it.
  bool _landed = false, _sparkling = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    if (session == _session) return;
    _session?.inbox.removeListener(_attach);
    _session?.leave();
    _session = session?..enter();
    // Another account, or none: nothing of the last one's board stays, and
    // its reads stop.
    _forget();
    session?.inbox.addListener(_attach);
    _attach();
    // Not listed yet: the inbox tells when it is.
    if (_swarm == null) unawaited(session?.inbox.refresh());
  }

  /// Follows the Swarm's reader once the inbox has one, and reads the board
  /// through it.
  void _attach() {
    final session = _session;
    final swarm = session?.inbox.reader(widget.swarmId);
    if (session == null || swarm == null || identical(swarm, _swarm)) return;
    _swarm?.removeListener(_changed);
    _swarm = swarm..addListener(_changed);
    _board?.dispose();
    _board = SwarmLeaderboardReader(
      tabId: swarm.tabId,
      projectId: widget.projectId,
      request: swarm.request,
      inFront: () => session.inbox.shown,
    )..addListener(_boardChanged);
    _board!.start();
    _changed();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  void _forget() {
    _swarm?.removeListener(_changed);
    _swarm = null;
    _board?.dispose();
    _board = null;
    _landed = _sparkling = false;
  }

  void _boardChanged() {
    final board = _board?.board;
    if (!_landed && board != null) {
      _landed = true;
      _sparkling =
          !MediaQuery.disableAnimationsOf(context) &&
          board.people.firstOrNull?.medal == SwarmMedal.gold;
    }
    _changed();
  }

  @override
  void dispose() {
    _session?.inbox.removeListener(_attach);
    _session?.leave();
    _swarm?.removeListener(_changed);
    _board?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final snapshot = _swarm?.snapshot;
    final project = snapshot?.projects
        .where((p) => p.id == widget.projectId)
        .firstOrNull;
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SwarmTopBar(
              leading: SwarmBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              title: 'Leaderboard',
              subtitle: project?.name,
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _board?.refresh ?? () async {},
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: EdgeInsets.fromLTRB(
                    12,
                    0,
                    12,
                    MediaQuery.paddingOf(context).bottom + 28,
                  ),
                  children: _body(context, snapshot),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _body(BuildContext context, SuperTabSnapshot? snapshot) {
    final reader = _board;
    final board = reader?.board;
    final current = swarmWeekOf(widget.now());
    // Signed out, or Swarm turned off: no account's board to show.
    if (_session == null) return const [];
    if (reader != null && reader.unavailable) {
      return [
        const SizedBox(height: 12),
        SwarmRow.line(
          "This Swarm's server has no leaderboard yet.",
          key: const ValueKey('swarm-leaderboard-unavailable'),
          lines: 2,
        ),
      ];
    }
    // The members name the people; until the Swarm is read, the rows wait.
    final error = reader?.error ?? (snapshot == null ? _swarm?.error : null);
    final people = snapshot?.people ?? const <SuperTabPerson>[];
    String nameOf(String id) =>
        switch (people.where((p) => p.id == id).firstOrNull) {
          final person? => superTabPersonName(person.email),
          null => 'Former member',
        };
    final week = swarmWeekName(reader?.week, current);
    final pickWeek = reader == null
        ? null
        : () => unawaited(_pickWeek(context, reader, current));
    return [
      if (board != null)
        _TeamCard(
          week: week,
          shipped: board.shipped,
          before: board.shippedBefore,
          onWeek: pickWeek,
        )
      else
        Align(
          alignment: Alignment.centerRight,
          child: _WeekButton(label: week, onTap: pickWeek),
        ),
      if (error != null)
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
          child: SwarmRow.line(
            error,
            key: const ValueKey('swarm-leaderboard-error'),
            lines: 3,
          ),
        ),
      if (board == null || snapshot == null)
        if (error == null) ...[
          if (board == null)
            const SkeletonBlock(
              child: Padding(
                padding: EdgeInsets.only(bottom: 14),
                child: Skeleton(height: 128, radius: 18),
              ),
            ),
          SwarmSkeletonRows(
            id: 'swarm-leaderboard-loading',
            rows: 4,
            round: true,
          ),
        ] else
          Align(
            alignment: Alignment.centerLeft,
            child: SwarmButton(
              label: 'Try again',
              onPressed: () => unawaited(
                Future.wait([
                  ?reader?.refresh(),
                  if (snapshot == null) ?_swarm?.refresh(),
                ]),
              ),
            ),
          )
      else if (board.people.isEmpty)
        SwarmRow.line('Nobody is on the board yet.')
      else ...[
        const SwarmCaption('Who moved it', first: true),
        for (final (i, score) in board.people.indexed)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: _PersonCard(
              key: ValueKey('swarm-leaderboard-person-${score.personId}'),
              score: score,
              name: nameOf(score.personId),
              sparkle: i == 0 && _sparkling
                  ? () => setState(() => _sparkling = false)
                  : null,
              onTap: () => unawaited(
                _showPerson(context, score, nameOf(score.personId)),
              ),
            ),
          ),
      ],
    ];
  }

  /// The four weeks the board keeps, this one first, in a sheet.
  Future<void> _pickWeek(
    BuildContext context,
    SwarmLeaderboardReader reader,
    int current,
  ) async {
    final shown = reader.week ?? current;
    final week = await showModalBottomSheet<int>(
      context: context,
      backgroundColor: AppGlass.rowFill,
      barrierColor: Colors.black.withValues(alpha: .55),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (context) => _Sheet(
        title: 'Week',
        closeKey: 'swarm-leaderboard-week-close',
        children: [
          for (var back = 0; back < 4; back++)
            _WeekOption(
              key: ValueKey('swarm-leaderboard-week-$back'),
              label: swarmWeekName(current - back * swarmWeekMs, current),
              selected: shown == current - back * swarmWeekMs,
              onTap: () =>
                  Navigator.of(context).pop(current - back * swarmWeekMs),
            ),
        ],
      ),
    );
    if (week == null || !mounted) return;
    await reader.showWeek(week == current ? null : week);
  }

  /// [score]'s week in a sheet, as the desktop shows it when a name is
  /// clicked.
  Future<void> _showPerson(
    BuildContext context,
    SwarmScore score,
    String name,
  ) => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppGlass.rowFill,
    barrierColor: Colors.black.withValues(alpha: .55),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (context) => _Sheet(
      key: const ValueKey('swarm-leaderboard-sheet'),
      title: name,
      leading: SwarmAvatar(id: score.personId, name: name),
      closeKey: 'swarm-leaderboard-sheet-close',
      children: [
        for (final (label, value) in swarmPersonWeek(score))
          _WeekLine(label: label, value: value),
      ],
    ),
  );
}

/// The team's week first (the Team first design Tony chose): what it
/// shipped in the week shown, big, and what it shipped the week before, on
/// the accent; the week picker in its corner.
class _TeamCard extends StatelessWidget {
  const _TeamCard({
    required this.week,
    required this.shipped,
    required this.before,
    required this.onWeek,
  });

  /// "This week", "Last week", …: the week shown.
  final String week;
  final int shipped, before;
  final VoidCallback? onWeek;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final fill = AppPalette.accentOnSurface;
    // Ink that reads on whichever accent the palette has.
    final ink = ThemeData.estimateBrightnessForColor(fill) == Brightness.dark
        ? Colors.white
        : const Color(0xFF181818);
    const figures = [FontFeature.tabularFigures()];
    final earlier = week == 'This week' ? 'last week' : 'the week before';
    return Semantics(
      container: true,
      label: 'Team ${week.toLowerCase()}: $shipped shipped, $before $earlier',
      child: Container(
        key: const ValueKey('swarm-leaderboard-team'),
        margin: const EdgeInsets.fromLTRB(0, 6, 0, 18),
        padding: const EdgeInsets.fromLTRB(18, 4, 4, 16),
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(18),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: ExcludeSemantics(
                    child: Text(
                      'Team ${week.toLowerCase()}',
                      style: TextStyle(
                        color: ink,
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ),
                _WeekButton(label: week, onTap: onWeek, ink: ink),
              ],
            ),
            ExcludeSemantics(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  const Text('🚀', style: TextStyle(fontSize: 34)),
                  const SizedBox(width: 8),
                  Text(
                    '$shipped',
                    style: TextStyle(
                      color: ink,
                      fontSize: 44,
                      fontWeight: FontWeight.w800,
                      height: 1.05,
                      fontFeatures: figures,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    'shipped',
                    style: TextStyle(
                      color: ink,
                      fontSize: 17,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 4),
            ExcludeSemantics(
              child: Text(
                '$before shipped $earlier',
                style: TextStyle(
                  color: ink.withValues(alpha: .85),
                  fontSize: 14,
                  fontFeatures: figures,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The week shown and its arrow: opens the week picker.
class _WeekButton extends StatelessWidget {
  const _WeekButton({required this.label, required this.onTap, this.ink});

  final String label;
  final VoidCallback? onTap;

  /// Its colour on a fill; the page's own text colours without one.
  final Color? ink;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: 'Week: $label',
    excludeSemantics: true,
    child: InkWell(
      key: const ValueKey('swarm-leaderboard-week'),
      borderRadius: BorderRadius.circular(10),
      onTap: onTap == null
          ? null
          : () {
              HapticFeedback.selectionClick();
              onTap!();
            },
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 44, minWidth: 44),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label,
                style: TextStyle(
                  color: ink ?? AppPalette.textPrimary,
                  fontSize: 15,
                ),
              ),
              const SizedBox(width: 4),
              Icon(
                LucideIcons.chevronDown300,
                size: 18,
                color: ink ?? AppPalette.textSecondary,
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

/// One person on the board as a card: their initial, name and cup, what
/// they shipped, unblocked and lent in words, and their points; first
/// place's points on gold.
class _PersonCard extends StatelessWidget {
  const _PersonCard({
    super.key,
    required this.score,
    required this.name,
    required this.onTap,
    this.sparkle,
  });

  final SwarmScore score;
  final String name;
  final VoidCallback onTap;

  /// First place sparkling as the page opens; called once it has.
  final VoidCallback? sparkle;

  /// First place's points, on a gold that reads on either ground.
  static const _gold = Color(0xFFD9A520);

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    const figures = [FontFeature.tabularFigures()];
    final medal = score.medal;
    return Semantics(
      button: true,
      label:
          '$name, place ${score.rank}, ${score.points} points, '
          '${score.shipped} shipped, ${score.unblocked} unblocked, '
          '${swarmHours(score.lentMs)} hours lent',
      excludeSemantics: true,
      child: Material(
        color: AppGlass.rowFill,
        borderRadius: BorderRadius.circular(14),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () {
            HapticFeedback.selectionClick();
            onTap();
          },
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 64),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
              child: Row(
                children: [
                  SwarmAvatar(id: score.personId, name: name, size: 40),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Row(
                          children: [
                            Flexible(
                              child: Text(
                                name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: AppPalette.textPrimary,
                                  fontSize: 16,
                                  fontWeight: FontWeight.w600,
                                  height: 1.3,
                                ),
                              ),
                            ),
                            if (medal != null) ...[
                              const SizedBox(width: 6),
                              Stack(
                                clipBehavior: Clip.none,
                                children: [
                                  Text(
                                    swarmCup(medal),
                                    style: const TextStyle(
                                      fontSize: 17,
                                      height: 1.1,
                                    ),
                                  ),
                                  if (sparkle case final done?)
                                    Positioned(
                                      top: -10,
                                      right: -14,
                                      child: _Sparkle(onDone: done),
                                    ),
                                ],
                              ),
                            ],
                          ],
                        ),
                        const SizedBox(height: 3),
                        Text(
                          '${score.shipped} shipped · '
                          '${score.unblocked} unblocked · '
                          '${swarmLentHours(score.lentMs)} lent',
                          style: TextStyle(
                            color: AppPalette.textSecondary,
                            fontSize: 13.5,
                            height: 1.35,
                            fontFeatures: figures,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      color: medal == SwarmMedal.gold
                          ? _gold.withValues(alpha: .28)
                          : AppPalette.textPrimary.withValues(alpha: .07),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(
                      '${score.points} pts',
                      style: TextStyle(
                        color: AppPalette.textPrimary,
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        fontFeatures: figures,
                      ),
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
}

/// A light sparkle beside first place's cup: it swells and fades once, then
/// tells [onDone].
class _Sparkle extends StatefulWidget {
  const _Sparkle({required this.onDone});

  final VoidCallback onDone;

  @override
  State<_Sparkle> createState() => _SparkleState();
}

class _SparkleState extends State<_Sparkle>
    with SingleTickerProviderStateMixin {
  late final _motion = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  );

  @override
  void initState() {
    super.initState();
    _motion.forward().whenComplete(() {
      if (mounted) widget.onDone();
    });
  }

  @override
  void dispose() {
    _motion.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => IgnorePointer(
    key: const ValueKey('swarm-leaderboard-sparkle'),
    child: AnimatedBuilder(
      animation: _motion,
      builder: (context, child) {
        final t = Curves.easeOut.transform(_motion.value);
        return Opacity(
          opacity: (t < .3 ? t / .3 : (1 - t) / .7).clamp(0, 1),
          child: Transform.rotate(
            angle: t * .6,
            child: Transform.scale(scale: .6 + t * .7, child: child),
          ),
        );
      },
      child: const Text('✨', style: TextStyle(fontSize: 16, height: 1)),
    ),
  );
}

/// A bottom sheet of the page: its handle, a title with maybe a mark before
/// it and a close button, and its rows.
class _Sheet extends StatelessWidget {
  const _Sheet({
    super.key,
    required this.title,
    required this.closeKey,
    required this.children,
    this.leading,
  });

  final String title, closeKey;
  final Widget? leading;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 36,
                height: 5,
                margin: const EdgeInsets.only(bottom: 8),
                decoration: BoxDecoration(
                  color: AppGlass.hair,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 2, 6),
              child: Row(
                children: [
                  if (leading case final leading?) ...[
                    leading,
                    const SizedBox(width: 12),
                  ],
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppPalette.textPrimary,
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  SwarmIconButton(
                    key: ValueKey(closeKey),
                    icon: LucideIcons.x300,
                    label: 'Close',
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            ...children,
          ],
        ),
      ),
    );
  }
}

/// A week in the picker; the one shown is checked.
class _WeekOption extends StatelessWidget {
  const _WeekOption({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    selected: selected,
    label: label,
    excludeSemantics: true,
    child: InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: () {
        HapticFeedback.selectionClick();
        onTap();
      },
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 52),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  style: TextStyle(
                    color: AppPalette.textPrimary,
                    fontSize: 16,
                    fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                  ),
                ),
              ),
              if (selected)
                Icon(LucideIcons.check300, size: 20, color: AppPalette.accent),
            ],
          ),
        ),
      ),
    ),
  );
}

/// One line of a person's week: what it counts, then what they did.
class _WeekLine extends StatelessWidget {
  const _WeekLine({required this.label, required this.value});

  final String label, value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 8, 4, 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 96,
          child: Text(
            label,
            style: TextStyle(
              color: AppPalette.textSecondary,
              fontSize: 14.5,
              height: 1.35,
            ),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: TextStyle(
              color: AppPalette.textPrimary,
              fontSize: 14.5,
              height: 1.35,
            ),
          ),
        ),
      ],
    ),
  );
}
