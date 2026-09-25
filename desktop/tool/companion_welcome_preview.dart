/// The production welcome, with a quiet invitation beside the status-bar egg.
library;

import 'package:flutter/material.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/workspace_bar_style.dart';
import 'package:harness/state/workspace_companion.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/workspace_welcome.dart';

class CompanionWelcomePreview extends StatelessWidget {
  const CompanionWelcomePreview({
    super.key,
    required this.controller,
    required this.showInvitation,
    required this.onVisit,
    required this.onHatch,
    required this.onCommand,
  });

  final CompanionController controller;
  final bool showInvitation;
  final VoidCallback onVisit, onHatch;
  final ValueChanged<String> onCommand;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final cell = workspaceBarCellSizeOf(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final ready = controller.journey.complete;
    return Stack(
      key: const ValueKey('companion-welcome-preview'),
      fit: StackFit.expand,
      children: [
        WorkspaceWelcome(onCommand: onCommand),
        if (showInvitation && controller.identity == null)
          Positioned(
            top: cell.height / 2,
            right: cell.width,
            child: TextButton(
              key: const ValueKey('welcome-companion-invitation'),
              onPressed: ready ? onHatch : onVisit,
              style:
                  TextButton.styleFrom(
                    foregroundColor: theme.foreground.withValues(alpha: .55),
                    textStyle: workspaceBarTextStyle(),
                    padding: EdgeInsets.symmetric(horizontal: cell.width),
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    shape: const RoundedRectangleBorder(),
                    splashFactory: NoSplash.splashFactory,
                  ).copyWith(
                    overlayColor: WidgetStatePropertyAll(
                      theme.selection.withValues(alpha: .5),
                    ),
                  ),
              child: Text(
                ready
                    ? 'Your companion is ready. [ hatch ]'
                    : 'A companion is inside. [ peek ]',
                semanticsLabel: ready
                    ? 'Hatch your companion'
                    : 'Meet the optional terminal companion',
              ),
            ),
          ),
      ],
    );
  }
}
