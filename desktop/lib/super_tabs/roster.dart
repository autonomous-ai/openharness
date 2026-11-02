import 'dart:async';

import 'package:collection/collection.dart' show mergeSort;
import 'package:flutter/material.dart';

import '../core/local_key_value_store.dart';
import '../core/relative_time.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/app_icons.dart';
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/browser_menu_guard.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/harness_activity_mark.dart';
import 'visible_tick.dart';
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
import 'model.dart';
import 'profile_sheet.dart';
import 'roster_scope.dart';
import 'section_heading.dart';
import 'agent_line.dart';
import '../widgets/laid_out_list.dart';

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
    this.onClose,
    this.app,
    this.board,
    this.storage,
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

  /// Closes the column: it opens only from Members (Quiet Swarm, Dee,
  /// 2026-11-02). No close when null.
  final VoidCallback? onClose;

  /// The open project's week board, shared with the sidebar's Models; the
  /// roster reads its own when not given.
  final SuperTabLeaderboardReader? board;

  /// Where the scope choice is kept on this computer; kept for this visit
  /// only when null.
  final LocalKeyValueStore? storage;
  final DateTime Function() now;
  @override
  State<SuperTabRoster> createState() => _SuperTabRosterState();
}

class _SuperTabRosterState extends State<SuperTabRoster>
    with WidgetsBindingObserver, VisibleTick<SuperTabRoster> {
  /// One per agent menu open now, each keeping the browser's menu off.
  final _menuHolds = <Object>{};

  /// Whether the agents folded under Idle (N) show; folded at first, for
  /// this visit.
  bool _idleOpen = false;

  SuperTabController get c => widget.controller;

  /// The board read here when the view shares none.
  SuperTabProjectBoard? _ownBoard;
  late final SuperTabLeaderboardReader _board =
      widget.board ?? (_ownBoard = SuperTabProjectBoard(c));

  /// Whole Swarm or the open project, remembered per account and Swarm.
  late final _choice = SuperTabRosterScopeChoice(
    storage: widget.storage,
    accountId: c.accountId,
    tabId: c.tabId,
  );

  /// The project the list is narrowed to now, so its loss is told from the
  /// person simply opening another project's chat.
  String? _scopedId;

  /// The scope follows the project open in the chat. A project that leaves
  /// the Swarm the reader sees (access revoked, deleted) while it is the one
  /// narrowing the list puts the choice back on All projects, and saves that,
  /// rather than carrying it over to whichever project opens next.
  void _scopeMoved() {
    _followScope();
    if (_choice.scope != SuperTabRosterScope.project) {
      _scopedId = null;
      return;
    }
    final state = c.snapshot;
    final last = _scopedId;
    if (last != null && state != null && state.projectById(last) == null) {
      _scopedId = null;
      _choice.choose(SuperTabRosterScope.all);
      return;
    }
    final open = c.selected?.projectId;
    if (open != null && open.isNotEmpty && state?.projectById(open) != null) {
      _scopedId = open;
    }
  }

  /// The board sums what the list shows: every readable project under All
  /// projects, the open one under its own name.
  void _followScope() => unawaited(
    _board.showAllProjects(_choice.scope == SuperTabRosterScope.all),
  );

  @override
  void initState() {
    super.initState();
    c.addListener(_scopeMoved);
    _choice.addListener(_scopeMoved);
    // A board shared with a roster of an earlier visit follows this one, after
    // this build: others are listening to it.
    scheduleMicrotask(() {
      if (mounted) _followScope();
    });
    // One tick for the whole list while on screen, so ages and leases stay true on a quiet Swarm (review of #2281); a change in
    // the Swarm rebuilds it anyway.
    visibleTick(const Duration(seconds: 30));
  }

  @override
  void dispose() {
    _menuHolds.forEach(BrowserMenuGuard.release);
    _menuHolds.clear();
    c.removeListener(_scopeMoved);
    _choice.removeListener(_scopeMoved);
    _ownBoard?.dispose();
    _choice.dispose();
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

  /// A person's card (Quiet Swarm, screen 5): their name with the crown,
  /// their points, the period on hover, their numbers under the name and
  /// what is behind them; who they are on the avatar's hover. One's own also
  /// opens the profile sheet, where one's avatar and status change.
  Future<void> _person(SuperTabPerson person, SuperTabPersonScore? score) {
    final name = leaderboardName(person, score);
    return showAppDialog<void>(
      context: context,
      builder: (context) => SuperTabDetailDialog(
        title: leaderboardCrowned(score) ? '$name \u{1F451}' : name,
        detail: score == null ? null : leaderboardCardNumbers(score),
        leading: Tooltip(
          message:
              '${person.email} · ${switch (person.role) {
                'owner' => 'Owner',
                'viewer' => 'Can view',
                _ => 'Can collaborate',
              }}',
          child: SuperTabAvatar.person(person, size: 40),
        ),
        headerActions: [
          if (score != null)
            Tooltip(
              // The period, and the one before rather than a difference.
              message: [
                'Points ${score.spanName}',
                if (score.prevWeekPoints case final before?)
                  '$before ${score.earlierName}',
              ].join(' · '),
              child: Text(
                plural(score.points, 'point'),
                style: leaderboardPointsStyle(),
              ),
            ),
        ],
        body: score == null
            ? const SizedBox.shrink()
            : LeaderboardPersonWeek(score: score, summary: false),
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
  }

  Future<void> _details(SuperTabAgent agent) => showSuperTabAgentDetails(
    context,
    c,
    widget.app,
    agent,
    widget.onOpenAgent,
  );

  /// The agent's card (Quiet Swarm, screen 5).
  Future<void> _card(SuperTabAgent agent) => showSuperTabAgentCard(
    context,
    c,
    widget.app,
    agent,
    onOpenAgent: widget.onOpenAgent,
    onOpenTask: widget.onAnswer,
  );

  /// An agent's row, one line (Quiet Swarm, screen 4): avatar, name, then
  /// its state in a word and the tabs' status mark at the right. Role, task,
  /// model, effort and machine are on its card and its hover.
  Widget _agent(SuperTabAgent agent, SuperTabAgentState state, DateTime now) {
    final name = c.snapshot!.agentName(agent.id), shown = state.mark;
    final info = SuperTabAgentInfo(c, widget.app, agent, activity: state.words);
    // The state in a word, where it runs, its engine, model and effort: on hover (Dee, 2026-10-30).
    final glance = superTabAgentGlance(info, now: now);
    final project = c.snapshot!.projects
        .where((p) => p.id == _agentProjectId(agent))
        .firstOrNull;
    final (name: role, badge: _) =
        c.snapshot!.roleOf(agent.id) ?? (name: 'Engineer', badge: 'Dev');
    final status = info.status ?? 'Status unavailable';
    // Who, then where and on what, then the task, then when (Dee,
    // 2026-10-30); since the row is one line, how long since its last
    // progress too, which its line said.
    final tooltip = [
      [name, role, ?project?.name, ?info.engine].join(' · '),
      glance.line,
      if (status != glance.label) status,
      if (state.work?.progressAt case final at?)
        'Last progress ${relativeAgo(at, now)}',
      if (info.lastActive case final at?) 'Last active ${relativeAgo(at, now)}',
    ].join('\n');
    void open() => unawaited(_card(agent));
    final theme = terminalThemeFor(
      grid.AppTheme.surfacePalette,
      terminalThemeStore.value,
    );
    return Tooltip(
      message: tooltip,
      constraints: const BoxConstraints(maxWidth: 820),
      child: BrowserMenuOff(
        active: true,
        child: GestureDetector(
          onSecondaryTapUp: (event) async {
            // Off until the menu closes: its barrier takes the pointer from the row.
            final hold = Object();
            _menuHolds.add(hold);
            BrowserMenuGuard.hold(hold);
            final String? choice;
            try {
              choice = await showMenu<String>(
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
                          if (_removeReason(agent) case final reason?)
                            Text(reason),
                        ],
                      ),
                    ),
                ],
              );
            } finally {
              _menuHolds.remove(hold);
              BrowserMenuGuard.release(hold);
            }
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
            onLongPress: open,
            avatar: SuperTabAvatar.agent(
              agent,
              name: name,
              size: SuperTabAvatar.rowSize,
              engineBadge: false,
            ),
            name: Text(
              name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.control(),
            ),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  superTabMemberWord(glance.label),
                  key: ValueKey('super-member-word-${agent.id}'),
                  maxLines: 1,
                  style: DesktopChrome.metadata(),
                ),
                const SizedBox(width: DesktopChrome.controlGap),
                ActivityMark(
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
              ],
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
    // The project the list is narrowed to, only while the person chose it and
    // a project they can read is open; otherwise the whole Swarm (Dee,
    // 2026-11-02). Read from the live snapshot, so a project that is gone or
    // no longer readable never narrows anything.
    final scoped =
        _choice.scope == SuperTabRosterScope.project && projectId != null
        ? state?.projectById(projectId)
        : null;
    final members = state?.teamAgents ?? const <SuperTabAgent>[];
    bool inScope(SuperTabAgent a) =>
        scoped == null ||
        (state!.leadProjectForAgent(a.id)?.id ?? _agentProjectId(a)) ==
            scoped.id;
    final leads = members
        .where((a) => state!.isLead(a.id) && inScope(a))
        .toList();
    final agents = members
        .where((a) => !state!.isLead(a.id) && inScope(a))
        .toList();
    // Only the open project's board: an answer for any other never lends
    // its numbers to these rows.
    final board = switch (_board.board) {
      // Nor numbers of another scope: a whole-Swarm board says nothing of who
      // is in this project. A board of a week is the open project's alone.
      final board?
          when projectId != null &&
              board.projectId == projectId &&
              (board.period == null ||
                  board.allProjects ==
                      (_choice.scope == SuperTabRosterScope.all)) =>
        board,
      _ => null,
    };
    final people = [
      for (final person in state?.people ?? const <SuperTabPerson>[])
        if (scoped == null || personInProject(scoped, person.id, board: board))
          person,
    ];
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
    // One points column for every person's row.
    final columns = board == null || board.people.isEmpty
        ? null
        : LeaderboardColumns.measure(
            context,
            points: board.people.map((s) => s.points),
          );
    final openProject = projectId == null
        ? null
        : state?.projectById(projectId);
    return [
      _heading(openProject == null ? null : scoped != null),
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
      // People and Agents: the two roles in one team (Quiet Swarm, screen 4).
      SuperTabSectionHeading(
        'People',
        onAdd: c.isOwner ? widget.onInvite : null,
        addTooltip: 'Invite people',
      ),
      // Points are the last 7 days, the period on hover; who waits on whom is
      // Activity's Needs you (Quiet Swarm, 2026-11-02).
      for (final person in sorted)
        LeaderboardPersonRow(
          person: person,
          score: scores[person.id],
          columns: columns,
          own: person.id == c.accountId,
          onTap: () => _person(person, scores[person.id]),
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
      for (final agent in listed)
        if (!superTabFoldsIdle(states[agent.id]!))
          _agent(agent, states[agent.id]!, now),
      if (listed.where((a) => superTabFoldsIdle(states[a.id]!)).toList()
          case final idle when idle.isNotEmpty) ...[
        SuperTabSectionHeading(
          'Idle (${idle.length})',
          key: const ValueKey('super-members-idle'),
          collapsed: !_idleOpen,
          onToggleCollapsed: () => setState(() => _idleOpen = !_idleOpen),
        ),
        if (_idleOpen)
          for (final agent in idle) _agent(agent, states[agent.id]!, now),
      ],
    ];
  }

  /// The column's heading: the project-or-Swarm choice while a project is
  /// open ([narrowed] says which is chosen), All projects alone otherwise,
  /// and its close at the right as a thread's has.
  Widget _heading(bool? narrowed) {
    final style = DesktopChrome.heading();
    return Padding(
      key: const ValueKey('super-members-heading'),
      padding: const EdgeInsets.fromLTRB(
        DesktopChrome.groupGap,
        0,
        DesktopChrome.controlGap,
        DesktopChrome.controlGap,
      ),
      child: Row(
        children: [
          Expanded(
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: narrowed == null
                  ? Semantics(
                      header: true,
                      child: Text(
                        superTabRosterScopeLabel(SuperTabRosterScope.all),
                        style: style,
                      ),
                    )
                  : AppSelectField<SuperTabRosterScope>(
                      key: const ValueKey('roster-scope'),
                      value: narrowed
                          ? SuperTabRosterScope.project
                          : SuperTabRosterScope.all,
                      width: AppSelectField.fitWidth(
                        context,
                        labels: SuperTabRosterScope.values.map(
                          superTabRosterScopeLabel,
                        ),
                      ),
                      height: DesktopChrome.compactControlHeight,
                      semanticLabel: 'Show',
                      options: [
                        for (final scope in SuperTabRosterScope.values.reversed)
                          SelectOption(
                            value: scope,
                            label: superTabRosterScopeLabel(scope),
                          ),
                      ],
                      onChanged: _choice.choose,
                    ),
            ),
          ),
          if (widget.onClose case final close?)
            AppIconButton(
              key: const ValueKey('super-members-close'),
              icon: AppIcons.close,
              tooltip: 'Close members',
              onPressed: close,
            ),
        ],
      ),
    );
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
          _choice,
          if (widget.app != null) ...[widget.app!, widget.app!.agentUnread],
          terminalThemeStore,
          appearancePrefsStore,
        ]),
        builder: (context, _) => LaidOutListView(
          key: PageStorageKey('super-tab-resources-${c.tabId}'),
          padding: const EdgeInsets.symmetric(vertical: 12),
          children: _members(),
        ),
      ),
    );
  }
}

/// An agent row's state word: the glance's in the chat's words ("waiting",
/// "working", "in review"), one short word so the row stays one line; a
/// reset time or a reason is on hover.
String superTabMemberWord(String label) => switch (label) {
  'Waiting on others' => 'in review',
  'Kept (closed)' => 'kept',
  _ when label.startsWith('Limited until') => 'limited',
  '' => label,
  _ => '${label[0].toLowerCase()}${label.substring(1)}',
};

/// Whether an agent folds under Idle (N): it holds no task and is idle,
/// stopped or offline. An agent with work, lost work too, stays in view.
bool superTabFoldsIdle(SuperTabAgentState state) =>
    state.work == null &&
    const {
      HarnessActivity.idle,
      HarnessActivity.paused,
      HarnessActivity.offline,
    }.contains(state.mark);
