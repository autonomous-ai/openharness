import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/fzf.dart' show fzfAge;
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_activity_page.dart' show confirmSwarmApprove;
import 'swarm_home_rows.dart';
import 'swarm_inbox.dart';
import 'swarm_need_rows.dart';
import 'swarm_project_page.dart' show swarmProjectWork;
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_task_status.dart';

/// A task's work is over: done, stopped or cancelled, as the team's glance
/// counts it.
const _finished = {'done', 'stopped', 'cancelled'};

/// One project's tasks as B2's Tasks tab groups them (Tony, 2026-10-29):
/// what waits on the person there ([waiting]: Needs you's own, so one rule
/// says what waits), the work going on ([working]), and the work the read
/// shows done today ([doneToday], [swarmDoneToday]), newest first.
typedef SwarmProjectTaskLists = ({
  List<SwarmNeed> waiting,
  List<SuperTabConversation> working,
  List<SuperTabConversation> doneToday,
});

/// [projectId]'s tasks in [reader]'s read, grouped as the Tasks tab shows
/// them ([SwarmProjectTaskLists]). Only what the read holds: a need of
/// another Swarm or project, a private chat and the person's Buddy chat
/// are left out ([swarmProjectWork]); work that waits on the person is under
/// Waiting on you alone. Empty while the project is not in the read.
SwarmProjectTaskLists swarmProjectTasks(
  SwarmInbox inbox,
  SwarmReader reader,
  String projectId,
  DateTime now,
) {
  final snapshot = reader.snapshot;
  final project = snapshot?.projects
      .where((p) => p.id == projectId)
      .firstOrNull;
  if (snapshot == null || project == null) {
    return (waiting: const [], working: const [], doneToday: const []);
  }
  final waiting = [
    for (final need in inbox.needs)
      if (need.swarmId == reader.tabId &&
          _projectOf(snapshot, need) == projectId)
        need,
  ];
  final waits = {for (final need in waiting) need.conversationId};
  final work = swarmProjectWork(snapshot, project, buddies: reader.buddies);
  bool over(SuperTabConversation g) =>
      g.closed || _finished.contains(g.assignment?['status']);
  final doneToday = [
    for (final g in [...work.active, ...work.older])
      if (!waits.contains(g.id) && swarmDoneToday(g, now)) g,
  ]..sort((a, b) => swarmProgressAt(b)!.compareTo(swarmProgressAt(a)!));
  return (
    waiting: waiting,
    working: [
      for (final g in work.active)
        if (!waits.contains(g.id) && !over(g)) g,
    ],
    doneToday: doneToday,
  );
}

/// Whether the read shows [g]'s work done on [now]'s day: its agent said
/// Done — stopped, cancelled or lost work was not done, nor was work only
/// archived — and its last progress ([swarmProgressAt]) was today. The read
/// holds no time of the Done itself (the server keeps it in a ledger it does
/// not send), and that progress comes at or before it, so a task this says
/// is done today is; one done today after earlier progress, and archived
/// work no read holds, are not counted: what it counts is a floor. A new
/// message on work done before does not make it today's.
bool swarmDoneToday(SuperTabConversation g, DateTime now) {
  if (g.assignment?['status'] != 'done') return false;
  final at = swarmProgressAt(g);
  return at != null && !at.isBefore(DateTime(now.year, now.month, now.day));
}

/// [g]'s agent's last progress on its work, which its Done comes at or
/// after (backend liveness.ts `renewLease`); null when the server sent none.
DateTime? swarmProgressAt(SuperTabConversation g) =>
    switch (g.assignment?['progressAt']) {
      final num at => DateTime.fromMillisecondsSinceEpoch(at.toInt()),
      _ => null,
    };

/// The project [need] was asked in, by id: a tag from an older server names
/// none, and its chat's project is the one.
String? _projectOf(SuperTabSnapshot snapshot, SwarmNeed need) => switch (need) {
  SwarmDecisionNeed(:final decision) when decision.projectId.isNotEmpty =>
    decision.projectId,
  SwarmMentionNeed(:final mention) when mention.projectId.isNotEmpty =>
    mention.projectId,
  SwarmWorkNeed(:final work) => work.project.id,
  _ => snapshot.conversation(need.conversationId)?.projectId,
};

/// One project's Tasks tab, as B2 draws it: "Waiting on you" with its count,
/// each need with Approve (a decision's recommended answer, held for Undo as
/// everywhere) or Reply, which opens where it was asked; "Working" with its
/// count, each task with its agent and its line; and "Done today", folded in
/// one row. A row opens its chat ([onOpen]); a pull reads the Swarm again.
class SwarmProjectTasks extends StatefulWidget {
  const SwarmProjectTasks({
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
  State<SwarmProjectTasks> createState() => _SwarmProjectTasksState();
}

class _SwarmProjectTasksState extends State<SwarmProjectTasks> {
  /// Done today shows its tasks.
  bool _doneOpen = false;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = widget.session;
    final reader = widget.reader;
    return ListenableBuilder(
      // Needs and held answers move with the session and its inbox; the
      // work with the read.
      listenable: Listenable.merge([session, session.inbox, reader]),
      builder: (context, _) {
        final snapshot = reader.snapshot;
        if (snapshot == null) return const SizedBox.shrink();
        final now = clock.now();
        final tasks = swarmProjectTasks(
          session.inbox,
          reader,
          widget.projectId,
          now,
        );
        final personName = swarmTaskPersonName(snapshot);
        Widget work(SuperTabConversation g) => SwarmWorkRow(
          key: ValueKey('swarm-task-${g.id}'),
          snapshot: snapshot,
          group: g,
          personName: personName,
          onTap: () => widget.onOpen(g.id),
        );
        final done = tasks.doneToday.length;
        return RefreshIndicator(
          onRefresh: reader.refresh,
          child: ListView(
            key: const ValueKey('swarm-project-tasks'),
            physics: const AlwaysScrollableScrollPhysics(),
            padding: EdgeInsets.fromLTRB(
              AppSpace.m,
              AppSpace.xs,
              AppSpace.m,
              MediaQuery.paddingOf(context).bottom + AppSpace.xl,
            ),
            children: [
              if (tasks.waiting.isNotEmpty) ...[
                SwarmCaption(
                  'Waiting on you',
                  count: tasks.waiting.length,
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
              SwarmCaption(
                'Working',
                count: tasks.working.length,
                countColor: AppColors.success,
                countKey: const ValueKey('swarm-working-count'),
                first: tasks.waiting.isEmpty,
              ),
              if (tasks.working.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
                  child: SwarmRow.line(
                    'No work going on.',
                    key: const ValueKey('swarm-tasks-none'),
                  ),
                )
              else
                SwarmGroup(children: [for (final g in tasks.working) work(g)]),
              // What the read shows done today is a floor ([swarmDoneToday]),
              // and says so.
              const SwarmCaption('Done today'),
              if (done == 0)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
                  child: SwarmRow.line(
                    'Nothing done today in recent work.',
                    key: const ValueKey('swarm-done-none'),
                  ),
                )
              else
                SwarmGroup(
                  children: [
                    Semantics(
                      expanded: _doneOpen,
                      child: SwarmRow(
                        key: const ValueKey('swarm-done-today'),
                        title: done == 1
                            ? 'At least 1 task done'
                            : 'At least $done tasks done',
                        chevron: _doneOpen
                            ? LucideIcons.chevronUp300
                            : LucideIcons.chevronDown300,
                        onTap: () => setState(() => _doneOpen = !_doneOpen),
                      ),
                    ),
                    if (_doneOpen)
                      for (final g in tasks.doneToday) work(g),
                  ],
                ),
            ],
          ),
        );
      },
    );
  }
}

/// A task of the project: its agent's face, its number and name, and its
/// agent and line under them ([SwarmTaskLine]) — or, for work the server
/// gave no state, its words. A tap opens its chat.
class SwarmWorkRow extends StatelessWidget {
  const SwarmWorkRow({
    super.key,
    required this.snapshot,
    required this.group,
    required this.onTap,
    this.personName,
    this.avatarSize = 32,
  });

  final SuperTabSnapshot snapshot;
  final SuperTabConversation group;
  final VoidCallback onTap;

  /// Names a person the task waits on, from [snapshot] alone.
  final String? Function(String personId)? personName;
  final double avatarSize;

  @override
  Widget build(BuildContext context) {
    final g = group;
    final agentId = g.assignment?['agentId'] as String?;
    final agent = agentId == null ? null : snapshot.agentName(agentId);
    return SwarmRow(
      // Nobody holds it: its number still lines up with the others'.
      leading: agentId == null
          ? SizedBox(width: avatarSize)
          : SwarmAvatar(
              id: agentId,
              name: agent!,
              size: avatarSize,
              picture: snapshot.agent(agentId)?.avatar,
            ),
      number: g.number == null ? null : '#${g.number}',
      title: g.title,
      // Its agent, then its task's line as the drawer's (#2125); work the
      // server gave no state keeps its words.
      detail: swarmTaskStatus(g, clock.now()) != null
          ? SwarmTaskLine(g, personName: personName, lead: agent)
          : switch (swarmWorkStatusWords(snapshot, g)) {
              final status? => SwarmRow.line(status),
              null => null,
            },
      onTap: onTap,
    );
  }
}

/// "Nova · Needs you"-like, from the work [g] holds; null when nobody holds
/// it.
String? swarmWorkStatusWords(
  SuperTabSnapshot snapshot,
  SuperTabConversation g,
) {
  final assignment = g.assignment;
  final status = assignment?['status'];
  if (assignment == null || status is! String) return null;
  final agent = snapshot.agentName(assignment['agentId'] as String? ?? '');
  final label = superTabWorkStatusLabel(status);
  return label.isEmpty
      ? agent
      : '$agent · ${label[0].toUpperCase()}${label.substring(1)}';
}

/// One thing in the project that waits on the person, as B2 draws it: a
/// yellow dot, the task it is in, who asks what and when under it — work's
/// own line ([SwarmTaskLine]) where it has one, after its agent — and at its
/// end what can be done there. A decision's is its recommended answer
/// ("Approve"), held for the session's Undo window and then sent, as on
/// Needs you; anything else is Reply, which opens where it was asked, as a
/// tap anywhere on the row does.
class SwarmWaitingRow extends StatelessWidget {
  const SwarmWaitingRow({
    super.key,
    required this.session,
    required this.snapshot,
    required this.need,
    required this.now,
    required this.onOpen,
    this.personName,
  });

  final SwarmSession session;
  final SuperTabSnapshot snapshot;
  final SwarmNeed need;
  final DateTime now;

  /// Names a person the work waits on, from [snapshot] alone.
  final String? Function(String personId)? personName;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final chat = snapshot.conversation(need.conversationId);
    final (title, who, at) = switch (need) {
      SwarmDecisionNeed(:final decision) => (
        decision.conversationTitle,
        decision.askerName,
        decision.createdAt,
      ),
      SwarmMentionNeed(:final mention) => (
        mention.conversationTitle,
        mention.leadName,
        mention.createdAt,
      ),
      SwarmWorkNeed(:final work) => (
        work.conversation.title,
        work.agentName,
        work.conversation.changedAt,
      ),
    };
    final (line, action) = _action(context);
    final task = switch (need) {
      SwarmWorkNeed(:final work) when line == null => switch (chat ??
          work.conversation) {
        final g when swarmTaskStatus(g, clock.now()) != null => g,
        _ => null,
      },
      _ => null,
    };
    return SwarmRow(
      leading: const _WaitDot(),
      number: chat?.number == null ? null : '#${chat!.number}',
      title: chat?.title ?? title,
      news: (bold: true, tags: 0),
      detail: task != null
          ? SwarmTaskLine(task, personName: personName, lead: who, mark: false)
          : SwarmRow.line(
              line ??
                  [
                    who,
                    // The task is the row's name: work with no question
                    // says how it waits.
                    switch (need) {
                      SwarmWorkNeed(:final work) =>
                        work.question ??
                            (work.status == 'blocked' ? 'stuck' : 'needs you'),
                      _ => swarmNeedAsk(need),
                    },
                    if (at != null) fzfAge(at.toLocal(), now.toLocal()),
                  ].where((part) => part.isNotEmpty).join(' · '),
              lines: 2,
            ),
      // As wide as a long answer may make it, and no wider: the task's
      // name keeps the rest.
      trailing: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 132),
        child: action,
      ),
      onTap: onOpen,
    );
  }

  /// What the row says in place of who asks, if anything, and its button.
  (String?, Widget) _action(BuildContext context) {
    final need = this.need;
    final reply = SwarmButton(
      key: ValueKey('swarm-reply-${need.key}'),
      label: 'Reply',
      onPressed: onOpen,
    );
    if (need is! SwarmDecisionNeed) return (null, reply);
    final decision = need.decision;
    final asks = session.inbox.asks(need.swarmId);
    if (session.held(need) case final held?) {
      return (
        'Sending “${swarmOption(decision.options, held)}”',
        SwarmButton(
          key: ValueKey('swarm-undo-${decision.id}'),
          label: 'Undo',
          style: SwarmButtonStyle.link,
          onPressed: () => session.undo(need),
        ),
      );
    }
    if (asks?.answering.contains(decision.id) ?? false) {
      return (
        'Sending…',
        SwarmButton(
          label: swarmOption(decision.options, decision.recommended),
          style: SwarmButtonStyle.fill,
          busy: true,
          busyLabel: 'Sending…',
          onPressed: null,
        ),
      );
    }
    // Sent and not confirmed, or a recommendation the decision does not
    // offer: its chat says what can be done.
    if (asks?.unconfirmed(decision) != null ||
        decision.recommended < 0 ||
        decision.recommended >= decision.options.length) {
      return (null, reply);
    }
    final option = swarmOption(decision.options, decision.recommended);
    return (
      session.dropped(need) ? 'Not sent, choose again.' : null,
      SwarmButton(
        key: ValueKey('swarm-approve-${decision.id}'),
        label: option,
        style: SwarmButtonStyle.fill,
        onPressed: () => unawaited(_approve(context, need, option)),
      ),
    );
  }

  /// Approve asks first ([confirmSwarmApprove]); confirmed, the recommended
  /// answer is held for Undo and then sent — unless meanwhile its row went:
  /// the decision left the person's list (answered elsewhere, or access
  /// taken away).
  Future<void> _approve(
    BuildContext context,
    SwarmDecisionNeed need,
    String option,
  ) async {
    if (!await confirmSwarmApprove(context, need, option)) return;
    if (!context.mounted) return;
    session.hold(need, need.decision.recommended);
  }
}

/// What waits on the person: a small dot in the warning colour.
class _WaitDot extends StatelessWidget {
  const _WaitDot();

  @override
  Widget build(BuildContext context) => Container(
    width: 8,
    height: 8,
    decoration: BoxDecoration(color: AppColors.warning, shape: BoxShape.circle),
  );
}
