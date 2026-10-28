import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_conversation.dart';
import 'swarm_inbox.dart';
import 'swarm_project_page.dart';
import 'swarm_reader.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_team_line.dart';
import 'team_glance.dart';

/// Swarm Home's drawer, from the left edge like the desktop's sidebar, as the
/// approved prototype draws it: its title and a close button; Swarm Home
/// with what waits on the person; the projects, each with its initial and
/// its team in a line — its name opens the project, its arrow lists its
/// chats: Chat with PM, the project chat, then its work, what waits on the
/// person first; then the way back to Harness (the terminals), and Settings
/// at its foot. A row closes the drawer before it opens anything.
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
              padding: const EdgeInsets.fromLTRB(18, 4, 8, 8),
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
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
                children: [
                  SwarmDrawerRow(
                    key: const ValueKey('swarm-drawer-home'),
                    leading: const _Glyph(LucideIcons.network300),
                    title: 'Swarm Home',
                    selected: true,
                    badge: waiting > 0 ? SwarmBadge(waiting, warn: true) : null,
                    onTap: close,
                  ),
                  // Before the list, and for a Swarm still to be read, its
                  // projects are rows on their way; one that could not be
                  // read lists none.
                  if (inbox != null &&
                      !inbox.loaded &&
                      inbox.error == null) ...[
                    const _Caption('Projects'),
                    SwarmSkeletonRows(id: 'swarm-drawer-loading', drawer: true),
                  ],
                  for (final swarm in swarms)
                    ...switch (inbox!.reader(swarm.id)) {
                      SwarmReader(snapshot: final snapshot?)
                          when snapshot.projects.isNotEmpty =>
                        [
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
                      SwarmReader(snapshot: null, error: null) || null => [
                        _Caption(several ? swarm.name : 'Projects'),
                        SwarmSkeletonRows(
                          id: 'swarm-drawer-loading-${swarm.id}',
                          drawer: true,
                        ),
                      ],
                      _ => const <Widget>[],
                    },
                  if (widget.onHarness case final harness?) ...[
                    const _Caption(''),
                    SwarmDrawerRow(
                      key: const ValueKey('swarm-drawer-harness'),
                      leading: const _Glyph(LucideIcons.squareTerminal300),
                      title: 'Harness',
                      onTap: () => then(harness),
                    ),
                  ],
                ],
              ),
            ),
            if (widget.onSettings case final settings?)
              DecoratedBox(
                decoration: BoxDecoration(
                  border: Border(top: BorderSide(color: AppGlass.hair)),
                ),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
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

  /// A project's row, and while its arrow is open, its chats ([_chats]).
  List<Widget> _project(
    SwarmSession session,
    String swarmId,
    SuperTabSnapshot snapshot,
    SuperTabProject project,
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
              detail: SwarmTeamLine(
                swarmTeamGlance(snapshot, projectId: project.id),
                size: 13,
              ),
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

  /// An open project's chats: Chat with PM, the project chat, then its work
  /// — what waits on the person first, the rest by latest activity. Worked
  /// out only while it is open: a closed project costs its row alone.
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
      session.accountId,
      pmChatId: reader == null ? null : swarmPmChat(reader, project.id)?.id,
    ).active;
    final waits = swarmWaitingOnYou(session.inbox, swarmId);
    SwarmDrawerRow chat(SuperTabConversation g, String title) => SwarmDrawerRow(
      key: ValueKey('swarm-drawer-chat-${g.id}'),
      title: title,
      sub: true,
      onTap: () => then(() => widget.onChat(swarmId, g.id)),
    );
    return [
      SwarmDrawerRow(
        key: ValueKey('swarm-drawer-pm-$swarmId-${project.id}'),
        title: 'Chat with PM',
        sub: true,
        onTap: () => then(() => widget.onPm(swarmId, project.id)),
      ),
      if (lead != null) chat(lead, 'Project chat'),
      for (final g in work)
        if (waits.contains(g.id)) chat(g, g.label),
      for (final g in work)
        if (!waits.contains(g.id)) chat(g, g.label),
    ];
  }
}

/// A row's glyph, in a 32-point box so titles line up with a project's tile.
class _Glyph extends StatelessWidget {
  const _Glyph(this.icon);

  final IconData icon;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 32,
    child: Icon(icon, size: 22, color: AppPalette.textSecondary),
  );
}

/// A caption over a run of the drawer's rows; empty, a gap.
class _Caption extends StatelessWidget {
  const _Caption(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(10, 18, 10, 6),
    child: Text(
      text,
      style: TextStyle(
        color: Color.lerp(AppPalette.textFaint, AppPalette.textSecondary, .5),
        fontSize: 13,
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

/// One row of the drawer: a glyph or a project's tile, a title and maybe a
/// line under it, a count; selected, it sits on a rounded fill. A chat under
/// its project ([sub]) is shorter, quieter, and lined up with the project's
/// name.
class SwarmDrawerRow extends StatelessWidget {
  const SwarmDrawerRow({
    super.key,
    this.leading,
    required this.title,
    this.detail,
    this.badge,
    this.selected = false,
    this.sub = false,
    required this.onTap,
  });

  final Widget? leading;
  final String title;
  final Widget? detail;
  final Widget? badge;
  final bool selected;

  /// A chat under its project.
  final bool sub;
  final VoidCallback? onTap;

  /// Every row but a chat under its project clears this, for a thumb.
  static const double height = 52;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Material(
      color: selected ? AppSurface.selectedFill : Colors.transparent,
      borderRadius: BorderRadius.circular(10),
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
            padding: EdgeInsets.fromLTRB(sub ? 54 : 10, 6, 10, 6),
            child: Row(
              children: [
                if (leading case final leading?) ...[
                  leading,
                  const SizedBox(width: 12),
                ],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: sub
                            ? TextStyle(
                                color: AppPalette.textSecondary,
                                fontSize: 15,
                              )
                            : TextStyle(
                                color: AppPalette.textPrimary,
                                fontSize: 16,
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
                if (badge case final badge?) ...[
                  const SizedBox(width: 12),
                  badge,
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
