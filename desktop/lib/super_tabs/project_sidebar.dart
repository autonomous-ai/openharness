import 'dart:async';

import 'package:clock/clock.dart';
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
import 'buddy_rows.dart';
import 'section_heading.dart';
import 'swarm_switcher.dart';
import 'task_groups.dart';
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
    required this.needsHuman,
    this.app,
    this.onNewProject,
    this.onNewSwarm,
    this.onManage,
    this.manageSelected = false,
    this.devicesSelected = false,
    this.onNotifications,
    this.notificationsSelected = false,
    this.attention,
    this.activity,
    this.onOpenBuddyChat,
    this.compact = false,
  });
  final SuperTabController controller;

  /// A phone's layout: its rows keep the app's sizes, not Slack desktop's ([SwarmType]).
  final bool compact;
  final ValueChanged<String> onSelect;
  final int Function(SuperTabConversation group) needsHuman;
  final AppNotifier? app;
  final VoidCallback? onNewProject;

  /// The existing New Swarm. Given, the bar starts with the Swarm dropdown
  /// ([SwarmSwitcher]), which offers it last.
  final VoidCallback? onNewSwarm;

  /// Opens Manage (Machines, Models, Devices, Swarm), the row at the foot.
  final VoidCallback? onManage;
  final bool manageSelected;
  final bool devicesSelected;

  /// Opens the Activity view (Slack's Activity): decisions asked of the
  /// reader, tags of them, replies to them and reactions to their messages.
  final VoidCallback? onNotifications;
  final bool notificationsSelected;

  /// What the Activity row counts and whether it is bold; without it the
  /// row counts the tags and decisions waiting, as Notifications did.
  final SuperTabActivity? activity;

  /// What needs the reader, as Slack shows it: each row's red number counts
  /// only tags of them (decisions asked of them among them), and Threads is
  /// bold while a thread they follow has replies they have not read. Without
  /// it rows carry no number.
  final SuperTabAttention? attention;

  /// Whether a row other than a conversation (Manage, devices, Notifications)
  /// holds the main pane.
  bool get _paneCovered =>
      manageSelected || devicesSelected || notificationsSelected;

  /// Opens the reader's Buddy chat in a project, by project id; the
  /// controller's [SuperTabController.openBuddyChat] when not given.
  final ValueChanged<String>? onOpenBuddyChat;

  /// Forwarded to the embedded [SuperTabMachines]; a test gives it to pin
  /// the clock its readings' ages are counted against.
  @visibleForTesting
  /// Projects and workgroups share a text column. Only projects use its icon.
  static const _iconColumn = SuperTabSectionHeading.actionWidth;
  static const _rowEnd = 10.0;

  /// A sidebar section's heading, as Slack's "Channels": the row's size, medium and muted. A phone keeps the
  /// heading's own.
  TextStyle? get _headingStyle => compact
      ? null
      : SwarmType.sidebar(
          compact: false,
          color: DesktopChrome.muted,
          medium: true,
        );

  Widget _navigationRow({
    required String key,
    required String label,
    required IconData icon,
    required VoidCallback? onTap,
    bool selected = false,
    int badge = 0,
    Widget? trailing,
    bool? unread,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 2),
    child: Material(
      color: selected ? grid.AppSurface.selectedFill : Colors.transparent,
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      clipBehavior: Clip.antiAlias,
      child: Semantics(
        button: true,
        selected: selected,
        child: InkWell(
          key: ValueKey(key),
          onTap: onTap,
          hoverColor: grid.AppSurface.hoverFill,
          focusColor: grid.AppSurface.hoverFill,
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
                      ? DesktopChrome.muted
                      : DesktopChrome.foreground,
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
                                ? DesktopChrome.muted
                                : DesktopChrome.foreground,
                          ).copyWith(
                            fontWeight: unread == true
                                ? grid.AppFont.semibold
                                : null,
                          ),
                    ),
                  ),
                ),
              ),
              if (trailing ?? (badge > 0 ? SuperTabCountBadge(badge) : null)
                  case final mark?)
                Padding(padding: const EdgeInsets.only(right: 10), child: mark),
            ],
          ),
        ),
      ),
    ),
  );

  /// A project reads as a channel; a private one keeps its lock in this mark slot.
  Widget _channelMark({required bool isPrivate}) => isPrivate
      ? PrivateProjectLock(size: 14, color: DesktopChrome.muted)
      : Text(
          '#',
          textAlign: TextAlign.center,
          style: SwarmType.sidebar(
            compact: compact,
            color: DesktopChrome.muted,
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
    final selected = !_paneCovered && controller.selectedId == group.id;
    // A project's row is bold for its own chat (Huy, 11-04, task #2638): a
    // person's message or a tag of the reader there, never agents' progress
    // alone (#2427). A task's unread is on its card and in Activity, and its
    // tags count in the row's number.
    final unread = reading == null
        ? controller.unreadShown(group)
        : reading.unread.contains(group.id);
    // Tags in its chat, which opening it clears (Dee, Slack's way), and the
    // tasks that need the reader, so someone in another project still sees
    // them (task #2569). Tags in tasks count here and are in Activity.
    final mentions = attention?.mentionsIn(group.id) ?? 0;
    final needsYou = reading?.needsYou ?? 0;
    final badge = mentions + needsYou;
    final badgeTooltip = needsYou == 0
        ? attention?.badgeTooltipIn(group.id)
        : [
            if (mentions > 0)
              attention?.badgeTooltipIn(group.id) ??
                  (mentions == 1 ? '1 mention' : '$mentions mentions'),
            needsYou == 1 ? '1 task needs you' : '$needsYou tasks need you',
          ].join(' · ');
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
          ? DesktopChrome.foreground
          : DesktopChrome.muted,
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
                focusColor: grid.AppSurface.hoverFill,
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
                              color: DesktopChrome.foreground,
                            )
                          : null,
                    ),
                    Expanded(
                      child: Semantics(
                        label: project?.isPrivate == true
                            ? 'Private project'
                            : null,
                        selected: selected,
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
                                        color: DesktopChrome.muted,
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
      selected:
          chat != null && !_paneCovered && controller.selectedId == chat.id,
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
    return _drawRow(
      chat ?? _unopenedSwarmBuddyChat,
      label: 'Buddy',
      key: 'super-swarm-buddy',
      selected:
          chat != null && !_paneCovered && controller.selectedId == chat.id,
      // Muted, it is greyed and never bold, as every chat (_drawRow).
      unread: chat != null && controller.unreadShown(chat),
      trailing: agent == null ? null : _buddyMark(agent),
      onTap: chat == null ? () => _openBuddyChat(key) : null,
      tappable: chat != null || !busy,
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

  /// Every project with its workgroups, by name from A to Z. The round dial
  /// swipes projects in this order (cli superTabs/cards.ts `leadsOf`): the
  /// two must match.
  List<(String, Widget)> _channels(
    SuperTabSnapshot? snapshot,
    _SidebarReading reading,
  ) => [
    for (final project in snapshot?.projects ?? const <SuperTabProject>[])
      if (reading.of(project) case final read
          when read.lead != null &&
              (!controller.unreadOnly || _hasUnread(read)))
        (
          project.name,
          Column(
            key: ValueKey('super-project-${project.id}'),
            mainAxisSize: MainAxisSize.min,
            children: [_row(read.lead!, reading: read)],
          ),
        ),
  ]..sort((a, b) => a.$1.toLowerCase().compareTo(b.$1.toLowerCase()));

  @override
  Widget build(BuildContext context) => switch ([?attention, ?activity]) {
    final List<Listenable> sources when sources.isNotEmpty => ListenableBuilder(
      listenable: Listenable.merge(sources),
      builder: (context, _) => _build(context),
    ),
    _ => _build(context),
  };

  Widget _build(BuildContext context) {
    final snapshot = controller.snapshot;
    final projects = snapshot?.projects ?? const <SuperTabProject>[];
    final reading = _SidebarReading(controller, needsHuman, attention);
    return Material(
      color: DesktopChrome.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: LaidOutListView(
              padding: const EdgeInsets.all(8),
              children: [
                if ((app, onNewSwarm) case (final app?, final onNewSwarm?))
                  SwarmSwitcher(
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
                // Slack's Activity, where Notifications was (Lead, 10-31): one row.
                if (onNotifications != null)
                  _navigationRow(
                    key: 'super-activity',
                    label: 'Activity',
                    icon: AppIcons.bell,
                    onTap: onNotifications,
                    selected: notificationsSelected,
                    unread: activity?.unread ?? false,
                    badge:
                        activity?.count ??
                        (snapshot?.mentionsWaiting ?? 0) +
                            (snapshot?.decisionsWaiting ?? 0),
                  ),
                // One Buddy for the whole Swarm, under Activity (Quiet Swarm, screen 1).
                if (controller.oneBuddy) ?_swarmBuddyRow(),
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
                  collapsed: !controller.projectsGroupOpen,
                  onToggleCollapsed: controller.toggleProjectsGroup,
                ),
                if (controller.projectsGroupOpen) ...[
                  for (final (_, channel) in _channels(snapshot, reading))
                    channel,
                ],
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
              padding: const EdgeInsets.symmetric(
                horizontal: grid.AppDesktop.controlGap,
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
          ? grid.AppSurface.selectedFill
          : _hovered
          ? grid.AppSurface.hoverFill
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
  _SidebarReading(this.controller, this.needsHuman, this.attention);
  final SuperTabController controller;
  final int Function(SuperTabConversation group) needsHuman;
  final SuperTabAttention? attention;
  final _projects = <String, _ProjectReading>{};

  _ProjectReading of(SuperTabProject project) =>
      _projects.putIfAbsent(project.id, () => _ProjectReading(this, project));

  /// The project of the open conversation.
  late final selectedProjectId = controller.selected?.projectId;
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
              (sidebar.attention?.mentionsIn(g.id) ?? 0) > 0))
        g.id,
  };

  /// How many of its tasks need the reader: what its row's badge adds.
  late final int needsYou = superTabTasksNeedingYouIn(
    superTabProjectBoard(
      sidebar.controller,
      project,
      now: clock.now(),
      needsHuman: sidebar.needsHuman,
      attention: sidebar.attention,
    ),
  );

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

/// The chats in the order the sidebar lists them, for Option+Shift+Down and
/// Up (Slack's next unread): the reader's one Buddy chat (`# buddy`, first
/// under Projects), each project's chat from A to Z, then the reader's
/// project Buddy chats. Tasks are in each project's Tasks view, not here
/// (task #2569). The round dial swipes projects in this A to Z order too (cli
/// superTabs/cards.ts `leadsOf`): the two must match.
List<String> superTabSidebarOrder(SuperTabController controller) {
  final snapshot = controller.snapshot;
  if (snapshot == null) return const [];
  final projects = [...snapshot.projects]
    ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
  return [
    if (controller.oneBuddy)
      if (controller.buddyChat(SuperTabController.kSwarmBuddyKey)
          case final chat?)
        chat.id,
    for (final project in projects)
      if (snapshot.conversation(project.leadConversationId) != null)
        project.leadConversationId,
    for (final project in projects)
      if (controller.buddyChat(project.id) case final chat?) chat.id,
  ];
}
