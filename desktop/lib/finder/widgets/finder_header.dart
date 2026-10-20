import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_pane_icon.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/theme/workspace_bar_style.dart';
import '../../theme/app_theme.dart';
import '../../widgets/agent_drag.dart' show PaneHeaderButton;
import '../../widgets/engine_identity.dart';
import '../finder_controller.dart';

/// The Finder tile's header: its folder, the branch it is on with how far
/// it is from upstream, Refresh and Close.
class FinderHeader extends StatelessWidget {
  const FinderHeader({
    super.key,
    required this.controller,
    required this.compact,
    required this.onClose,
  });

  final FinderController controller;
  final bool compact;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final repository = controller.git.repository;
    final branch = [
      ?repository?.branch,
      if ((repository?.ahead ?? 0) > 0) '↑${repository!.ahead}',
      if ((repository?.behind ?? 0) > 0) '↓${repository!.behind}',
    ].join(' ');
    return MediaQuery.withNoTextScaling(
      child: SizedBox(
        height: compact ? 38 : 46,
        child: Padding(
          padding: const EdgeInsets.only(
            left: 14,
            right: grid.AppDesktop.paneCloseInset,
          ),
          child: Row(
            children: [
              const EngineMark(engine: kFinderEngine, size: 17),
              const SizedBox(width: 10),
              Expanded(
                child: Tooltip(
                  message: controller.root,
                  waitDuration: const Duration(milliseconds: 500),
                  child: Text.rich(
                    key: const ValueKey('finder-pane-title'),
                    TextSpan(
                      text: p.basename(controller.root),
                      style: workspaceBarTextStyle(color: AppColors.text),
                      children: [
                        if (branch.isNotEmpty)
                          TextSpan(
                            text: '   $branch',
                            style: grid.AppType.monoLabel(
                              color: AppColors.mutedStrong,
                            ),
                          ),
                      ],
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ),
              PaneHeaderButton(
                label: 'Refresh',
                icon: AppPaneSymbol.reload,
                onPressed: controller.refresh,
              ),
              PaneHeaderButton(
                label: 'Close Finder',
                command: 'pane.close',
                icon: AppPaneSymbol.close,
                iconSize: AppIcons.closeSize,
                onPressed: onClose,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
