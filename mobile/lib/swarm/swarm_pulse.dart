import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'pulse_model.dart';
import 'swarm_leaderboard.dart' show swarmSheetRoute;
import 'swarm_project_page.dart' show swarmChatRoute;
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_style.dart';
import 'swarm_task_status.dart' show swarmTaskPersonName;

/// How long ago, shortest, for the pulse: "0m", "14m", "3h", "2d".
String swarmPulseAge(Duration age) {
  if (age.inHours < 1) return '${age.inMinutes < 0 ? 0 : age.inMinutes}m';
  if (age.inDays < 1) return '${age.inHours}h';
  return '${age.inDays}d';
}

/// The name the pulse calls [pulse]'s PM by: its agent's name, or "the PM".
String swarmPulsePmName(SuperTabSnapshot snapshot, SuperTabPulse pulse) =>
    switch (pulse.pmId) {
      final id? when snapshot.agent(id) != null => snapshot.agentName(id),
      _ => 'the PM',
    };

/// The strip's words, part by part: each part's text and whether it is the
/// count, which speaks louder than the words around it.
typedef _Words = List<(String, bool)>;

/// What the strip's asks say: "Waiting for River: 2 asks · oldest 14m (Huy)",
/// or "Nothing waiting for River".
_Words _askWords(SuperTabSnapshot snapshot, SuperTabPulse pulse, DateTime now) {
  final pm = swarmPulsePmName(snapshot, pulse);
  final asks = pulse.asks;
  if (asks.count == 0) return [('Nothing waiting for $pm', false)];
  final who = switch (asks.personId) {
    final id? => swarmTaskPersonName(snapshot)(id),
    null => null,
  };
  return [
    ('Waiting for $pm: ', false),
    (asks.count == 1 ? '1 ask' : '${asks.count} asks', true),
    if (asks.oldestAt case final at?)
      (' · oldest ${swarmPulseAge(now.difference(at))}', false),
    if (who != null) (' ($who)', false),
  ];
}

/// A project's board pulse (task #3384) on top of its task list: what waits
/// for its PM, then who works of its crew, what is next up, lost and held,
/// as the server counts them (`derived.pulse`). Nothing without a pulse: an
/// older server sends none. Each count opens its list in a sheet
/// ([showSwarmPulseList]). A part is red once the server's `redAt` for its
/// rule has come — asks; idle, on Working; lost; held — with a mark and bold
/// beside its colour; the app holds no threshold. It wakes when the next
/// `redAt` comes, and each minute so its ages stay true.
class SwarmPulseStrip extends StatefulWidget {
  const SwarmPulseStrip({
    super.key,
    required this.reader,
    required this.projectId,
    required this.onOpen,
  });

  final SwarmReader reader;
  final String projectId;

  /// Opens one of the project's chats, by id: a task from a list.
  final ValueChanged<String> onOpen;

  /// How often its ages are worked out again: they count minutes.
  static const tick = Duration(minutes: 1);

  @override
  State<SwarmPulseStrip> createState() => _SwarmPulseStripState();
}

class _SwarmPulseStripState extends State<SwarmPulseStrip> {
  late final Timer _tick;
  late final AppLifecycleListener _lifecycle;

  /// Wakes the strip when the next `redAt` comes ([_wake]).
  Timer? _red;
  DateTime? _redAt;

  void _redraw() {
    if (mounted) setState(() {});
  }

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(SwarmPulseStrip.tick, (_) => _redraw());
    _lifecycle = AppLifecycleListener(onResume: _redraw);
  }

  @override
  void dispose() {
    _tick.cancel();
    _red?.cancel();
    _lifecycle.dispose();
    super.dispose();
  }

  /// One timer, for the soonest rule still to turn red.
  void _wake(SuperTabPulse pulse, DateTime now) {
    final next = pulse.nextRedAfter(now);
    if (next == _redAt) return;
    _red?.cancel();
    _redAt = next;
    _red = next == null
        ? null
        : Timer(next.difference(now), () {
            _redAt = null;
            _redraw();
          });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final snapshot = widget.reader.snapshot;
    final pulse = snapshot?.pulseOf(widget.projectId);
    if (snapshot == null || pulse == null) {
      _red?.cancel();
      _red = _redAt = null;
      return const SizedBox.shrink();
    }
    final now = clock.now();
    _wake(pulse, now);
    void open(SwarmPulseList list) => unawaited(
      showSwarmPulseList(
        context,
        reader: widget.reader,
        projectId: widget.projectId,
        list: list,
        onOpen: widget.onOpen,
      ),
    );
    bool red(SuperTabPulseRule rule) => pulse.isRed(rule, now);
    final held = pulse.held;
    return Padding(
      key: const ValueKey('swarm-pulse'),
      padding: const EdgeInsets.only(top: AppSpace.s),
      child: SwarmGroup(
        children: [
          _Segment(
            name: 'asks',
            words: _askWords(snapshot, pulse, now),
            red: red(SuperTabPulseRule.asks),
            wide: true,
            onTap: () => open(SwarmPulseList.asks),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
            child: Wrap(
              spacing: AppSpace.xs,
              children: [
                _Segment(
                  name: 'working',
                  words: [
                    ('Working ', false),
                    ('${pulse.working.count}', true),
                    (' of ${pulse.working.crew}', false),
                  ],
                  red: red(SuperTabPulseRule.idle),
                  onTap: () => open(SwarmPulseList.working),
                ),
                _Segment(
                  name: 'next-up',
                  words: [('Next up ', false), ('${pulse.nextUp.count}', true)],
                  red: false,
                  onTap: () => open(SwarmPulseList.nextUp),
                ),
                _Segment(
                  name: 'lost',
                  words: [('Lost ', false), ('${pulse.lost.count}', true)],
                  red: red(SuperTabPulseRule.lost),
                  onTap: () => open(SwarmPulseList.lost),
                ),
                _Segment(
                  name: 'held',
                  words: [
                    ('Held ', false),
                    ('${held.count}', true),
                    if (held.withoutReason > 0)
                      (' (${held.withoutReason} no reason)', false),
                  ],
                  red: red(SuperTabPulseRule.held),
                  onTap: () => open(SwarmPulseList.held),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// One part of the strip, a thumb's touch tall: its words in the secondary
/// ink, its count in the primary one; red, all of it in the error ink and
/// bold after a mark, and heard as needing a look. [wide] takes the strip's
/// width, with a chevron at its end.
class _Segment extends StatelessWidget {
  const _Segment({
    required this.name,
    required this.words,
    required this.red,
    required this.onTap,
    this.wide = false,
  });

  final String name;
  final _Words words;
  final bool red, wide;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final heard = words.map((w) => w.$1).join();
    final text = Text.rich(
      TextSpan(
        children: [
          for (final (part, count) in words)
            TextSpan(
              text: part,
              style: count && !red
                  ? TextStyle(
                      color: AppPalette.textPrimary,
                      fontWeight: AppFont.semibold,
                    )
                  : null,
            ),
        ],
      ),
      key: ValueKey('swarm-pulse-$name-text'),
      maxLines: wide ? 2 : 1,
      overflow: TextOverflow.ellipsis,
      style: AppType.caption(
        color: red ? AppColors.danger : AppPalette.textSecondary,
        fontWeight: red ? AppFont.semibold : null,
        height: 1.35,
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
    );
    final mark = red
        ? [
            Icon(
              LucideIcons.circleAlert300,
              key: ValueKey('swarm-pulse-$name-red'),
              size: 16,
              color: AppColors.danger,
            ),
            const SizedBox(width: AppSpace.xs),
          ]
        : const <Widget>[];
    return Semantics(
      button: true,
      label: red ? '$heard, needs a look' : heard,
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        key: ValueKey('swarm-pulse-$name'),
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: minTouchTarget),
            child: Padding(
              padding: EdgeInsets.symmetric(
                horizontal: wide ? AppSpace.l : AppSpace.s,
                vertical: AppSpace.s,
              ),
              child: Row(
                mainAxisSize: wide ? MainAxisSize.max : MainAxisSize.min,
                children: [
                  ...mark,
                  if (wide) Expanded(child: text) else Flexible(child: text),
                  if (wide) ...[
                    const SizedBox(width: AppSpace.m),
                    Icon(
                      LucideIcons.chevronRight300,
                      size: 18,
                      color: AppPalette.textFaint,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The lists the strip's counts open.
enum SwarmPulseList { asks, working, nextUp, lost, held }

/// [list] of [projectId]'s pulse in a sheet, kept up to date by [reader]'s
/// reads: the asks, each its person, how long ago and where, opening its
/// message in its conversation; the working agents, each opening the task it
/// holds; or Next up's, Lost's or Held's tasks, Held's with each reason or
/// "no reason", each opening its task ([onOpen]). Whatever opens goes over
/// the sheet, and back comes back to it.
Future<void> showSwarmPulseList(
  BuildContext context, {
  required SwarmReader reader,
  required String projectId,
  required SwarmPulseList list,
  required ValueChanged<String> onOpen,
}) => Navigator.of(context).push(
  swarmSheetRoute<void>(
    context,
    builder: (context) => _PulseSheet(
      reader: reader,
      projectId: projectId,
      list: list,
      onOpen: onOpen,
    ),
  ),
);

class _PulseSheet extends StatelessWidget {
  const _PulseSheet({
    required this.reader,
    required this.projectId,
    required this.list,
    required this.onOpen,
  });

  final SwarmReader reader;
  final String projectId;
  final SwarmPulseList list;
  final ValueChanged<String> onOpen;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: reader,
      builder: (context, _) {
        final snapshot = reader.snapshot;
        final pulse = snapshot?.pulseOf(projectId);
        final pm = snapshot == null || pulse == null
            ? 'the PM'
            : swarmPulsePmName(snapshot, pulse);
        final (title, none) = switch (list) {
          SwarmPulseList.asks => (
            'Waiting for $pm',
            'Nothing waiting for $pm.',
          ),
          SwarmPulseList.working => ('Working', 'Nobody is working.'),
          SwarmPulseList.nextUp => ('Next up', 'Nothing next up.'),
          SwarmPulseList.lost => ('Lost', 'No lost tasks.'),
          SwarmPulseList.held => ('Held', 'Nothing held.'),
        };
        final rows = snapshot == null || pulse == null
            ? const <Widget>[]
            : _rows(context, snapshot, pulse);
        return ConstrainedBox(
          key: const ValueKey('swarm-pulse-sheet'),
          // Never over the status bar: a long list scrolls inside it.
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * .82,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
                child: Row(
                  children: [
                    SwarmIconButton(
                      key: const ValueKey('swarm-pulse-close'),
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
                  ],
                ),
              ),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  padding: EdgeInsets.fromLTRB(
                    AppSpace.l,
                    AppSpace.s,
                    AppSpace.l,
                    MediaQuery.paddingOf(context).bottom + AppSpace.xl,
                  ),
                  children: [
                    if (rows.isEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: AppSpace.xs,
                        ),
                        child: SwarmRow.line(none),
                      )
                    else
                      SwarmGroup(children: rows),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  List<Widget> _rows(
    BuildContext context,
    SuperTabSnapshot snapshot,
    SuperTabPulse pulse,
  ) {
    final now = clock.now();
    Widget task(String id, {String? Function()? reason}) {
      final g = snapshot.conversation(id);
      final why = reason?.call();
      return SwarmRow(
        key: ValueKey('swarm-pulse-task-$id'),
        number: g?.number == null ? null : '#${g!.number}',
        title: g?.title ?? 'A task',
        detail: reason == null ? null : SwarmRow.line(why ?? 'no reason'),
        onTap: () => onOpen(id),
      );
    }

    return switch (list) {
      SwarmPulseList.asks => [
        for (final ask in pulse.asks.list) _askRow(context, snapshot, ask, now),
      ],
      SwarmPulseList.working => [
        for (final id in pulse.working.agentIds) _agentRow(snapshot, id),
      ],
      SwarmPulseList.nextUp => [
        for (final id in pulse.nextUp.conversationIds) task(id),
      ],
      SwarmPulseList.lost => [
        for (final id in pulse.lost.conversationIds) task(id),
      ],
      SwarmPulseList.held => [
        for (final hold in pulse.held.list)
          task(hold.conversationId, reason: () => hold.reason),
      ],
    };
  }

  /// A person's ask: who, how long ago and where; a tap opens the message
  /// in its conversation.
  Widget _askRow(
    BuildContext context,
    SuperTabSnapshot snapshot,
    SuperTabPulseAsk ask,
    DateTime now,
  ) {
    final person = snapshot.people
        .where((p) => p.id == ask.personId)
        .firstOrNull;
    final name = switch (ask.personId) {
      final id? => swarmTaskPersonName(snapshot)(id),
      null => null,
    };
    final chat = snapshot.conversation(ask.conversationId);
    final where = switch (chat) {
      null => null,
      final g when g.number != null => '#${g.number} ${g.title}',
      final g => g.title,
    };
    return SwarmRow(
      key: ValueKey('swarm-pulse-ask-${ask.messageId}'),
      leading: SwarmAvatar(
        id: ask.personId ?? ask.messageId,
        name: name ?? '?',
        picture: person?.avatar,
      ),
      title: name ?? 'A person',
      detail: SwarmRow.line(
        [
          if (ask.at case final at?) '${swarmPulseAge(now.difference(at))} ago',
          ?where,
        ].join(' · '),
      ),
      onTap: () => unawaited(
        Navigator.of(context).push(
          swarmChatRoute(
            swarmId: reader.tabId,
            conversationId: ask.conversationId,
            messageId: ask.messageId,
          ),
        ),
      ),
    );
  }

  /// A working agent, with the task it holds, which a tap opens.
  Widget _agentRow(SuperTabSnapshot snapshot, String id) {
    final name = snapshot.agentName(id);
    final held = [
      for (final g in snapshot.conversations)
        if (g.projectId == projectId &&
            !g.closed &&
            g.assignment?['agentId'] == id &&
            !const {
              'done',
              'stopped',
              'cancelled',
            }.contains(g.assignment?['status']))
          g,
    ];
    final task =
        held.where((g) => g.assignment?['status'] == 'working').firstOrNull ??
        held.firstOrNull;
    return SwarmRow(
      key: ValueKey('swarm-pulse-agent-$id'),
      leading: SwarmAvatar(
        id: id,
        name: name,
        picture: snapshot.agent(id)?.avatar,
      ),
      title: name,
      detail: task == null
          ? null
          : SwarmRow.line(
              task.number == null
                  ? task.title
                  : '#${task.number} ${task.title}',
            ),
      onTap: task == null ? null : () => onOpen(task.id),
    );
  }
}
