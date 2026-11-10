import 'dart:async';
import 'dart:math' show min;

import 'package:flutter/material.dart';

import '../core/models.dart' show Machine;
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_menu.dart';
import '../shared/theme/appearance_prefs_store.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/harness_activity_mark.dart';
import 'agent_state.dart';
import 'attention.dart';
import 'controller.dart';
import 'delete_agent.dart';
import 'buddies.dart';
import 'buddy_chat.dart' show kCountCap;
import 'model.dart';
import 'my_agents.dart';
import 'personal_agents.dart';
import 'personal_projects.dart' show PersonalProjects;
import 'places.dart';
import 'buddy_rows.dart';
import 'identity.dart';
import 'leaderboard/reader.dart';
import 'section_heading.dart';
import 'swarm_switcher.dart';
import 'private_project_lock.dart';
import '../widgets/laid_out_list.dart';
import '../widgets/pane_menu.dart' show showContextMenuAt;
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
    this.onManageMachines,
    this.manageSelected = false,
    this.devicesSelected = false,
    this.onPage,
    this.page,
    this.attention,
    this.places,
    this.onOpenBuddyChat,
    this.compact = false,
    this.board = false,
    this.onNewAgent,
    this.onAttachAgent,
    this.onOpenAgentChat,
    this.onOpenPane,
    this.boardProjectId,
    this.onOpenAgentTerminal,
    this.leaderboard,
    this.agentStates,
  });
  final SuperTabController controller;

  /// What each agent of Your Team is doing, its row's one line; without it a row says only that its agent is offline.
  final SwarmAgentStates? agentStates;

  /// The board Humans lists on the Desktop (task #4466): the view's, which the right pane reads too. Without it, or
  /// before it is read, Humans is its heading alone.
  final SuperTabLeaderboardReader? leaderboard;

  /// How many people Humans lists, most points first; the heading opens the whole board.
  static const humansShown = 8;

  /// A phone's layout: its rows keep the app's sizes, not Slack desktop's ([SwarmType]).
  final bool compact;

  /// Desktop's Board layout (anh Dee, task #3787): no Threads row and no Buddy entry, the Buddy being the right pane.
  final bool board;

  /// + New agent (Swarm v3, task #4118): opens the creation dialog, where Regular or PM is chosen. Without it the section
  /// has no + .
  final VoidCallback? onNewAgent;

  /// Attach beside + (Swarm v4): picks an agent already running on its person's own computers to join their team.
  /// Without it the heading has no Attach.
  final VoidCallback? onAttachAgent;

  /// Opens the chat of an agent chosen in My agents in the middle; [onSelect] when not given.
  final ValueChanged<String>? onOpenAgentChat;

  /// Opens a pane of the person's own listed under Your Team in their Personal Swarm; its row opens nothing without it.
  final ValueChanged<PersonalAgent>? onOpenPane;

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

  /// Opens Manage on its Machines, where a computer in Your Machines is managed.
  final VoidCallback? onManageMachines;
  final bool manageSelected;
  final bool devicesSelected;

  /// Opens one of the Swarm's pages, the Leaderboard or Projects.
  final ValueChanged<SwarmPage>? onPage;

  /// The page holding the main pane, if one does.
  final SwarmPage? page;

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
    child: SuperTabRowGround(
      color: selected ? grid.SidebarInk.selected : Colors.transparent,
      child: Semantics(
        button: true,
        selected: selected,
        child: InkWell(
          key: ValueKey(key),
          onTap: onTap,
          hoverColor: grid.SidebarInk.hover,
          focusColor: Colors.transparent,
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
    final selected = _chatLit(group);
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
    // Swarm v4: how many posts are new in the project's channel, its agents'
    // among them (anh Dee 2026-11-09: "i dont see any agent to agent chat"),
    // while the name stays bold for people and tags alone.
    // Read with Your Team's states, from the same reads of the channel (agent_state.dart).
    final fresh = board && project != null && !selected
        ? agentStates?.newIn(group.id)
        : null;
    return _drawRow(
      group,
      project: project,
      key: key,
      selected: selected,
      unread: unread,
      fresh: fresh,
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
    ({int count, bool more})? fresh,
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
    final highlighted =
        selected ||
        (project != null &&
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
                focusColor: Colors.transparent,
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
                                        : Text(
                                            project!.name,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: style,
                                          ),
                                  ),
                                  if (fresh != null && !muted) ...[
                                    const SizedBox(width: 8),
                                    Text(
                                      fresh.count >= kCountCap - 1 || fresh.more
                                          ? '${min(fresh.count, kCountCap - 1)}+ new'
                                          : '${fresh.count} new',
                                      key: ValueKey('super-new-${group.id}'),
                                      maxLines: 1,
                                      style:
                                          DesktopChrome.metadata(
                                            color: grid.SidebarInk.inkMuted,
                                          ).copyWith(
                                            fontFeatures: const [
                                              FontFeature.tabularFigures(),
                                            ],
                                          ),
                                    ),
                                  ],
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
                // The Desktop has no unread filter to turn off: one saved on hides nothing there.
                (board ||
                    !controller.unreadOnly ||
                    (read.buddyChat != null && _keptByFilter(read.buddyChat!))))
          read,
    ];
    return [
      for (final read in listed)
        board
            ? _quietBuddy(read, named: listed.length > 1)
            : _buddy(read, named: listed.length > 1),
    ];
  }

  /// A project's Buddy in the Desktop's My agents, from a server before one Buddy per Swarm: the project its one detail
  /// when there are several, or why it is not running.
  Widget _quietBuddy(_ProjectReading reading, {required bool named}) {
    final project = reading.project;
    final chat = reading.buddyChat;
    final agent = controller.buddy(project.id);
    final name = agent == null
        ? chat?.buddyName ?? 'Your agent'
        : controller.snapshot!.agentName(agent.id, fallback: agent.name);
    return SuperTabQuietRow(
      key: ValueKey('super-buddy-${project.id}'),
      leading: _face(agent, name),
      name: name,
      tooltip: 'Your Buddy · ${project.name}',
      detail:
          _detail(agent) ??
          switch ((agent, controller.buddyStart(project.id))) {
            (null, {'harnessId': null, 'error': null}) => 'starting',
            (null, _) => 'not started',
            _ => named ? project.name : null,
          },
      selected: _chatLit(chat),
      unread: chat != null && controller.unreadShown(chat),
      onTap: chat != null
          ? () => onSelect(chat.id)
          : controller.saving || controller.hasPendingAction
          ? null
          : () => _openBuddyChat(project.id),
    );
  }

  /// An agent's 20 face in a quiet row; a Buddy not running yet has its name's.
  Widget _face(SuperTabAgent? agent, String name, {bool lead = false}) =>
      agent == null
      ? SuperTabAvatar(
          identity: 'buddy:$name',
          name: name,
          size: SuperTabQuietRow.faceSize,
        )
      : SuperTabAvatar.agent(
          agent,
          name: name,
          size: SuperTabQuietRow.faceSize,
          engineBadge: false,
          lead: lead,
        );

  /// What [agent] is doing, as the Agents list reads it; null with no app to ask, or none running.
  HarnessActivity? _activity(SuperTabAgent? agent) => agent == null
      ? null
      : agent.downSince != null
      ? HarnessActivity.offline
      : switch (app) {
          final app? => harnessActivity(app, agent.machineId, agent.harnessId),
          null => null,
        };

  /// An agent's one quiet detail in My agents ([superTabAgentDetail]).
  String? _detail(SuperTabAgent? agent, {String? leads}) =>
      superTabAgentDetail(_activity(agent), leads: leads);

  Widget _iconRow({
    required String key,
    required IconData icon,
    required String name,
    required VoidCallback? onTap,
    String? detail,
    bool selected = false,
    bool unread = false,
  }) => SuperTabQuietRow(
    key: ValueKey(key),
    leading: Icon(
      icon,
      size: AppIcons.inlineSize,
      color: grid.SidebarInk.inkMuted,
    ),
    name: name,
    detail: detail,
    selected: selected,
    unread: unread,
    onTap: onTap,
  );

  /// The Desktop's left pane (Swarm v4, anh Dee 2026-11-08): the org name, Your Team, Projects, then Top Teams; Manage
  /// stays at the foot. Nothing else: no Decisions, no Projects grid, no Buddy.
  List<Widget> _desktop(
    SuperTabSnapshot? snapshot,
    _SidebarReading reading, {
    required Widget? switcher,
  }) {
    final projects = snapshot?.projects ?? const <SuperTabProject>[];
    return [
      ?switcher,
      const SizedBox(height: grid.AppDesktop.groupGap),
      ..._myAgents(snapshot, reading),
      SuperTabQuietHeading(
        'Projects',
        key: const ValueKey('project-sidebar-projects'),
        collapsed: !controller.projectsGroupOpen,
        onTap: controller.toggleProjectsGroup,
        onAdd: controller.canWrite ? onNewProject : null,
        addTooltip: 'New project',
        addKey: const ValueKey('project-sidebar-projects-add'),
      ),
      if (controller.projectsGroupOpen)
        if (snapshot != null && projects.isEmpty)
          _noProjects()
        else
          for (final (_, channel) in _channels(snapshot, reading)) channel,
      const SizedBox(height: grid.AppDesktop.groupGap),
      ..._yourMachines(),
      ..._humans(snapshot),
    ];
  }

  /// Your Machines (Swarm v4, anh Dee 2026-11-09): the computers of this account, each opening Manage where it is managed.
  /// What the machine list says is up is up. A person with none sees no heading. Folded until it is opened, but open by itself
  /// while a computer is off, so why an agent is silent is in sight; what its person chose stands.
  List<Widget> _yourMachines() {
    final machines =
        [
          for (final m in app?.machines ?? const <Machine>[])
            if (!m.isShared && !m.isTeamAccount && !m.isSharedMachine) m,
        ]..sort(
          (a, b) => a.displayName.toLowerCase().compareTo(
            b.displayName.toLowerCase(),
          ),
        );
    if (machines.isEmpty) return const [];
    final open = controller.yourMachinesGroupChosen
        ? controller.yourMachinesGroupOpen
        : machines.any((m) => m.reportedOnline == false);
    return [
      SuperTabQuietHeading(
        'Your Machines',
        key: const ValueKey('project-sidebar-machines'),
        collapsed: !open,
        onTap: () => controller.setYourMachinesGroup(!open),
      ),
      if (open)
        for (final machine in machines)
          _iconRow(
            key: 'super-machine-${machine.machineId}',
            icon: machine.reportedOnline == false
                ? AppIcons.monitorOff
                : AppIcons.monitor,
            name: machine.displayName,
            detail: machine.reportedOnline == false ? 'offline' : null,
            onTap: onManageMachines ?? onManage,
          ),
      const SizedBox(height: grid.AppDesktop.groupGap),
    ];
  }

  /// Humans (task #4466): the Leaderboard in short, its people most points first with their points on the right. The
  /// heading and every person open the whole board.
  List<Widget> _humans(SuperTabSnapshot? snapshot) {
    final onPage = this.onPage;
    if (snapshot == null || onPage == null) return const [];
    final scores = [...?leaderboard?.board?.people].take(humansShown).toList();
    // An empty list shows nothing (anh Dee's rule): no heading until someone has points.
    if (scores.isEmpty) return const [];
    void open() => onPage(SwarmPage.leaderboard);
    final people = {for (final person in snapshot.people) person.id: person};
    return [
      SuperTabQuietHeading(
        'Top Teams',
        key: const ValueKey('project-sidebar-humans'),
        collapsed: !controller.topTeamsGroupOpen,
        onTap: controller.toggleTopTeamsGroup,
      ),
      if (controller.topTeamsGroupOpen)
        for (final score in scores)
          if (people[score.personId] case final person)
            SuperTabQuietRow(
              key: ValueKey('super-human-${score.personId}'),
              leading: person == null
                  ? SuperTabAvatar(
                      identity: 'person:${score.personId}',
                      name: score.displayName ?? '',
                      size: SuperTabQuietRow.faceSize,
                    )
                  : SuperTabAvatar.person(
                      person,
                      size: SuperTabQuietRow.faceSize,
                    ),
              name: person?.shownName ?? score.displayName ?? 'Someone',
              detail: '${score.points}',
              selected:
                  page == SwarmPage.leaderboard &&
                  score.personId == controller.accountId,
              onTap: open,
            ),
    ];
  }

  Widget _buddy(_ProjectReading reading, {required bool named}) {
    final snapshot = controller.snapshot!;
    final project = reading.project;
    final chat = reading.buddyChat;
    final agent = controller.buddy(project.id);
    // With no Buddy running it reads as the name the reader chose for it, or
    // "Your agent" (task #4568): one name everywhere is the point of renaming
    // (Lead, 10-29).
    final name = agent == null
        ? chat?.buddyName ?? 'Your agent'
        : snapshot.agentName(agent.id, fallback: agent.name);
    return SuperTabBuddyRow(
      key: ValueKey('super-buddy-${project.id}'),
      agentId: agent?.id,
      name: name,
      compact: compact,
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
      // Its own name and face, as the header draws it (audit finding 8 of #4436).
      final name = agent == null
          ? chat?.buddyName ?? 'Your agent'
          : controller.snapshot!.agentName(agent.id, fallback: agent.name);
      return SuperTabQuietRow(
        key: const ValueKey('super-swarm-buddy'),
        leading: _face(agent, name),
        name: name,
        tooltip: 'Your Buddy',
        detail: _detail(agent),
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
      label: 'Your agent',
      key: 'super-swarm-buddy',
      selected: _chatLit(chat),
      // Muted, it is greyed and never bold, as every chat (_drawRow).
      unread: chat != null && controller.unreadShown(chat),
      trailing: agent == null ? null : _buddyMark(agent),
      onTap: chat == null ? () => _openBuddyChat(key) : null,
      tappable: chat != null || !busy,
    );
  }

  /// My agents (Swarm v3, task #4118): the person's Buddy first, then the agents they brought, each with its face and
  /// name, a Lead's naming the project it leads (task #4421), the name bold while its chat has unread. The heading's +
  /// opens New agent (task #4645), and Attach before it brings an agent already running (Swarm v4); a person with no
  /// agents of their own also gets New agent as a row, to start from.
  List<Widget> _myAgents(SuperTabSnapshot? snapshot, _SidebarReading reading) {
    if (snapshot == null) return const [];
    final newAgent = controller.canWrite ? onNewAgent : null;
    final attachAgent = controller.canWrite ? onAttachAgent : null;
    return [
      SuperTabQuietHeading(
        'Your Team',
        key: const ValueKey('project-sidebar-agents'),
        collapsed: !controller.agentsGroupOpen,
        onTap: controller.toggleAgentsGroup,
        onAdd: newAgent,
        addTooltip: 'New agent',
        addKey: const ValueKey('project-sidebar-agents-add'),
        onAttach: attachAgent,
        attachTooltip: 'Attach agent',
        attachKey: const ValueKey('project-sidebar-agents-attach'),
      ),
      if (controller.agentsGroupOpen) ...[
        for (final (agent, chat) in reading.myAgents)
          _agentRow(snapshot, agent, chat),
        for (final pane in reading.panes) _paneRow(pane),
      ],
      const SizedBox(height: grid.AppDesktop.groupGap),
    ];
  }

  /// A pane of the person's own in their Personal Swarm, an agent of theirs that has not joined it: its face as it will be,
  /// its name and its computer.
  Widget _paneRow(PersonalAgent pane) => SuperTabQuietRow(
    key: ValueKey('super-pane-${pane.machineId}-${pane.agent.id}'),
    leading: SuperTabAvatar(
      identity: 'agent:${pane.swarmId}',
      name: pane.name,
      size: SuperTabQuietRow.faceSize,
      face: true,
    ),
    name: pane.name,
    detail: pane.place,
    onTap: onOpenPane == null ? null : () => onOpenPane!(pane),
  );

  Widget _agentRow(
    SuperTabSnapshot snapshot,
    SuperTabAgent agent,
    SuperTabConversation? chat,
  ) {
    final name = snapshot.agentName(agent.id, fallback: agent.name);
    final pm = superTabAgentIsPm(snapshot, agent);
    final row = SuperTabQuietRow(
      key: ValueKey('super-agent-${agent.id}'),
      leading: _face(agent, name, lead: pm),
      name: name,
      // Only what the row does not say itself.
      tooltip: chat == null && onOpenAgentTerminal != null
          ? 'Opens its terminal'
          : null,
      detail: agentStates?.of(agent) ?? SwarmAgentStates.offlineOf(agent),
      selected: _chatLit(chat),
      unread: chat != null && controller.unreadShown(chat),
      onTap: switch ((chat, onOpenAgentTerminal)) {
        (final chat?, _) => () => (onOpenAgentChat ?? onSelect)(chat.id),
        (null, final terminal?) => () => terminal(agent),
        _ => null,
      },
    );
    // Delete is one right-click away, for its person alone (Swarm v4: only its person stops an agent). A project's PM
    // stays until its project goes.
    if (agent.contributorId != controller.accountId || !controller.canWrite) {
      return row;
    }
    final kept = snapshot.leadProtectionReason(agent.id);
    return Builder(
      builder: (context) => GestureDetector(
        onSecondaryTapUp: (event) async {
          final choice = await showContextMenuAt<String>(
            context: context,
            at: event.globalPosition,
            children: (close) => [
              AppMenuItem(
                label: 'Delete',
                detail: kept,
                leadingSlot: false,
                onPressed: kept == null ? () => close('delete') : null,
              ),
            ],
          );
          if (choice == 'delete' && context.mounted) {
            await deleteSwarmAgent(context, controller, agent, name);
          }
        },
        child: row,
      ),
    );
  }

  /// Open Projects over a Swarm with none, in the names' column.
  Widget _noProjects() => Padding(
    key: const ValueKey('super-projects-empty'),
    padding: EdgeInsets.fromLTRB(
      SuperTabSectionHeading.indentFor(0) + _iconColumn,
      SwarmType.sidebarRowPadding(compact: compact),
      grid.AppDesktop.controlGap,
      SwarmType.sidebarRowPadding(compact: compact),
    ),
    child: Text(
      'No projects yet.',
      style: SwarmType.sidebar(
        compact: compact,
        color: grid.SidebarInk.inkMuted,
      ),
    ),
  );

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
  List<(String, Widget)> _channels(
    SuperTabSnapshot? snapshot,
    _SidebarReading reading,
  ) => [
    for (final read in _listed(snapshot, reading))
      (
        read.project.name,
        Column(
          key: ValueKey('super-project-${read.project.id}'),
          mainAxisSize: MainAxisSize.min,
          children: [_row(read.lead!, reading: read)],
        ),
      ),
  ];

  /// The projects Projects lists, each with a chat, in its order.
  Iterable<_ProjectReading> _listed(
    SuperTabSnapshot? snapshot,
    _SidebarReading reading,
  ) {
    final hidden = superTabHiddenProjects(controller, app: app);
    return [
      for (final project in ([...?snapshot?.projects]..sort(_compareProjects)))
        if (reading.of(project) case final read
            when read.lead != null &&
                (!controller.unreadOnly || _hasUnread(read)) &&
                !_paneless(project, read.lead!, hidden))
          read,
    ];
  }

  // The sidebar's ink scope (#3006): a theme's own sidebar ink reaches the
  // shared rows drawn in it.
  @override
  Widget build(BuildContext context) => grid.SidebarInk.scope(
    child: switch ([?attention, ?places, ?leaderboard, ?agentStates]) {
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
    final reading = _SidebarReading(controller, attention, app);
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
            }) => Tooltip(
              // A long Swarm name is cut in the row; hovering reads all of it.
              message: label,
              excludeFromSemantics: true,
              positionDelegate: _besideTheRow,
              constraints: const BoxConstraints(maxWidth: 260),
              child: board
                  // Plain text, its chevron only on hover (task #4466).
                  ? SuperTabQuietHeading.org(
                      label,
                      key: const ValueKey('super-swarm-switcher'),
                      onTap: onTap,
                    )
                  : _navigationRow(
                      key: 'super-swarm-switcher',
                      label: label,
                      icon: icon,
                      onTap: onTap,
                      trailing: trailing,
                    ),
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
              children: board
                  ? _desktop(snapshot, reading, switcher: switcher)
                  : [
                      if (places case final places?) _arrows(places),
                      ?switcher,
                      if (app != null && onNewSwarm != null)
                        const SizedBox(height: DesktopChrome.controlGap),
                      const SizedBox(height: 20),
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
                      ),
                      // The reader's one Buddy, the first item under Projects (anh
                      // Dee, 11-05).
                      if (controller.oneBuddy) ?_swarmBuddyRow(),
                      if (snapshot != null && projects.isEmpty)
                        _noProjects()
                      else
                        for (final (_, channel) in _channels(snapshot, reading))
                          channel,
                      const SizedBox(height: 16),
                      // Buddies replaced Chat with PM in every Swarm (Ken, 10-29); where the
                      // server gives one Buddy for the whole Swarm, it is # buddy above.
                      if (!controller.oneBuddy) ...[
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
              child: board
                  ? _iconRow(
                      key: 'super-manage',
                      icon: AppIcons.settings,
                      name: 'Manage',
                      onTap: onManage,
                      selected: manageSelected,
                    )
                  : _navigationRow(
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

/// A project row's ground: the selected fill, or the hover fill while the
/// pointer is anywhere over it, one shape across the row's whole width, and
/// the focus ring ([SuperTabRowGround]).
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
    child: SuperTabRowGround(
      color: widget.selected
          ? grid.SidebarInk.selected
          : _hovered
          ? grid.SidebarInk.hover
          : Colors.transparent,
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
  _SidebarReading(this.controller, this.attention, this.app);
  final SuperTabController controller;
  final SuperTabAttention? attention;
  final AppNotifier? app;
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

  /// In the person's Personal Swarm, the panes they run that are not in it yet: more of Your Team.
  late final List<PersonalAgent> panes = switch ((app, controller.snapshot)) {
    (final app?, final snapshot?)
        when PersonalProjects.of(app).eligible(controller) =>
      personalAgents(app, snapshot),
    _ => const [],
  };
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

/// An agent's one quiet detail in the Desktop's My agents (task #4466): "offline", else the project a Lead [leads].
String? superTabAgentDetail(HarnessActivity? activity, {String? leads}) =>
    activity == HarnessActivity.offline ? 'offline' : leads;
