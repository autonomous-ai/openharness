import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../shared/theme/workspace_bar_style.dart';
import 'finger_target.dart';
import 'workspace_bar_control.dart';

/// A fixed-width bell; changes to its count never move the neighboring ribbon.
class WorkspaceNotificationsButton extends StatelessWidget {
  const WorkspaceNotificationsButton({
    super.key,
    required this.count,
    required this.foreground,
    required this.onPressed,
  });

  final int count;
  final Color foreground;
  final VoidCallback? onPressed;

  /// The desktop slot matches the account avatar's, so the two ends of the
  /// title row read as one pair. A phone keeps its finger-sized cell.
  static double widthOf(BuildContext context) => workspaceIsCompact(context)
      ? workspaceBarCellSizeOf(context).width * 4
      : 32;

  @override
  Widget build(BuildContext context) => WorkspaceBarControl(
    label: count == 0 ? 'Notifications' : 'Notifications, $count unread',
    tooltip: count == 0 ? 'Notifications' : 'Notifications · $count unread',
    onPressed: onPressed,
    builder: (context, emphasized) => SizedBox(
      width: widthOf(context),
      height: workspaceBarControlHeight(context),
      child: Center(
        child: Badge(
          alignment: Alignment.topRight,
          isLabelVisible: count > 0,
          backgroundColor: const Color(0xffcf4038),
          textColor: Colors.white,
          smallSize: 5,
          largeSize: 12,
          label: Text(
            count > 99 ? '99+' : '$count',
            style: const TextStyle(fontSize: 8, fontWeight: FontWeight.w600),
          ),
          child: Icon(
            AppIcons.bell,
            size: workspaceIsCompact(context) ? kPhoneBarIcon : 16,
            color: foreground.withValues(
              alpha: onPressed == null
                  ? .28
                  : emphasized
                  ? 1
                  : .75,
            ),
          ),
        ),
      ),
    ),
  );
}
