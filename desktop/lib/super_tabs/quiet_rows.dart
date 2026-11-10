import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'section_heading.dart';
import 'swarm_type.dart';

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

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final strong = unread || selected;
    // The same type as a project's row beside it (Swarm v4: one size in the left pane).
    final nameStyle = SwarmType.sidebar(
      compact: false,
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
              (detail == null ? 0 : gap),
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

/// A heading of the Desktop's left pane (task #4466): 12 and secondary, its text level with the faces' left edge. A
/// group that folds ([collapsed] given) shows its chevron only while hovered or focused, as every dropdown does;
/// [SuperTabQuietHeading.org] is the org name, semibold 13 primary, whose chevron opens the Swarm menu.
class SuperTabQuietHeading extends StatefulWidget {
  const SuperTabQuietHeading(
    this.title, {
    super.key,
    required this.onTap,
    this.collapsed,
    this.onAdd,
    this.addTooltip,
    this.addKey,
    this.onAttach,
    this.attachTooltip,
    this.attachKey,
  }) : _org = false;

  const SuperTabQuietHeading.org(this.title, {super.key, required this.onTap})
    : collapsed = false,
      onAdd = null,
      addTooltip = null,
      addKey = null,
      onAttach = null,
      attachTooltip = null,
      attachKey = null,
      _org = true;

  final String title;
  final VoidCallback? onTap;

  /// Whether a group that folds is folded; null for a heading that only opens a page, which has no chevron.
  final bool? collapsed;

  /// The + at the heading's right (task #4645), as on every section heading ([SuperTabSectionHeading.onAdd]).
  final VoidCallback? onAdd;
  final String? addTooltip;
  final Key? addKey;

  /// Attach, before the + (Swarm v4, anh Dee 2026-11-09): what is already running joins, as ⌘P opens it where ⌘N makes it.
  final VoidCallback? onAttach;
  final String? attachTooltip;
  final Key? attachKey;
  final bool _org;

  @override
  State<SuperTabQuietHeading> createState() => _SuperTabQuietHeadingState();
}

class _SuperTabQuietHeadingState extends State<SuperTabQuietHeading> {
  // The org name's chevron shows only while it is hovered or focused; a section that folds always shows its own.
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
    final onAdd = widget.onAdd;
    final heading = MouseRegion(
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
                if (collapsed != null && (!org || _hovered || _focused)) ...[
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
    final onAttach = widget.onAttach;
    if (onAdd == null && onAttach == null) return heading;
    // The + ends where the rows' details end, so the heading's right edge is theirs.
    return Row(
      children: [
        Expanded(child: heading),
        if (onAttach != null)
          AppIconButton(
            key: widget.attachKey,
            icon: AppIcons.link2,
            tooltip: widget.attachTooltip ?? widget.title,
            onPressed: onAttach,
          ),
        if (onAdd != null)
          AppIconButton(
            key: widget.addKey,
            icon: AppIcons.plus,
            tooltip: widget.addTooltip ?? widget.title,
            onPressed: onAdd,
          ),
      ],
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
