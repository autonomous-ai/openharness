import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import '../devices/device_artwork.dart';
import '../store/store_mark.dart';
import 'workspace_bar_control.dart';

/// Harness Store, and Devices beside it: each its own mark, and nothing else.
///
/// Icons like the search before them, as in a browser's toolbar, so the one
/// thing in the row with a word on it is Sign in (owner, 2026-10-11;
/// `workspace_account_button.dart`). The name is the tooltip's and the screen
/// reader's. They were pills carrying their names until then.
class WorkspaceStoreButton extends StatelessWidget {
  const WorkspaceStoreButton({
    super.key,
    required this.width,
    required this.tooltip,
    this.onPressed,
    this.devices = false,
  });

  final double width;
  final String tooltip;
  final VoidCallback? onPressed;
  final bool devices;

  /// The slot each takes in the row: the search icon's.
  static double widthOf(BuildContext context, {bool devices = false}) =>
      workspaceBarCellSizeOf(context).width * 4;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final enabled = onPressed != null;
    return WorkspaceBarControl(
      label: devices ? 'Devices' : 'Harness Store',
      tooltip: tooltip,
      onPressed: onPressed,
      builder: (context, emphasized) => SizedBox(
        width: width,
        height: workspaceBarControlHeight(context),
        child: Center(
          // A mark has its own colors, so it steps forward by opacity, as the
          // search glyph beside it does.
          child: Opacity(
            opacity: !enabled || emphasized ? 1 : .82,
            child: devices
                ? DeviceMark(size: 20, enabled: enabled)
                : StoreMark(size: 18, enabled: enabled),
          ),
        ),
      ),
    );
  }
}
