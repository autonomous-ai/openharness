import 'dart:async';

import 'package:clock/clock.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

import 'identity.dart';
import 'model.dart';
import 'swarm_leaderboard_reader.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// The people of [project] in [snapshot]: everyone in the Swarm, or, for a
/// private project, only its owner and members — the people who read it.
List<SuperTabPerson> swarmProjectPeople(
  SuperTabSnapshot snapshot,
  SuperTabProject project,
) => [
  for (final person in snapshot.people)
    if (!project.isPrivate ||
        person.id == project.ownerId ||
        project.memberIds.contains(person.id))
      person,
];

/// One person on a project's board: their week's [score], if the board has
/// answered and lists them, and whether they are the viewer.
typedef SwarmProjectHuman = ({
  SuperTabPerson person,
  String name,
  SwarmScore? score,
  bool own,
});

/// [project]'s people ([swarmProjectPeople]) by this week's points on [board],
/// most first, then by name, letter case aside — all by name while there is no
/// board. Someone the board lists who does not read the project is not here.
/// Matched by id, never by name.
List<SwarmProjectHuman> swarmProjectHumans(
  SuperTabSnapshot snapshot,
  SuperTabProject project,
  SwarmLeaderboard? board, {
  required String viewer,
}) {
  final scores = {
    for (final score in board?.people ?? const <SwarmScore>[])
      score.personId: score,
  };
  final humans = [
    for (final person in swarmProjectPeople(snapshot, project))
      (
        person: person,
        name:
            scores[person.id]?.displayName ?? superTabPersonName(person.email),
        score: scores[person.id],
        own: person.id == viewer,
      ),
  ];
  String sortName(SwarmProjectHuman h) => h.name.toLowerCase();
  int points(SwarmProjectHuman h) => h.score?.points ?? 0;
  return humans..sort((a, b) {
    final byPoints = points(b).compareTo(points(a));
    if (byPoints != 0) return byPoints;
    final byName = sortName(a).compareTo(sortName(b));
    return byName != 0 ? byName : a.person.id.compareTo(b.person.id);
  });
}

/// A route for a sheet of the page under [context], with
/// [showModalBottomSheet]'s default options. A screen that keeps it can close
/// the sheet when it loses what the sheet shows, even between the tap and the
/// sheet's first frame.
ModalBottomSheetRoute<T> swarmSheetRoute<T>(
  BuildContext context, {
  required WidgetBuilder builder,
  bool isScrollControlled = true,
}) {
  final navigator = Navigator.of(context);
  final localizations = MaterialLocalizations.of(context);
  return ModalBottomSheetRoute<T>(
    capturedThemes: InheritedTheme.capture(
      from: context,
      to: navigator.context,
    ),
    isScrollControlled: isScrollControlled,
    barrierLabel: localizations.scrimLabel,
    barrierOnTapHint: localizations.scrimOnTapHint(
      localizations.bottomSheetLabel,
    ),
    backgroundColor: AppGlass.rowFill,
    showDragHandle: true,
    shape: AppControl.sheetShape,
    modalBarrierColor: Theme.of(context).bottomSheetTheme.modalBarrierColor,
    builder: builder,
  );
}

/// A sheet from a project's menu: ✕, its [title] and maybe a control at the
/// end ([trailing]) over its [child]; as tall whatever it holds, so its rows
/// are built as they come into view.
class SwarmProjectSheetFrame extends StatelessWidget {
  const SwarmProjectSheetFrame({
    super.key,
    required this.title,
    required this.closeKey,
    required this.child,
    this.trailing,
  });

  final String title, closeKey;
  final Widget? trailing;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SizedBox(
      height: MediaQuery.sizeOf(context).height * .82,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
            child: Row(
              children: [
                SwarmIconButton(
                  key: ValueKey(closeKey),
                  icon: LucideIcons.x300,
                  label: 'Close',
                  onPressed: () => Navigator.of(context).pop(),
                ),
                const SizedBox(width: AppSpace.xs),
                Expanded(
                  child: Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppType.heading(color: AppPalette.textPrimary),
                  ),
                ),
                ?trailing,
              ],
            ),
          ),
          Expanded(child: child),
        ],
      ),
    );
  }
}

/// One project's leaderboard, built as the design system's Numbers and
/// rankings at phone sizes, the same structure as the desktop's Humans: the
/// team's week first, as quiet text with the week picker beside it; then a row
/// for each person: their rank as a bold numeral in its own column, the face
/// they chose, their name over their non-zero numbers in words, the change
/// against last week and their points, the one emphasized number. The
/// viewer's own row has the selected fill. A row opens the person's week in a
/// sheet. No cups, medals or emoji.
///
/// In a sheet from the project's menu ([sheet]) the people are the project's
/// own ([swarmProjectHumans]), without ranks: each shows at once, with their
/// points when the board answers.
///
/// People are named from the members its Swarm already read; the board
/// itself is read on open, on a pull, on another week, and every few minutes
/// while the app is in front ([SwarmLeaderboardReader]).
class SwarmLeaderboardPage extends StatefulWidget {
  const SwarmLeaderboardPage({
    super.key,
    required this.swarmId,
    required this.projectId,
    this.header = true,
    this.sheet = false,
    this.now = DateTime.now,
  });

  final String swarmId, projectId;

  /// Its own top bar, back and "Leaderboard"; none in a project's tab,
  /// under the project's own header.
  final bool header;

  /// It is a sheet over the project's chat ([SwarmProjectSheetFrame]), the
  /// week picker in its top line; [header] does not count.
  final bool sheet;

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

  /// The Swarm's reader was held and has been lost: it left the account's
  /// list, or may no longer be read. Nothing of it is drawn, and no loading
  /// stays up for an answer that will not come.
  bool _lost = false;

  /// The person's week this page opened, while it is up. What it shows is
  /// this board's: it closes with the page, and when the account, the Swarm
  /// or the project it was opened from is gone ([_closeWeek]).
  ModalRoute<void>? _week;

  /// The week picker, while it is up: it goes with the board.
  ModalRoute<void>? _picker;

  @override
  void didUpdateWidget(SwarmLeaderboardPage old) {
    super.didUpdateWidget(old);
    // Another Swarm or project: none of the last board stays.
    if (old.swarmId != widget.swarmId || old.projectId != widget.projectId) {
      _forget();
      _attach();
    }
  }

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
    if (session == null) return;
    // Off the list, or refused: what was read of it goes, and a reader that
    // may not read it again is not followed. Not listed yet is only waiting.
    if (swarm == null || swarm.accessRevoked) {
      if (!_lost && (_swarm != null || swarm != null)) _lose();
      return;
    }
    if (identical(swarm, _swarm)) return;
    _swarm?.removeListener(_swarmChanged);
    _lost = false;
    _swarm = swarm..addListener(_swarmChanged);
    _startBoard();
    _changed();
  }

  void _startBoard() {
    final session = _session, swarm = _swarm;
    if (session == null || swarm == null) return;
    _board?.dispose();
    _board = null;
    // A project the Swarm does not have is not asked for.
    if (_projectGone(swarm.snapshot)) return;
    _board = SwarmLeaderboardReader(
      tabId: swarm.tabId,
      projectId: widget.projectId,
      request: swarm.request,
      inFront: () => session.inbox.shown,
    )..addListener(_changed);
    _board!.start();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  /// Whether [snapshot], once read, still has this page's project.
  bool _projectGone(SuperTabSnapshot? snapshot) =>
      snapshot != null &&
      !snapshot.projects.any((p) => p.id == widget.projectId);

  /// The Swarm's reader told of a change: revoked, nothing of it stays;
  /// without the project any more, nothing of the project does either: its
  /// week closes and its board is not read, until the project is back.
  void _swarmChanged() {
    final swarm = _swarm;
    if (swarm == null) return;
    if (swarm.accessRevoked) return _lose();
    if (_projectGone(swarm.snapshot)) {
      _closeWeek();
      _board?.dispose();
      _board = null;
    } else if (_board == null) {
      _startBoard();
    }
    _changed();
  }

  void _lose() {
    _forget();
    _lost = true;
    _changed();
  }

  void _forget() {
    _swarm?.removeListener(_swarmChanged);
    _swarm = null;
    _board?.dispose();
    _board = null;
    _lost = false;
    _closeWeek();
  }

  /// Closes the week open and the week picker, if any: once this frame is
  /// done, as a page whose reader goes away may not change the navigator while
  /// it builds.
  void _closeWeek() {
    final routes = [?_week, ?_picker];
    _week = _picker = null;
    if (routes.isEmpty) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      for (final route in routes) {
        if (route.isActive) route.navigator?.removeRoute(route);
      }
    });
  }

  @override
  void dispose() {
    _closeWeek();
    _session?.inbox.removeListener(_attach);
    _session?.leave();
    _swarm?.removeListener(_swarmChanged);
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
    if (widget.sheet) return _inSheet(context, snapshot, project);
    final board = RefreshIndicator(
      onRefresh: _board?.refresh ?? () async {},
      child: ListView(
        key: const ValueKey('swarm-leaderboard'),
        physics: const AlwaysScrollableScrollPhysics(),
        // Rows draw their own inner gap, so their content meets the
        // screen's side inset.
        padding: EdgeInsets.fromLTRB(
          AppSpace.screenInset - AppSpace.s,
          0,
          AppSpace.screenInset - AppSpace.s,
          MediaQuery.paddingOf(context).bottom + AppSpace.xl,
        ),
        children: _body(context, snapshot),
      ),
    );
    if (!widget.header) return board;
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
            Expanded(child: board),
          ],
        ),
      ),
    );
  }

  /// The board as a sheet: ✕, Leaderboard and the week shown on one line, then
  /// the team's week and the project's people.
  Widget _inSheet(
    BuildContext context,
    SuperTabSnapshot? snapshot,
    SuperTabProject? project,
  ) {
    final reader = _board;
    final current = swarmWeekOf(widget.now());
    return SwarmProjectSheetFrame(
      title: 'Leaderboard',
      closeKey: 'swarm-leaderboard-close',
      trailing: _WeekButton(
        label: swarmWeekName(reader?.week, current),
        onTap: reader == null
            ? null
            : () => unawaited(_pickWeek(context, reader, current)),
      ),
      child: RefreshIndicator(
        // The Swarm names its people, and the board scores them.
        onRefresh: () async {
          await Future.wait([?_board?.refresh(), ?_swarm?.refresh()]);
        },
        child: ListView(
          key: const ValueKey('swarm-leaderboard'),
          physics: const AlwaysScrollableScrollPhysics(),
          padding: EdgeInsets.fromLTRB(
            AppSpace.screenInset - AppSpace.s,
            0,
            AppSpace.screenInset - AppSpace.s,
            MediaQuery.paddingOf(context).bottom + AppSpace.xl,
          ),
          children: _sheetBody(context, snapshot, project, current),
        ),
      ),
    );
  }

  List<Widget> _sheetBody(
    BuildContext context,
    SuperTabSnapshot? snapshot,
    SuperTabProject? project,
    int current,
  ) {
    final reader = _board;
    if (_session == null || _lost || snapshot == null || project == null) {
      return const [];
    }
    final board = reader?.board;
    final humans = swarmProjectHumans(
      snapshot,
      project,
      board,
      viewer: _swarm?.accountId ?? '',
    );
    final columns = _Columns.of(context, [for (final h in humans) ?h.score]);
    return [
      if (reader != null && reader.unavailable)
        Padding(
          padding: const EdgeInsets.all(AppSpace.s),
          child: SwarmRow.line(
            "This Swarm's server has no leaderboard yet.",
            key: const ValueKey('swarm-leaderboard-unavailable'),
            lines: 2,
          ),
        ),
      if (board != null)
        _TeamLine(
          week: swarmWeekName(reader?.week, current),
          shipped: board.shipped,
          before: board.shippedBefore,
          onWeek: null,
          picker: false,
        ),
      if (reader?.error case final error?)
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.s,
            0,
            AppSpace.s,
            AppSpace.s,
          ),
          child: Row(
            children: [
              Expanded(
                child: SwarmRow.line(
                  error,
                  key: const ValueKey('swarm-leaderboard-error'),
                  lines: 3,
                ),
              ),
              SwarmButton(
                key: const ValueKey('swarm-leaderboard-retry'),
                label: 'Try again',
                onPressed: () => unawaited(reader?.refresh()),
              ),
            ],
          ),
        ),
      for (final h in humans)
        _PersonRow(
          id: h.person.id,
          score: h.score,
          person: h.person,
          name: h.name,
          own: h.own,
          columns: columns,
          ranks: false,
          onTap: switch (h.score) {
            final score? => () => _openWeek(context, score, h.person, h.name),
            null => null,
          },
        ),
    ];
  }

  List<Widget> _body(BuildContext context, SuperTabSnapshot? snapshot) {
    final reader = _board;
    final board = reader?.board;
    final current = swarmWeekOf(widget.now());
    // Signed out, or Swarm turned off: no account's board to show; nor of a
    // Swarm that was lost, or of a project it does not have.
    if (_session == null || _lost || _projectGone(snapshot)) return const [];
    if (reader != null && reader.unavailable) {
      return [
        const SizedBox(height: AppSpace.m),
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
    SuperTabPerson? personOf(String id) =>
        people.where((p) => p.id == id).firstOrNull;
    String nameOf(SwarmScore score) => switch (personOf(score.personId)) {
      final person? => score.displayName ?? superTabPersonName(person.email),
      null => 'Former member',
    };
    final week = swarmWeekName(reader?.week, current);
    final pickWeek = reader == null
        ? null
        : () => unawaited(_pickWeek(context, reader, current));
    final columns = board == null || board.people.isEmpty
        ? null
        : _Columns.of(context, board.people);
    final viewer = _swarm?.accountId;
    return [
      _TeamLine(
        week: week,
        shipped: board?.shipped,
        before: board?.shippedBefore,
        onWeek: pickWeek,
      ),
      if (error != null)
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.s,
            0,
            AppSpace.s,
            AppSpace.s,
          ),
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
        for (final score in board.people)
          _PersonRow(
            id: score.personId,
            score: score,
            person: personOf(score.personId),
            name: nameOf(score),
            own: score.personId == viewer,
            columns: columns!,
            onTap: () => _openWeek(
              context,
              score,
              personOf(score.personId),
              nameOf(score),
            ),
          ),
    ];
  }

  void _openWeek(
    BuildContext context,
    SwarmScore score,
    SuperTabPerson? person,
    String name,
  ) {
    ModalRoute<void>? shown;
    unawaited(
      showSwarmPersonWeek(
        context,
        score: score,
        person: person,
        name: name,
        opened: (route) => _week = shown = route,
      ).whenComplete(() {
        if (_week == shown) _week = null;
      }),
    );
  }

  /// The four weeks the board keeps, this one first, in a sheet.
  Future<void> _pickWeek(
    BuildContext context,
    SwarmLeaderboardReader reader,
    int current,
  ) async {
    final shown = reader.week ?? current;
    final route = swarmSheetRoute<int>(
      context,
      isScrollControlled: false,
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
    _picker = route;
    final week = await Navigator.of(context).push(route);
    if (identical(_picker, route)) _picker = null;
    if (week == null || !mounted || !identical(reader, _board)) return;
    await reader.showWeek(week == current ? null : week);
  }
}

/// [score]'s week in a sheet, as the desktop shows it when a name is clicked:
/// from the leaderboard and from a project's Team. [opened] is told the
/// sheet's route before it is pushed, not when it first draws, so a screen
/// that loses what the sheet shows between the tap and the next frame can
/// still close it.
Future<void> showSwarmPersonWeek(
  BuildContext context, {
  required SwarmScore score,
  required SuperTabPerson? person,
  required String name,
  ValueChanged<ModalRoute<void>>? opened,
}) {
  final route = swarmSheetRoute<void>(
    context,
    builder: (context) => _Sheet(
      key: const ValueKey('swarm-leaderboard-sheet'),
      title: name,
      leading: SwarmAvatar(
        id: score.personId,
        name: name,
        picture: person?.avatar,
      ),
      closeKey: 'swarm-leaderboard-sheet-close',
      children: [
        for (final (label, value) in swarmPersonWeek(score))
          _WeekLine(label: label, value: value),
      ],
    ),
  );
  opened?.call(route);
  return Navigator.of(context).push(route);
}

/// Figures of one width, so a column of numbers holds row under row.
const _figures = [FontFeature.tabularFigures()];

/// Numbers and rankings: the rank a bold numeral in secondary ink, the points
/// the one emphasized number, 0 included.
TextStyle _rankStyle() => AppType.label(
  fontWeight: FontWeight.w700,
  color: AppPalette.textSecondary,
  fontFeatures: _figures,
);
TextStyle swarmPointsStyle() => AppType.label(
  fontWeight: FontWeight.w600,
  color: AppPalette.textPrimary,
  fontFeatures: _figures,
);
TextStyle _trendStyle(Color color) =>
    AppType.caption(color: color, fontFeatures: _figures);

/// The trend arrow's size in Numbers and rankings, the same on both.
const _trendIconSize = 14.0;

/// The team's week as quiet text, "19 shipped this week · 11 last week" (no
/// hover on a phone, so the week before is said), the week picker beside it.
class _TeamLine extends StatelessWidget {
  const _TeamLine({
    required this.week,
    required this.shipped,
    required this.before,
    required this.onWeek,
    this.picker = true,
  });

  /// "This week", "Last week", …: the week shown.
  final String week;

  /// Null until the board is read.
  final int? shipped, before;
  final VoidCallback? onWeek;

  /// The week picker beside the line; a sheet has it in its top line.
  final bool picker;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final shipped = this.shipped, before = this.before;
    final earlier = week == 'This week' ? 'last week' : 'the week before';
    return Padding(
      key: const ValueKey('swarm-leaderboard-team'),
      padding: const EdgeInsets.only(left: AppSpace.s, bottom: AppSpace.xs),
      child: Row(
        children: [
          Expanded(
            child: shipped == null
                ? const SizedBox.shrink()
                : Text(
                    '$shipped shipped ${week.toLowerCase()} · '
                    '$before $earlier',
                    style: AppType.caption(color: AppPalette.textSecondary),
                  ),
          ),
          if (picker) _WeekButton(label: week, onTap: onWeek),
        ],
      ),
    );
  }
}

/// The board's fixed numeric columns, each as wide as its widest value at the
/// current text size, so rank, trend and points line up on every row.
class _Columns {
  const _Columns({required this.rank, required this.points, this.trend});

  factory _Columns.of(BuildContext context, List<SwarmScore> scores) {
    final scaler = MediaQuery.textScalerOf(context);
    double width(String text, TextStyle style) {
      final painter = TextPainter(
        text: TextSpan(text: text, style: style),
        textDirection: TextDirection.ltr,
        textScaler: scaler,
      )..layout();
      final width = painter.width;
      painter.dispose();
      return width;
    }

    // Digits are of one width, so the longest number is the widest.
    String widest(Iterable<int> values) => values
        .map((value) => '$value')
        .fold('0', (a, b) => b.length > a.length ? b : a);
    final changes = [
      for (final score in scores)
        if (score.prevWeekPoints case final before? when before != score.points)
          (score.points - before).abs(),
    ];
    return _Columns(
      rank: width(widest(scores.map((score) => score.rank)), _rankStyle()),
      points: width(
        widest(scores.map((score) => score.points)),
        swarmPointsStyle(),
      ),
      trend: changes.isEmpty
          ? null
          : _trendIconSize +
                width(widest(changes), _trendStyle(AppPalette.textSecondary)),
    );
  }

  final double rank, points;

  /// Null when no one on the board moved against last week.
  final double? trend;
}

/// One person on the board: rank, face, name over their numbers, change
/// against last week and points, at least a thumb tall; the viewer's own row
/// in the selected fill. A project's sheet has no [ranks], and until the board
/// answers, or for someone it does not list, no [score].
class _PersonRow extends StatelessWidget {
  const _PersonRow({
    required this.id,
    required this.score,
    required this.person,
    required this.name,
    required this.own,
    required this.columns,
    required this.onTap,
    this.ranks = true,
  });

  final String id;
  final SwarmScore? score;
  final bool ranks;

  /// Null for someone who has left.
  final SuperTabPerson? person;
  final String name;
  final bool own;
  final _Columns columns;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final score = this.score;
    final numbers = score == null ? const <String>[] : swarmNumbers(score);
    final trend = score == null ? null : swarmTrend(score);
    Widget column(String kind, double width, Widget? child) => Padding(
      padding: const EdgeInsets.only(left: AppSpace.s),
      child: SizedBox(
        key: ValueKey('swarm-leaderboard-$kind-$id'),
        width: width,
        child: Align(alignment: Alignment.centerRight, child: child),
      ),
    );
    final radius = BorderRadius.circular(AppControl.radius);
    return Material(
      color: own ? AppSurface.selectedFill : Colors.transparent,
      borderRadius: radius,
      clipBehavior: Clip.antiAlias,
      child: Semantics(
        key: ValueKey('swarm-leaderboard-person-$id'),
        button: onTap != null,
        // What the row shows, the numbers in full: none at zero.
        label: [
          name,
          if (ranks && score != null) 'place ${score.rank}',
          if (score != null) '${score.points} points',
          ...numbers,
          ?trend,
        ].join(', '),
        excludeSemantics: true,
        child: InkWell(
          borderRadius: radius,
          onTap: switch (onTap) {
            final onTap? => () {
              HapticFeedback.selectionClick();
              onTap();
            },
            null => null,
          },
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: minTouchTarget),
            child: Padding(
              padding: const EdgeInsets.all(AppSpace.s),
              child: Row(
                children: [
                  if (ranks && score != null) ...[
                    SizedBox(
                      key: ValueKey('swarm-leaderboard-rank-$id'),
                      width: columns.rank,
                      child: Text(
                        '${score.rank}',
                        maxLines: 1,
                        textAlign: TextAlign.right,
                        style: _rankStyle(),
                      ),
                    ),
                    const SizedBox(width: AppSpace.m),
                  ],
                  SwarmAvatar(
                    id: id,
                    name: name,
                    picture: person?.avatar,
                    status: person?.statusAt(clock.now()),
                  ),
                  const SizedBox(width: AppSpace.m),
                  Expanded(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppType.body(color: AppPalette.textPrimary),
                        ),
                        if (numbers.isNotEmpty)
                          _Numbers(
                            key: ValueKey('swarm-leaderboard-meta-$id'),
                            parts: numbers,
                          ),
                      ],
                    ),
                  ),
                  if (columns.trend case final width?)
                    column(
                      'trend-column',
                      width,
                      trend == null ? null : _Trend(score: score!),
                    ),
                  column(
                    'points',
                    columns.points,
                    score == null
                        ? null
                        : Text(
                            '${score.points}',
                            maxLines: 1,
                            style: swarmPointsStyle(),
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

/// A person's numbers joined by a spaced middle dot. Where the line does not
/// fit, whole items fall off its end, never part of a word; the person's
/// sheet has them all. A first item too wide even alone wraps between its
/// words.
class _Numbers extends StatelessWidget {
  const _Numbers({super.key, required this.parts});

  final List<String> parts;

  @override
  Widget build(BuildContext context) {
    final style = AppType.caption(color: AppPalette.textSecondary);
    final scaler = MediaQuery.textScalerOf(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        bool fits(String text) {
          final painter = TextPainter(
            text: TextSpan(text: text, style: style),
            textDirection: TextDirection.ltr,
            textScaler: scaler,
            maxLines: 1,
          )..layout(maxWidth: constraints.maxWidth);
          final fits = !painter.didExceedMaxLines;
          painter.dispose();
          return fits;
        }

        var shown = parts.length;
        while (shown > 1 && !fits(parts.take(shown).join(' · '))) {
          shown--;
        }
        final text = parts.take(shown).join(' · ');
        return Text(
          text,
          maxLines: fits(text) ? 1 : 2,
          overflow: TextOverflow.ellipsis,
          style: style,
        );
      },
    );
  }
}

/// An arrow and the change against last week, by shape and colour both: up in
/// the online green, down in the theme's error ink.
class _Trend extends StatelessWidget {
  const _Trend({required this.score});

  final SwarmScore score;

  @override
  Widget build(BuildContext context) {
    final change = score.points - score.prevWeekPoints!;
    final color = change > 0
        ? AppPalette.online
        : Theme.of(context).colorScheme.error;
    return Row(
      key: ValueKey('swarm-leaderboard-trend-${score.personId}'),
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          change > 0 ? LucideIcons.arrowUp300 : LucideIcons.arrowDown300,
          size: _trendIconSize,
          color: color,
        ),
        Text('${change.abs()}', style: _trendStyle(color)),
      ],
    );
  }
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
      borderRadius: BorderRadius.circular(AppControl.radius),
      onTap: onTap == null
          ? null
          : () {
              HapticFeedback.selectionClick();
              onTap!();
            },
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          minHeight: minTouchTarget,
          minWidth: minTouchTarget,
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(label, style: AppType.body(color: AppPalette.textPrimary)),
              const SizedBox(width: AppSpace.xs),
              Icon(
                LucideIcons.chevronDown300,
                size: _iconSize,
                color: AppPalette.textSecondary,
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

/// An icon beside text, at the Phone section's size.
const _iconSize = 20.0;

/// A bottom sheet of the page under its drag handle: a title with maybe a
/// mark before it and a close button, and its rows.
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
        padding: const EdgeInsets.fromLTRB(
          AppSpace.screenInset,
          0,
          AppSpace.screenInset,
          AppSpace.l,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpace.s),
              child: Row(
                children: [
                  if (leading case final leading?) ...[
                    leading,
                    const SizedBox(width: AppSpace.m),
                  ],
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppType.heading(color: AppPalette.textPrimary),
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
      borderRadius: BorderRadius.circular(AppControl.radius),
      onTap: () {
        HapticFeedback.selectionClick();
        onTap();
      },
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: minTouchTarget),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  style: AppType.body(
                    color: AppPalette.textPrimary,
                    fontWeight: selected ? FontWeight.w600 : null,
                  ),
                ),
              ),
              if (selected)
                Icon(
                  LucideIcons.check300,
                  size: _iconSize,
                  color: AppPalette.accent,
                ),
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
    padding: const EdgeInsets.symmetric(vertical: AppSpace.s),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // The labels' column: as wide as the widest of them, "Unblocked".
        SizedBox(
          width: _labelWidth(context),
          child: Text(
            label,
            style: AppType.body(color: AppPalette.textSecondary),
          ),
        ),
        const SizedBox(width: AppSpace.m),
        Expanded(
          child: Text(
            value,
            style: AppType.body(color: AppPalette.textPrimary),
          ),
        ),
      ],
    ),
  );

  static double _labelWidth(BuildContext context) {
    final painter = TextPainter(
      text: TextSpan(
        text: 'Unblocked',
        style: AppType.body(color: AppPalette.textSecondary),
      ),
      textDirection: TextDirection.ltr,
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final width = painter.width;
    painter.dispose();
    return width;
  }
}
