import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'team_glance.dart';

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

/// One agent on a project's Team: its state in a word or two ([label]) and
/// the open work it holds ([task]).
class SwarmTeamAgent {
  SwarmTeamAgent(this.agent, this.name, this.state, this.label, this.task);
  final SuperTabAgent agent;
  final String name;
  final SwarmMemberState state;
  final String label;
  final SuperTabConversation? task;

  /// Its row's quiet line: "Working · #2156 Buddy chat header".
  String get line => [label, ?task?.label].join(' · ');
}

/// [projectId]'s agents as its Team lists them: each in its state
/// ([SwarmMemberState]), the most urgent first, then by name, letter case
/// aside. Read from the Swarm alone, as the team glance is: an agent is of
/// the project it records or whose work it is in, matched by id, never by
/// name; a Buddy is no one's team.
List<SwarmTeamAgent> swarmProjectAgents(
  SuperTabSnapshot snapshot,
  String projectId, {
  DateTime? now,
}) {
  final glance = swarmTeamGlance(snapshot, projectId: projectId, now: now);
  final team = [
    // The read names its Buddies; one it has not named yet says so itself.
    for (final a in glance.agents)
      if (!a.agent.isBuddy) _member(a),
  ];
  String sortName(SwarmTeamAgent a) => a.name.toLowerCase();
  return team..sort((a, b) {
    final byState = a.state.index.compareTo(b.state.index);
    if (byState != 0) return byState;
    final byName = sortName(a).compareTo(sortName(b));
    return byName != 0 ? byName : a.agent.id.compareTo(b.agent.id);
  });
}

SwarmTeamAgent _member(SwarmAgentGlance glance) {
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
  return SwarmTeamAgent(agent, glance.name, state, label, glance.task);
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

/// A project's Team, as Swarm Home C draws it (Tony, 2026-10-30) to Dee's
/// rules (2026-10-29): its agents, each in its state with the task it holds,
/// the most urgent first ([swarmProjectAgents]), with what needs a look
/// counted beside their caption. No ranks. An agent's row opens the task it
/// holds ([onOpen]); a pull reads the Swarm again.
class SwarmProjectTeam extends StatelessWidget {
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

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: reader,
      builder: (context, _) {
        final snapshot = reader.snapshot;
        if (snapshot == null) return const SizedBox.shrink();
        final agents = swarmProjectAgents(snapshot, projectId);
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
              SwarmCaption(
                'Agents',
                key: const ValueKey('swarm-team-agents-caption'),
                note: swarmTeamAgentsLine(agents),
                first: true,
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
                          final task? => () => onOpen(task.id),
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

/// One person or agent on a project's Team, in the one shape both share
/// (Dee, 2026-10-29): the face in one column — an agent's with its state's
/// [dot] — the name with [trailing] at the end of its line (a person's
/// points), and a quiet [detail] line beneath. A finger's height at least;
/// a tap does [onTap], when there is one.
class SwarmMemberRow extends StatelessWidget {
  const SwarmMemberRow({
    super.key,
    required this.face,
    required this.name,
    this.dot,
    this.tag,
    this.detail,
    this.trailing,
    this.trailingLabel,
    this.onTap,
  });

  final Widget face;
  final String name;

  /// The state's colour on the face's corner: an agent's.
  final Color? dot;

  /// Quiet words after the name: "you" on the viewer's own row.
  final String? tag;
  final String? detail;
  final Widget? trailing;

  /// [trailing] in words, for a screen reader: "1,320 points".
  final String? trailingLabel;
  final VoidCallback? onTap;

  static const double _face = 36, _dot = 11;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final dot = this.dot, tag = this.tag, detail = this.detail;
    final trailing = this.trailing;
    return Semantics(
      // Its own node, a tap or not: one row, said as one.
      container: true,
      button: onTap != null,
      label: [name, ?tag, ?detail, ?trailingLabel].join(', '),
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: minTouchTarget + 12),
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
                      Row(
                        children: [
                          Expanded(
                            child: Text.rich(
                              TextSpan(
                                children: [
                                  TextSpan(text: name),
                                  if (tag != null)
                                    TextSpan(
                                      text: '  $tag',
                                      style: AppType.caption(
                                        color: AppPalette.textSecondary,
                                      ),
                                    ),
                                ],
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: AppType.label(
                                color: AppPalette.textPrimary,
                              ),
                            ),
                          ),
                          if (trailing != null) ...[
                            const SizedBox(width: AppSpace.s),
                            trailing,
                          ],
                        ],
                      ),
                      if (detail != null && detail.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            detail,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AppType.caption(
                              color: AppPalette.textSecondary,
                              height: 1.35,
                            ),
                          ),
                        ),
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
