import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'buddy_chat.dart';
import 'identity.dart';
import 'model.dart';
import 'section_heading.dart';

/// A sidebar count of what is for the reader, such as the tags waiting in
/// Notifications or in a conversation: Slack's red number, white on the
/// danger fill (5.4:1 or more in both themes, app_theme.dart dangerFill).
class SuperTabCountBadge extends StatelessWidget {
  const SuperTabCountBadge(this.count, {super.key, this.tooltip});
  final int count;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final badge = Container(
      constraints: const BoxConstraints(minWidth: 18),
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.badgeInset,
      ),
      decoration: ShapeDecoration(
        color: grid.AppPalette.dangerFill,
        shape: const StadiumBorder(),
      ),
      child: Text(
        countText(count),
        textAlign: TextAlign.center,
        style: DesktopChrome.metadata(color: grid.AppPalette.onDangerFill)
            .copyWith(fontWeight: grid.AppFont.semibold),
      ),
    );
    return tooltip == null ? badge : Tooltip(message: tooltip!, child: badge);
  }
}

/// A person's Buddy chat in a project, in the sidebar's Buddies: its Buddy's
/// avatar and name ("Buddy" while none runs), with the project in brackets
/// after it when the Swarm has several: "Wren (web-2)". New lines, the PM's
/// private ones among them, show as the name in bold, with no count (design
/// system: Unread).
class SuperTabBuddyRow extends StatelessWidget {
  const SuperTabBuddyRow({
    super.key,
    required this.agentId,
    required this.name,
    required this.tooltip,
    required this.onTap,
    this.agent,
    this.project,
    this.selected = false,
    this.unread = false,
    this.badge = 0,
    this.badgeTooltip,
    this.note,
    this.detail,
    this.status,
    this.crownKey,
  });

  /// The Buddy, for its avatar; null while none runs.
  final String? agentId;
  final String name;

  /// An agent in My agents: the row wears its face, picture or pattern, as
  /// its chat, cards and Tasks pane draw it (audit finding 6 of task #4211).
  final SuperTabAgent? agent;

  /// The project's name, shown when the Swarm has several.
  final String? project;
  final bool selected, unread;

  /// Tags of the reader in this chat: the red number.
  final int badge;
  final String? badgeTooltip;
  final VoidCallback? onTap;

  /// What hovering says: "Your Buddy · openharness".
  final String tooltip;

  /// A quiet word after the name, such as a Buddy's "offline".
  final String? note;

  /// Set on a PM: its crown, right after the name (Swarm v3, task #4118).
  final Key? crownKey;

  /// A line under the name, such as where a Buddy runs, with [status], its
  /// activity mark, before it.
  final String? detail;
  final Widget? status;

  static const _column = SuperTabSectionHeading.actionWidth;

  @override
  Widget build(BuildContext context) {
    // Muted when read, full strength when unread or open (Dee, 10-31).
    final color = onTap != null && (selected || unread)
        ? grid.SidebarInk.foreground(context)
        : grid.SidebarInk.muted(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: grid.AppDesktop.listRowGap),
      child: Material(
        color: selected
            ? grid.SidebarInk.selectedFill(context)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        clipBehavior: Clip.antiAlias,
        child: Semantics(
          button: true,
          selected: selected,
          child: InkWell(
            onTap: onTap,
            hoverColor: grid.SidebarInk.hoverFill(context),
            focusColor: grid.SidebarInk.hoverFill(context),
            borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
            child: Tooltip(
              message: tooltip,
              child: Row(
                children: [
                  SizedBox(width: SuperTabSectionHeading.indentFor(0)),
                  SizedBox(
                    width: _column,
                    child: Center(
                      child: switch (agent) {
                        final agent? => SuperTabAvatar.agent(
                          agent,
                          name: name,
                          size: 20,
                          engineBadge: false,
                        ),
                        null => SuperTabAvatar(
                          identity: agentId == null
                              ? 'buddy:$name'
                              : 'agent:$agentId',
                          name: name,
                          size: 20,
                        ),
                      },
                    ),
                  ),
                  Expanded(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 36),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          vertical: grid.AppDesktop.controlGap,
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            // The name keeps its whole width first; the
                            // project and note after it take what is left
                            // (at the left pane's 180 a Buddy read "Bu… no…").
                            LayoutBuilder(
                              builder: (context, box) => Row(
                                children: [
                                  ConstrainedBox(
                                    constraints: BoxConstraints(
                                      maxWidth: math.max(
                                        0,
                                        box.maxWidth -
                                            (crownKey == null
                                                ? 0
                                                : 4 + AppIcons.metadataSize) -
                                            8 * [project, note].nonNulls.length,
                                      ),
                                    ),
                                    child: Text(
                                      name,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      // Unread is the name in bold, no dot (Dee, 2026-10-29).
                                      style:
                                          DesktopChrome.control(
                                            medium: selected,
                                            color: color,
                                          ).copyWith(
                                            fontWeight: unread
                                                ? grid.AppFont.semibold
                                                : null,
                                          ),
                                    ),
                                  ),
                                  if (crownKey case final crownKey?) ...[
                                    const SizedBox(width: 4),
                                    Icon(
                                      AppIcons.crown,
                                      key: crownKey,
                                      size: AppIcons.metadataSize,
                                      color: color,
                                    ),
                                  ],
                                  if (project case final project?) ...[
                                    const SizedBox(width: 8),
                                    Flexible(
                                      child: Text(
                                        '($project)',
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: DesktopChrome.metadata(
                                          color: grid.SidebarInk.muted(context),
                                        ),
                                      ),
                                    ),
                                  ],
                                  // A quiet note yields first at large text sizes.
                                  if (note case final note?) ...[
                                    const SizedBox(width: 8),
                                    Flexible(
                                      child: Text(
                                        note,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: DesktopChrome.metadata(
                                          color: grid.SidebarInk.muted(context),
                                        ),
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                            if (detail case final detail?)
                              Row(
                                children: [
                                  if (status case final status?) ...[
                                    status,
                                    const SizedBox(width: 6),
                                  ],
                                  Flexible(
                                    child: Text(
                                      detail,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: DesktopChrome.metadata(
                                        color: grid.SidebarInk.muted(context),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  if (badge > 0)
                    Padding(
                      padding: const EdgeInsets.only(
                        left: grid.AppDesktop.controlGap,
                      ),
                      child: Semantics(
                        label: badge == 1 ? '1 mention' : '$badge mentions',
                        excludeSemantics: true,
                        child: SuperTabCountBadge(badge, tooltip: badgeTooltip),
                      ),
                    ),
                  SizedBox(
                    width: _column,
                    // Unread is drawn as a bold name and heard in words.
                    child: Semantics(label: unread ? 'Unread messages' : null),
                  ),
                  const SizedBox(width: _column),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
