import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/harness_activity.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/harness_activity_mark.dart';
import 'buddy_chat.dart';
import 'identity.dart';
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
    this.mark,
    this.markColumn = false,
  });

  static const double height = 30;
  static const double faceSize = 20;

  /// Where the face's left edge, and so the headings' text, starts.
  static double get faceInset =>
      _leadingStart + SuperTabSectionHeading.actionWidth / 2 - faceSize / 2;
  static double get _leadingStart => SuperTabSectionHeading.indentFor(0);

  /// The least of the row a name keeps when its detail is long.
  static const _nameShare = .6;

  static double _width(BuildContext context, String text, TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final width = painter.width;
    painter.dispose();
    return width;
  }

  /// The face (20) or the icon, centred in its column.
  final Widget leading;
  final String name;

  /// The one quiet word on the right: the project a Lead leads, "offline", a person's points, a count.
  final String? detail;
  final bool selected, unread;
  final String? tooltip;
  final VoidCallback? onTap;

  /// An agent's status mark, after the detail (anh Dee 11-07): only while it works, needs you or failed.
  final Widget? mark;

  /// Whether the row keeps the marks' column at its right edge, so a list's marks and details line up.
  final bool markColumn;

  /// The marks' column.
  static const double markWidth = AppIcons.controlSize;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final strong = unread || selected;
    final markColumn = this.markColumn || mark != null;
    final nameStyle = DesktopChrome.control(
      color: strong
          ? grid.SidebarInk.foreground(context)
          : grid.SidebarInk.muted(context),
    ).copyWith(fontWeight: unread ? grid.AppFont.semibold : null);
    final detailStyle = DesktopChrome.metadata(
      color: grid.SidebarInk.faint(context),
    ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]);
    final nameText = Text(
      name,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: nameStyle,
    );
    final row = LayoutBuilder(
      builder: (context, box) {
        const gap = grid.AppDesktop.controlGap;
        final detail = this.detail;
        // What the name and the detail share: the row less its face column and the gaps.
        final room = math.max(
          0.0,
          box.maxWidth -
              _leadingStart -
              SuperTabSectionHeading.actionWidth -
              gap -
              (detail == null ? 0 : gap) -
              (markColumn ? markWidth : 0),
        );
        return ConstrainedBox(
          constraints: const BoxConstraints(minHeight: height),
          child: Row(
            children: [
              SizedBox(width: _leadingStart),
              SizedBox(
                width: SuperTabSectionHeading.actionWidth,
                child: Center(child: leading),
              ),
              if (detail == null)
                Expanded(child: nameText)
              else ...[
                // The name first: a long detail is cut before it, but always keeps the rest of the row.
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: math.max(
                      room - _width(context, detail, detailStyle),
                      room * _nameShare,
                    ),
                  ),
                  child: nameText,
                ),
                const SizedBox(width: gap),
                Expanded(
                  child: Text(
                    detail,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.right,
                    style: detailStyle,
                  ),
                ),
              ],
              if (markColumn)
                SizedBox(
                  width: markWidth,
                  child: Center(child: mark),
                ),
              // Unread is a semibold name, and heard in words: the row says what its face, name and detail say.
              if (unread) Semantics(label: 'unread'),
              const SizedBox(width: gap),
            ],
          ),
        );
      },
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: grid.AppDesktop.listRowGap),
      // Focus is a ring, not a second fill (#4445, audit finding 21).
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
            child: tooltip == null
                ? row
                : Tooltip(message: tooltip!, child: row),
          ),
        ),
      ),
    );
  }
}

/// An agent's status mark in the Desktop's My agents (anh Dee 11-07): the shared activity mark, grey, but failed in the
/// error ink. Only working, needs you and failed are ever drawn (`superTabAgentMark`).
class SuperTabAgentMark extends StatelessWidget {
  const SuperTabAgentMark(this.activity, {super.key});
  final HarnessActivity activity;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ActivityMark(
      activity: activity,
      color: activity == HarnessActivity.failed
          ? Theme.of(context).colorScheme.error
          : grid.SidebarInk.muted(context),
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
    this.project,
    this.selected = false,
    this.unread = false,
    this.badge = 0,
    this.badgeTooltip,
    this.note,
    this.detail,
    this.status,
    this.compact = false,
  });

  /// The Buddy, for its avatar; null while none runs.
  final String? agentId;
  final String name;

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

  /// A line under the name, such as where a Buddy runs, with [status], its
  /// activity mark, before it; [status] shows only with it.
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
                      child: SuperTabAvatar(
                        identity: agentId == null
                            ? 'buddy:$name'
                            : 'agent:$agentId',
                        name: name,
                        size: 20,
                      ),
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
