import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import 'workspace_bar_control.dart';

/// The primary workspace action, also rendered by the native macOS title bar.
class WorkspaceShareButton extends StatelessWidget {
  const WorkspaceShareButton({
    super.key,
    required this.label,
    required this.tooltip,
    this.onPressed,
  });

  final String label;
  final String tooltip;
  final VoidCallback? onPressed;

  static const text = 'Share';

  static double widthOf(BuildContext context) =>
      workspaceBarTextSizeOf(context, text).width +
      workspaceBarCellSizeOf(context).width * 2;

  static Color backgroundFor(bool enabled) =>
      enabled ? grid.AppPalette.accent : grid.AppSurface.recess;

  static Color foregroundFor(bool enabled) =>
      enabled ? Colors.white : grid.AppPalette.textFaint;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final enabled = onPressed != null;
    return WorkspaceBarControl(
      label: label,
      tooltip: tooltip,
      onPressed: onPressed,
      builder: (context, emphasized) => ColoredBox(
        color: backgroundFor(enabled),
        child: SizedBox(
          width: widthOf(context),
          height: workspaceBarControlHeight(context),
          child: Center(
            child: Text(
              text,
              style: workspaceBarTextStyle(
                color: foregroundFor(enabled),
                emphasized: emphasized,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
