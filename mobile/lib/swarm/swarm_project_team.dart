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
import 'swarm_leaderboard.dart';
import 'swarm_project_tasks.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_task_status.dart';
import 'team_glance.dart';

/// "3 humans · 5 agents", the people and agents of a project in words; the
/// agents left out when there are none, as the team's line then says so.
String swarmProjectHeads({required int humans, required int agents}) => [
  humans == 1 ? '1 human' : '$humans humans',
  if (agents > 0) agents == 1 ? '1 agent' : '$agents agents',
].join(' · ');

/// An agent's state on a project's Team (Dee, 2026-10-29: every state),
/// in the order the list puts them, the most urgent first: its work needs a
/// person; it waits on a review or a usage limit; it is offline; it is
/// working; it finished and waits on the Product Manager's decision; it is
/// idle; it was stopped. The phone's team glance order ([swarmTeamGlance]),
/// with the states only the Team tells apart.
enum SwarmMemberState {
  needsInput('needs input'),
  waiting('waiting'),
  offline('offline'),
  working('working'),
  done('done'),
  idle('idle'),
  stopped('stopped');

  const SwarmMemberState(this.counted);

  /// How the Team's count names it: "2 working".
  final String counted;
}

/// How long since an agent's last progress, shortest: "now", "4m", "2h",
/// "3d" — the desktop's `superTabAgentAge`, word for word.
String swarmAgentAge(Duration age) {
  if (age.inMinutes < 1) return 'now';
  if (age.inMinutes < 60) return '${age.inMinutes}m';
  if (age.inHours < 24) return '${age.inHours}h';
  return '${age.inDays}d';
}

/// One agent on a project's Team: its state in a word or two ([label]), the
/// open work it holds ([task]) and how long since its last progress on it
/// ([age]).
class SwarmTeamAgent {
  SwarmTeamAgent(
    this.agent,
    this.name,
    this.state,
    this.label,
    this.task, {
    this.age,
  });
  final SuperTabAgent agent;
  final String name;
  final SwarmMemberState state;
  final String label;
  final SuperTabConversation? task;

  /// "4m" since the agent last reported progress on [task] (the Swarm's
  /// assignment.progressAt, which every status, check or post it sends
  /// renews), as the desktop's Agents list says it (#2281); null with no
  /// task named, or none the Swarm sent a time for.
  final String? age;

  /// Its row's quiet line: "Working · #2156 Buddy chat header · 4m".
  String get line => [label, ?task?.label, ?age].join(' · ');
}

/// [projectId]'s agents as its Team lists them: each in its state
/// ([SwarmMemberState]), the most urgent first, then by name, letter case
/// aside. Read from the Swarm alone, as the team glance is: an agent is of
/// the project it records or whose work it is in, matched by id, never by
/// name; a Buddy is no one's team. Work it still holds in another project, a
/// Buddy chat or a private chat whose people leave out [viewerId] is not
/// named here, nor timed, nor opened: its state stays, as the glance counts
/// it.
List<SwarmTeamAgent> swarmProjectAgents(
  SuperTabSnapshot snapshot,
  String projectId, {
  DateTime? now,
  String? viewerId,
}) {
  final at = now ?? clock.now();
  final glance = swarmTeamGlance(snapshot, projectId: projectId, now: at);
  final team = [
    // The read names its Buddies; one it has not named yet says so itself.
    for (final a in glance.agents)
      if (!a.agent.isBuddy) _member(a, projectId, at, viewerId),
  ];
  String sortName(SwarmTeamAgent a) => a.name.toLowerCase();
  return team..sort((a, b) {
    final byState = a.state.index.compareTo(b.state.index);
    if (byState != 0) return byState;
    final byName = sortName(a).compareTo(sortName(b));
    return byName != 0 ? byName : a.agent.id.compareTo(b.agent.id);
  });
}

SwarmTeamAgent _member(
  SwarmAgentGlance glance,
  String projectId,
  DateTime now,
  String? viewerId,
) {
  final agent = glance.agent;
  final work = glance.task?.assignment?['status'];
  // Offline outranks a stop, which outranks the work it still holds.
  final (state, label) = switch (glance.state) {
    SwarmAgentState.down => (SwarmMemberState.offline, 'Offline'),
    _ when agent.workDecision == 'stop' => (
      SwarmMemberState.stopped,
      'Stopped',
    ),
    SwarmAgentState.waiting => (SwarmMemberState.needsInput, 'Needs input'),
    SwarmAgentState.stuck => (SwarmMemberState.needsInput, 'Stuck'),
    SwarmAgentState.limited => (SwarmMemberState.waiting, glance.label),
    SwarmAgentState.working when work == 'review' => (
      SwarmMemberState.waiting,
      'Waiting for review',
    ),
    SwarmAgentState.working => (SwarmMemberState.working, glance.label),
    SwarmAgentState.idle when agent.workDecision == 'awaiting' => (
      SwarmMemberState.done,
      'Done',
    ),
    SwarmAgentState.idle => (SwarmMemberState.idle, 'Idle'),
  };
  // Only a task the viewer reads in this project: the desktop's
  // superTabGroupReadable, should the server ever send another.
  final task = switch (glance.task) {
    final t?
        when t.projectId == projectId &&
            !t.isBuddyChat &&
            (t.audience == null || t.audience!.contains(viewerId)) =>
      t,
    _ => null,
  };
  final since = task == null ? null : swarmProgressAt(task);
  return SwarmTeamAgent(
    agent,
    glance.name,
    state,
    label,
    task,
    age: since == null ? null : swarmAgentAge(now.difference(since)),
  );
}

/// What on [team] needs a look, counted in the order it is listed: "1 needs
/// input · 1 waiting · 2 working". Done, idle and stopped agents are not
/// counted; empty when nothing is.
String swarmTeamAgentsLine(List<SwarmTeamAgent> team) => [
  for (final state in const [
    SwarmMemberState.needsInput,
    SwarmMemberState.waiting,
    SwarmMemberState.offline,
    SwarmMemberState.working,
  ])
    if (team.where((a) => a.state == state).length case final n when n > 0)
      '$n ${state.counted}',
].join(' · ');

/// The colour of [state]'s dot on an agent's face. Never the only signal: the
/// row says the state in words.
Color swarmMemberColor(SwarmMemberState state) => switch (state) {
  SwarmMemberState.needsInput || SwarmMemberState.waiting => AppColors.warning,
  SwarmMemberState.offline => AppColors.danger,
  SwarmMemberState.working => AppColors.success,
  SwarmMemberState.done => AppPalette.swarmAccent,
  SwarmMemberState.idle || SwarmMemberState.stopped => AppPalette.textFaint,
};

/// A project's Team, in the sheet its menu opens (Tony, 2026-10-30), under
/// ✕ and "Team": [SwarmProjectTeam] of whichever read its Swarm has. The page
/// under it closes it when the read or the project is gone.
class SwarmProjectTeamSheet extends StatelessWidget {
  const SwarmProjectTeamSheet({
    super.key,
    required this.swarmId,
    required this.projectId,
    required this.onOpen,
  });

  final String swarmId, projectId;

  /// Opens one of the project's chats, by id: over this sheet, and back comes
  /// back to it.
  final ValueChanged<String> onOpen;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = SwarmScope.of(context);
    return SwarmProjectSheetFrame(
      title: 'Team',
      closeKey: 'swarm-team-close',
      child: session == null
          ? const SizedBox.shrink()
          : ListenableBuilder(
              listenable: session.inbox,
              builder: (context, _) => switch (session.inbox.reader(swarmId)) {
                final reader? => SwarmProjectTeam(
                  session: session,
                  reader: reader,
                  projectId: projectId,
                  onOpen: onOpen,
                ),
                null => const SizedBox.shrink(),
              },
            ),
    );
  }
}

/// A project's Team, as Swarm Home C draws it (Tony, 2026-10-30) to Dee's
/// rules (2026-10-29), one row shape for its agents ([SwarmMemberRow]). On
/// top its open tasks, in the Tasks tab's rows: what waits on the person,
/// then the work going on ([swarmProjectTasks]) — the first [workShown], and
/// a row that shows the rest in place — each opening its chat ([onOpen]).
/// Then its agents, each in its state with the task it holds, the most urgent
/// first ([swarmProjectAgents]), with what needs a look counted beside their
/// caption, each opening the task it holds ([onOpen]), its time since its
/// last progress kept true by a tick a minute ([tick]) and on coming back to
/// the app. Its humans are on the project's leaderboard. A pull reads the
/// Swarm again.
class SwarmProjectTeam extends StatefulWidget {
  const SwarmProjectTeam({
    super.key,
    required this.session,
    required this.reader,
    required this.projectId,
    required this.onOpen,
  });

  final SwarmSession session;
  final SwarmReader reader;
  final String projectId;

  /// Opens one of the project's chats, by id.
  final ValueChanged<String> onOpen;

  /// How much of the work going on shows before See all: a Swarm with a
  /// hundred open tasks still reaches its agents (Tony, 2026-10-30).
  static const workShown = 5;

  /// How often the agents' times are worked out again on a quiet Swarm: they
  /// count minutes, so no more often than once a minute; a read of the Swarm
  /// redraws them anyway.
  static const tick = Duration(minutes: 1);

  @override
  State<SwarmProjectTeam> createState() => _SwarmProjectTeamState();
}

class _SwarmProjectTeamState extends State<SwarmProjectTeam> {
  /// See all was tapped: kept here, so no read of the Swarm folds it again.
  bool _allWork = false;

  /// One tick for the whole Team, cancelled with it.
  late final Timer _tick;

  /// Back in the app, times are worked out at once: a phone asleep for an
  /// hour does not show the hour before until the next tick.
  late final AppLifecycleListener _lifecycle;

  void _redraw() {
    if (mounted) setState(() {});
  }

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(SwarmProjectTeam.tick, (_) => _redraw());
    _lifecycle = AppLifecycleListener(onResume: _redraw);
  }

  @override
  void dispose() {
    _tick.cancel();
    _lifecycle.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(SwarmProjectTeam old) {
    super.didUpdateWidget(old);
    if (old.projectId != widget.projectId) _allWork = false;
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = widget.session;
    final reader = widget.reader;
    return ListenableBuilder(
      // Needs and held answers move with the session and its inbox; the
      // work and the team with the read.
      listenable: Listenable.merge([session, session.inbox, reader]),
      builder: (context, _) {
        final snapshot = reader.snapshot;
        final project = snapshot?.projects
            .where((p) => p.id == widget.projectId)
            .firstOrNull;
        if (snapshot == null || project == null) {
          return const SizedBox.shrink();
        }
        final now = clock.now();
        final tasks = swarmProjectTasks(session.inbox, reader, project.id, now);
        final personName = swarmTaskPersonName(snapshot);
        final agents = swarmProjectAgents(
          snapshot,
          project.id,
          now: now,
          viewerId: reader.accountId,
        );
        final working = tasks.working;
        final folds = working.length > SwarmProjectTeam.workShown;
        final work = folds && !_allWork
            ? working.take(SwarmProjectTeam.workShown)
            : working;
        return RefreshIndicator(
          onRefresh: reader.refresh,
          child: ListView(
            key: const ValueKey('swarm-project-team-list'),
            physics: const AlwaysScrollableScrollPhysics(),
            padding: EdgeInsets.fromLTRB(
              AppSpace.m,
              AppSpace.xs,
              AppSpace.m,
              MediaQuery.paddingOf(context).bottom + AppSpace.xl,
            ),
            children: [
              if (tasks.waiting.isNotEmpty) ...[
                const SwarmCaption(
                  'Waiting on you',
                  key: ValueKey('swarm-team-waiting-caption'),
                  first: true,
                ),
                SwarmGroup(
                  children: [
                    for (final need in tasks.waiting)
                      SwarmWaitingRow(
                        key: ValueKey('swarm-waiting-${need.key}'),
                        session: session,
                        snapshot: snapshot,
                        need: need,
                        personName: personName,
                        now: now,
                        onOpen: () => widget.onOpen(need.conversationId),
                      ),
                  ],
                ),
              ],
              if (working.isNotEmpty || tasks.waiting.isEmpty)
                SwarmCaption(
                  'Working on',
                  key: const ValueKey('swarm-team-working-caption'),
                  first: tasks.waiting.isEmpty,
                ),
              if (working.isEmpty && tasks.waiting.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
                  child: SwarmRow.line(
                    'No open tasks.',
                    key: const ValueKey('swarm-team-no-tasks'),
                  ),
                )
              else if (working.isNotEmpty)
                SwarmGroup(
                  children: [
                    for (final g in work)
                      SwarmWorkRow(
                        key: ValueKey('swarm-task-${g.id}'),
                        snapshot: snapshot,
                        group: g,
                        personName: personName,
                        onTap: () => widget.onOpen(g.id),
                      ),
                    if (folds)
                      SwarmRow(
                        key: const ValueKey('swarm-team-see-all'),
                        title: _allWork
                            ? 'Show fewer'
                            : 'See all ${working.length} tasks',
                        chevron: _allWork
                            ? LucideIcons.chevronUp300
                            : LucideIcons.chevronRight300,
                        onTap: () => setState(() => _allWork = !_allWork),
                      ),
                  ],
                ),
              SwarmCaption(
                'Agents',
                key: const ValueKey('swarm-team-agents-caption'),
                note: swarmTeamAgentsLine(agents),
              ),
              if (agents.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
                  child: SwarmRow.line(
                    'No agents yet.',
                    key: const ValueKey('swarm-team-no-agents'),
                  ),
                )
              else
                SwarmGroup(
                  children: [
                    for (final a in agents)
                      SwarmMemberRow(
                        key: ValueKey('swarm-member-${a.agent.id}'),
                        face: SwarmAvatar(
                          id: a.agent.id,
                          name: a.name,
                          picture: a.agent.avatar,
                        ),
                        dot: swarmMemberColor(a.state),
                        name: a.name,
                        detail: a.line,
                        onTap: switch (a.task) {
                          final task? => () => widget.onOpen(task.id),
                          null => null,
                        },
                      ),
                  ],
                ),
            ],
          ),
        );
      },
    );
  }
}

/// One agent on a project's Team (Dee, 2026-10-29): the face in one column,
/// with its state's [dot], the name and a quiet [detail] line beneath. The
/// same height with or without the line; a tap does [onTap], when there is
/// one.
class SwarmMemberRow extends StatelessWidget {
  const SwarmMemberRow({
    super.key,
    required this.face,
    required this.name,
    this.dot,
    this.detail,
    this.onTap,
  });

  final Widget face;
  final String name;

  /// The state's colour on the face's corner.
  final Color? dot;
  final String? detail;
  final VoidCallback? onTap;

  static const double _face = 36, _dot = 11;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final dot = this.dot, detail = this.detail;
    return Semantics(
      // Its own node, a tap or not: one row, said as one.
      container: true,
      button: onTap != null,
      label: [name, if (detail != null && detail.isNotEmpty) detail].join(', '),
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          // A name over its line, with or without the line: every row of the
          // Team one height.
          constraints: const BoxConstraints(minHeight: minTouchTarget + 16),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpace.l,
              vertical: AppSpace.s,
            ),
            child: Row(
              children: [
                SizedBox.square(
                  dimension: _face,
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Positioned.fill(child: FittedBox(child: face)),
                      if (dot != null)
                        Positioned(
                          right: -2,
                          bottom: -2,
                          child: Container(
                            width: _dot,
                            height: _dot,
                            decoration: BoxDecoration(
                              color: dot,
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: AppGlass.rowFill,
                                width: 2,
                                strokeAlign: BorderSide.strokeAlignOutside,
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
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
                        style: AppType.label(color: AppPalette.textPrimary),
                      ),
                      if (detail != null && detail.isNotEmpty) ...[
                        const SizedBox(height: 2),
                        Text(
                          detail,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppType.caption(
                            color: AppPalette.textSecondary,
                            height: 1.35,
                          ),
                        ),
                      ],
                    ],
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
