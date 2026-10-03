import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/workspace_bar_style.dart';
import '../../widgets/workspace_bar_control.dart';

/// A bar control that reads as a dropdown: one line of text, then a chevron.
/// The phone's tab switcher and its footer are both one of these.
class WebDropdownControl extends StatelessWidget {
  const WebDropdownControl({
    super.key,
    required this.label,
    required this.tooltip,
    required this.color,
    this.onPressed,
  });

  final String label;
  final String tooltip;
  final Color color;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) => WorkspaceBarControl(
    label: '$tooltip: $label',
    tooltip: tooltip,
    onPressed: onPressed,
    builder: (context, emphasized) => SizedBox(
      height: workspaceBarControlHeight(context),
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: workspaceBarCellSizeOf(context).width,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: workspaceBarTextStyle(
                  color: color,
                  emphasized: emphasized,
                ),
              ),
            ),
            // An icon, not "▾": the terminal face may have no such glyph.
            Icon(
              AppIcons.chevronDown,
              size: 14,
              color: color.withValues(alpha: .75),
            ),
          ],
        ),
      ),
    ),
  );
}

/// Where a menu opened from the widget at [context] goes: under it, flush
/// with its right edge. Near the bottom of the window the menu is lifted to
/// fit. Null while that widget is not laid out.
RelativeRect? webMenuAnchor(BuildContext context) {
  final box = context.findRenderObject() as RenderBox?;
  final overlay = Overlay.of(context).context.findRenderObject() as RenderBox?;
  if (box == null || overlay == null) return null;
  final origin = box.localToGlobal(Offset.zero, ancestor: overlay);
  return RelativeRect.fromLTRB(
    origin.dx,
    origin.dy + box.size.height + 6,
    overlay.size.width - origin.dx - box.size.width,
    0,
  );
}
