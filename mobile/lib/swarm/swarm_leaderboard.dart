import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'identity.dart';
import 'model.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// A place among the top three with points.
enum SwarmMedal { gold, silver, bronze }

const swarmWeekMs = 7 * 86400000;
const _minute = 60000, _hour = 3600000;

int _int(Object? value) => value is num ? value.round() : 0;
int? _optional(Object? value) => value is num ? value.round() : null;
Map<String, dynamic> _map(Object? value) =>
    value is Map ? value.cast<String, dynamic>() : const {};

/// One project's week as the leaderboard read answers it
/// (`backend/src/superTabs/leaderboard/contract.ts`): what it shipped, and
/// each person who reads the project with their points, most first. The
/// desktop's `SuperTabLeaderboard` (`desktop/lib/super_tabs/leaderboard`),
/// kept to what the phone shows.
class SwarmLeaderboard {
  SwarmLeaderboard.fromJson(Map<String, dynamic> json)
    : week = _int(json['week']),
      shipped = _int(_map(_map(json['goal'])['thisWeek'])['shipped']),
      people = List.unmodifiable([
        for (final row in json['people'] as List? ?? const [])
          if (row is Map) SwarmScore.fromJson(_map(row)),
      ]);

  /// The week's Monday 00:00 UTC, in epoch milliseconds.
  final int week;

  /// What the project shipped in the week.
  final int shipped;

  /// Most points first.
  final List<SwarmScore> people;
}

/// One person's week on the board.
class SwarmScore {
  SwarmScore.fromJson(Map<String, dynamic> json)
    : personId = json['personId'] as String? ?? '',
      points = _int(json['points']),
      rank = _int(json['rank']),
      medal = SwarmMedal.values.asNameMap()[json['medal']],
      shipped = _int(_map(json['shipped'])['count']),
      medianAskToShipMs = _optional(_map(json['shipped'])['medianAskToShipMs']),
      unblocked = _int(_map(json['unblocked'])['count']),
      unblockedMs = _int(_map(json['unblocked'])['agentMs']),
      medianAnswerMs = _optional(_map(json['unblocked'])['medianAnswerMs']),
      lentMachines = _int(_map(json['lent'])['machines']),
      lentMs = _int(_map(json['lent'])['agentMs']),
      streakDays = _int(json['streakDays']);

  final String personId;

  /// [rank] 1 has the most points; people with the same points share one.
  final int points, rank;
  final SwarmMedal? medal;
  final int shipped, unblocked, lentMachines, streakDays;

  /// Agent time the person's answers freed, and agent time run on their
  /// machines.
  final int unblockedMs, lentMs;
  final int? medianAskToShipMs, medianAnswerMs;
}

String swarmCup(SwarmMedal medal) => switch (medal) {
  SwarmMedal.gold => '🥇',
  SwarmMedal.silver => '🥈',
  SwarmMedal.bronze => '🥉',
};

/// "6 min" under an hour, then hours with one decimal unless whole: "3 h",
/// "3.1 h" (the desktop's `leaderboardDuration`).
String swarmDuration(int ms) {
  if (ms < _hour) return '${(ms / _minute).round()} min';
  final rounded = (ms / _hour * 10).round() / 10;
  return rounded == rounded.roundToDouble()
      ? '${rounded.round()} h'
      : '${rounded.toStringAsFixed(1)} h';
}

/// Whole agent-hours, as the points count them: "40h".
String swarmLentHours(int ms) => '${(ms / _hour).round()}h';

String _plural(int count, String one) =>
    '$count ${count == 1 ? one : '${one}s'}';

/// The Monday 00:00 UTC of the week [now] is in.
int swarmWeekOf(DateTime now) {
  final utc = now.toUtc();
  final day = DateTime.utc(utc.year, utc.month, utc.day);
  return day
      .subtract(Duration(days: day.weekday - DateTime.monday))
      .millisecondsSinceEpoch;
}

/// "This week", "Last week", "2 weeks ago", from the week's Monday and this
/// one's; null is this week.
String swarmWeekName(int? week, int currentWeek) {
  final back = week == null ? 0 : ((currentWeek - week) / swarmWeekMs).round();
  return switch (back) {
    0 => 'This week',
    1 => 'Last week',
    _ => '$back weeks ago',
  };
}

/// Reads one project's leaderboard: once [start]ed, at once and every
/// [every] while the app is in front ([inFront]); the board sums a week, so
/// it moves slowly. A failed refresh keeps the last board and says why (the
/// desktop's `SuperTabLeaderboardReader`).
class SwarmLeaderboardReader extends ChangeNotifier {
  SwarmLeaderboardReader({
    required this.tabId,
    required this.projectId,
    required this.request,
    required this.inFront,
    this.every = const Duration(minutes: 5),
  });

  final String tabId, projectId;
  final SwarmRequest request;
  final bool Function() inFront;
  final Duration every;

  /// The week as last read; null before a read of the week shown lands.
  SwarmLeaderboard? board;

  /// Why the last read failed; null once one succeeds.
  String? error;

  /// The server has no leaderboard: it is from before one.
  bool unavailable = false;

  /// The Monday of the week shown; null for this week.
  int? week;

  int _read = 0;
  Timer? _timer;
  bool _disposed = false;

  bool get loading => board == null && error == null && !unavailable;

  /// Reads now, and every [every] after while the app is in front.
  void start() {
    _timer ??= Timer.periodic(every, (_) {
      if (inFront()) unawaited(refresh());
    });
    unawaited(refresh());
  }

  /// Shows another week, null for this one.
  Future<void> showWeek(int? week) {
    if (week == this.week) return Future.value();
    this.week = week;
    // Another week's numbers under this week's name would mislead until the
    // read lands.
    board = null;
    error = null;
    _notify();
    return refresh();
  }

  Future<void> refresh() async {
    if (_disposed) return;
    final read = ++_read, week = this.week;
    try {
      final answer = await request(
        'GET',
        '/api/super-tabs/${Uri.encodeComponent(tabId)}/leaderboard'
            '?projectId=${Uri.encodeQueryComponent(projectId)}'
            '${week == null ? '' : '&week=$week'}',
      );
      if (read != _read || _disposed) return;
      if (answer is! Map) throw const FormatException();
      board = SwarmLeaderboard.fromJson(answer.cast<String, dynamic>());
      error = null;
      unavailable = false;
    } on SuperTabFailure catch (failure) {
      if (read != _read || _disposed) return;
      if (failure.statusCode == 404) {
        board = null;
        error = null;
        unavailable = true;
      } else {
        error = failure.message;
      }
    } catch (_) {
      if (read != _read || _disposed) return;
      error = "Couldn't read the leaderboard.";
    }
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}

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

/// One project's leaderboard, as the desktop's Humans section shows it and
/// the approved mockup lays it out on a phone: what the team shipped in the
/// week shown, the week in a picker, then each person with their cup or
/// place, initial, name and points, and their 🚀 shipped, 🔓 unblocked and
/// 💻 lent beneath. A person's row opens their week in a sheet. First place
/// sparkles once as the page opens, unless Reduce Motion is on.
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
    return [
      SizedBox(
        height: 52,
        child: Row(
          children: [
            if (board != null) _ShippedChip(board.shipped),
            const Spacer(),
            _WeekButton(
              label: swarmWeekName(reader?.week, current),
              onTap: reader == null
                  ? null
                  : () => unawaited(_pickWeek(context, reader, current)),
            ),
          ],
        ),
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
        if (error == null)
          SwarmSkeletonRows(
            id: 'swarm-leaderboard-loading',
            rows: 4,
            round: true,
          )
        else
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
      else
        SwarmGroup(
          children: [
            for (final (i, score) in board.people.indexed)
              _PersonRow(
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
          ],
        ),
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

/// A person's week as the desktop's `LeaderboardPersonWeek` words it: the
/// points and place, what landed, what they answered, what they lent, and
/// their streak.
List<(String, String)> swarmPersonWeek(SwarmScore score) {
  String median(int? ms, String what) =>
      ms == null ? '' : ' · median ${swarmDuration(ms)}$what';
  return [
    (
      'Points',
      score.medal == null
          ? '${score.points} this week'
          : '${score.points} this week · place ${score.rank}',
    ),
    (
      'Shipped',
      score.shipped == 0
          ? 'Nothing landed yet'
          : '${_plural(score.shipped, 'ask')} landed'
                '${median(score.medianAskToShipMs, ' to ship')}',
    ),
    (
      'Unblocked',
      score.unblocked == 0
          ? 'Nothing answered yet'
          : '${score.unblocked} answered${median(score.medianAnswerMs, '')}'
                ' · ${swarmDuration(score.unblockedMs)} of agent time freed',
    ),
    (
      'Lent',
      score.lentMachines == 0
          ? 'Nothing lent yet'
          : '${_plural(score.lentMachines, 'machine')}'
                ' · ${(score.lentMs / _hour).round()} agent-hours',
    ),
    (
      'Streak',
      score.streakDays == 0
          ? 'No streak yet'
          : '${_plural(score.streakDays, 'day')} shipping',
    ),
  ];
}

/// What the team shipped in the week shown, in a small chip.
class _ShippedChip extends StatelessWidget {
  const _ShippedChip(this.shipped);

  final int shipped;

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('swarm-leaderboard-shipped'),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
    decoration: BoxDecoration(
      color: AppGlass.rowFill,
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: AppGlass.hair),
    ),
    child: Text(
      '🚀 $shipped shipped',
      style: TextStyle(
        color: AppPalette.textPrimary,
        fontSize: 14,
        fontWeight: FontWeight.w500,
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
    ),
  );
}

/// The week shown and its arrow: opens the week picker.
class _WeekButton extends StatelessWidget {
  const _WeekButton({required this.label, required this.onTap});

  final String label;
  final VoidCallback? onTap;

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
                style: TextStyle(color: AppPalette.textPrimary, fontSize: 15),
              ),
              const SizedBox(width: 4),
              Icon(
                LucideIcons.chevronDown300,
                size: 18,
                color: AppPalette.textSecondary,
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

/// One person on the board: their cup or place, initial, name and points,
/// and beneath, what they shipped, unblocked and lent.
class _PersonRow extends StatelessWidget {
  const _PersonRow({
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

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    const figures = [FontFeature.tabularFigures()];
    final quiet = TextStyle(
      color: AppPalette.textSecondary,
      fontSize: 13.5,
      height: 1.35,
      fontFeatures: figures,
    );
    final medal = score.medal;
    return Semantics(
      button: true,
      label:
          '$name, place ${score.rank}, ${score.points} points, '
          '${score.shipped} shipped, ${score.unblocked} unblocked, '
          '${(score.lentMs / _hour).round()} hours lent',
      excludeSemantics: true,
      child: InkWell(
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 60),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 10, 14, 10),
            child: Row(
              children: [
                SizedBox(
                  width: 30,
                  child: Stack(
                    clipBehavior: Clip.none,
                    alignment: Alignment.center,
                    children: [
                      Text(
                        medal == null ? '${score.rank}' : swarmCup(medal),
                        textAlign: TextAlign.center,
                        style: medal == null
                            ? TextStyle(
                                color: AppPalette.textSecondary,
                                fontSize: 15,
                                fontWeight: FontWeight.w500,
                                fontFeatures: figures,
                              )
                            : const TextStyle(fontSize: 22, height: 1.1),
                      ),
                      if (sparkle case final done?)
                        Positioned(
                          top: -10,
                          right: -8,
                          child: _Sparkle(onDone: done),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                SwarmAvatar(id: score.personId, name: name),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: AppPalette.textPrimary,
                          fontSize: 16,
                          fontWeight: FontWeight.w500,
                          height: 1.3,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Wrap(
                        spacing: 14,
                        children: [
                          Text('🚀 ${score.shipped}', style: quiet),
                          Text('🔓 ${score.unblocked}', style: quiet),
                          Text(
                            '💻 ${swarmLentHours(score.lentMs)}',
                            style: quiet,
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  '${score.points} pts',
                  style: TextStyle(
                    color: AppPalette.textPrimary,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    fontFeatures: figures,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A light sparkle over first place's cup: it swells and fades once, then
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
