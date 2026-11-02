import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/theme/workspace_bar_style.dart';
import '../../state/app_state.dart';
import '../../state/workspace_chrome.dart';
import '../../terminal/terminal_theme.dart';
import '../../terminal/terminal_theme_store.dart';
import '../../theme/app_theme.dart' show AppColors;
import '../../widgets/finger_target.dart';
import '../../widgets/pane_menu.dart';
import '../../widgets/workspace_bar_control.dart';
import 'web_dropdown_control.dart';
import 'web_layout.dart';
import 'web_menu_items.dart';

/// The `+` beside the tabs, as a small menu: the browser has no native menu
/// bar, so new work, and what has no other door, is one click away here. Rows
/// run the same workspace commands keys do.
///
/// Its menu sits in the page's overlay, above the workspace, so it closes with
/// this button: sign-out or a lost session must not leave it over the next
/// screen, nor run a row tapped as it went.
class WebNewMenuButton extends StatefulWidget {
  const WebNewMenuButton({
    super.key,
    required this.app,
    required this.commands,
  });

  final AppNotifier app;
  final WorkspaceCommands commands;

  @override
  State<WebNewMenuButton> createState() => _WebNewMenuButtonState();
}

class _WebNewMenuButtonState extends State<WebNewMenuButton> {
  static const _more = 'web.more';

  void Function()? _closeOpen;

  @override
  void dispose() {
    _closeOpen?.call();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final enabled = widget.commands.enabled();
    return WorkspaceBarControl(
      key: const ValueKey('web-new-menu-button'),
      label: 'New',
      tooltip: 'New',
      foreground: theme.foreground,
      onPressed: enabled ? _toggle : null,
      builder: (context, emphasized) => SizedBox(
        width: workspaceBarCellSizeOf(context).width * 3,
        height: workspaceBarControlHeight(context),
        child: Center(
          child: Icon(
            AppIcons.plus,
            size: AppIcons.inlineSize,
            color: theme.foreground.withValues(
              alpha: !enabled
                  ? .28
                  : emphasized
                  ? 1
                  : .75,
            ),
          ),
        ),
      ),
    );
  }

  /// A press with its menu open closes it, as the avatar's does.
  Future<void> _toggle() async {
    if (_closeOpen case final close?) {
      close();
      return;
    }
    final compact = isWebCompact(context);
    // Resolved as it opens, so the rows match the workspace's state right now.
    final canRun = widget.commands.canRun;
    final more = runnableWebMore(canRun, panes: widget.app.panes.length);
    final chosen = await _show(
      compact: compact,
      children: (close) => [
        for (final (index, group) in runnableWebMenu(
          canRun,
          compact: compact,
        ).indexed) ...[
          if (index > 0) _rule(),
          for (final item in group)
            _row(item.command, item.label, item.icon, close, compact: compact),
        ],
        if (more.isNotEmpty) ...[
          _rule(),
          _row(
            _more,
            'More',
            const Icon(AppIcons.chevronRight),
            close,
            compact: compact,
          ),
        ],
      ],
    );
    if (!mounted || chosen == null) return;
    if (chosen != _more) {
      // Run after the menu closed and handed focus back, never inside it.
      widget.commands.run(chosen);
      return;
    }
    final further = await _show(
      compact: compact,
      children: (close) => [
        paneMenuHeader('More'),
        for (final item in more)
          _row(item.command, item.label, item.icon, close, compact: compact),
      ],
    );
    if (mounted && further != null) widget.commands.run(further);
  }

  Future<String?> _show({
    required bool compact,
    required List<Widget> Function(void Function(String?) close) children,
  }) async {
    final position = webMenuAnchor(context);
    if (position == null) return null;
    try {
      return await showPaneMenu<String>(
        context: context,
        // Opened by a click: no row is lit until the pointer picks one.
        focusFirst: false,
        position: position,
        minWidth: 240,
        maxWidth: 320,
        onOpen: (_, close) => _closeOpen = close,
        ownsPointer: _ownsPointer,
        children: children,
      );
    } finally {
      _closeOpen = null;
    }
  }

  /// The button toggles its own menu rather than having it close under it.
  bool _ownsPointer(Offset position) {
    final box = context.findRenderObject();
    return box is RenderBox &&
        box.hasSize &&
        (box.localToGlobal(Offset.zero) & box.size).contains(position);
  }

  Widget _rule() => Divider(
    height: 9,
    thickness: 1,
    indent: 14,
    endIndent: 14,
    color: AppColors.border,
  );

  // Uncoloured on purpose: the row's ink tints the icon, so it turns with the
  // label when the row lights up.
  Widget _row(
    String id,
    String label,
    Widget icon,
    void Function(String?) close, {
    required bool compact,
  }) => paneMenuItem(
    onTap: () => close(id),
    // On a phone the row is a finger's height; a mouse keeps it as it was.
    child: fingerTarget(
      enabled: compact,
      PaneMenuRow(
        key: ValueKey('web-menu:$id'),
        selected: false,
        title: label,
        leading: IconTheme.merge(
          data: const IconThemeData(size: AppIcons.inlineSize),
          child: icon,
        ),
      ),
    ),
  );
}
