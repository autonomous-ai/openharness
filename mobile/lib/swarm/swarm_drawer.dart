import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';

import 'identity.dart';
import 'model.dart';
import 'swarm_buddy.dart';
import 'swarm_buddy_chat.dart';
import 'swarm_devices_page.dart';
import 'swarm_face.dart';
import 'swarm_inbox.dart';
import 'swarm_leaderboard.dart';
import 'swarm_models_page.dart';
import 'swarm_project_page.dart';
import 'swarm_reader.dart';
import 'swarm_machines.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_task_status.dart';
import 'swarm_unread.dart';

/// Swarm Home's drawer, from the left edge like the desktop's sidebar, as the
/// approved prototype draws it: its title and a close button; Swarm Home
/// with what waits on the person; Buddies, the person's Buddy chat in each
/// project (Tony, 2026-10-29, as on the desktop since #2090); the projects,
/// each with its initial and its name, no team line (Team at a glance is
/// gone, as on the desktop) — its name opens the project, its arrow lists
/// its chats: Buddy chat, the project chat, its leaderboard, then its work,
/// what waits on the person first; then Your models and Your devices, read
/// only; then Settings at its foot. A row closes the drawer before it opens
/// anything. A chat, a Buddy or a project with something new is bold, with
/// the tags waiting in it as `@N` ([swarmChatNews], [swarmProjectNews]),
/// as Tony approved (2026-10-29).
class SwarmDrawer extends StatefulWidget {
  const SwarmDrawer({
    super.key,
    required this.session,
    required this.onProject,
    required this.onBuddy,
    required this.onChat,
    this.onSettings,
    this.onProfile,
  });

  /// The account's Swarm; null while there is none to read.
  final SwarmSession? session;

  /// A project's page.
  final void Function(String swarmId, String projectId) onProject;

  /// The person's Buddy chat in a project, opened on the server first when
  /// it has none yet.
  final void Function(String swarmId, String projectId) onBuddy;

  /// One chat.
  final void Function(String swarmId, String conversationId) onChat;

  /// Settings over Swarm Home, opened from the context it is given.
  final void Function(BuildContext context)? onSettings;

  /// The person's own profile in a Swarm; null offers none.
  final void Function(String swarmId)? onProfile;

  @override
  State<SwarmDrawer> createState() => _SwarmDrawerState();
}

class _SwarmDrawerState extends State<SwarmDrawer> {
  /// Projects whose chats are listed, as `swarmId/projectId`.
  final _open = <String>{};

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final session = widget.session;
    final inbox = session?.inbox;
    final navigator = Navigator.of(context);
    void close() => Scaffold.of(context).closeDrawer();
    void then(VoidCallback action) {
      close();
      action();
    }

    final swarms = inbox?.swarms ?? const <SwarmListing>[];
    final several = swarms.length > 1;
    final waiting = inbox?.needs.length ?? 0;
    return Drawer(
      width: MediaQuery.sizeOf(context).width * .86,
      backgroundColor: AppPalette.panelBg,
      shape: Border(right: BorderSide(color: AppGlass.hair)),
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              // The title over the rows' words.
              padding: const EdgeInsets.fromLTRB(
                AppSpace.s + SwarmDrawerRow.inset,
                AppSpace.xs,
                AppSpace.s,
                AppSpace.s,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Swarm',
                      style: tty.style(size: 17, weight: FontWeight.w600),
                    ),
                  ),
                  SwarmIconButton(
                    key: const ValueKey('swarm-drawer-close'),
                    icon: LucideIcons.x300,
                    label: 'Close menu',
                    onPressed: close,
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(
                  AppSpace.s,
                  0,
                  AppSpace.s,
                  AppSpace.m,
                ),
                children: [
                  // Who you are in each Swarm, first: the way to your
                  // picture and status.
                  if (widget.onProfile case final onProfile?)
                    for (final swarm in swarms)
                      if (inbox!.reader(swarm.id) case final reader?)
                        _You(
                          key: ValueKey('swarm-drawer-you-${swarm.id}'),
                          reader: reader,
                          swarmName: several ? swarm.name : null,
                          onTap: () => then(() => onProfile(swarm.id)),
                        ),
                  SwarmDrawerRow(
                    key: const ValueKey('swarm-drawer-home'),
                    leading: const _Glyph(LucideIcons.network300),
                    title: 'Swarm Home',
                    selected: true,
                    badge: waiting > 0 ? SwarmBadge(waiting, warn: true) : null,
                    onTap: close,
                  ),
                  ..._buddies(swarms, inbox, then),
                  // Before the list (and no Home kept), and for a Swarm
                  // still to be read, its projects are rows on their way; one
                  // that could not be read lists none.
                  if (inbox != null &&
                      !inbox.loaded &&
                      inbox.swarms.isEmpty &&
                      inbox.error == null) ...[
                    const _Caption('Projects'),
                    _ProjectsLoading('swarm-drawer-loading'),
                  ],
                  for (final swarm in swarms)
                    ...switch (inbox!.reader(swarm.id)) {
                      final SwarmReader reader
                          when reader.snapshot?.projects.isNotEmpty ?? false =>
                        _projects(session!, swarm, reader, several, then),
                      SwarmReader(snapshot: null, error: null) || null => [
                        _Caption(several ? swarm.name : 'Projects'),
                        _ProjectsLoading('swarm-drawer-loading-${swarm.id}'),
                      ],
                      _ => const <Widget>[],
                    },
                  for (final swarm in swarms)
                    if (inbox?.reader(swarm.id) case final reader?)
                      SwarmMachinesSection(
                        key: ValueKey('swarm-machine-section-${swarm.id}'),
                        reader: reader,
                        swarmName: several ? swarm.name : null,
                        open: (id) => then(
                          () =>
                              unawaited(showSwarmMachine(context, reader, id)),
                        ),
                      ),
                  // The Swarm's models and the account's computers, read
                  // only, as Desktop's sidebar has them under its projects.
                  const _Caption(''),
                  SwarmDrawerRow(
                    key: const ValueKey('swarm-drawer-models'),
                    leading: const _Glyph(LucideIcons.brain300),
                    title: 'Your models',
                    trailing: true,
                    onTap: () => then(
                      () => navigator.push(
                        phoneRoute(
                          (_) => const SwarmModelsPage(),
                          listensForItself: true,
                        ),
                      ),
                    ),
                  ),
                  if (SwarmScope.computersOf(context) != null)
                    SwarmDrawerRow(
                      key: const ValueKey('swarm-drawer-devices'),
                      leading: const _Glyph(LucideIcons.laptop300),
                      title: 'Your devices',
                      trailing: true,
                      onTap: () => then(
                        () => navigator.push(
                          phoneRoute(
                            (_) => const SwarmDevicesPage(),
                            listensForItself: true,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            if (widget.onSettings case final settings?)
              DecoratedBox(
                decoration: BoxDecoration(
                  border: Border(top: BorderSide(color: AppGlass.hair)),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpace.s,
                    vertical: AppSpace.s,
                  ),
                  child: SwarmDrawerRow(
                    key: const ValueKey('swarm-drawer-settings'),
                    leading: const _Glyph(LucideIcons.settings2300),
                    title: 'Settings',
                    onTap: () => then(() => settings(context)),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// Buddies: the person's Buddy chat in each project of each Swarm read,
  /// there from the start (#2090); a viewer, who starts no Buddy, sees only
  /// the chats they have. The project is in brackets once there are several,
  /// with its Swarm where there are several Swarms.
  List<Widget> _buddies(
    List<SwarmListing> swarms,
    SwarmInbox? inbox,
    void Function(VoidCallback action) then,
  ) {
    final rows = [
      for (final swarm in swarms)
        if (inbox?.reader(swarm.id) case final reader?)
          for (final project in reader.snapshot?.projects ?? const [])
            if (swarmBuddyChat(reader, project.id) != null ||
                swarmCanWrite(reader))
              (swarm: swarm, reader: reader, project: project),
    ];
    if (rows.isEmpty) return const [];
    final several = swarms.length > 1;
    return [
      const _Caption('Buddies'),
      for (final (:swarm, :reader, :project) in rows)
        SwarmDrawerRow(
          key: ValueKey('swarm-drawer-buddy-${swarm.id}-${project.id}'),
          leading: SwarmBuddyAvatar(reader: reader, projectId: project.id),
          title: swarmBuddyName(reader, project.id),
          news: switch (swarmBuddyChat(reader, project.id)) {
            final chat? => swarmChatNews(reader, inbox!.asks(swarm.id), chat),
            null => swarmNoNews,
          },
          asides: [
            if (rows.length > 1)
              several
                  ? '(${project.name} · ${swarm.name})'
                  : '(${project.name})',
            ?swarmBuddyNote(reader, project.id),
          ],
          onTap: () => then(() => widget.onBuddy(swarm.id, project.id)),
        ),
    ];
  }

  /// A Swarm's projects under its caption, what is new in each worked out
  /// once for them all ([swarmProjectNews]).
  List<Widget> _projects(
    SwarmSession session,
    SwarmListing swarm,
    SwarmReader reader,
    bool several,
    void Function(VoidCallback action) then,
  ) {
    final snapshot = reader.snapshot!;
    final news = swarmProjectNews(reader, session.inbox.asks(swarm.id));
    return [
      _Caption(several ? swarm.name : 'Projects'),
      for (final project in snapshot.projects)
        ..._project(
          session,
          swarm.id,
          snapshot,
          project,
          news[project.id] ?? swarmNoNews,
          then,
        ),
    ];
  }

  /// A project's row, and while its arrow is open, its chats ([_chats]).
  List<Widget> _project(
    SwarmSession session,
    String swarmId,
    SuperTabSnapshot snapshot,
    SuperTabProject project,
    SwarmRowNews news,
    void Function(VoidCallback action) then,
  ) {
    final id = '$swarmId/${project.id}';
    final open = _open.contains(id);
    return [
      Row(
        children: [
          Expanded(
            child: SwarmDrawerRow(
              key: ValueKey('swarm-drawer-project-$swarmId-${project.id}'),
              leading: SwarmProjectTile(project.name),
              title: project.name,
              news: news,
              onTap: () => then(() => widget.onProject(swarmId, project.id)),
            ),
          ),
          _Disclosure(
            key: ValueKey('swarm-drawer-chats-$swarmId-${project.id}'),
            open: open,
            label: '${open ? 'Hide' : 'Show'} the chats of ${project.name}',
            onTap: () =>
                setState(() => open ? _open.remove(id) : _open.add(id)),
          ),
        ],
      ),
      if (open) ..._chats(session, swarmId, snapshot, project, then),
    ];
  }

  /// An open project's chats: Buddy chat, the project chat, its
  /// leaderboard, then its work — what waits on the person first, the rest
  /// by latest activity, each with its task's status line under its name
  /// ([SwarmTaskLine]). Worked out only while it is open: a closed project
  /// costs its row alone.
  List<Widget> _chats(
    SwarmSession session,
    String swarmId,
    SuperTabSnapshot snapshot,
    SuperTabProject project,
    void Function(VoidCallback action) then,
  ) {
    final lead = snapshot.conversation(project.leadConversationId);
    final reader = session.inbox.reader(swarmId);
    final work = swarmProjectWork(
      snapshot,
      project,
      buddies: reader?.buddies ?? SwarmBuddies.none,
    ).active;
    final waits = swarmWaitingOnYou(session.inbox, swarmId);
    final asks = session.inbox.asks(swarmId);
    SwarmRowNews news(SuperTabConversation? g) => reader == null || g == null
        ? swarmNoNews
        : swarmChatNews(reader, asks, g);
    final personName = swarmTaskPersonName(snapshot);
    // A task's line under its name, as on the desktop (#2125); its trailing
    // edge stays the tags'.
    SwarmDrawerRow chat(
      SuperTabConversation g,
      String title, {
      bool task = false,
    }) => SwarmDrawerRow(
      key: ValueKey('swarm-drawer-chat-${g.id}'),
      title: title,
      sub: true,
      news: news(g),
      detail: task ? SwarmTaskLine(g, personName: personName) : null,
      onTap: () => then(() => widget.onChat(swarmId, g.id)),
    );
    final buddyChat = reader == null
        ? null
        : swarmBuddyChat(reader, project.id);
    return [
      if (reader != null && (buddyChat != null || swarmCanWrite(reader)))
        SwarmDrawerRow(
          key: ValueKey('swarm-drawer-buddy-chat-$swarmId-${project.id}'),
          title: 'Buddy chat',
          sub: true,
          news: news(buddyChat),
          onTap: () => then(() => widget.onBuddy(swarmId, project.id)),
        ),
      if (lead != null) chat(lead, 'Project chat'),
      SwarmDrawerRow(
        key: ValueKey('swarm-drawer-leaderboard-$swarmId-${project.id}'),
        title: 'Leaderboard',
        sub: true,
        onTap: () =>
            then(() => openSwarmLeaderboard(context, swarmId, project.id)),
      ),
      for (final g in work)
        if (waits.contains(g.id)) chat(g, g.label, task: true),
      for (final g in work)
        if (!waits.contains(g.id)) chat(g, g.label, task: true),
    ];
  }
}

/// The person as a Swarm shows them: their face, and their status while it
/// lasts; nothing until the Swarm is read with them in it.
class _You extends StatelessWidget {
  const _You({
    super.key,
    required this.reader,
    required this.swarmName,
    required this.onTap,
  });

  final SwarmReader reader;

  /// The Swarm's name, where there are several.
  final String? swarmName;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: reader,
    builder: (context, _) {
      final me = reader.snapshot?.person(reader.accountId);
      if (me == null) return const SizedBox.shrink();
      return SwarmUntil(
        until: me.status?.until,
        builder: (context) {
          final status = me.statusAt(clock.now());
          // A Home kept for a cold start holds no email.
          final name = me.email.isEmpty ? 'You' : superTabPersonName(me.email);
          return SwarmDrawerRow(
            leading: SwarmAvatar(
              id: me.id,
              name: name,
              picture: me.avatar,
              status: status,
            ),
            title: swarmName == null ? name : '$name · $swarmName',
            detail: Text(
              status?.label ?? 'Set a status',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppType.caption(
                color: status == null
                    ? AppPalette.textFaint
                    : AppPalette.textSecondary,
              ),
            ),
            onTap: onTap,
          );
        },
      );
    },
  );
}

/// A row's glyph, in a 32-point box so titles line up with a project's tile.
class _Glyph extends StatelessWidget {
  const _Glyph(this.icon);

  static const double width = 32;

  final IconData icon;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: width,
    child: Icon(icon, size: 22, color: AppPalette.textSecondary),
  );
}

/// A caption over a run of the drawer's rows; empty, a gap.
class _Caption extends StatelessWidget {
  const _Caption(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(
      SwarmDrawerRow.inset,
      AppSpace.l,
      SwarmDrawerRow.inset,
      AppSpace.s,
    ),
    child: Text(
      text,
      style: AppType.caption(
        color: Color.lerp(AppPalette.textFaint, AppPalette.textSecondary, .5),
        height: 1.2,
      ),
    ),
  );
}

/// A project's arrow: right while its chats are hidden, down while listed.
class _Disclosure extends StatelessWidget {
  const _Disclosure({
    super.key,
    required this.open,
    required this.label,
    required this.onTap,
  });

  final bool open;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: label,
    excludeSemantics: true,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () {
        HapticFeedback.selectionClick();
        onTap();
      },
      child: SizedBox(
        width: 44,
        height: SwarmDrawerRow.height,
        child: Icon(
          open ? LucideIcons.chevronDown300 : LucideIcons.chevronRight300,
          size: 18,
          color: AppPalette.textFaint,
        ),
      ),
    ),
  );
}

/// One row of the drawer: a glyph or a project's tile, a title, quiet words
/// after it ([asides]) and maybe a line under it, a count; selected, it sits
/// on a rounded fill. A chat under its project ([sub]) is shorter, quieter,
/// and lined up with the project's name. Something new in it ([news]) sets
/// its title in bold, with no dot, and the tags waiting in it as `@N` at its
/// trailing edge (desktop design system: Unread, Mentions).
class SwarmDrawerRow extends StatelessWidget {
  const SwarmDrawerRow({
    super.key,
    this.leading,
    required this.title,
    this.detail,
    this.badge,
    this.selected = false,
    this.sub = false,
    this.trailing = false,
    this.asides = const [],
    this.news = swarmNoNews,
    required this.onTap,
  });

  final Widget? leading;
  final String title;

  /// Quiet words after the title, such as a Buddy's project in brackets and
  /// "offline"; they give way first when the row is narrow.
  final List<String> asides;
  final Widget? detail;
  final Widget? badge;
  final bool selected;

  /// A chat under its project.
  final bool sub;

  /// Opens a page of its own: a chevron at its right.
  final bool trailing;

  /// What is new in it: unread or tagged ([swarmChatNews]).
  final SwarmRowNews news;
  final VoidCallback? onTap;

  /// Every row but a chat under its project clears this, for a thumb.
  static const double height = 52;

  /// From a row's edges to its words.
  static const double inset = AppSpace.m;

  /// Around a row's words; a chat's start under its project's name.
  static const padding = EdgeInsets.symmetric(
    horizontal: inset,
    vertical: AppSpace.s,
  );

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Material(
      color: selected ? AppSurface.selectedFill : Colors.transparent,
      borderRadius: BorderRadius.circular(AppControl.rowRadius),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap == null
            ? null
            : () {
                HapticFeedback.selectionClick();
                onTap!();
              },
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: sub ? 44 : height),
          child: Padding(
            padding: sub
                ? padding.copyWith(
                    left: padding.left + _Glyph.width + AppSpace.m,
                  )
                : padding,

            child: Row(
              children: [
                if (leading case final leading?) ...[
                  leading,
                  const SizedBox(width: AppSpace.m),
                ],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            // Unread is heard in words, as the bold is seen;
                            // tags say their own.
                            child: Semantics(
                              label: news.bold && news.tags == 0
                                  ? 'Unread messages'
                                  : null,
                              child: Text(
                                title,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: switch ((sub, news.bold)) {
                                  (_, true) => AppType.label(
                                    color: AppPalette.textPrimary,
                                    fontWeight: AppFont.semibold,
                                  ),
                                  (true, false) => AppType.body(
                                    color: AppPalette.textSecondary,
                                  ),
                                  (false, false) => AppType.label(
                                    color: AppPalette.textPrimary,
                                  ),
                                },
                              ),
                            ),
                          ),
                          for (final aside in asides) ...[
                            const SizedBox(width: 8),
                            Flexible(
                              child: Text(
                                aside,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppType.caption(
                                  color: AppPalette.textFaint,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                      if (detail case final detail?) ...[
                        const SizedBox(height: 2),
                        detail,
                      ],
                    ],
                  ),
                ),
                if (news.tags > 0) ...[
                  const SizedBox(width: 12),
                  SwarmTags(news.tags),
                ],
                if (badge case final badge?) ...[
                  const SizedBox(width: 12),
                  badge,
                ],
                if (trailing) ...[
                  const SizedBox(width: 12),
                  Icon(
                    LucideIcons.chevronRight300,
                    size: 18,
                    color: AppPalette.textFaint,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A Swarm's projects on their way: two rows in the shape of a project's
/// [SwarmDrawerRow], as tall as the rows that replace them, fading towards
/// the last; one "Loading" to a screen reader. Keyed [id]; its row `i`,
/// `$id-$i`.
class _ProjectsLoading extends StatelessWidget {
  _ProjectsLoading(this.id) : super(key: ValueKey(id));

  final String id;

  static const _rows = 2;

  @override
  Widget build(BuildContext context) => SkeletonBlock(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < _rows; i++)
          Opacity(
            opacity: skeletonFade(i, _rows, depth: .4),
            child: _ProjectLoading(
              key: ValueKey('$id-$i'),
              width: i.isEven ? .45 : .6,
            ),
          ),
      ],
    ),
  );
}

/// One project's row on its way: its tile and a bar for its name, as tall as
/// the line it stands for.
class _ProjectLoading extends StatelessWidget {
  const _ProjectLoading({super.key, required this.width});

  /// The name's share of the row's words.
  final double width;

  @override
  Widget build(BuildContext context) => ConstrainedBox(
    constraints: const BoxConstraints(minHeight: SwarmDrawerRow.height),
    child: Padding(
      padding: SwarmDrawerRow.padding,
      child: Row(
        children: [
          const Skeleton(
            width: _Glyph.width,
            height: _Glyph.width,
            radius: AppCard.insetRadius,
          ),
          const SizedBox(width: AppSpace.m),
          // The real row's metrics: its title alone.
          Expanded(
            child: SkeletonText(style: AppType.label(), widthFactor: width),
          ),
        ],
      ),
    ),
  );
}
