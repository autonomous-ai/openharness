import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';

/// Keeps resource headings aligned whether their add action is available or not.
class SuperTabSectionHeading extends StatelessWidget {
  const SuperTabSectionHeading(
    this.title, {
    super.key,
    this.onAdd,
    this.addTooltip,
    this.trailing,
    this.actions = const [],
    this.endInset = 12,
    this.collapsed,
    this.onToggleCollapsed,
  });

  final String title;
  final VoidCallback? onAdd;
  final String? addTooltip;

  /// Beside the title, before the add action: a status the heading carries, such as the Machines pill.
  final Widget? trailing;

  /// Compact actions right before the add action, each an [AppIconButton]
  /// the size of the add action itself, such as Machines' Your devices.
  final List<Widget> actions;

  /// The space after the last action. The left sidebar passes 0, so that
  /// its + is centered on the column of its rows' trailing dots
  /// ([ProjectSidebar.markerInset]).
  final double endInset;

  /// Whether a collapsible group's body is currently hidden. Ignored unless
  /// [onToggleCollapsed] is set.
  final bool? collapsed;

  /// Set on a heading that collapses a sidebar group; draws a leading chevron
  /// that toggles it, aligned with the icon column project/machine rows share.
  final VoidCallback? onToggleCollapsed;

  /// The chevron and every action are a fixed 32 px square; the gap
  /// before the actions is 4 px; the title always keeps at least this
  /// much room, even when the trailing pill is at its widest.
  static const actionWidth = 32.0;

  /// One step of the sidebar's tree: a group's rows sit one step in from its heading, and the rows under one
  /// of those (a project's workgroups, the offline machines) two.
  static const indentStep = 16.0;

  /// Where a collapsible heading's chevron column starts.
  static const _leadingInset = 4.0;

  /// Where the icon column of a row at [level] starts, from the row's leading edge; its text starts right
  /// after that 32 px column, as the heading's does. Level 0 is the heading's own.
  static double indentFor(int level) => _leadingInset + level * indentStep;

  static const _trailingGap = 4.0;
  static const _minTitleWidth = 40.0;

  @override
  Widget build(BuildContext context) {
    final collapsible = onToggleCollapsed != null;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        collapsible ? _leadingInset : 16,
        0,
        endInset,
        4,
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 32),
        child: LayoutBuilder(
          builder: (context, constraints) {
            // A plain (non-flex) child, so it keeps its natural width right
            // before the add action instead of splitting the row's free
            // space with the title — capped only so a narrow drawer at a
            // large text scale ellipsizes it instead of overflowing.
            final pillMaxWidth = trailing == null
                ? 0.0
                : (constraints.maxWidth -
                          (collapsible ? actionWidth : 0) -
                          actions.length * actionWidth -
                          (onAdd != null ? actionWidth : 0) -
                          _trailingGap -
                          _minTitleWidth)
                      .clamp(0.0, double.infinity);
            return Row(
              children: [
                if (collapsible)
                  IconButton(
                    icon: Icon(
                      collapsed == true
                          ? AppIcons.chevronRight
                          : AppIcons.chevronDown,
                      size: AppIcons.inlineSize,
                    ),
                    color: DesktopChrome.muted,
                    // The row owns hover/press feedback. Keep the themed
                    // focus boundary for this independent disclosure action.
                    style: const ButtonStyle(
                      minimumSize: WidgetStatePropertyAll(Size.square(32)),
                      padding: WidgetStatePropertyAll(EdgeInsets.all(6)),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      visualDensity: VisualDensity.standard,
                      overlayColor: WidgetStatePropertyAll(Colors.transparent),
                      backgroundColor: WidgetStatePropertyAll(
                        Colors.transparent,
                      ),
                    ),
                    tooltip:
                        '${collapsed == true ? 'Expand' : 'Collapse'} $title',
                    onPressed: onToggleCollapsed,
                  ),
                Expanded(
                  child: Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.metadata().copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                if (trailing != null) ...[
                  ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: pillMaxWidth),
                    child: trailing!,
                  ),
                  const SizedBox(width: _trailingGap),
                ],
                ...actions,
                if (onAdd != null)
                  AppIconButton(
                    icon: AppIcons.plus,
                    tooltip: addTooltip ?? title,
                    onPressed: onAdd,
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}
