import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'backlog.dart';

/// A small rounded label: a count, a project, a badge or a pull request.
class SuperTabChip extends StatelessWidget {
  const SuperTabChip({
    super.key,
    required this.text,
    this.color,
    this.fill,
    this.outlined = false,
    this.leading,
    this.trailing,
    this.bold = false,
  });
  final String text;
  final Color? color, fill;
  final bool outlined, bold;
  final Widget? leading, trailing;

  @override
  Widget build(BuildContext context) {
    final ink = color ?? DesktopChrome.muted;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.menuInset,
        vertical: grid.AppDesktop.listRowGap,
      ),
      decoration: BoxDecoration(
        color: fill ?? (outlined ? null : grid.AppSurface.wellFill),
        border: outlined ? Border.all(color: grid.AppPalette.divider) : null,
        borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (leading case final leading?) ...[
            leading,
            const SizedBox(width: grid.AppDesktop.badgeInset),
          ],
          Text(
            text,
            style: DesktopChrome.metadata(color: ink).copyWith(
              fontWeight: bold ? FontWeight.w600 : null,
              letterSpacing: bold ? .6 : null,
            ),
          ),
          if (trailing case final trailing?) ...[
            const SizedBox(width: grid.AppDesktop.listRowGap),
            trailing,
          ],
        ],
      ),
    );
  }
}

/// A tinted chip: [color] ink on a wash of it.
SuperTabChip superTabTintedChip(
  String text,
  Color color, {
  Key? key,
  Widget? leading,
  Widget? trailing,
  bool bold = false,
}) => SuperTabChip(
  key: key,
  text: text,
  color: color,
  fill: color.withValues(alpha: .14),
  leading: leading,
  trailing: trailing,
  bold: bold,
);

/// [priority]'s ink (task #3117): P0 critical, P1 a warning, P2 and P3 quiet.
Color superTabPriorityColor(SuperTabTaskPriority priority) =>
    switch (priority) {
      SuperTabTaskPriority.p0 => grid.AppPalette.usageCritical,
      SuperTabTaskPriority.p1 => grid.AppPalette.warn,
      SuperTabTaskPriority.p2 || SuperTabTaskPriority.p3 => DesktopChrome.muted,
    };

/// A task's priority as a tinted badge, "P0", leading a card's caption, a
/// Backlog row's title and the task header's title. With [menu] it carries a
/// ▾, for the header's button that opens the priority menu.
class SuperTabPriorityBadge extends StatelessWidget {
  const SuperTabPriorityBadge(this.priority, {super.key, this.menu = false});

  final SuperTabTaskPriority priority;
  final bool menu;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final color = superTabPriorityColor(priority);
    return Semantics(
      label: 'Priority ${priority.badge}, ${priority.meaning}',
      excludeSemantics: true,
      child: superTabTintedChip(
        priority.badge,
        color,
        bold: true,
        trailing: menu
            ? Icon(
                AppIcons.chevronDown,
                size: AppIcons.inlineSize,
                color: color,
              )
            : null,
      ),
    );
  }
}
