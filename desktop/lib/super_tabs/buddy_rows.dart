import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'buddy_chat.dart';
import 'identity.dart';
import 'model.dart';
import 'section_heading.dart';
import 'swarm_type.dart';

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

/// A sidebar row's ground: its fill and, while a key's focus is in the row, a
/// 2 px ring over it, the fill left as it is. Focus once wore the hover fill
/// and read as a second selection (Desktop 1.3.89 audit, finding 21).
class SuperTabRowGround extends StatefulWidget {
  const SuperTabRowGround({
    super.key,
    required this.color,
    required this.child,
  });
  final Color color;
  final Widget child;

  @override
  State<SuperTabRowGround> createState() => _SuperTabRowGroundState();
}

class _SuperTabRowGroundState extends State<SuperTabRowGround> {
  var _focused = false;

  @override
  Widget build(BuildContext context) => Focus(
    canRequestFocus: false,
    skipTraversal: true,
    onFocusChange: (focused) {
      if (focused != _focused) setState(() => _focused = focused);
    },
    child: Material(
      color: widget.color,
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      clipBehavior: Clip.antiAlias,
      child: DecoratedBox(
        position: DecorationPosition.foreground,
        decoration: _focused
            ? BoxDecoration(
                borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                border: Border.all(color: DesktopChrome.focusRing, width: 2),
              )
            : const BoxDecoration(),
        child: widget.child,
      ),
    ),
  );
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
    this.crown = false,
    this.compact = false,
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

  /// A quiet word after the name, such as a Buddy's "offline" or the project
  /// a PM leads.
  final String? note;

  /// A PM: its crown on its avatar (anh Dee 11-07, task #4421).
  final bool crown;

  /// A line under the name, such as where a Buddy runs, with [status], its
  /// activity mark, before it. Without one the mark sits at the row's right.
  final String? detail;
  final Widget? status;

  /// A phone's sidebar, whose rows keep the app's sizes ([SwarmType.sidebar]).
  final bool compact;

  static const _column = SuperTabSectionHeading.actionWidth;

  @override
  Widget build(BuildContext context) {
    // Muted when read, full strength when unread or open (Dee, 10-31).
    final color = onTap != null && (selected || unread)
        ? grid.SidebarInk.foreground(context)
        : grid.SidebarInk.muted(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: grid.AppDesktop.listRowGap),
      child: SuperTabRowGround(
        color: selected
            ? grid.SidebarInk.selectedFill(context)
            : Colors.transparent,
        child: Semantics(
          button: true,
          selected: selected,
          child: InkWell(
            onTap: onTap,
            hoverColor: grid.SidebarInk.hoverFill(context),
            focusColor: Colors.transparent,
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
                          crown: crown,
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
                                            8 * [project, note].nonNulls.length,
                                      ),
                                    ),
                                    child: Text(
                                      name,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      // Unread is the name in bold, no dot (Dee, 2026-10-29). The pane's one
                                      // row size, as + New agent and the projects (#4444).
                                      style:
                                          SwarmType.sidebar(
                                            compact: compact,
                                            medium: selected,
                                            color: color,
                                          ).copyWith(
                                            fontWeight: unread
                                                ? grid.AppFont.semibold
                                                : null,
                                          ),
                                    ),
                                  ),
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
                  // Unread is drawn as a bold name and heard in words.
                  Semantics(label: unread ? 'Unread messages' : null),
                  // With no second line the activity mark is at the right, where two empty columns cut names
                  // early (audit finding 9 of #4436).
                  if (detail == null && status != null)
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: grid.AppDesktop.controlGap,
                      ),
                      child: status,
                    )
                  else
                    const SizedBox(width: 12),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
