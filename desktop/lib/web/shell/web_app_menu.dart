import 'package:harness/shared/theme/app_icons.dart';

import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/theme/workspace_bar_style.dart';
import '../../state/app_state.dart';
import '../../state/workspace_chrome.dart';
import '../../terminal/terminal_theme.dart';
import '../../theme/app_theme.dart' show AppColors;
import '../../terminal/terminal_theme_store.dart';
import '../../widgets/pane_menu.dart';
import '../../widgets/workspace_bar_control.dart';
import 'web_layout.dart';
import 'web_menu_items.dart';

/// The browser has no native menu bar, so everything desktop keeps there is
/// one click away here. Rows run the same workspace commands keys do.
class WebAppMenuButton extends StatelessWidget {
  const WebAppMenuButton({
    super.key,
    required this.app,
    required this.commands,
  });

  final AppNotifier app;
  final WorkspaceCommands commands;

  static double widthOf(BuildContext context) =>
      workspaceBarCellSizeOf(context).width * 4;

  @override
  Widget build(BuildContext context) {
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final enabled = commands.enabled();
    return WorkspaceBarControl(
      key: const ValueKey('web-app-menu-button'),
      label: 'Menu',
      tooltip: 'Menu',
      onPressed: enabled ? () => _open(context) : null,
      builder: (context, emphasized) => SizedBox(
        width: widthOf(context),
        height: workspaceBarControlHeight(context),
        child: Icon(
          AppIcons.menu,
          size: 16,
          color: theme.foreground.withValues(
            alpha: !enabled
                ? .28
                : emphasized
                ? 1
                : .75,
          ),
        ),
      ),
    );
  }

  Future<void> _open(BuildContext context) async {
    final box = context.findRenderObject() as RenderBox?;
    final overlay =
        Overlay.of(context).context.findRenderObject() as RenderBox?;
    if (box == null || overlay == null) return;
    final origin = box.localToGlobal(Offset.zero, ancestor: overlay);
    // Resolved as it opens, so the rows match the workspace's state right now.
    final groups = runnableWebMenu(
      commands.canRun,
      compact: isWebCompact(context),
    );
    final chosen = await showPaneMenu<String>(
      context: context,
      // Opened by a click: no row is lit until the pointer picks one.
      focusFirst: false,
      position: RelativeRect.fromLTRB(
        origin.dx,
        origin.dy + box.size.height + 6,
        overlay.size.width - origin.dx - WebAppMenuButton.widthOf(context),
        0,
      ),
      minWidth: 240,
      maxWidth: 320,
      children: (close) => _rows(groups, close),
    );
    // Run after the menu closed and handed focus back, never inside it.
    if (chosen == _signOut) {
      unawaited(app.logout());
    } else if (chosen != null) {
      commands.run(chosen);
    }
  }

  static const _signOut = 'web.sign_out';

  List<Widget> _rows(
    List<List<WebMenuItem>> groups,
    void Function(String?) close,
  ) {
    // Uncoloured on purpose: the row's ink tints it, so it turns with the
    // label when the row lights up.
    Widget row(String id, String label, Widget icon) => paneMenuItem(
      onTap: () => close(id),
      child: PaneMenuRow(
        key: ValueKey('web-menu:$id'),
        selected: false,
        title: label,
        leading: IconTheme.merge(
          data: const IconThemeData(size: AppIcons.inlineSize),
          child: icon,
        ),
      ),
    );
    final rule = Divider(
      height: 9,
      thickness: 1,
      indent: 14,
      endIndent: 14,
      color: AppColors.border,
    );
    return [
      for (final group in groups) ...[
        for (final item in group) row(item.command, item.label, item.icon),
        rule,
      ],
      if (app.currentUser?.email case final email?) paneMenuEmpty(email),
      row(_signOut, 'Sign out', const Icon(AppIcons.logOut)),
    ];
  }
}
