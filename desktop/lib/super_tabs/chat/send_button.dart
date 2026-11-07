import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../widgets/desktop_chrome.dart';

/// A chat composer's send: a round 28-point button in the row's 32-point
/// target, grey while there is nothing to send and blue once there is, the
/// one blue in the composer (anh Dee, 11-07, #4467: blue only for the main
/// action). Its circle is keyed `swarm-send-fill`.
class SwarmSendButton extends StatelessWidget {
  const SwarmSendButton({
    super.key,
    required this.tooltip,
    required this.onPressed,
  });

  final String tooltip;

  /// Null while there is nothing to send, or it can't go now.
  final VoidCallback? onPressed;

  static const double size = 28;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final ready = onPressed != null;
    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        enabled: ready,
        child: SizedBox.square(
          dimension: grid.AppControl.height,
          child: Center(
            child: Material(
              type: MaterialType.transparency,
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: onPressed,
                mouseCursor: ready
                    ? SystemMouseCursors.click
                    : SystemMouseCursors.basic,
                child: DecoratedBox(
                  key: const ValueKey('swarm-send-fill'),
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: ready ? grid.AppPalette.accent : DesktopChrome.rim,
                  ),
                  child: SizedBox.square(
                    dimension: size,
                    child: Center(
                      child: Icon(
                        AppIcons.arrowUp,
                        size: AppIcons.inlineSize,
                        color: ready
                            ? DesktopChrome.onSelection
                            : DesktopChrome.hint,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
