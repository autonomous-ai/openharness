import 'dart:async';

import 'package:collection/collection.dart' show mergeSort;
import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/harness_activity_mark.dart';
import 'agent_details.dart';
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
import 'machine_status.dart';
import 'model.dart';
import 'profile_sheet.dart';
import 'section_heading.dart';
import 'agent_line.dart';

/// The current Swarm's authorized people, each with their week on the
/// leaderboard of the open conversation's project, and agents from the
/// selected project.
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

  /// Opens a conversation where an agent waits on a person.
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

  @override
  void dispose() {
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

  /// This Mac's reading of the agent; null when it cannot see it, or reads
  /// its status as unknown.
  HarnessActivity? _native(SuperTabAgent agent) {
    final app = widget.app;
    final native = app == null
        ? null
        : harnessActivity(app, agent.machineId, agent.harnessId);
    return native == HarnessActivity.unknown ? null : native;
  }

  HarnessActivity _activity(SuperTabAgent agent) {
    final native = _native(agent);
    // Keep the shared lifecycle precedence. A retained workgroup question must
    // not make a stopped or disconnected harness look available for input.
    if (native == HarnessActivity.offline ||
        native == HarnessActivity.paused ||
        native == HarnessActivity.starting ||
        native == HarnessActivity.failed ||
        native == HarnessActivity.needsInput) {
      return native!;
    }
    if (native == null) {
      if (_swarmDown(agent) case final down?) return down;
    }
    if (c.snapshot?.conversations.any(
          (group) =>
              !group.closed &&
              group.assignment?['agentId'] == agent.id &&
              superTabWorkWaits(group.assignment?['status']),
        ) ==
        true) {
      return HarnessActivity.needsInput;
    }
    return native ?? HarnessActivity.unknown;
  }

  /// What the Swarm knows of an agent this Mac cannot see that stops it
  /// running (Dee, 2026-10-29): its computer silent, offline; its session
  /// stopped; its start failed. Null when none is known. While the Swarm
  /// cannot be read, its computers are not called offline.
  HarnessActivity? _swarmDown(SuperTabAgent agent) {
    // The computer it runs on reports for itself: a Harness Team account
    // shown as its Mac has its own heartbeat.
    final machine = c.snapshot?.pool(agent.machineId);
    final at = switch (machine?['observation']) {
      {'receivedAt': final num at} => at.toInt(),
      _ => null,
    };
    if (machine != null &&
        !c.backendUnreachable &&
        superTabMachineStatus(
              age: at == null
                  ? null
                  : widget.now().difference(
                      DateTime.fromMillisecondsSinceEpoch(at),
                    ),
            ) ==
            SuperTabMachineStatus.offline) {
      return HarnessActivity.offline;
    }
    if (agent.downSince != null) return HarnessActivity.paused;
    final task = SuperTabAgentInfo(c, null, agent).taskGroup;
    return task?.liveness?['state'] == 'orphaned' &&
            task?.liveness?['why'] == 'start-failed'
        ? HarnessActivity.failed
        : null;
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

  Widget _agentIdentity(String name, String role, String badge) =>
      LayoutBuilder(
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
          final nameWidth = measure(name, nameStyle).clamp(
            0.0,
            (constraints.maxWidth - badgeWidth - 6).clamp(0.0, double.infinity),
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
                const SizedBox(width: 6),
              ],
              Semantics(
                label: role,
                excludeSemantics: true,
                child: SizedBox(width: badgeWidth, child: tag(badge)),
              ),
            ],
          );
        },
      );

  /// The mark an agent's row shows, which also orders the list: its activity,
  /// except that lost work shows the tabs' Offline, since nothing runs it
  /// (Dee, 2026-10-29). An agent this Mac cannot see, and the Swarm knows
  /// nothing stopping, takes its mark from its work: a prompt on its screen
  /// needs input; finished and in review, done; a task under way, working;
  /// nothing held, idle. Its words still say only Assigned for a task.
  HarnessActivity _shownActivity(SuperTabAgentInfo info) {
    final work = info.taskGroup?.assignment?['status'];
    if (work == 'lost') return HarnessActivity.offline;
    final activity = info.activity ?? HarnessActivity.unknown;
    if (activity != HarnessActivity.unknown || _native(info.agent) != null) {
      return activity;
    }
    if (info.agent.alerting.contains('prompt')) {
      return HarnessActivity.needsInput;
    }
    return switch (work) {
      'review' => HarnessActivity.done,
      'working' || 'planned' => HarnessActivity.working,
      _ => HarnessActivity.idle,
    };
  }

  /// An agent's row, in the shape the people's rows share (Dee, 2026-10-29):
  /// avatar, name and role chip, today's one status line beneath, and the
  /// tabs' status mark at the right. No rank and no points.
  Widget _agent(SuperTabAgent agent) {
    final name = c.snapshot!.agentName(agent.id), activity = _activity(agent);
    final info = SuperTabAgentInfo(c, widget.app, agent, activity: activity);
    final shown = _shownActivity(info);
    // One line, readable in a second (Dee, 2026-10-27): state, machine, model and effort. The task is in the tooltip.
    final glance = superTabAgentGlance(info);
    final project = c.snapshot!.projects
        .where((p) => p.id == _agentProjectId(agent))
        .firstOrNull;
    final customRole = c.snapshot!.activeRoleForAgent(agent);
    final role =
        customRole?.name ??
        (c.snapshot!.isLead(agent.id)
            ? 'Product Manager'
            : agent.isReviewer
            ? 'Reviewer'
            : 'Engineer');
    final badge =
        customRole?.name ??
        (c.snapshot!.isLead(agent.id)
            ? 'PM'
            : agent.isReviewer
            ? 'Rev'
            : 'Dev');
    final status = info.status ?? 'Status unavailable';
    final tooltip = [
      [name, role, ?project?.name].join(' · '),
      if (info.tooltip.isNotEmpty) info.tooltip,
      if (!info.tooltip.contains(status)) status,
    ].join('\n');
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
          onTap: () => unawaited(_details(agent)),
          onLongPress: () => unawaited(_details(agent)),
          avatar: SuperTabAvatar.agent(
            agent,
            name: name,
            size: SuperTabAvatar.rowSize,
            engineBadge: false,
          ),
          name: _agentIdentity(name, role, badge),
          detail: Text(
            glance.line,
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
    // The backend already scopes this snapshot to projects the person can
    // access. The roster follows the selected project; without one it keeps
    // the full directory, as the Product Managers' conversation, which belongs
    // to no project, does. Local machine inventory is not membership here.
    final projectId = c.selected?.projectId == ''
        ? null
        : c.selected?.projectId;
    // A private conversation lists only who reads it: its people and the
    // agents in it, the project's Lead.
    final audience = c.selected?.audience;
    final members =
        state?.teamAgents
            .where(
              (agent) =>
                  (projectId == null || _agentProjectId(agent) == projectId) &&
                  (audience == null || c.selected!.agentIds.contains(agent.id)),
            )
            .toList() ??
        const <SuperTabAgent>[];
    final leads = members.where((a) => state!.isLead(a.id)).toList();
    final agents = members.where((a) => !state!.isLead(a.id)).toList();
    final people =
        state?.people
            .where((p) => audience == null || audience.contains(p.id))
            .toList() ??
        const <SuperTabPerson>[];
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
    // idle, offline. Equals keep today's order, the Lead first.
    final shown = {
      for (final agent in [...leads, ...agents])
        agent.id: _shownActivity(
          SuperTabAgentInfo(c, widget.app, agent, activity: _activity(agent)),
        ),
    };
    final listed = [...leads, ...agents];
    mergeSort(
      listed,
      compare: (a, b) => shown[a.id]!.index - shown[b.id]!.index,
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
        // An agent joins the Product Managers' conversation by leading a project,
        // and a private conversation holds only the project's Lead.
        onAdd:
            c.canWrite &&
                c.selected != null &&
                c.selected!.id != c.snapshot?.leadsConversationId &&
                audience == null
            ? () => widget.onAddAgent(c.selected!)
            : null,
        addTooltip: 'Add agent',
      ),
      for (final agent in listed) _agent(agent),
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
