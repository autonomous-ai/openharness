import 'dart:async';

import 'package:collection/collection.dart' show mergeSort;
import 'package:flutter/material.dart';

import '../core/relative_time.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/harness_activity_mark.dart';
import 'agent_details.dart';
import 'agent_mark.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'leaderboard/format.dart';
import 'leaderboard/member_row.dart';
import 'leaderboard/model.dart';
import 'leaderboard/person_row.dart';
import 'leaderboard/reader.dart';
import 'leaderboard/waiting_line.dart';
import 'model.dart';
import 'profile_sheet.dart';
import 'section_heading.dart';
import 'agent_line.dart';

/// The current Swarm's authorized people, each with their week on the
/// leaderboard of the open conversation's project, and every agent of the
/// Swarm: the same list whichever chat is open, as Slack's and Discord's member
/// lists are (Dee, 2026-10-31).
class SuperTabRoster extends StatefulWidget {
  const SuperTabRoster({
    super.key,
    required this.controller,
    required this.onInvite,
    required this.onOpenAgent,
    required this.onAddAgent,
    required this.onAnswer,
    this.app,
    this.board,
    this.now = DateTime.now,
  });
  final SuperTabController controller;
  final AppNotifier? app;
  final VoidCallback onInvite;
  final ValueChanged<SuperTabAgent> onOpenAgent;
  final ValueChanged<SuperTabConversation> onAddAgent;

  /// Opens a conversation: one where an agent waits on a person, or an agent
  /// row's task.
  final ValueChanged<String> onAnswer;

  /// The open project's week board, shared with the sidebar's Models; the
  /// roster reads its own when not given.
  final SuperTabLeaderboardReader? board;
  final DateTime Function() now;
  @override
  State<SuperTabRoster> createState() => _SuperTabRosterState();
}

class _SuperTabRosterState extends State<SuperTabRoster> {
  SuperTabController get c => widget.controller;

  /// The board read here when the view shares none.
  SuperTabProjectBoard? _ownBoard;
  late final SuperTabLeaderboardReader _board =
      widget.board ?? (_ownBoard = SuperTabProjectBoard(c));

  /// One tick for the whole list, so ages and leases stay true on a quiet
  /// Swarm (review of #2281); a change in the Swarm rebuilds it anyway.
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(
      const Duration(seconds: 30),
      (_) => mounted ? setState(() {}) : null,
    );
  }

  @override
  void dispose() {
    _tick?.cancel();
    _ownBoard?.dispose();
    super.dispose();
  }

  String? _agentProjectId(SuperTabAgent agent) => agent.hasProjectId
      ? agent.projectId
      : c.snapshot?.conversations
            .where(
              (group) =>
                  group.agentIds.contains(agent.id) || group.leadId == agent.id,
            )
            .firstOrNull
            ?.projectId;

  bool _canRemove(SuperTabAgent agent) =>
      c.canWrite && (c.isOwner || agent.contributorId == c.accountId);

  String? _removeReason(SuperTabAgent agent) =>
      c.snapshot?.leadProtectionReason(agent.id);

  Future<void> _remove(SuperTabAgent agent) async {
    var busy = false, attempted = false;
    final name = c.snapshot!.agentName(agent.id);
    // The Mac, for an agent in that Mac's Harness Team account.
    final place = c.snapshot?.placeOf(agent.machineId) ?? agent.machineId;
    final machine =
        widget.app?.stateOf(place)?.machine.displayName ??
        c.snapshot?.pool(place)?['name'] as String? ??
        'its computer';
    await showAppDialog<void>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        child: StatefulBuilder(
          builder: (context, update) => ListenableBuilder(
            listenable: c,
            builder: (context, _) {
              final current = c.snapshot?.agent(agent.id);
              final pending = c.pendingCommand;
              final checking =
                  pending?['type'] == 'agent.remove' &&
                  pending?['agentId'] == agent.id;
              final available = current != null || checking || busy;
              final permitted = _canRemove(current ?? agent);
              final reason = _removeReason(current ?? agent);
              final enabled =
                  permitted &&
                  reason == null &&
                  !busy &&
                  !c.saving &&
                  (checking || !c.hasPendingAction);
              return PopScope(
                canPop: !busy,
                child: AlertDialog(
                  title: Text(
                    available
                        ? 'Remove $name from this Swarm?'
                        : 'Agent unavailable',
                  ),
                  content: SizedBox(
                    width: 400,
                    child: SingleChildScrollView(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            reason ??
                                (available && permitted
                                    ? 'Any open task needs to be assigned again or closed. Its session on $machine will stop.'
                                    : 'This action is no longer available.'),
                          ),
                          if (attempted && c.operationError != null) ...[
                            const SizedBox(height: 12),
                            Text(c.operationError!),
                          ],
                        ],
                      ),
                    ),
                  ),
                  actions: [
                    TextButton(
                      autofocus: true,
                      onPressed: busy ? null : () => Navigator.pop(context),
                      child: Text(
                        checking || !available || !permitted
                            ? 'Close'
                            : 'Cancel',
                      ),
                    ),
                    if (available && permitted)
                      FilledButton(
                        style: grid.dangerButtonStyle(),
                        onPressed: !enabled
                            ? null
                            : () async {
                                update(() {
                                  busy = true;
                                  attempted = true;
                                });
                                final result = checking
                                    ? await c.retry()
                                    : await c.command({
                                        'type': 'agent.remove',
                                        'agentId': agent.id,
                                      });
                                if (!context.mounted) return;
                                if (result != null) {
                                  Navigator.pop(context);
                                } else {
                                  update(() => busy = false);
                                }
                              },
                        child: Text(checking ? 'Retry' : 'Remove from Swarm'),
                      ),
                  ],
                ),
              );
            },
          ),
        ),
      ),
    );
  }

  /// A person's email and role, and their week when the board has them. One's
  /// own also opens the profile sheet, where one's avatar and status change.
  Future<void> _person(SuperTabPerson person, SuperTabPersonScore? score) =>
      showAppDialog<void>(
        context: context,
        builder: (context) => SuperTabDetailDialog(
          title: leaderboardName(person, score),
          // Who they are on one line under the name (Ken, 2026-10-28).
          detail:
              '${person.email} · ${switch (person.role) {
                'owner' => 'Owner',
                'viewer' => 'Can view',
                _ => 'Can collaborate',
              }}',
          leading: SuperTabAvatar.person(person, size: 40),
          body: score == null
              ? const SizedBox.shrink()
              : LeaderboardPersonWeek(score: score),
          actions: [
            TextButton(
              onPressed: () {
                Navigator.pop(context);
                widget.onInvite();
              },
              child: const Text('Manage people'),
            ),
            if (person.id == c.accountId && c.canWrite)
              TextButton(
                key: const ValueKey('super-profile-edit'),
                onPressed: () {
                  Navigator.pop(context);
                  showSuperTabProfile(this.context, c);
                },
                child: const Text('Edit profile'),
              ),
          ],
        ),
      );

  Future<void> _details(SuperTabAgent agent) => showSuperTabAgentDetails(
    context,
    c,
    widget.app,
    agent,
    widget.onOpenAgent,
  );

  /// Name, role chip, then the model and effort in the details line's grey
  /// (Dee, 2026-10-31). The name and chip are measured first; the model takes
  /// what is left and is cut before either shrinks.
  Widget _agentIdentity(
    String name,
    String role,
    String badge, {
    String? model,
    Key? modelKey,
  }) => LayoutBuilder(
    builder: (context, constraints) {
      final nameStyle = DesktopChrome.control();
      final tagStyle = DesktopChrome.metadata();
      final scale = MediaQuery.textScalerOf(context);
      double measure(String text, TextStyle style) {
        final painter = TextPainter(
          text: TextSpan(text: text, style: style),
          textDirection: Directionality.of(context),
          textScaler: scale,
          maxLines: 1,
        )..layout();
        final width = painter.width;
        painter.dispose();
        return width;
      }

      final badgeWidth = (measure(badge, tagStyle) + 10).clamp(
        0.0,
        constraints.maxWidth,
      );
      // One gap between name, chip and model.
      const gap = 6.0;
      final nameWidth = measure(name, nameStyle).clamp(
        0.0,
        (constraints.maxWidth - badgeWidth - gap).clamp(0.0, double.infinity),
      );
      Widget tag(String text) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
        decoration: BoxDecoration(
          color: grid.AppSurface.hoverFill,
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(
          text,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: tagStyle,
        ),
      );
      return Row(
        children: [
          if (nameWidth > 0) ...[
            SizedBox(
              width: nameWidth,
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: nameStyle,
              ),
            ),
            const SizedBox(width: gap),
          ],
          Semantics(
            label: role,
            excludeSemantics: true,
            child: SizedBox(width: badgeWidth, child: tag(badge)),
          ),
          // The gap shrinks with the model, so a name that fills the row never overflows.
          if (model != null)
            Flexible(
              child: Padding(
                padding: const EdgeInsets.only(left: gap),
                child: Text(
                  model,
                  key: modelKey,
                  maxLines: 1,
                  softWrap: false,
                  overflow: TextOverflow.ellipsis,
                  style: tagStyle,
                ),
              ),
            ),
        ],
      );
    },
  );

  /// An agent's row, in the shape the people's rows share (Dee, 2026-10-29):
  /// avatar, name and role chip, today's one status line beneath, and the
  /// tabs' status mark at the right. No rank and no points.
  Widget _agent(SuperTabAgent agent, SuperTabAgentState state, DateTime now) {
    final name = c.snapshot!.agentName(agent.id), shown = state.mark;
    final info = SuperTabAgentInfo(c, widget.app, agent, activity: state.words);
    final work = state.work;
    // The state in a word, where it runs, its engine, model and effort: on hover (Dee, 2026-10-30); the model and
    // effort on the first line too (Dee, 2026-10-31).
    final glance = superTabAgentGlance(info, now: now);
    final project = c.snapshot!.projects
        .where((p) => p.id == _agentProjectId(agent))
        .firstOrNull;
    final (name: role, :badge) =
        c.snapshot!.roleOf(agent.id) ?? (name: 'Engineer', badge: 'Dev');
    final status = info.status ?? 'Status unavailable';
    final tooltip = [
      [name, role, ?project?.name, ?info.engine].join(' · '),
      glance.line,
      if (status != glance.label) status,
      if (info.lastActive case final at?) 'Last active ${relativeAgo(at, now)}',
    ].join('\n');
    // The row's details line (Dee, 2026-10-30): the task in plain words and
    // how long since its last progress; with no task, the state in a word.
    final limited = glance.label.startsWith('Limited until')
        ? glance.label
        : null;
    final detail = work == null
        ? glance.label
        : [
            ?limited,
            work.group.title,
            if (work.progressAt case final at?)
              superTabAgentAge(now.difference(at)),
          ].join(' · ');
    // A task opens its conversation, a needs-you one at its question; no task, the details.
    void open() => work == null
        ? unawaited(_details(agent))
        : widget.onAnswer(work.group.id);
    final theme = terminalThemeFor(
      grid.AppTheme.surfacePalette,
      terminalThemeStore.value,
    );
    return Tooltip(
      message: tooltip,
      constraints: const BoxConstraints(maxWidth: 820),
      child: GestureDetector(
        onSecondaryTapUp: (event) async {
          final choice = await showMenu<String>(
            context: context,
            position: RelativeRect.fromLTRB(
              event.globalPosition.dx,
              event.globalPosition.dy,
              event.globalPosition.dx,
              event.globalPosition.dy,
            ),
            items: [
              const PopupMenuItem(value: 'details', child: Text('Details')),
              if (_canRemove(c.snapshot?.agent(agent.id) ?? agent))
                PopupMenuItem(
                  value: 'remove',
                  enabled: _removeReason(agent) == null,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Remove from Swarm'),
                      if (_removeReason(agent) case final reason?) Text(reason),
                    ],
                  ),
                ),
            ],
          );
          if (choice == 'details' && mounted) await _details(agent);
          if (choice == 'remove' && mounted) {
            final current = c.snapshot?.agent(agent.id);
            if (current != null &&
                _canRemove(current) &&
                _removeReason(current) == null) {
              await _remove(current);
            }
          }
        },
        child: SuperTabMemberRow(
          rowKey: ValueKey('super-member-${agent.id}'),
          onTap: open,
          onLongPress: () => unawaited(_details(agent)),
          avatar: SuperTabAvatar.agent(
            agent,
            name: name,
            size: SuperTabAvatar.rowSize,
            engineBadge: false,
          ),
          name: _agentIdentity(
            name,
            role,
            badge,
            model: glance.modelEffort,
            modelKey: ValueKey('super-member-model-${agent.id}'),
          ),
          detail: Text(
            detail,
            key: ValueKey('super-member-line-${agent.id}'),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.metadata(),
          ),
          trailing: ActivityMark(
            key: ValueKey('super-member-mark-${agent.id}'),
            activity: shown,
            tooltip: false,
            showIdle: true,
            color: activityColor(
              shown,
              theme,
              color: appearancePrefsStore.value.prompt.color,
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _members() {
    final state = c.snapshot;
    // The whole Swarm the person may see, whichever chat is open (Dee,
    // 2026-10-31): the backend already scopes this snapshot to the projects
    // they can read. Local machine inventory is not membership here.
    final projectId = c.selected?.projectId == ''
        ? null
        : c.selected?.projectId;
    // Who reads a private conversation still decides its +, never the list.
    final audience = c.selected?.audience;
    final members = state?.teamAgents ?? const <SuperTabAgent>[];
    final leads = members.where((a) => state!.isLead(a.id)).toList();
    final agents = members.where((a) => !state!.isLead(a.id)).toList();
    final people = state?.people ?? const <SuperTabPerson>[];
    // Only the open project's board: an answer for any other never lends
    // its numbers to these rows.
    final board = switch (_board.board) {
      final board? when projectId != null && board.projectId == projectId =>
        board,
      _ => null,
    };
    final scores = {
      for (final score in board?.people ?? const []) score.personId: score,
    };
    // The selected week's points, highest first; equal points, and no points
    // at all, by name, letter case aside (Dee, 2026-10-29).
    int points(SuperTabPerson p) => scores[p.id]?.points ?? 0;
    String sortName(SuperTabPerson p) =>
        leaderboardName(p, scores[p.id]).toLowerCase();
    final sorted = [...people]
      ..sort((a, b) {
        final byPoints = points(b).compareTo(points(a));
        if (byPoints != 0) return byPoints;
        final byName = sortName(a).compareTo(sortName(b));
        return byName != 0 ? byName : a.id.compareTo(b.id);
      });
    // Most urgent first, as the tabs order their marks: needs input, working,
    // idle, offline; within a mark, the most recent progress first (Dee,
    // 2026-10-30). Equals keep today's order, the Lead first. Each agent's
    // state is worked out once, by the Swarm's clock.
    final now = superTabServerNow(c, widget.now());
    final states = {
      for (final agent in [...leads, ...agents])
        agent.id: superTabAgentState(c, widget.app, agent, now: now),
    };
    final progress = {
      for (final MapEntry(:key, :value) in states.entries)
        key: value.work?.progressAt,
    };
    final listed = [...leads, ...agents];
    mergeSort(
      listed,
      compare: (a, b) {
        final byMark = states[a.id]!.mark.index - states[b.id]!.mark.index;
        if (byMark != 0) return byMark;
        final pa = progress[a.id], pb = progress[b.id];
        if (pa == null || pb == null) {
          return (pa == null ? 1 : 0) - (pb == null ? 1 : 0);
        }
        return pb.compareTo(pa);
      },
    );
    final current = leaderboardWeekOf(widget.now());
    // One points column for every person's row.
    final columns = board == null || board.people.isEmpty
        ? null
        : LeaderboardColumns.measure(
            context,
            points: board.people.map((s) => s.points),
          );
    final week = weekName(_board.week, current);
    return [
      // Humans and Agents: the two roles in one team (Dee, 2026-10-29).
      SuperTabSectionHeading(
        'Humans',
        actions: [
          if (board != null || _board.week != null)
            AppSelectField<int>(
              key: const ValueKey('leaderboard-week'),
              value: _board.week ?? current,
              width: 112,
              height: DesktopChrome.compactControlHeight,
              semanticLabel: 'Week',
              options: [
                for (var back = 0; back < 4; back++)
                  SelectOption(
                    value: current - back * weekMs,
                    label: capitalized(
                      weekName(current - back * weekMs, current),
                    ),
                  ),
              ],
              onChanged: (week) =>
                  unawaited(_board.showWeek(week == current ? null : week)),
            ),
        ],
        onAdd: c.isOwner ? widget.onInvite : null,
        addTooltip: 'Invite people',
      ),
      if (_board.error case final error?)
        Padding(
          padding: const EdgeInsets.fromLTRB(
            DesktopChrome.groupGap,
            0,
            DesktopChrome.groupGap,
            DesktopChrome.controlGap / 2,
          ),
          child: Text(error, style: DesktopChrome.metadata()),
        ),
      for (final person in sorted)
        LeaderboardPersonRow(
          person: person,
          score: scores[person.id],
          columns: columns,
          own: person.id == c.accountId,
          weekName: week,
          onTap: () => _person(person, scores[person.id]),
        ),
      if (board != null && board.waiting.total > 0)
        LeaderboardWaitingLine(
          waiting: board.waiting,
          viewerId: c.accountId,
          nameOf: (id) {
            final person = state?.people.where((p) => p.id == id).firstOrNull;
            return person == null
                ? 'Former member'
                : leaderboardName(person, scores[id]);
          },
          onAnswer: widget.onAnswer,
        ),
      const SizedBox(height: DesktopChrome.groupGap),
      SuperTabSectionHeading(
        'Agents',
        // A private conversation holds only the project's Lead.
        onAdd: c.canWrite && c.selected != null && audience == null
            ? () => widget.onAddAgent(c.selected!)
            : null,
        addTooltip: 'Add agent',
      ),
      for (final agent in listed) _agent(agent, states[agent.id]!, now),
    ];
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Material(
      color: DesktopChrome.surface,
      child: ListenableBuilder(
        listenable: Listenable.merge([
          c,
          _board,
          if (widget.app != null) ...[widget.app!, widget.app!.agentUnread],
          terminalThemeStore,
          appearancePrefsStore,
        ]),
        builder: (context, _) => ListView(
          key: PageStorageKey('super-tab-resources-${c.tabId}'),
          padding: const EdgeInsets.symmetric(vertical: 12),
          children: _members(),
        ),
      ),
    );
  }
}
