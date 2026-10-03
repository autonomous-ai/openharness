import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'workspace_bar_control.dart';

/// Agent and model selectors share quiet text, fixed targets and focus behavior.
class PaneHeaderTextButton extends StatelessWidget {
  const PaneHeaderTextButton({
    super.key,
    required this.text,
    required this.label,
    this.fullText,
    this.tooltip,
    this.onPressed,
  });

  static const horizontalPadding = grid.AppDesktop.controlGap;

  final String text, label;
  final String? fullText, tooltip;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final foreground = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    ).foreground;
    final labelSize = workspaceBarTextSizeOf(context, text);
    final highContrast = MediaQuery.highContrastOf(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        final padding = math.min(horizontalPadding, constraints.maxWidth / 2);
        final textWidth = math.max(0.0, constraints.maxWidth - padding * 2);
        return WorkspaceBarControl(
          label: label,
          tooltip: [
            if (labelSize.width > textWidth ||
                (fullText != null && fullText != text))
              fullText ?? text,
            if (tooltip?.isNotEmpty == true) tooltip!,
          ].join('\n'),
          onPressed: onPressed,
          builder: (context, emphasized) => SizedBox(
            width: math.min(labelSize.width, textWidth) + padding * 2,
            height: workspaceBarControlHeight(context),
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: padding),
              child: Center(
                child: Text(
                  text,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: workspaceBarTextStyle(
                    color: foreground.withValues(
                      alpha: onPressed == null
                          ? (highContrast ? .45 : .28)
                          : emphasized
                          ? 1
                          : (highContrast ? .85 : .75),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
