import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_conversation.dart';
import 'swarm_inbox.dart';
import 'swarm_pm_chat.dart';
import 'swarm_project_page.dart';
import 'swarm_session.dart';
import 'swarm_team_line.dart';
import 'team_glance.dart';

/// Swarm Home's drawer, from the left edge like the desktop's sidebar: Swarm
/// Home with what waits on the person; Chat with PM, one per project; the
/// projects as # channels, each with its team in a line — its name opens the
/// project, its arrow lists its chats; then the way back to Harness (the
/// terminals), and Settings at its foot. A row closes the drawer before it
/// opens anything.
class SwarmDrawer extends StatefulWidget {
  const SwarmDrawer({
    super.key,
    required this.session,
    required this.onProject,
    required this.onPm,
    required this.onChat,
    this.onHarness,
    this.onSettings,
  });

  /// The account's Swarm; null while there is none to read.
  final SwarmSession? session;

  /// A project's page.
  final void Function(String swarmId, String projectId) onProject;

  /// The person's Chat with PM of a project.
  final void Function(String swarmId, String projectId) onPm;

  /// One chat.
  final void Function(String swarmId, String conversationId) onChat;

  /// Harness at the root; null where there is no shell to switch (a test).
  final VoidCallback? onHarness;

  /// Settings over Swarm Home, opened from the context it is given.
  final void Function(BuildContext context)? onSettings;

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
    void then(VoidCallback action) {
      Scaffold.of(context).closeDrawer();
      action();
    }

    final swarms = [
      for (final swarm in inbox?.swarms ?? const <SwarmListing>[])
        if (inbox!.reader(swarm.id)?.snapshot case final snapshot?)
          (swarm: swarm, snapshot: snapshot),
    ];
    final several = swarms.length > 1;
    final secondary = TextStyle(
      color: AppPalette.textSecondary,
      fontSize: 12.5,
      height: 1.4,
    );
    return Drawer(
      backgroundColor: AppPalette.panelBg,
      shape: const RoundedRectangleBorder(),
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(Tty.origin, 12, Tty.origin, 8),
              child: TtyText(
                'Swarm',
                size: TtySize.title,
                weight: FontWeight.w600,
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(vertical: 4),
                children: [
                  SwarmDrawerRow(
                    key: const ValueKey('swarm-drawer-home'),
                    icon: LucideIcons.network300,
                    title: 'Swarm Home',
                    selected: true,
                    badge: switch (inbox?.needs.length ?? 0) {
                      0 => null,
                      final count => '$count',
                    },
                    badgeColor: tty.yellow,
                    onTap: () => Scaffold.of(context).closeDrawer(),
                  ),
                  if (swarms.any((s) => s.snapshot.projects.isNotEmpty))
                    const _Caption('Chat with PM'),
                  for (final (:swarm, :snapshot) in swarms)
                    for (final project in snapshot.projects)
                      SwarmDrawerRow(
                        key: ValueKey(
                          'swarm-drawer-pm-${swarm.id}-${project.id}',
                        ),
                        icon: LucideIcons.messageSquare300,
                        title: project.name,
                        detail: switch ([
                          ?swarmPmName(snapshot, project),
                          if (several) swarm.name,
                        ]) {
                          [] => null,
                          final words => Text(
                            words.join(' · '),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: secondary,
                          ),
                        },
                        onTap: () =>
                            then(() => widget.onPm(swarm.id, project.id)),
                      ),
                  for (final (:swarm, :snapshot) in swarms)
                    if (snapshot.projects.isNotEmpty) ...[
                      _Caption(several ? swarm.name : 'Projects'),
                      for (final project in snapshot.projects)
                        ..._project(
                          session!,
                          swarm.id,
                          snapshot,
                          project,
                          then,
                        ),
                    ],
                  if (widget.onHarness case final harness?) ...[
                    const SizedBox(height: 12),
                    SwarmDrawerRow(
                      key: const ValueKey('swarm-drawer-harness'),
                      icon: LucideIcons.squareTerminal300,
                      title: 'Harness',
                      onTap: () => then(harness),
                    ),
                  ],
                ],
              ),
            ),
            if (widget.onSettings case final settings?) ...[
              Divider(height: 1, thickness: 1, color: AppGlass.hair),
              SwarmDrawerRow(
                key: const ValueKey('swarm-drawer-settings'),
                icon: LucideIcons.settings300,
                title: 'Settings',
                onTap: () => then(() => settings(context)),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// A project's row, and while its arrow is open, its chats: the project
  /// chat, then its work by latest activity (Chat with PM has its own row).
  List<Widget> _project(
    SwarmSession session,
    String swarmId,
    SuperTabSnapshot snapshot,
    SuperTabProject project,
    void Function(VoidCallback action) then,
  ) {
    final id = '$swarmId/${project.id}';
    final open = _open.contains(id);
    final lead = snapshot.conversation(project.leadConversationId);
    final reader = session.inbox.reader(swarmId);
    final work = swarmProjectWork(
      snapshot,
      project,
      session.accountId,
      pmChatId: reader == null ? null : swarmPmChat(reader, project.id)?.id,
    ).active;
    SwarmDrawerRow chat(SuperTabConversation g, String title) => SwarmDrawerRow(
      key: ValueKey('swarm-drawer-chat-${g.id}'),
      title: title,
      indent: true,
      onTap: () => then(() => widget.onChat(swarmId, g.id)),
    );
    return [
      SwarmDrawerRow(
        key: ValueKey('swarm-drawer-project-$swarmId-${project.id}'),
        icon: LucideIcons.hash300,
        title: project.name,
        detail: SwarmTeamLine(swarmTeamGlance(snapshot, projectId: project.id)),
        onTap: () => then(() => widget.onProject(swarmId, project.id)),
        trailing: _Disclosure(
          key: ValueKey('swarm-drawer-chats-$swarmId-${project.id}'),
          open: open,
          label: '${open ? 'Hide' : 'Show'} the chats of ${project.name}',
          onTap: () => setState(() => open ? _open.remove(id) : _open.add(id)),
        ),
      ),
      if (open) ...[
        if (lead != null) chat(lead, 'Project chat'),
        for (final g in work) chat(g, g.label),
      ],
    ];
  }
}

/// A caption over a run of the drawer's rows, as Settings heads its groups.
class _Caption extends StatelessWidget {
  const _Caption(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(Tty.origin, 18, Tty.origin, 6),
    child: Text(
      text.toLowerCase(),
      style: TextStyle(
        color: Color.lerp(AppPalette.textFaint, AppPalette.textSecondary, .5),
        fontSize: 13,
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
        width: 52,
        height: SwarmDrawerRow.height,
        child: Icon(
          open ? LucideIcons.chevronDown300 : LucideIcons.chevronRight300,
          size: 20,
          color: AppPalette.textFaint,
        ),
      ),
    ),
  );
}

/// One row of the drawer: a glyph, a title and maybe a line under it, a
/// count, and at the right an optional control of its own.
class SwarmDrawerRow extends StatelessWidget {
  const SwarmDrawerRow({
    super.key,
    this.icon,
    required this.title,
    this.detail,
    this.badge,
    this.badgeColor,
    this.selected = false,
    this.indent = false,
    this.trailing,
    required this.onTap,
  });

  final IconData? icon;
  final String title;
  final Widget? detail;
  final String? badge;
  final Color? badgeColor;
  final bool selected;

  /// A chat under its project: lined up with the project's name.
  final bool indent;
  final Widget? trailing;
  final VoidCallback? onTap;

  /// Every row clears this, for a thumb.
  static const double height = 52;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return Material(
      color: selected ? AppSurface.selectedFill : Colors.transparent,
      child: InkWell(
        onTap: onTap == null
            ? null
            : () {
                HapticFeedback.selectionClick();
                onTap!();
              },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: height),
          child: Padding(
            padding: EdgeInsets.only(
              left: indent ? Tty.origin + 22 + 14 : Tty.origin,
              right: trailing == null ? Tty.origin : 0,
            ),
            child: Row(
              children: [
                if (icon case final icon?) ...[
                  Icon(icon, size: 22, color: AppPalette.textSecondary),
                  const SizedBox(width: 14),
                ],
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: AppPalette.textPrimary,
                            fontSize: 15,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        if (detail case final detail?) ...[
                          const SizedBox(height: 2),
                          detail,
                        ],
                      ],
                    ),
                  ),
                ),
                if (badge case final badge?)
                  Padding(
                    padding: const EdgeInsets.only(left: 8),
                    child: TtyText(
                      badge,
                      color: badgeColor ?? tty.text,
                      weight: FontWeight.w600,
                      size: TtySize.meta,
                    ),
                  ),
                ?trailing,
              ],
            ),
          ),
        ),
      ),
    );
  }
}
