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

/// One line of the Desktop's left pane (task #4466, anh Dee 11-07): a face or an icon in a fixed column, so every name
/// starts on one line, the name, and at most one quiet detail on the right. 13 names, 12 details; a read name is
/// secondary, an unread one semibold primary, the open row a neutral fill. No marks, badges or colour of its own.
class SuperTabQuietRow extends StatelessWidget {
  const SuperTabQuietRow({
    super.key,
    required this.leading,
    required this.name,
    required this.onTap,
    this.detail,
    this.selected = false,
    this.unread = false,
    this.tooltip,
  });

  static const double height = 30;
  static const double faceSize = 20;

  /// Where the face's left edge, and so the headings' text, starts.
  static double get faceInset =>
      _leadingStart + SuperTabSectionHeading.actionWidth / 2 - faceSize / 2;
  static double get _leadingStart => SuperTabSectionHeading.indentFor(0);

  /// The face (20) or the icon, centred in its column.
  final Widget leading;
  final String name;

  /// The one quiet word on the right: the project a Lead leads, "offline", a person's points, a count.
  final String? detail;
  final bool selected, unread;
  final String? tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final strong = unread || selected;
    final row = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: height),
      child: Row(
        children: [
          SizedBox(width: _leadingStart),
          SizedBox(
            width: SuperTabSectionHeading.actionWidth,
            child: Center(child: leading),
          ),
          Expanded(
            child: Text(
              name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.control(
                color: strong
                    ? grid.SidebarInk.foreground(context)
                    : grid.SidebarInk.muted(context),
              ).copyWith(fontWeight: unread ? grid.AppFont.semibold : null),
            ),
          ),
          if (detail case final detail?) ...[
            const SizedBox(width: grid.AppDesktop.controlGap),
            Text(
              detail,
              maxLines: 1,
              textAlign: TextAlign.right,
              style: DesktopChrome.metadata(
                color: grid.SidebarInk.faint(context),
              ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
            ),
          ],
          const SizedBox(width: grid.AppDesktop.controlGap),
        ],
      ),
    );
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
          label: [name, ?detail, if (unread) 'unread'].join(', '),
          excludeSemantics: true,
          child: InkWell(
            onTap: onTap,
            hoverColor: grid.SidebarInk.hoverFill(context),
            focusColor: grid.SidebarInk.hoverFill(context),
            borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
            child: tooltip == null
                ? row
                : Tooltip(message: tooltip!, child: row),
          ),
        ),
      ),
    );
  }
}

/// A heading of the Desktop's left pane (task #4466): 12 and secondary, its text level with the faces' left edge. A
/// group that folds ([collapsed] given) shows its chevron only while hovered or focused, as every dropdown does;
/// [SuperTabQuietHeading.org] is the org name, semibold 13 primary, whose chevron opens the Swarm menu.
class SuperTabQuietHeading extends StatefulWidget {
  const SuperTabQuietHeading(
    this.title, {
    super.key,
    required this.onTap,
    this.collapsed,
  }) : _org = false;

  const SuperTabQuietHeading.org(this.title, {super.key, required this.onTap})
    : collapsed = false,
      _org = true;

  final String title;
  final VoidCallback? onTap;

  /// Whether a group that folds is folded; null for a heading that only opens a page, which has no chevron.
  final bool? collapsed;
  final bool _org;

  @override
  State<SuperTabQuietHeading> createState() => _SuperTabQuietHeadingState();
}

class _SuperTabQuietHeadingState extends State<SuperTabQuietHeading> {
  bool _hovered = false, _focused = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final org = widget._org;
    final style = org
        ? DesktopChrome.control(color: grid.SidebarInk.foreground(context))
              .copyWith(fontWeight: grid.AppFont.semibold)
        : DesktopChrome.metadata(color: grid.SidebarInk.muted(context));
    final collapsed = widget.collapsed;
    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: Semantics(
        button: widget.onTap != null,
        expanded: org || collapsed == null ? null : !collapsed,
        child: InkWell(
          onTap: widget.onTap,
          onFocusChange: (focused) => setState(() => _focused = focused),
          hoverColor: Colors.transparent,
          focusColor: grid.SidebarInk.hoverFill(context),
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: SuperTabQuietRow.height,
            ),
            child: Row(
              children: [
                SizedBox(width: SuperTabQuietRow.faceInset),
                Flexible(
                  child: Text(
                    widget.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: style,
                  ),
                ),
                if (collapsed != null && (_hovered || _focused)) ...[
                  const SizedBox(width: grid.AppDesktop.listRowGap * 2),
                  Icon(
                    collapsed ? AppIcons.chevronRight : AppIcons.chevronDown,
                    size: AppIcons.closeSize,
                    color: grid.SidebarInk.muted(context),
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
                    // Unread is drawn as a bold name and heard in words. A row with no detail line has its status here,
                    // quiet, at its end (task #4220).
                    child: Semantics(
                      label: unread ? 'Unread messages' : null,
                      child: switch ((detail, status)) {
                        (null, final status?) => Center(child: status),
                        _ => null,
                      },
                    ),
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
