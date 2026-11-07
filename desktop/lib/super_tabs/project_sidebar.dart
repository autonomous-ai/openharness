import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shared/theme/appearance_prefs_store.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/harness_activity_mark.dart';
import 'activity.dart';
import 'attention.dart';
import 'controller.dart';
import 'buddies.dart';
import 'model.dart';
import 'my_agents.dart';
import 'personal_projects.dart' show PersonalProjects;
import 'places.dart';
import 'buddy_rows.dart';
import 'section_heading.dart';
import 'swarm_switcher.dart';
import 'project_github.dart';
import 'private_project_lock.dart';
import '../widgets/laid_out_list.dart';
import 'swarm_type.dart';

/// The reader's one Buddy for the whole Swarm, listed first among the projects
/// as a channel (Dee, 10-31).
const kSwarmBuddyChannel = 'buddy';

/// What the # buddy row draws before the reader's one Buddy chat is opened: a
/// row with nothing in it, which opens the chat on the server when clicked.
final _unopenedSwarmBuddyChat = SuperTabConversation.fromJson(const {
  'id': '',
  'kind': 'swarm-buddy',
  'title': kSwarmBuddyChannel,
  'brief': '',
  'leadId': null,
  'archived': false,
  'agentIds': <String>[],
});

class ProjectSidebar extends StatelessWidget {
  const ProjectSidebar({
    super.key,
    required this.controller,
    required this.onSelect,
    this.app,
    this.onNewProject,
    this.onNewSwarm,
    this.onManage,
    this.manageSelected = false,
    this.devicesSelected = false,
    this.onPage,
    this.page,
    this.attention,
    this.activity,
    this.places,
    this.onOpenBuddyChat,
    this.compact = false,
    this.board = false,
    this.onNewAgent,
    this.onOpenAgentChat,
    this.boardProjectId,
    this.onOpenAgentTerminal,
  });
  final SuperTabController controller;

  /// A phone's layout: its rows keep the app's sizes, not Slack desktop's ([SwarmType]).
  final bool compact;

  /// Desktop's Board layout (anh Dee, task #3787): no Threads row and no Buddy entry, the Buddy being the right pane.
  final bool board;

  /// + New agent (Swarm v3, task #4118): opens the creation dialog, where Regular or PM is chosen. Without it the section
  /// has no + .
  final VoidCallback? onNewAgent;

  /// Opens the chat of an agent chosen in My agents in the middle; [onSelect] when not given.
  final ValueChanged<String>? onOpenAgentChat;

  /// The project whose Board holds the Desktop's middle, if one does. Its row is then the lit one, though the selected
  /// chat is the Buddy's on the right (task #4220).
  final String? boardProjectId;

  /// Opens the terminal of an agent in My agents that has no chat to open (task #4220); without it the row opens nothing.
  final ValueChanged<SuperTabAgent>? onOpenAgentTerminal;
  final ValueChanged<String> onSelect;
  final AppNotifier? app;
  final VoidCallback? onNewProject;

  /// The existing New Swarm. Given, the bar starts with the Swarm dropdown
  /// ([SwarmSwitcher]), which offers it last.
  final VoidCallback? onNewSwarm;

  /// Opens Manage (Machines, Models, Devices, Swarm), the row at the foot.
  final VoidCallback? onManage;
  final bool manageSelected;
  final bool devicesSelected;

  /// Opens one of the Swarm's pages: Decisions, Mentions or Threads (anh
  /// Dee, 11-05, task #2996). Without it the three rows are not shown.
  final ValueChanged<SwarmPage>? onPage;

  /// The page holding the main pane, if one does.
  final SwarmPage? page;

  /// What the three rows read, to be bold or grey; without it Decisions and
  /// Mentions read what the server says waits, and Threads nothing.
  final SuperTabActivity? activity;

  /// The reader's places, for the back and forward arrows at the top of a
  /// layout that is not the Desktop's; without it there are none. The
  /// Desktop has none (anh Dee, task #4192): ⌘[ and ⌘] still step.
  final SuperTabPlaces? places;

  /// What needs the reader, as Slack shows it: each row's red number counts
  /// only tags of them (decisions asked of them among them), and Threads is
  /// bold while a thread they follow has replies they have not read. Without
  /// it rows carry no number.
  final SuperTabAttention? attention;

  /// Whether a row other than a conversation (Manage, devices, a page) holds
  /// the main pane.
  bool get _paneCovered => manageSelected || devicesSelected || page != null;

  /// Whether an open My agents lists an agent whose chat is [chat], so that agent's row is the lit one.
  bool _litInMyAgents(SuperTabConversation chat, _SidebarReading? reading) =>
      board &&
      controller.agentsGroupOpen &&
      reading != null &&
      reading.myAgents.any((row) => row.$2?.id == chat.id);

  /// A project's Board holds the Desktop's middle: no chat's row is lit.
  bool get _boardOpen => board && boardProjectId != null;

  /// Whether [chat]'s row is the open one: its chat holds the main pane.
  bool _chatLit(SuperTabConversation? chat) =>
      chat != null &&
      !_paneCovered &&
      !_boardOpen &&
      controller.selectedId == chat.id;

  /// Opens the reader's Buddy chat in a project, by project id; the
  /// controller's [SuperTabController.openBuddyChat] when not given.
  final ValueChanged<String>? onOpenBuddyChat;

  /// Forwarded to the embedded [SuperTabMachines]; a test gives it to pin
  /// the clock its readings' ages are counted against.
  @visibleForTesting
  /// Projects and workgroups share a text column. Only projects use its icon.
  static const _iconColumn = SuperTabSectionHeading.actionWidth;
  static const _rowEnd = 10.0;

  /// Under the chat box and under Manage beside it, so the two end on one line.
  static const double footGap = 16;

  /// A sidebar section's heading, as Slack's "Channels": the row's size, medium and muted. A phone keeps the
  /// heading's own.
  TextStyle? get _headingStyle => compact
      ? null
      : SwarmType.sidebar(
          compact: false,
          color: grid.SidebarInk.inkMuted,
          medium: true,
        );

  Widget _navigationRow({
    required String key,
    required String label,
    required IconData icon,
    required VoidCallback? onTap,
    bool selected = false,
    Widget? trailing,
    bool? unread,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 2),
    child: Material(
      color: selected ? grid.SidebarInk.selected : Colors.transparent,
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      clipBehavior: Clip.antiAlias,
      child: Semantics(
        button: true,
        selected: selected,
        child: InkWell(
          key: ValueKey(key),
          onTap: onTap,
          hoverColor: grid.SidebarInk.hover,
          focusColor: grid.SidebarInk.hover,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          child: Row(
            children: [
              SizedBox(width: SuperTabSectionHeading.indentFor(0)),
              SizedBox(
                width: _iconColumn,
                child: Icon(
                  icon,
                  size: AppIcons.inlineSize,
                  color: onTap == null
                      ? grid.SidebarInk.inkMuted
                      : grid.SidebarInk.ink,
                ),
              ),
              Expanded(
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    minHeight: SwarmType.sidebarRowHeight(compact: compact),
                  ),
                  child: Padding(
                    padding: EdgeInsets.fromLTRB(
                      0,
                      SwarmType.sidebarRowPadding(compact: compact),
                      12,
                      SwarmType.sidebarRowPadding(compact: compact),
                    ),
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      // A row that reads or not ([unread] given) is drawn as
                      // conversations are: muted when read, full strength
                      // and bold when not.
                      style:
                          SwarmType.sidebar(
                            compact: compact,
                            medium: selected,
                            color:
                                onTap == null || (unread == false && !selected)
                                ? grid.SidebarInk.inkMuted
                                : grid.SidebarInk.ink,
                          ).copyWith(
                            fontWeight: unread == true
                                ? grid.AppFont.semibold
                                : null,
                          ),
                    ),
                  ),
                ),
              ),
              if (trailing case final mark?)
                Padding(padding: const EdgeInsets.only(right: 10), child: mark),
            ],
          ),
        ),
      ),
    ),
  );

  /// A page row of Decisions, Mentions or Threads: no number and no red,
  /// bold at full strength while something waits, grey when nothing does
  /// (anh Dee, 11-05, task #3128).
  Widget _pageRow(
    ValueChanged<SwarmPage> onPage, {
    required SwarmPage target,
    required String key,
    required String label,
    required IconData icon,
    required int waiting,
  }) => _navigationRow(
    key: key,
    label: label,
    icon: icon,
    onTap: () => onPage(target),
    selected: page == target,
    unread: waiting > 0,
  );

  /// Back and forward over the reader's places (⌘[ and ⌘]), at the top.
  Widget _arrows(SuperTabPlaces places) => Row(
    children: [
      SizedBox(width: SuperTabSectionHeading.indentFor(0)),
      AppIconButton(
        key: const ValueKey('super-back'),
        icon: AppIcons.arrowLeft,
        tooltip: 'Back',
        onPressed: places.canGoBack ? () => places.step(-1) : null,
      ),
      AppIconButton(
        key: const ValueKey('super-forward'),
        icon: AppIcons.arrowRight,
        tooltip: 'Forward',
        onPressed: places.canGoForward ? () => places.step(1) : null,
      ),
    ],
  );

  /// A project reads as a channel; a private one keeps its lock in this mark slot.
  Widget _channelMark({required bool isPrivate}) => isPrivate
      ? PrivateProjectLock(size: 14, color: grid.SidebarInk.inkMuted)
      : Text(
          '#',
          textAlign: TextAlign.center,
          style: SwarmType.sidebar(
            compact: compact,
            color: grid.SidebarInk.inkMuted,
            medium: true,
          ),
        );

  void _openBuddyChat(String projectId) => onOpenBuddyChat != null
      ? onOpenBuddyChat!(projectId)
      : unawaited(controller.openBuddyChat(projectId));

  /// A project row's name opens the project's chat; only the chevron at its
  /// right end shows or hides its conversations (Dee, 2026-10-28).
  Widget _row(
    SuperTabConversation group, {
    _ProjectReading? reading,
    String? key,
  }) {
    final project = reading?.project;
    // On the Desktop the lit project is the one whose Board is in the middle (task #4220), and never the one whose chat
    // a My agents row has lit: a PM's chat is its project's (#4441).
    final selected = _boardOpen
        ? !_paneCovered && project?.id == boardProjectId
        : _chatLit(group) && !_litInMyAgents(group, reading?.sidebar);
    // A project's row is bold for its own chat (Huy, 11-04, task #2638): a
    // person's message or a tag of the reader there, never agents' progress
    // alone (#2427). A task's unread is on its card and in Activity.
    final unread = reading == null
        ? controller.unreadShown(group)
        : reading.unread.contains(group.id);
    // Only the reader's tags in its chat, which opening it clears (Dee,
    // Slack's channel badge, task #2927). Tags in its tasks and threads,
    // decisions and tasks that need the reader are in Activity.
    final badge = attention?.chatTagsIn(group.id) ?? 0;
    final badgeTooltip = badge == 0
        ? null
        : badge == 1
        ? '1 tag'
        : '$badge tags';
    return _drawRow(
      group,
      project: project,
      key: key,
      selected: selected,
      unread: unread,
      badge: badge,
      badgeTooltip: badgeTooltip,
      buddyChat: reading?.buddyChat,
      selectedProjectId: reading?.sidebar.selectedProjectId,
    );
  }

  Widget _drawRow(
    SuperTabConversation group, {
    SuperTabProject? project,
    // A chat that is no project: Buddy, the reader's one Buddy chat.
    String? label,
    String? key,
    required bool selected,
    required bool unread,
    int badge = 0,
    String? badgeTooltip,
    SuperTabConversation? buddyChat,
    String? selectedProjectId,
    Widget? trailing,
    VoidCallback? onTap,
    bool tappable = true,
  }) {
    // A project shows as selected while one of its tasks is open; the
    // reader's Buddy chat has a row of its own.
    // The Desktop lights one row, the middle's: never a project for a chat of its in the middle (task #4220).
    final highlighted =
        selected ||
        (!board &&
            project != null &&
            !_paneCovered &&
            selectedProjectId == project.id &&
            controller.selectedId != buddyChat?.id);
    // As Slack draws it (Dee, 10-31): a read row in the muted text colour, an
    // unread one at full strength and bold, no dot; the open row keeps its
    // highlight.
    // A muted chat stays listed, greyed, never bold (Slack); the open one
    // keeps its highlight.
    final muted = controller.notifyOf(group.id) == SuperTabNotify.muted;
    // Regular weight when open too, as Slack's: the highlight carries it,
    // and bold stays for unread alone (Huy, 11-03, #2427).
    final style = SwarmType.sidebar(
      compact: compact,
      color: highlighted || (unread && !muted)
          ? grid.SidebarInk.ink
          : grid.SidebarInk.inkMuted,
    ).copyWith(fontWeight: unread && !muted ? grid.AppFont.semibold : null);
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      // Hover lights the whole row, chevron included, in the selected
      // highlight's shape (Dee, 10-31): the row draws it, not each click.
      child: _RowSurface(
        selected: highlighted,
        // The chevron stands beside the row's own click, not inside it: the
        // name opens and the chevron toggles.
        child: Row(
          children: [
            Expanded(
              child: InkWell(
                key: ValueKey(key ?? 'super-group-${group.id}'),
                onTap: !tappable ? null : onTap ?? () => onSelect(group.id),
                hoverColor: Colors.transparent,
                focusColor: grid.SidebarInk.hover,
                borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                child: Row(
                  children: [
                    SizedBox(width: SuperTabSectionHeading.indentFor(0)),
                    SizedBox(
                      width: _iconColumn,
                      child: project != null
                          ? _channelMark(isPrivate: project.isPrivate)
                          : label != null
                          ? Icon(
                              AppIcons.bot,
                              size: AppIcons.inlineSize,
                              color: grid.SidebarInk.ink,
                            )
                          : null,
                    ),
                    Expanded(
                      child: Semantics(
                        label: project?.isPrivate == true
                            ? 'Private project'
                            : null,
                        selected: highlighted,
                        child: Tooltip(
                          // Beside the row, level with it, never over
                          // the rows below (Huy, 11-03, #2427).
                          positionDelegate: _besideTheRow,
                          // Compact: a long name wraps rather than
                          // needing more room than the window has right
                          // of the list.
                          constraints: const BoxConstraints(maxWidth: 260),
                          message: label ?? project!.name,
                          child: ConstrainedBox(
                            // A project a little taller than other rows
                            // (Huy, 11-03, #2427).
                            constraints: BoxConstraints(
                              minHeight: label == null
                                  ? SwarmType.projectRowHeight(compact: compact)
                                  : SwarmType.sidebarRowHeight(
                                      compact: compact,
                                    ),
                            ),
                            child: Padding(
                              padding: EdgeInsets.symmetric(
                                vertical: label == null
                                    ? SwarmType.projectRowPadding(
                                        compact: compact,
                                      )
                                    : SwarmType.sidebarRowPadding(
                                        compact: compact,
                                      ),
                              ),
                              child: Row(
                                children: [
                                  Expanded(
                                    child: label != null
                                        ? Text(
                                            label,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: style,
                                          )
                                        : Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            mainAxisSize: MainAxisSize.min,
                                            children: [
                                              Text(
                                                project!.name,
                                                maxLines: 1,
                                                overflow: TextOverflow.ellipsis,
                                                style: style,
                                              ),
                                              // Teammates' agents cannot push to its repository yet (project_github.dart).
                                              ProjectGitHubLine(
                                                controller: controller,
                                                project: project,
                                              ),
                                            ],
                                          ),
                                  ),
                                  if (badge > 0) ...[
                                    const SizedBox(width: 8),
                                    Semantics(
                                      label:
                                          badgeTooltip ??
                                          (badge == 1
                                              ? '1 mention'
                                              : '$badge mentions'),
                                      excludeSemantics: true,
                                      child: SuperTabCountBadge(
                                        badge,
                                        key: ValueKey(
                                          'super-mentions-${group.id}',
                                        ),
                                        tooltip: badgeTooltip,
                                      ),
                                    ),
                                  ],
                                  if (muted) ...[
                                    const SizedBox(width: 8),
                                    Tooltip(
                                      message: 'Muted',
                                      child: Icon(
                                        AppIcons.bellOff,
                                        key: ValueKey(
                                          'super-muted-${group.id}',
                                        ),
                                        size: 14,
                                        color: grid.SidebarInk.inkMuted,
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                    SizedBox(
                      // A project's row keeps no column for a mark it does
                      // not have: its red number ends where Activity's does.
                      width: project != null && trailing == null
                          ? _rowEnd
                          : _iconColumn,
                      // Unread is drawn as a bold name; a screen reader
                      // hears it said, as it heard the dot it replaces.
                      child: Semantics(
                        label: unread ? 'Unread messages' : null,
                        child: Center(child: trailing),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// The signed-in person's Buddy chat in each project, there from the start
  /// (Lead's ruling, 10-29): the PM's private lines to them land there, and it
  /// offers to start their Buddy. A viewer, who opens nothing, sees only the
  /// chats they have. The project is in brackets once there are several.
  List<Widget> _buddies(
    List<SuperTabProject> projects,
    _SidebarReading reading,
  ) {
    final listed = [
      for (final project in projects)
        if (reading.of(project) case final read
            when (read.buddyChat != null || controller.canWrite) &&
                (!controller.unreadOnly ||
                    (read.buddyChat != null && _keptByFilter(read.buddyChat!))))
          read,
    ];
    return [for (final read in listed) _buddy(read, named: listed.length > 1)];
  }

  Widget _buddy(_ProjectReading reading, {required bool named}) {
    final snapshot = controller.snapshot!;
    final project = reading.project;
    final chat = reading.buddyChat;
    final agent = controller.buddy(project.id);
    // With no Buddy running it reads as the name the reader chose for it, or
    // plain "Buddy" (its chat's default title names the owner, which the
    // reader is): one name everywhere is the point of renaming (Lead, 10-29).
    final name = agent == null
        ? chat?.buddyName ?? 'Buddy'
        : snapshot.agentName(agent.id, fallback: agent.name);
    return SuperTabBuddyRow(
      key: ValueKey('super-buddy-${project.id}'),
      agentId: agent?.id,
      name: name,
      project: named ? project.name : null,
      tooltip: 'Your Buddy · ${project.name}',
      // Where it runs, as the Agents list once showed every Buddy: only its
      // person reads this line now. The project is in the name when several.
      detail: agent == null
          ? null
          : [
              if (!named) project.name,
              '${buddyEngineName(agent.engine)} on ${buddyMachineName(controller, agent.machineId, app: app)}',
            ].join(' · '),
      status: agent == null ? null : _buddyMark(agent),
      note: switch ((agent, controller.buddyStart(project.id))) {
        (null, {'harnessId': null, 'error': null}) => 'starting',
        (null, _) => 'not started',
        (final agent?, _) when agent.downSince != null => 'offline',
        _ => null,
      },
      selected: _chatLit(chat),
      unread: chat != null && controller.unreadShown(chat),
      badge: chat == null ? 0 : attention?.mentionsIn(chat.id) ?? 0,
      badgeTooltip: chat == null ? null : attention?.badgeTooltipIn(chat.id),
      onTap: chat != null
          ? () => onSelect(chat.id)
          : controller.saving || controller.hasPendingAction
          ? null
          : () => _openBuddyChat(project.id),
    );
  }

  /// The reader's one Buddy for the whole Swarm, the first row under Projects
  /// (Dee, 10-31; spec 2026-10-31-one-buddy-per-swarm): a channel like the
  /// projects, `# buddy`, bold with new lines, with its activity mark on the
  /// right and no chevron. Before its chat is opened the row opens it, as the
  /// Buddies section's rows did; a viewer, who opens nothing, sees it only
  /// once they have one.
  Widget? _swarmBuddyRow() {
    const key = SuperTabController.kSwarmBuddyKey;
    final chat = controller.buddyChat(key);
    if (chat == null && !controller.canWrite) return null;
    // The unread filter never hides it: it is the person's one Buddy, pinned
    // like a personal chat, and bold only while it has something unread
    // (Tony, 11-02: it vanished from the latest Desktop under the filter).
    final agent = controller.buddy(key);
    final busy = controller.saving || controller.hasPendingAction;
    // The Desktop's My agents draws it as every agent, its face and name, never the robot icon (anh Dee, task #4192).
    if (board) {
      final muted =
          chat != null && controller.notifyOf(chat.id) == SuperTabNotify.muted;
      return SuperTabBuddyRow(
        key: const ValueKey('super-swarm-buddy'),
        agentId: agent?.id,
        name: 'Buddy',
        tooltip: 'Your Buddy',
        status: agent == null ? null : _buddyMark(agent),
        selected: _chatLit(chat),
        unread: chat != null && !muted && controller.unreadShown(chat),
        onTap: switch (chat) {
          null when busy => null,
          null => () => _openBuddyChat(key),
          final chat => () => (onOpenAgentChat ?? onSelect)(chat.id),
        },
      );
    }
    return _drawRow(
      chat ?? _unopenedSwarmBuddyChat,
      label: 'Buddy',
      key: 'super-swarm-buddy',
      selected: _chatLit(chat),
      // Muted, it is greyed and never bold, as every chat (_drawRow).
      unread: chat != null && controller.unreadShown(chat),
      trailing: agent == null ? null : _buddyMark(agent),
      onTap: chat == null ? () => _openBuddyChat(key) : null,
      tappable: chat != null || !busy,
    );
  }

  /// My agents (Swarm v3, task #4118): the person's Buddy first, then the agents they brought, each with its face and name,
  /// a PM's crowned and followed by the project it leads (task #4421), the name bold while its chat has unread, and + New agent in the heading.
  List<Widget> _myAgents(
    BuildContext context,
    SuperTabSnapshot? snapshot,
    _SidebarReading reading,
  ) {
    if (snapshot == null) return const [];
    return [
      SuperTabSectionHeading(
        key: const ValueKey('project-sidebar-agents'),
        'My agents',
        titleStyle: _headingStyle,
        endInset: 0,
        // It folds as Projects does, remembered (task #4192).
        collapsed: !controller.agentsGroupOpen,
        onToggleCollapsed: controller.toggleAgentsGroup,
      ),
      if (controller.agentsGroupOpen) ...[
        if (controller.oneBuddy)
          ?_swarmBuddyRow()
        else
          ..._buddies([...snapshot.projects], reading),
        for (final (agent, chat) in reading.myAgents)
          _agentRow(snapshot, agent, chat),
        // The last row opens the creation dialog, where Regular or PM is chosen.
        if (controller.canWrite && onNewAgent != null)
          _navigationRow(
            key: 'super-new-agent-row',
            label: 'New agent',
            icon: AppIcons.plus,
            onTap: onNewAgent,
          ),
      ],
      const SizedBox(height: 16),
    ];
  }

  Widget _agentRow(
    SuperTabSnapshot snapshot,
    SuperTabAgent agent,
    SuperTabConversation? chat,
  ) {
    final name = snapshot.agentName(agent.id, fallback: agent.name);
    final pm = superTabAgentIsPm(snapshot, agent);
    return SuperTabBuddyRow(
      key: ValueKey('super-agent-${agent.id}'),
      agentId: agent.id,
      agent: agent,
      name: name,
      tooltip: chat != null
          ? name
          : onOpenAgentTerminal != null
          ? '$name · opens its terminal'
          : '$name · no chat yet',
      crown: pm,
      note: pm ? snapshot.leadProjectForAgent(agent.id)?.name : null,
      status: _buddyMark(agent),
      selected: _chatLit(chat),
      unread: chat != null && controller.unreadShown(chat),
      onTap: switch ((chat, onOpenAgentTerminal)) {
        (final chat?, _) => () => (onOpenAgentChat ?? onSelect)(chat.id),
        (null, final terminal?) => () => terminal(agent),
        _ => null,
      },
    );
  }

  /// The Buddy's activity mark, drawn as the Agents list draws an agent's.
  Widget? _buddyMark(SuperTabAgent agent) {
    final app = this.app;
    if (app == null) return null;
    final theme = terminalThemeFor(
      grid.AppTheme.surfacePalette,
      terminalThemeStore.value,
    );
    final activity = agent.downSince != null
        ? HarnessActivity.offline
        : harnessActivity(app, agent.machineId, agent.harnessId) ??
              HarnessActivity.unknown;
    return ActivityMark(
      activity: activity,
      tooltip: false,
      showIdle: true,
      color: activityColor(
        activity,
        theme,
        color: appearancePrefsStore.value.prompt.color,
      ),
    );
  }

  /// Whether the unread filter keeps [read]'s project: its chat or an open
  /// workgroup is unread or tags the reader, or the open chat is in it. What
  /// is for a person (#2427), and wider than its row's bold, which is its
  /// chat's alone (task #2638): a project with an unread task stays listed.
  bool _hasUnread(_ProjectReading read) =>
      (!_paneCovered && read.sidebar.selectedProjectId == read.project.id) ||
      read.unread.isNotEmpty ||
      read.mentions > 0 ||
      (read.lead != null && controller.unreadForPeople(read.lead!));

  /// Whether the unread filter keeps a Buddy chat's row: any new message, as
  /// its row is bold.
  bool _keptByFilter(SuperTabConversation group) =>
      !controller.unreadOnly ||
      (!_paneCovered && controller.selectedId == group.id) ||
      controller.unreadShown(group) ||
      (attention?.mentionsIn(group.id) ?? 0) > 0;

  /// A Personal project whose panes are all closed (personal_projects.dart
  /// `hidden`, task #3042), unless its chat is the one open now, as the
  /// unread filter keeps it.
  /// [hidden] is worked out once per draw (`superTabHiddenProjects`).
  bool _paneless(
    SuperTabProject project,
    SuperTabConversation chat,
    Set<String> hidden,
  ) =>
      (_paneCovered || controller.selectedId != chat.id) &&
      hidden.contains(project.id);

  /// Every project with its workgroups, by name from A to Z. The round dial
  /// swipes projects in this order (cli superTabs/cards.ts `leadsOf`); a
  /// Personal project whose panes are all closed leaves this list but stays
  /// on the dial (task #3042: the brief is the project list).
  /// [taggedOnly]: only the projects whose chat tags the reader, as folded Projects lists them.
  List<(String, Widget)> _channels(
    SuperTabSnapshot? snapshot,
    _SidebarReading reading, {
    bool taggedOnly = false,
  }) {
    final hidden = superTabHiddenProjects(controller, app: app);
    return [
      for (final project in ([...?snapshot?.projects]..sort(_compareProjects)))
        if (reading.of(project) case final read
            when read.lead != null &&
                (!taggedOnly ||
                    (attention?.chatTagsIn(read.lead!.id) ?? 0) > 0) &&
                (!controller.unreadOnly || _hasUnread(read)) &&
                !_paneless(project, read.lead!, hidden))
          (
            project.name,
            Column(
              key: ValueKey('super-project-${project.id}'),
              mainAxisSize: MainAxisSize.min,
              children: [_row(read.lead!, reading: read)],
            ),
          ),
    ];
  }

  // The sidebar's ink scope (#3006): a theme's own sidebar ink reaches the
  // shared rows drawn in it.
  @override
  Widget build(BuildContext context) => grid.SidebarInk.scope(
    child: switch ([?attention, ?activity, ?places]) {
      final List<Listenable> sources when sources.isNotEmpty =>
        ListenableBuilder(
          listenable: Listenable.merge(sources),
          builder: (context, _) => _build(context),
        ),
      _ => Builder(builder: _build),
    },
  );

  Widget _build(BuildContext context) {
    final snapshot = controller.snapshot;
    final projects = snapshot?.projects ?? const <SuperTabProject>[];
    final reading = _SidebarReading(controller, attention);
    final decisions = activity?.needsCount ?? snapshot?.decisionsWaiting ?? 0;
    final mentions = activity?.mentionsCount ?? snapshot?.mentionsWaiting ?? 0;
    final threads = activity?.threadsCount ?? 0;
    final switcher = switch ((app, onNewSwarm)) {
      (final app?, final onNewSwarm?) => SwarmSwitcher(
        app: app,
        controller: controller,
        onNewSwarm: onNewSwarm,
        row:
            ({
              required label,
              required icon,
              required onTap,
              required trailing,
            }) => _navigationRow(
              key: 'super-swarm-switcher',
              label: label,
              icon: icon,
              onTap: onTap,
              trailing: trailing,
            ),
      ),
      _ => null,
    };
    return Material(
      // The page's color: the rule at its edge is what separates them. A
      // theme may give the sidebar its own (Plum's plum).
      color: grid.AppPalette.swarmSidebar,
      textStyle: grid.SidebarInk.textStyle(context),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: LaidOutListView(
              padding: const EdgeInsets.all(8),
              children: [
                // The Desktop's org switcher is the first thing in the pane (Swarm v3 spec), with no arrows under it
                // (task #4192); elsewhere it follows the back and forward arrows.
                if (board)
                  ?switcher
                else ...[
                  if (places case final places?) _arrows(places),
                  ?switcher,
                ],
                // Three rows, each one thing, in anh Dee's order (11-05, task
                // #2996): bold when something waits, grey when not, and no
                // numbers (task #3128). The Swarm switcher stands apart from
                // them by a control gap.
                if (onPage case final onPage?) ...[
                  if (app != null && onNewSwarm != null)
                    const SizedBox(height: DesktopChrome.controlGap),
                  _pageRow(
                    onPage,
                    target: SwarmPage.decisions,
                    key: 'super-decisions',
                    label: 'Decisions',
                    icon: AppIcons.flag,
                    waiting: decisions,
                  ),
                  if (board)
                    _pageRow(
                      onPage,
                      target: SwarmPage.leaderboard,
                      key: 'super-leaderboard',
                      label: 'Leaderboard',
                      icon: AppIcons.trophy,
                      waiting: 0,
                    ),
                  // Mentions goes from the Desktop's left pane (Swarm v3, anh Dee 11-07).
                  if (!board)
                    _pageRow(
                      onPage,
                      target: SwarmPage.mentions,
                      key: 'super-mentions',
                      label: 'Mentions',
                      icon: AppIcons.atSign,
                      waiting: mentions,
                    ),
                  if (!board)
                    _pageRow(
                      onPage,
                      target: SwarmPage.threads,
                      key: 'super-threads',
                      label: 'Threads',
                      icon: AppIcons.messagesSquare,
                      waiting: threads,
                    ),
                ],
                const SizedBox(height: 20),
                if (board) ..._myAgents(context, snapshot, reading),
                SuperTabSectionHeading(
                  key: const ValueKey('project-sidebar-projects'),
                  'Projects',
                  titleStyle: _headingStyle,
                  // Slack's unread filter: only chats with something unread.
                  actions: [
                    AppIconButton(
                      key: const ValueKey('super-unread-only'),
                      icon: AppIcons.listFilter,
                      selected: controller.unreadOnly,
                      tooltip: controller.unreadOnly
                          ? 'Show all chats'
                          : 'Show unread chats only',
                      onPressed: controller.toggleUnreadOnly,
                    ),
                  ],
                  onAdd: controller.canWrite ? onNewProject : null,
                  addTooltip: 'New project',
                  endInset: 0,
                  // The Desktop folds Projects: closed while the person has an agent (Swarm v3, #4118).
                  collapsed: board ? !controller.projectsOpen : null,
                  onToggleCollapsed: board
                      ? controller.toggleProjectsGroup
                      : null,
                ),
                // The reader's one Buddy, the first item under Projects (anh
                // Dee, 11-05).
                if (controller.oneBuddy && !board) ?_swarmBuddyRow(),
                // Folded, it keeps the projects whose chat tags the reader: the Desktop has no Mentions row (task #4220).
                for (final (_, channel) in _channels(
                  snapshot,
                  reading,
                  taggedOnly: board && !controller.projectsOpen,
                ))
                  channel,
                const SizedBox(height: 16),
                // Buddies replaced Chat with PM in every Swarm (Ken, 10-29); where the
                // server gives one Buddy for the whole Swarm, it is # buddy above.
                if (!controller.oneBuddy && !board) ...[
                  SuperTabSectionHeading(
                    'Buddies',
                    titleStyle: _headingStyle,
                    onAdd:
                        controller.canWrite &&
                            !controller.saving &&
                            !controller.hasPendingAction &&
                            buddyProjects(controller).isNotEmpty
                        ? () => unawaited(
                            showAddBuddy(context, controller, app: app),
                          )
                        : null,
                    addTooltip: 'Add a Buddy',
                    endInset: 0,
                    collapsed: !controller.buddiesGroupOpen,
                    onToggleCollapsed: controller.toggleBuddiesGroup,
                  ),
                  if (controller.buddiesGroupOpen)
                    ..._buddies(projects, reading),
                  const SizedBox(height: 16),
                ],
              ],
            ),
          ),
          // At the foot, however long the list (Quiet Swarm, screen 1).
          if (onManage != null)
            Padding(
              // On the chat box's bottom line, less the row's own 2 under it. A
              // phone's has no box beside it, and keeps the list's 8.
              padding: EdgeInsets.fromLTRB(
                grid.AppDesktop.controlGap,
                0,
                grid.AppDesktop.controlGap,
                (compact ? grid.AppDesktop.controlGap : footGap) - 2,
              ),
              child: _navigationRow(
                key: 'super-manage',
                label: 'Manage',
                icon: AppIcons.settings,
                onTap: onManage,
                selected: manageSelected,
              ),
            ),
        ],
      ),
    );
  }
}

/// A sidebar row's ground: the selected fill, or the hover fill while the
/// pointer is anywhere over it, one shape across the row's whole width.
class _RowSurface extends StatefulWidget {
  const _RowSurface({required this.selected, required this.child});
  final bool selected;
  final Widget child;

  @override
  State<_RowSurface> createState() => _RowSurfaceState();
}

class _RowSurfaceState extends State<_RowSurface> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) => MouseRegion(
    onEnter: (_) => setState(() => _hovered = true),
    onExit: (_) => setState(() => _hovered = false),
    child: Material(
      color: widget.selected
          ? grid.SidebarInk.selected
          : _hovered
          ? grid.SidebarInk.hover
          : Colors.transparent,
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      clipBehavior: Clip.antiAlias,
      child: widget.child,
    ),
  );
}

/// A sidebar row's tooltip, to the right of its row and level with it, so it
/// never covers the rows below (Huy, 11-03, #2427); kept on screen.
Offset _besideTheRow(TooltipPositionContext context) {
  const gap = 8.0;
  final left =
      context.target.dx +
      context.targetSize.width / 2 +
      ProjectSidebar._iconColumn +
      gap;
  final top = context.target.dy - context.tooltipSize.height / 2;
  final overlay = context.overlaySize;
  double fit(double value, double room) =>
      value.clamp(gap, room > gap ? room : gap).toDouble();
  return Offset(
    fit(left, overlay.width - context.tooltipSize.width - gap),
    fit(top, overlay.height - context.tooltipSize.height - gap),
  );
}

/// What one build of the sidebar reads, each piece once: per row, a Swarm's
/// thousands of conversations were scanned again on every rebuild (Diego,
/// 10-29).
class _SidebarReading {
  _SidebarReading(this.controller, this.attention);
  final SuperTabController controller;
  final SuperTabAttention? attention;
  final _projects = <String, _ProjectReading>{};

  _ProjectReading of(SuperTabProject project) =>
      _projects.putIfAbsent(project.id, () => _ProjectReading(this, project));

  /// The project of the open conversation.
  late final selectedProjectId = controller.selected?.projectId;

  /// My agents' rows after the Buddy, each agent with the chat it opens: drawn by the rows, and asked by the project
  /// rows, so a chat lit there is not lit twice (#4441).
  late final List<(SuperTabAgent, SuperTabConversation?)> myAgents = [
    if (controller.snapshot case final snapshot?)
      for (final agent in superTabMyAgents(snapshot, controller.accountId))
        if (agent.buddyOf == null) (agent, superTabAgentChat(snapshot, agent)),
  ];
}

/// One build's reading of a project, each part asked once and only when a
/// row needs it.
class _ProjectReading {
  _ProjectReading(this.sidebar, this.project);
  final _SidebarReading sidebar;
  final SuperTabProject project;

  late final conversations = sidebar.controller.projectConversations(
    project.id,
  );
  late final SuperTabConversation? lead =
      conversations
          .where((g) => g.id == project.leadConversationId)
          .firstOrNull ??
      sidebar.controller.snapshot?.conversation(project.leadConversationId);
  late final buddyChat = sidebar.controller.buddyChat(project.id);

  /// The open conversations with unread messages; never the reader's Buddy
  /// chat, which has its own row under Buddies.
  late final Set<String> unread = {
    for (final g in conversations)
      if (!g.closed &&
          !g.isBuddyChat &&
          g.audience == null &&
          (sidebar.controller.unreadForPeople(g) ||
              (sidebar.attention?.chatTagsIn(g.id) ?? 0) > 0))
        g.id,
  };

  /// Tags of the reader in the project's chat and its open workgroups: why the
  /// unread filter keeps a collapsed project. Never its number ([_row]).
  late final int mentions = switch (sidebar.attention) {
    null => 0,
    final attention =>
      attention.mentionsIn(project.leadConversationId) +
          [
            for (final g in conversations)
              if (!g.closed &&
                  !g.isBuddyChat &&
                  g.audience == null &&
                  g.id != project.leadConversationId)
                attention.mentionsIn(g.id),
          ].fold(0, (a, b) => a + b),
  };
}

String _projectSortName(String name) =>
    (name.startsWith('#') ? name.substring(1).trimLeft() : name).toLowerCase();

int _compareProjects(SuperTabProject a, SuperTabProject b) {
  final byName = _projectSortName(a.name).compareTo(_projectSortName(b.name));
  return byName != 0 ? byName : a.id.compareTo(b.id);
}

/// The chats in the order the sidebar lists them, for Option+Shift+Down and
/// Up (Slack's next unread): the reader's one Buddy chat (`# buddy`, first
/// under Projects), each project's chat from A to Z, then the reader's
/// project Buddy chats. Tasks are in each project's Tasks view, not here
/// (task #2569). The round dial swipes projects in this A to Z order too (cli
/// superTabs/cards.ts `leadsOf`), less the Personal projects this list hides
/// (task #3042).
List<String> superTabSidebarOrder(
  SuperTabController controller, {
  AppNotifier? app,
}) {
  final snapshot = controller.snapshot;
  if (snapshot == null) return const [];
  final projects = [...snapshot.projects]..sort(_compareProjects);
  final hidden = superTabHiddenProjects(controller, app: app);
  return [
    if (controller.oneBuddy)
      if (controller.buddyChat(SuperTabController.kSwarmBuddyKey)
          case final chat?)
        chat.id,
    for (final project in projects)
      if (snapshot.conversation(project.leadConversationId) != null &&
          (controller.selectedId == project.leadConversationId ||
              !hidden.contains(project.id)))
        project.leadConversationId,
    for (final project in projects)
      if (controller.buddyChat(project.id) case final chat?) chat.id,
  ];
}

/// The projects the list leaves out: Personal projects of the person's whose
/// panes are all closed (personal_projects.dart, task #3042), worked out in
/// one pass. None without the app, which holds the panes.
Set<String> superTabHiddenProjects(
  SuperTabController controller, {
  AppNotifier? app,
}) => app == null ? const {} : PersonalProjects.of(app).hiddenIn(controller);
