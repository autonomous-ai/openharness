import 'package:flutter/material.dart';

import '../core/models.dart' show Machine;
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'agent_state.dart';
import 'controller.dart';
import 'delete_agent.dart';
import 'model.dart';
import 'places.dart' show SwarmPage;
import 'my_agents.dart';
import 'personal_agents.dart';
import 'personal_projects.dart' show PersonalProjects;
import 'quiet_rows.dart';
import 'identity.dart';
import 'leaderboard/shipping.dart';
import 'section_heading.dart';
import 'swarm_starts.dart';
import 'swarm_switcher.dart';
import 'private_project_lock.dart';
import '../widgets/laid_out_list.dart';
import '../widgets/pane_menu.dart' show showContextMenuAt;
import 'swarm_type.dart';

class ProjectSidebar extends StatelessWidget {
  const ProjectSidebar({
    super.key,
    required this.controller,
    required this.onSelect,
    this.app,
    this.onNewProject,
    this.onNewSwarm,
    this.onRenameSwarm,
    this.onManage,
    this.onManageMachines,
    this.manageSelected = false,
    this.devicesSelected = false,
    this.onPage,
    this.page,
    this.compact = false,
    this.onNewAgent,
    this.onAttachAgent,
    this.onOpenAgentChat,
    this.onOpenPane,
    this.joining = const {},
    this.boardProjectId,
    this.onOpenAgentTerminal,
    this.leaderboard,
    this.agentStates,
  });
  final SuperTabController controller;

  /// What each agent of Your Team is doing, its row's one line; without it a row says only that its agent is offline.
  final SwarmAgentStates? agentStates;

  /// The leaderboard Top Teams lists on the Desktop: the view's, which its Leaderboard page shows too. Without it, or before it
  /// is read, there is no Top Teams.
  final SuperTabShippingReader? leaderboard;

  /// How many people Humans lists, most points first; the heading opens the whole board.
  static const humansShown = 8;

  /// A phone's layout: its rows keep the app's sizes, not Slack desktop's ([SwarmType]).
  final bool compact;

  /// + New agent (Swarm v3, task #4118): opens the creation dialog, where Regular or PM is chosen. Without it the section
  /// has no + .
  final VoidCallback? onNewAgent;

  /// Attach beside + (Swarm v4): picks an agent already running on its person's own computers to join their team.
  /// Without it the heading has no Attach.
  final VoidCallback? onAttachAgent;

  /// Opens the chat of an agent chosen in My agents in the middle; [onSelect] when not given.
  final ValueChanged<String>? onOpenAgentChat;

  /// Opens a pane of the person's own listed under Your Team in their Personal Swarm, which makes it an agent of the Swarm; its
  /// row opens nothing without it.
  final ValueChanged<PersonalAgent>? onOpenPane;

  /// The panes ([PersonalAgent.swarmId]) joining the Swarm now: their rows say so and wait.
  final Set<String> joining;

  /// The project whose Board holds the Desktop's middle, if one does. Its row is then the lit one (task #4220).
  final String? boardProjectId;

  /// Opens the terminal of an agent in My agents that has no chat to open (task #4220); without it the row opens nothing.
  final ValueChanged<SuperTabAgent>? onOpenAgentTerminal;
  final ValueChanged<String> onSelect;
  final AppNotifier? app;
  final VoidCallback? onNewProject;

  /// The existing New Swarm. Given, the bar starts with the Swarm dropdown
  /// ([SwarmSwitcher]), which offers it last.
  final VoidCallback? onNewSwarm;

  /// Rename in that dropdown, for this Swarm, to a person who may change it (anh Dee, 2026-11-10: "how do i rename a
  /// swarm").
  final VoidCallback? onRenameSwarm;

  /// Opens Manage (Machines, Models, Devices, Swarm), the row at the foot.
  final VoidCallback? onManage;

  /// Opens Manage on its Machines, where a computer in Your Machines is managed.
  final VoidCallback? onManageMachines;
  final bool manageSelected;
  final bool devicesSelected;

  /// Opens one of the Swarm's pages, the Leaderboard.
  final ValueChanged<SwarmPage>? onPage;

  /// The page holding the main pane, if one does.
  final SwarmPage? page;

  /// Whether a row other than a conversation (Manage, devices, a page) holds
  /// the main pane.
  bool get _paneCovered => manageSelected || devicesSelected || page != null;

  /// A project's Board holds the Desktop's middle: no chat's row is lit.
  bool get _boardOpen => boardProjectId != null;

  /// Whether [chat]'s row is the open one: its chat holds the main pane.
  bool _chatLit(SuperTabConversation? chat) =>
      chat != null &&
      !_paneCovered &&
      !_boardOpen &&
      controller.selectedId == chat.id;

  /// Projects and workgroups share a text column. Only projects use its icon.
  static const _iconColumn = SuperTabSectionHeading.actionWidth;
  static const _rowEnd = 10.0;

  /// Under the chat box and under Manage beside it, so the two end on one line.
  static const double footGap = 16;

  /// A project row's name opens the project's chat; only the chevron at its
  /// right end shows or hides its conversations (Dee, 2026-10-28).
  Widget _row(SuperTabConversation group, _ProjectReading reading) {
    final project = reading.project;
    final selected = _chatLit(group);
    // A project's row is bold for its own chat (Huy, 11-04, task #2638): a
    // person's message there, never agents' progress alone (#2427).
    final unread = reading.unread.contains(group.id);
    return _drawRow(
      group,
      project: project,
      selected: selected,
      unread: unread,
      selectedProjectId: reading.sidebar.selectedProjectId,
    );
  }

  Widget _drawRow(
    SuperTabConversation group, {
    required SuperTabProject project,
    required bool selected,
    required bool unread,
    String? selectedProjectId,
  }) {
    // A project shows as selected while one of its tasks is open.
    final highlighted =
        selected || (!_paneCovered && selectedProjectId == project.id);
    // As Slack draws it (Dee, 10-31): a read row in the muted text colour, an
    // unread one at full strength and bold, no dot; the open row keeps its
    // highlight. A project's mute does not hold in Swarm v4 (notifyOf).
    // Regular weight when open too, as Slack's: the highlight carries it,
    // and bold stays for unread alone (Huy, 11-03, #2427).
    final style = SwarmType.sidebar(
      compact: compact,
      color: highlighted || unread
          ? grid.SidebarInk.ink
          : grid.SidebarInk.inkMuted,
    ).copyWith(fontWeight: unread ? grid.AppFont.semibold : null);
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
                key: ValueKey('super-group-${group.id}'),
                onTap: () => onSelect(group.id),
                hoverColor: Colors.transparent,
                focusColor: Colors.transparent,
                borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                child: Row(
                  children: [
                    SizedBox(width: SuperTabSectionHeading.indentFor(0)),
                    SizedBox(
                      width: _iconColumn,
                      child: _channelMark(
                        isPrivate: project.isPrivate,
                        compact: compact,
                      ),
                    ),
                    Expanded(
                      child: Semantics(
                        label: project.isPrivate ? 'Private project' : null,
                        selected: highlighted,
                        child: Tooltip(
                          // Beside the row, level with it, never over
                          // the rows below (Huy, 11-03, #2427).
                          positionDelegate: _besideTheRow,
                          // Compact: a long name wraps rather than
                          // needing more room than the window has right
                          // of the list.
                          constraints: const BoxConstraints(maxWidth: 260),
                          message: project.name,
                          child: ConstrainedBox(
                            // A project a little taller than other rows
                            // (Huy, 11-03, #2427).
                            constraints: BoxConstraints(
                              minHeight: SwarmType.projectRowHeight(
                                compact: compact,
                              ),
                            ),
                            child: Padding(
                              padding: EdgeInsets.symmetric(
                                vertical: SwarmType.projectRowPadding(
                                  compact: compact,
                                ),
                              ),
                              child: Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      project.name,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: style,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                    SizedBox(
                      // A project's row keeps no column for a mark it does
                      // not have: its name ends where the other rows' details do.
                      width: _rowEnd,
                      // Unread is drawn as a bold name; a screen reader
                      // hears it said, as it heard the dot it replaces.
                      child: Semantics(
                        label: unread ? 'Unread messages' : null,
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

  /// An agent's 20 face in a quiet row.
  Widget _face(SuperTabAgent agent, String name, {bool lead = false}) =>
      SuperTabAvatar.agent(
        agent,
        name: name,
        size: SuperTabQuietRow.faceSize,
        engineBadge: false,
        lead: lead,
      );

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
  /// stays at the foot. Nothing else.
  List<Widget> _desktop(
    SuperTabSnapshot? snapshot,
    _SidebarReading reading, {
    required Widget? switcher,
  }) {
    final projectStarts = [
      for (final start in _starts)
        if (start.project) start,
    ];
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
      if (controller.projectsGroupOpen) ...[
        for (final start in projectStarts) _startRow(start),
        if (snapshot != null &&
            projectStarts.isEmpty &&
            superTabListedProjects(
              controller,
              app: app,
              paneCovered: _paneCovered,
            ).isEmpty)
          _noProjects()
        else
          for (final (_, channel) in _channels(snapshot, reading)) channel,
      ],
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

  /// Top Teams: the Leaderboard in short, its people most points first with their points on the right (people ranked by how
  /// many of their agents ship, docs/plans/2026-11-09-swarm-v4-leaderboard.md). Every person opens the whole board.
  List<Widget> _humans(SuperTabSnapshot? snapshot) {
    final onPage = this.onPage;
    if (snapshot == null || onPage == null) return const [];
    // This week's, whichever the Leaderboard page shows.
    final board = leaderboard?.week;
    final scores = [...?board?.people].take(humansShown).toList();
    // An empty list shows nothing (anh Dee's rule): no heading until someone has points. A Swarm of one person before its first
    // task ships has a board of one zero, empty too; a team's zeros stay, the way to its Leaderboard.
    final empty =
        scores.isEmpty ||
        (snapshot.people.length < 2 && scores.first.points <= 0);
    // A computer of the reader's that could not read GitHub is why nobody may be shipping: it is said even then.
    final failures = empty ? [...?board?.failures] : const <ShippingFailure>[];
    if (empty && failures.isEmpty) return const [];
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
                      name: score.displayName,
                      size: SuperTabQuietRow.faceSize,
                    )
                  : SuperTabAvatar.person(
                      person,
                      size: SuperTabQuietRow.faceSize,
                    ),
              name: person?.shownName ?? score.displayName,
              detail: shippingPoints(score.points),
              selected:
                  page == SwarmPage.leaderboard &&
                  score.personId == controller.accountId,
              onTap: open,
            ),
      if (controller.topTeamsGroupOpen)
        for (final failure in failures.take(1))
          _iconRow(
            key: 'super-human-reading',
            icon: AppIcons.triangleAlert,
            name: shippingFailureText(failure.code),
            onTap: open,
          ),
    ];
  }

  /// My agents (task #4118): the agents the person brought, each with its face and
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
        for (final start in _starts)
          if (!start.project && !_listedAgent(snapshot, start))
            _startRow(start),
        ..._teamRows(snapshot, reading),
      ],
      const SizedBox(height: grid.AppDesktop.groupGap),
    ];
  }

  /// How many of Your Team's rows show before "N more" (tester Q1, 2026-11-10: with forty agents a person scrolled past
  /// every one to reach a project).
  static const teamShown = 8;

  /// Your Team's rows: every one when at most one more than [teamShown] would show, or once the reader opened them all;
  /// else the [teamShown] that matter most (something new first, then on a task, then the rest; a pane not in the Swarm
  /// yet last), each where it stands in the list, plus the open one, and "N more". Only the rows shown are built.
  List<Widget> _teamRows(SuperTabSnapshot snapshot, _SidebarReading reading) {
    final agents = reading.myAgents;
    final count = agents.length + reading.panes.length;
    bool unread(SuperTabConversation? chat) =>
        chat != null && controller.unreadShown(chat);
    Widget build(int i) => i < agents.length
        ? _agentRow(snapshot, agents[i].$1, agents[i].$2)
        : _paneRow(reading.panes[i - agents.length]);
    final all = [for (var i = 0; i < count; i++) i];
    if (count <= teamShown + 1) return [for (final i in all) build(i)];
    if (controller.agentsAllShown) {
      return [
        for (final i in all) build(i),
        SuperTabFoldRow(open: true, onTap: controller.toggleAllAgents),
      ];
    }
    int rank(int i) {
      if (i >= agents.length) return 3;
      final (agent, chat) = agents[i];
      if (unread(chat)) return 0;
      return agentStates?.taskOf(agent) != null ? 1 : 2;
    }

    final ranks = [for (final i in all) rank(i)];
    final order = [...all]
      ..sort((a, b) {
        final byRank = ranks[a].compareTo(ranks[b]);
        return byRank != 0 ? byRank : a.compareTo(b);
      });
    final shown = {
      ...order.take(teamShown),
      for (var i = 0; i < agents.length; i++)
        if (_chatLit(agents[i].$2)) i,
    };
    final hidden = [
      for (final i in all)
        if (!shown.contains(i)) i,
    ];
    if (hidden.length < 2) return [for (final i in all) build(i)];
    return [
      for (final i in all)
        if (shown.contains(i)) build(i),
      SuperTabFoldRow(
        hidden: hidden.length,
        // Something new behind it says so, as a row's bold name does.
        unread: hidden.any((i) => i < agents.length && unread(agents[i].$2)),
        onTap: controller.toggleAllAgents,
      ),
    ];
  }

  /// A pane of the person's own in their Personal Swarm, an agent of theirs that has not joined it: its face as it will be,
  /// its name and its computer. A click joins it, which needs its computer on and is done once at a time.
  Widget _paneRow(PersonalAgent pane) {
    final busy = joining.contains(pane.swarmId);
    return SuperTabQuietRow(
      key: ValueKey('super-pane-${pane.machineId}-${pane.agent.id}'),
      leading: SuperTabAvatar(
        identity: 'agent:${pane.swarmId}',
        name: pane.name,
        size: SuperTabQuietRow.faceSize,
        face: true,
      ),
      name: pane.name,
      detail: busy ? 'joining' : pane.place,
      onTap: busy || pane.machine.isOffline || onOpenPane == null
          ? null
          : () => onOpenPane!(pane),
    );
  }

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
      // A message waits while its engine starts: it says so, before anything else it is doing.
      detail:
          SwarmAgentStates.offlineOf(agent) == null &&
              (app?.engineStarting(agent.machineId, agent.harnessId) ?? false)
          ? 'starting'
          : agentStates?.of(agent) ?? SwarmAgentStates.offlineOf(agent),
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
            await deleteSwarmAgent(context, controller, agent, name, app: app);
          }
        },
        child: row,
      ),
    );
  }

  /// This Swarm's New Project and New Agent going on without their forms (swarm_starts.dart).
  List<SwarmStart> get _starts =>
      app?.swarmStarts.of(controller.tabId) ?? const [];

  /// Whether [start]'s agent is in the Swarm now: its own row stands, so the start's goes.
  bool _listedAgent(SuperTabSnapshot snapshot, SwarmStart start) {
    final harness = start.form.createdAgentId;
    return harness != null &&
        snapshot.agents.any(
          (agent) =>
              agent.machineId == start.form.machineId &&
              agent.harnessId == harness,
        );
  }

  /// A start's row, whose failure opens its form again as its section's + does.
  Widget _startRow(SwarmStart start) => SwarmStartRow(
    key: ValueKey('super-start-${start.id}'),
    name: start.name,
    project: start.project,
    isPrivate: start.isPrivate,
    failed: start.failed,
    compact: compact,
    onOpen: start.project ? onNewProject : onNewAgent,
  );

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

  /// Every project with its workgroups, by name from A to Z. The round dial
  /// swipes projects in this order (cli superTabs/cards.ts `leadsOf`); a
  /// Personal project this list leaves out ([superTabListedProjects]) stays
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
          children: [_row(read.lead!, read)],
        ),
      ),
  ];

  /// The projects Projects lists ([superTabListedProjects]), each with a chat, in its order, less one still starting (its
  /// start row stands in for it).
  Iterable<_ProjectReading> _listed(
    SuperTabSnapshot? snapshot,
    _SidebarReading reading,
  ) {
    final starting = {for (final start in _starts) ?start.projectId};
    return [
      if (snapshot != null)
        for (final project in superTabListedProjects(
          controller,
          app: app,
          paneCovered: _paneCovered,
        ))
          if (reading.of(project) case final read
              when read.lead != null && !starting.contains(project.id))
            read,
    ];
  }

  // The sidebar's ink scope (#3006): a theme's own sidebar ink reaches the
  // shared rows drawn in it.
  @override
  Widget build(BuildContext context) => grid.SidebarInk.scope(
    child: switch ([?leaderboard, ?agentStates, ?app?.swarmStarts]) {
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
    final reading = _SidebarReading(controller, app);
    final switcher = switch ((app, onNewSwarm)) {
      (final app?, final onNewSwarm?) => SwarmSwitcher(
        app: app,
        controller: controller,
        onNewSwarm: onNewSwarm,
        onRename: controller.canWrite ? onRenameSwarm : null,
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
              // Plain text, its chevron only on hover (task #4466).
              child: SuperTabQuietHeading.org(
                label,
                key: const ValueKey('super-swarm-switcher'),
                onTap: onTap,
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
              children: _desktop(snapshot, reading, switcher: switcher),
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
              child: _iconRow(
                key: 'super-manage',
                icon: AppIcons.settings,
                name: 'Manage',
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
  _SidebarReading(this.controller, this.app);
  final SuperTabController controller;
  final AppNotifier? app;
  final _projects = <String, _ProjectReading>{};

  _ProjectReading of(SuperTabProject project) =>
      _projects.putIfAbsent(project.id, () => _ProjectReading(this, project));

  /// The project of the open conversation.
  late final selectedProjectId = controller.selected?.projectId;

  /// My agents' rows, each agent with the chat it opens: drawn by the rows, and asked by the project
  /// rows, so a chat lit there is not lit twice (#4441).
  late final List<(SuperTabAgent, SuperTabConversation?)> myAgents = [
    if (controller.snapshot case final snapshot?)
      for (final agent in superTabMyAgents(snapshot, controller.accountId))
        (agent, superTabAgentChat(snapshot, agent)),
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

  /// The open conversations with unread messages.
  late final Set<String> unread = {
    for (final g in conversations)
      if (!g.closed &&
          g.audience == null &&
          sidebar.controller.unreadForPeople(g))
        g.id,
  };
}

String _projectSortName(String name) =>
    (name.startsWith('#') ? name.substring(1).trimLeft() : name).toLowerCase();

int _compareProjects(SuperTabProject a, SuperTabProject b) {
  final byName = _projectSortName(a.name).compareTo(_projectSortName(b.name));
  return byName != 0 ? byName : a.id.compareTo(b.id);
}

/// The chats in the order the sidebar lists them, for Option+Shift+Down and
/// Up (Slack's next unread): each project's chat from A to Z. Tasks are on each project's task board, not here
/// (task #2569). The round dial swipes projects in this A to Z order too (cli
/// superTabs/cards.ts `leadsOf`), but keeps the Personal projects this list
/// leaves out (task #3042).
List<String> superTabSidebarOrder(
  SuperTabController controller, {
  AppNotifier? app,
}) {
  final snapshot = controller.snapshot;
  if (snapshot == null) return const [];
  return [
    for (final project in superTabListedProjects(controller, app: app))
      if (snapshot.conversation(project.leadConversationId) != null)
        project.leadConversationId,
  ];
}

/// The projects a list of them offers, from A to Z: the Swarm's, less an archived one, and in the person's own Personal
/// Swarm (personal_projects.dart, worked out once a call) less v3's tab projects and those it hides: a project whose
/// panes are all closed (task #3042) and the Swarm's first project while it names no repository. A hidden one stays while
/// its chat is open, unless something covers the chat ([paneCovered]), and while that chat has something unread. None
/// left out without the app, which holds the panes.
List<SuperTabProject> superTabListedProjects(
  SuperTabController controller, {
  AppNotifier? app,
  bool paneCovered = false,
}) {
  final snapshot = controller.snapshot;
  if (snapshot == null) return const [];
  final personal = app == null ? null : PersonalProjects.of(app);
  final closing = personal?.unlistedIn(controller) ?? const <String>{};
  final hidden = personal?.hiddenIn(controller) ?? const <String>{};
  bool kept(SuperTabProject project) {
    if (closing.contains(project.id)) return false;
    if (!hidden.contains(project.id)) return true;
    final chat = snapshot.conversation(project.leadConversationId);
    return chat != null &&
        ((!paneCovered && controller.selectedId == chat.id) ||
            controller.unreadShown(chat));
  }

  return [
    for (final project in [...snapshot.listedProjects]..sort(_compareProjects))
      if (kept(project)) project,
  ];
}

/// A project reads as a channel; a private one keeps its lock in this mark slot.
Widget _channelMark({required bool isPrivate, required bool compact}) =>
    isPrivate
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

/// A New project or New agent going on after its form closed ([SwarmStart]; anh Dee, 2026-11-10: "show the agent/project
/// on the left sidebar. grey out or something with loading status. when it's done i can go in and use it"): first in its
/// section, a project's mark or a grey face, its name and one word, `starting`, which opens nothing yet, or `failed` in
/// red, whose click ([onOpen]) opens its form again with why.
class SwarmStartRow extends StatelessWidget {
  const SwarmStartRow({
    super.key,
    required this.name,
    required this.project,
    this.isPrivate = false,
    this.failed = false,
    this.compact = false,
    this.onOpen,
  });
  final String name;
  final bool project, isPrivate, failed, compact;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) => SuperTabQuietRow(
    leading: project
        ? _channelMark(isPrivate: isPrivate, compact: compact)
        : SuperTabAvatar(
            identity: 'start:$name',
            name: name,
            size: SuperTabQuietRow.faceSize,
            face: true,
            offline: true,
          ),
    name: name,
    detail: failed ? 'failed' : 'starting',
    failed: failed,
    onTap: failed ? onOpen : null,
  );
}

/// Under Your Team's first rows (`teamShown`): "N more", which opens every row, and once they are open "Show fewer", which
/// folds them again. Bold while a row it folds has something new.
class SuperTabFoldRow extends StatelessWidget {
  const SuperTabFoldRow({
    super.key = const ValueKey('super-team-more'),
    this.hidden = 0,
    this.open = false,
    this.unread = false,
    required this.onTap,
  });

  /// How many rows it folds; none once [open].
  final int hidden;
  final bool open;
  final bool unread;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => SuperTabQuietRow(
    leading: Icon(
      open ? AppIcons.chevronUp : AppIcons.chevronDown,
      size: AppIcons.inlineSize,
      color: grid.SidebarInk.inkMuted,
    ),
    name: open ? 'Show fewer' : '$hidden more',
    unread: unread,
    onTap: onTap,
  );
}
