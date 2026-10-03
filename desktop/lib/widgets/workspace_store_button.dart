import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../devices/device_artwork.dart';
import '../store/store_mark.dart';
import 'desktop_chrome.dart';
import 'workspace_bar_control.dart';

/// The Store's rounded, marked button, restored from the original tab bar.
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

  static Size _labelSize(BuildContext context, {bool devices = false}) {
    final painter = TextPainter(
      text: TextSpan(
        text: devices ? 'Devices' : 'Harness Store',
        style: DesktopChrome.control(),
      ),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final size = painter.size;
    painter.dispose();
    return size;
  }

  static double widthOf(BuildContext context, {bool devices = false}) =>
      _labelSize(context, devices: devices).width + 52;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final enabled = onPressed != null;
    final accent = grid.AppPalette.swarmAccent;
    return WorkspaceBarControl(
      label: devices ? 'Devices' : 'Harness Store',
      tooltip: tooltip,
      onPressed: onPressed,
      builder: (context, emphasized) => Container(
        width: width,
        height: math.max(
          grid.AppControl.heightSmall,
          _labelSize(context, devices: devices).height + 12,
        ),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: ShapeDecoration(
          color: Color.alphaBlend(
            accent.withValues(
              alpha: !enabled
                  ? .04
                  : emphasized
                  ? .18
                  : .10,
            ),
            grid.AppPalette.swarmWelcome,
          ),
          shape: StadiumBorder(
            side: BorderSide(
              color: accent.withValues(alpha: emphasized ? .85 : .12),
              width: emphasized ? 1.5 : 1,
            ),
          ),
        ),
        child: Row(
          children: [
            if (devices)
              DeviceMark(enabled: enabled)
            else
              StoreMark(enabled: enabled),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                devices ? 'Devices' : 'Harness Store',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.control(
                  color: accent.withValues(alpha: enabled ? 1 : .45),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
