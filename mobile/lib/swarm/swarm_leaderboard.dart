import 'dart:async';

import 'package:clock/clock.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/widgets/engine_identity.dart' show EngineMark;

import 'identity.dart';
import 'model.dart';
import 'swarm_leaderboard_reader.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'team_glance.dart';

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

/// One project's leaderboard, built as the design system's Numbers and
/// rankings at phone sizes, with the desktop's member list's rows (Tony
/// approved the phone's, 2026-10-29): one screen, no tabs. Humans first,
/// with the week picker, which sets all three lists: a row for each person,
/// their rank as a bold numeral in its own column, the face they chose,
/// their name (number one's with the crown) and status over their non-zero
/// numbers in words, and their points, the one number. The viewer's own row
/// has the selected fill, and a row opens the person's week in a sheet.
/// Then Agents (the PM and Buddies), ranked the same way with the line their
/// Team row gives them, read only; then Models, each with only the share of
/// its work approved at its first review. No crown but the top person's, no
/// cups, medals or other marks.
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

  /// Follows the Swarm's reader while the inbox has one, and reads the board
  /// through it. Off the list (the person left the Swarm or was removed),
  /// the board and any answer on its way are dropped.
  void _attach() {
    final swarm = _session?.inbox.reader(widget.swarmId);
    if (identical(swarm, _swarm)) return;
    _swarm?.removeListener(_changed);
    _board?.dispose();
    _board = null;
    _swarm = swarm?..addListener(_changed);
    _changed();
  }

  void _changed() {
    _follow();
    if (mounted) setState(() {});
  }

  /// Reads the board while the Swarm may show the project: until its first
  /// read, and while it lists it. Taken away, the board read so far and any
  /// answer on its way go with the reader, and nothing is read again.
  void _follow() {
    final session = _session, swarm = _swarm;
    if (session == null || swarm == null || _gone(swarm) != null) {
      _board?.dispose();
      _board = null;
      return;
    }
    if (_board != null) return;
    _board = SwarmLeaderboardReader(
      tabId: swarm.tabId,
      projectId: widget.projectId,
      request: swarm.request,
      inFront: () => session.inbox.shown,
    )..addListener(_changed);
    _board!.start();
  }

  /// Why [swarm] shows no board of the project: the person may no longer
  /// read the Swarm, or it does not show the project (gone, private, or
  /// never one of its own). Null while it may.
  String? _gone(SwarmReader swarm) {
    if (swarm.accessRevoked) return _swarmGone;
    final snapshot = swarm.snapshot;
    if (snapshot == null) return null;
    return snapshot.projects.any((p) => p.id == widget.projectId)
        ? null
        : _projectGone;
  }

  static const _swarmGone = 'This Swarm is no longer available.';
  static const _projectGone = 'This project is no longer in the Swarm.';

  void _forget() {
    _swarm?.removeListener(_changed);
    _swarm = null;
    _board?.dispose();
    _board = null;
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
    final inbox = _session?.inbox;
    if (inbox == null) return const [];
    final swarm = _swarm;
    // Off the list once it has been read, or taken away: nothing of it
    // stays, and nothing waits for it.
    final gone = swarm == null
        ? (inbox.loaded && inbox.error == null ? _swarmGone : null)
        : _gone(swarm);
    if (gone != null) {
      return [
        const SizedBox(height: AppSpace.m),
        SwarmRow.line(
          gone,
          key: const ValueKey('swarm-leaderboard-gone'),
          lines: 2,
        ),
      ];
    }
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
    final error =
        reader?.error ??
        (snapshot == null ? swarm?.error : null) ??
        (swarm == null ? inbox.error : null);
    final week = swarmWeekName(reader?.week, current);
    final pickWeek = reader == null
        ? null
        : () => unawaited(_pickWeek(context, reader, current));
    return [
      _Heading(
        'Humans',
        first: true,
        trailing: _WeekButton(label: week, onTap: pickWeek),
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
                  if (snapshot == null) ?swarm?.refresh(),
                  if (swarm == null) inbox.refresh(),
                ]),
              ),
            ),
          )
      else ...[
        ..._people(context, board, snapshot, week),
        ..._agents(context, board, snapshot),
        ..._models(context, board),
      ],
    ];
  }

  /// Each person on the board, most points first.
  List<Widget> _people(
    BuildContext context,
    SwarmLeaderboard board,
    SuperTabSnapshot snapshot,
    String week,
  ) {
    if (board.people.isEmpty) {
      return const [_Empty('Nobody is on the board yet.')];
    }
    SuperTabPerson? personOf(String id) =>
        snapshot.people.where((p) => p.id == id).firstOrNull;
    String nameOf(SwarmScore score) =>
        _personName(board, snapshot, score.personId) ?? 'Former member';
    final columns = _Columns.measure(
      context,
      ranks: board.people.map((s) => s.rank),
      points: board.people.map((s) => '${s.points}'),
    );
    final viewer = _swarm?.accountId;
    return [
      for (final score in board.people)
        _PersonRow(
          score: score,
          person: personOf(score.personId),
          name: nameOf(score),
          own: score.personId == viewer,
          columns: columns,
          week: week,
          onTap: () => unawaited(
            _showPerson(
              context,
              score,
              personOf(score.personId),
              nameOf(score),
            ),
          ),
        ),
    ];
  }

  /// What the board calls a person, on their row and as a Buddy's person:
  /// their name on the board, else their account's; null for someone who
  /// is no longer a member.
  static String? _personName(
    SwarmLeaderboard board,
    SuperTabSnapshot snapshot,
    String personId,
  ) {
    final person = snapshot.people.where((p) => p.id == personId).firstOrNull;
    if (person == null) return null;
    return board.people
            .where((s) => s.personId == personId)
            .firstOrNull
            ?.displayName ??
        superTabPersonName(person.email);
  }

  /// The project's PM and Buddies, ranked like people, under their heading;
  /// none, no heading. Each is named as the board names it; its face, its
  /// person, its line and its engine come from the Swarm only while it is
  /// this project's, since an agent keeps its id when its terminal is added
  /// again elsewhere.
  List<Widget> _agents(
    BuildContext context,
    SwarmLeaderboard board,
    SuperTabSnapshot snapshot,
  ) {
    final scores = board.agents;
    if (scores.isEmpty) return const [];
    final columns = _Columns.measure(
      context,
      ranks: scores.map((s) => s.rank),
      points: scores.map((s) => '${s.points}'),
    );
    final team = swarmTeamGlance(snapshot, projectId: widget.projectId);
    return [
      const _Heading('Agents'),
      for (final score in scores)
        if (_ownAgent(snapshot, score.agentId) case final agent)
          _AgentRow(
            id: 'agent-${score.agentId}',
            rank: score.rank,
            points: score.points,
            columns: columns,
            identity: SwarmAvatar(
              id: score.agentId,
              name: score.displayName,
              picture: agent?.avatar,
            ),
            name: score.displayName,
            tag: score.buddy
                ? [
                    'Buddy',
                    ?switch (score.personId) {
                      final id? => _personName(board, snapshot, id),
                      null => null,
                    },
                  ].join(' · ')
                : 'PM',
            line: agent == null ? const [] : _agentLine(snapshot, team, agent),
            engine: switch (agent?.engine) {
              final engine? when engine.isNotEmpty => engine,
              _ => null,
            },
          ),
    ];
  }

  /// What [agent] is doing, where and on what: "Idle", "Mac Studio", "Opus ·
  /// xhigh", the desktop's agent line (`SuperTabAgentGlance.line`), read
  /// from the Swarm the person already sees. Its state is its Team row's; a
  /// Buddy, on no team, reads Down or Idle. What the Swarm does not say is
  /// left out.
  static List<String> _agentLine(
    SuperTabSnapshot snapshot,
    SwarmTeamGlance team,
    SuperTabAgent agent,
  ) {
    final state =
        team.agents.where((a) => a.agent.id == agent.id).firstOrNull?.label ??
        (agent.downSince != null ? 'Down' : 'Idle');
    final model = switch (agent.configuration['model']) {
      final String model when model.isNotEmpty => swarmModelLabel(
        agent.engine,
        model,
      ),
      _ => null,
    };
    final effort = switch (agent.configuration['effort']) {
      final String effort
          when effort.isNotEmpty && effort != 'auto' && effort != 'default' =>
        effort,
      _ => null,
    };
    return [
      state,
      ?_machineName(snapshot.pool(agent.machineId)?['name']),
      if (model != null) [model, ?effort].join(' · '),
    ];
  }

  /// A machine's name without its `.local`, as the desktop shows it; null
  /// while the Swarm names none.
  static String? _machineName(Object? name) {
    const suffix = '.local';
    if (name is! String || name.isEmpty) return null;
    return name.length > suffix.length && name.toLowerCase().endsWith(suffix)
        ? name.substring(0, name.length - suffix.length)
        : name;
  }

  /// Each model whose work was reviewed that week, the most approved first,
  /// under its heading; none, no heading (the desktop's Models list, which
  /// shows the number alone).
  List<Widget> _models(BuildContext context, SwarmLeaderboard board) {
    final approvals = swarmModelApprovals(board.byModel);
    if (approvals.isEmpty) return const [];
    final columns = _Columns.measure(
      context,
      ranks: board.people.map((s) => s.rank),
      points: approvals.map((a) => '${a.percent}%'),
    );
    return [
      const _Heading('Models'),
      for (final approval in approvals)
        _ModelRow(approval: approval, columns: columns),
    ];
  }

  /// The Swarm's agent [id] while it is this project's; null once it is
  /// another's, or gone.
  SuperTabAgent? _ownAgent(SuperTabSnapshot snapshot, String id) {
    final agent = snapshot.agents.where((a) => a.id == id).firstOrNull;
    if (agent == null) return null;
    final projectId = agent.hasProjectId
        ? agent.projectId
        : snapshot.conversations
              .where((g) => g.agentIds.contains(id) || g.leadId == id)
              .firstOrNull
              ?.projectId;
    return projectId == widget.projectId ? agent : null;
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
      showDragHandle: true,
      shape: AppControl.sheetShape,
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
    SuperTabPerson? person,
    String name,
  ) => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppGlass.rowFill,
    showDragHandle: true,
    shape: AppControl.sheetShape,
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
TextStyle _pointsStyle() => AppType.label(
  fontWeight: FontWeight.w600,
  color: AppPalette.textPrimary,
  fontFeatures: _figures,
);

/// An agent's engine beside its points, at the size of an icon in a line.
const _markSize = 16.0;

/// A list's name over its rows, in a caption's quiet ink, with maybe what
/// sets it at its right: Humans and the week picker.
class _Heading extends StatelessWidget {
  const _Heading(this.text, {this.trailing, this.first = false});

  final String text;
  final Widget? trailing;

  /// The first thing on the screen: less room above it.
  final bool first;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      key: ValueKey('swarm-leaderboard-heading-${text.toLowerCase()}'),
      padding: EdgeInsets.fromLTRB(
        AppSpace.s,
        first ? 0 : AppSpace.l,
        0,
        trailing == null ? AppSpace.xs : 0,
      ),
      child: Row(
        children: [
          Expanded(
            child: Semantics(
              container: true,
              header: true,
              child: Text(
                text,
                style: AppType.caption(
                  color: Color.lerp(
                    AppPalette.textFaint,
                    AppPalette.textSecondary,
                    .5,
                  ),
                ),
              ),
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

/// A list with nothing to show that week, said as quiet text where the rows'
/// content starts.
class _Empty extends StatelessWidget {
  const _Empty(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
    child: SwarmRow.line(text, lines: 2),
  );
}

/// The board's fixed numeric columns, each as wide as its widest value at the
/// current text size, so rank and points line up on every row of a list.
class _Columns {
  const _Columns({required this.rank, required this.points});

  factory _Columns.measure(
    BuildContext context, {
    required Iterable<int> ranks,
    required Iterable<String> points,
  }) {
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

    // Digits are of one width, so the longest value is the widest.
    String widest(Iterable<String> values) =>
        values.fold('0', (a, b) => b.length > a.length ? b : a);
    return _Columns(
      rank: width(widest(ranks.map((rank) => '$rank')), _rankStyle()),
      points: width(widest(points), _pointsStyle()),
    );
  }

  final double rank, points;
}

/// What a ranked row is drawn of, people's and agents' alike: the rank in
/// its column, a face, the name over a quiet line, maybe an engine's mark,
/// and the points in theirs, at least a thumb tall.
Widget _rankedRow({
  required String id,
  required int rank,
  required int points,
  required _Columns columns,
  required Widget identity,
  required Widget name,
  required Widget? numbers,
  Widget? mark,
}) {
  Widget column(String kind, double width, Widget child) => SizedBox(
    key: ValueKey('swarm-leaderboard-$kind-$id'),
    width: width,
    child: Align(alignment: Alignment.centerRight, child: child),
  );
  return ConstrainedBox(
    constraints: const BoxConstraints(minHeight: minTouchTarget),
    child: Padding(
      padding: const EdgeInsets.all(AppSpace.s),
      child: Row(
        children: [
          column(
            'rank',
            columns.rank,
            Text('$rank', maxLines: 1, style: _rankStyle()),
          ),
          const SizedBox(width: AppSpace.m),
          identity,
          const SizedBox(width: AppSpace.m),
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [name, ?numbers],
            ),
          ),
          const SizedBox(width: AppSpace.s),
          if (mark != null) ...[mark, const SizedBox(width: AppSpace.s)],
          column(
            'points',
            columns.points,
            Text('$points', maxLines: 1, style: _pointsStyle()),
          ),
        ],
      ),
    ),
  );
}

/// A row's name in the body face, number one's crown after it, then maybe a
/// quiet tag: "PM", "Buddy · ken", a person's status.
Widget _name(String name, {String? crownId, String? tag}) => Text.rich(
  TextSpan(
    text: name,
    children: [
      if (crownId != null)
        WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: _Crown(id: crownId),
        ),
      if (tag != null)
        TextSpan(
          text: '  $tag',
          style: AppType.caption(color: AppPalette.textSecondary),
        ),
    ],
  ),
  maxLines: 1,
  overflow: TextOverflow.ellipsis,
  style: AppType.body(color: AppPalette.textPrimary),
);

/// Number one's crown beside their name: content artwork at the caption
/// size, so a crowned row is as tall as any other (the desktop's
/// `LeaderboardCrown`). The row says it in words.
class _Crown extends StatelessWidget {
  const _Crown({required this.id});

  final String id;

  @override
  Widget build(BuildContext context) => Padding(
    key: ValueKey('swarm-leaderboard-crown-$id'),
    padding: const EdgeInsets.only(left: AppSpace.xs),
    child: Text('\u{1F451}', style: AppType.caption()),
  );
}

/// One person on the board: rank, face, name and status over their numbers,
/// and points; the viewer's own row in the selected fill. Tapped, their week.
class _PersonRow extends StatelessWidget {
  const _PersonRow({
    required this.score,
    required this.person,
    required this.name,
    required this.own,
    required this.columns,
    required this.week,
    required this.onTap,
  });

  final SwarmScore score;

  /// Null for someone who has left.
  final SuperTabPerson? person;
  final String name;
  final bool own;
  final _Columns columns;

  /// "This week", "Last week", …: the week shown, as the crown says it.
  final String week;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final id = score.personId;
    final numbers = swarmNumbers(score);
    final crowned = swarmCrowned(rank: score.rank, points: score.points);
    final status = person?.statusAt(clock.now());
    final radius = BorderRadius.circular(AppControl.radius);
    return Material(
      color: own ? AppSurface.selectedFill : Colors.transparent,
      borderRadius: radius,
      clipBehavior: Clip.antiAlias,
      child: Semantics(
        key: ValueKey('swarm-leaderboard-person-$id'),
        button: true,
        // What the row shows, the numbers in full: none at zero.
        label: [
          '$name, place ${score.rank}, ${score.points} points',
          if (crowned) 'number one ${week.toLowerCase()}',
          ?status?.text,
          ...numbers,
        ].join(', '),
        excludeSemantics: true,
        child: InkWell(
          borderRadius: radius,
          onTap: () {
            HapticFeedback.selectionClick();
            onTap();
          },
          child: _rankedRow(
            id: id,
            rank: score.rank,
            points: score.points,
            columns: columns,
            identity: SwarmAvatar(
              id: id,
              name: name,
              picture: person?.avatar,
              status: status,
            ),
            name: _name(name, crownId: crowned ? id : null, tag: status?.text),
            numbers: numbers.isEmpty
                ? null
                : _Numbers(
                    key: ValueKey('swarm-leaderboard-meta-$id'),
                    parts: numbers,
                  ),
          ),
        ),
      ),
    );
  }
}

/// One agent on the board, read only: rank, its face, its name and role
/// over the line its Team row gives it, its engine's mark, and points (the
/// desktop's member list: "Agent rows stay as before and add only the rank
/// and points").
class _AgentRow extends StatelessWidget {
  const _AgentRow({
    required this.id,
    required this.rank,
    required this.points,
    required this.columns,
    required this.identity,
    required this.name,
    required this.tag,
    required this.line,
    required this.engine,
  });

  final String id, name, tag;
  final int rank, points;
  final _Columns columns;
  final Widget identity;

  /// "Idle", "Mac Studio", "Opus · xhigh": empty for an agent the Swarm no
  /// longer shows in this project.
  final List<String> line;

  /// Null where the Swarm does not say what it runs on.
  final String? engine;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      key: ValueKey('swarm-leaderboard-row-$id'),
      container: true,
      label: [name, tag, 'place $rank, $points points', ...line].join(', '),
      excludeSemantics: true,
      child: _rankedRow(
        id: id,
        rank: rank,
        points: points,
        columns: columns,
        identity: identity,
        name: _name(name, tag: tag),
        numbers: line.isEmpty
            ? null
            : _Numbers(
                key: ValueKey('swarm-leaderboard-line-$id'),
                parts: line,
              ),
        mark: switch (engine) {
          final engine? => EngineMark(
            key: ValueKey('swarm-leaderboard-engine-$id'),
            engine: engine,
            size: _markSize,
          ),
          null => null,
        },
      ),
    );
  }
}

/// One model in the Models list: its name, and the share of its work this
/// week that passed its first review, the one number (Dee, 10-29: "keep it
/// simple"). Its name starts where the faces do. A screen reader hears the
/// counts behind the share.
class _ModelRow extends StatelessWidget {
  const _ModelRow({required this.approval, required this.columns});

  final SwarmModelApproval approval;
  final _Columns columns;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final (:name, :reviewed, :passed, :percent) = approval;
    return Semantics(
      key: ValueKey('swarm-leaderboard-model-$name'),
      container: true,
      label:
          '$name, $percent% approved, $passed of $reviewed passed first '
          'review',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.all(AppSpace.s),
        child: Row(
          children: [
            SizedBox(width: columns.rank + AppSpace.m),
            Expanded(
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppType.body(color: AppPalette.textPrimary),
              ),
            ),
            const SizedBox(width: AppSpace.s),
            SizedBox(
              width: columns.points,
              child: Align(
                alignment: Alignment.centerRight,
                child: Text('$percent%', maxLines: 1, style: _pointsStyle()),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A row's quiet line, its parts joined by a spaced middle dot. Where the
/// line does not fit, whole parts fall off its end, never part of a word; a
/// person's sheet has them all, and a screen reader hears them all. A first
/// part too wide even alone wraps between its words.
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
