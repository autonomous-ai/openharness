import 'dart:async';

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/theme/workspace_bar_style.dart';
import '../../state/app_state.dart';
import '../../state/harness_activity.dart';
import '../../state/workspace_chrome.dart';
import '../../state/workspace_status.dart';
import '../../terminal/terminal_theme.dart';
import '../../terminal/terminal_theme_store.dart';
import '../../widgets/pane_menu.dart';
import '../../widgets/pane_grid.dart' show soloPaneId;
import '../shell/web_dropdown_control.dart';
import 'web_tab_menu.dart';
import '../../widgets/workspace_bar_control.dart';

/// The tab list on a phone: the current tab as one control; its harnesses and
/// every tab one tap away in a menu. A row of tabs leaves room for one, and a
/// swipe along it reorders tabs instead of scrolling them.
class WebTabSwitcher extends StatelessWidget {
  const WebTabSwitcher({super.key, required this.app, required this.commands});

  final AppNotifier app;
  final WorkspaceCommands commands;

  @override
  Widget build(BuildContext context) {
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final enabled = commands.enabled();
    final index = app.swarms.indexWhere((tab) => tab.id == app.activeSwarmId);
    final name = workspaceTabNames(app)[app.activeSwarmId] ?? '';
    final activity = tabActivity(app, app.activeSwarm);
    final panes = app.panes;
    final shown = panes.indexWhere((pane) => pane.id == soloPaneId(app));
    final label = [
      '${index + 1}:$name',
      // Which of the tab's harnesses is on screen: a phone draws one.
      if (panes.length > 1) '· ${shown + 1}/${panes.length}',
      if (activity?.mark.isNotEmpty == true) activity!.mark,
    ].join(' ');
    return Row(
      children: [
        Flexible(child: _switcher(context, label, enabled, theme)),
        _newTabButton(context, enabled, theme),
      ],
    );
  }

  Widget _switcher(
    BuildContext context,
    String label,
    bool enabled,
    TerminalTheme theme,
  ) => WebDropdownControl(
    key: const ValueKey('web-tab-switcher'),
    label: label,
    tooltip: 'Tabs',
    color: theme.foreground,
    onPressed: enabled ? () => _open(context) : null,
  );

  /// Desktop's `+` beside the tabs: a new tab, which opens on "Start an agent".
  Widget _newTabButton(
    BuildContext context,
    bool enabled,
    TerminalTheme theme,
  ) => WorkspaceBarControl(
    key: const ValueKey('web-new-tab-button'),
    label: 'New Tab',
    tooltip: 'New Tab',
    foreground: theme.foreground,
    onPressed: enabled && commands.canRun('swarm.new')
        ? () => commands.run('swarm.new')
        : null,
    builder: (context, emphasized) => SizedBox(
      width: workspaceBarCellSizeOf(context).width * 3,
      height: workspaceBarControlHeight(context),
      child: Center(
        child: Text('+', style: workspaceBarTextStyle(emphasized: emphasized)),
      ),
    ),
  );

  Future<void> _open(BuildContext context) async {
    final position = webMenuAnchor(context);
    if (position == null) return;
    final choice = await showPaneMenu<WebTabChoice>(
      context: context,
      // Opened by a click: no row is lit until the pointer picks one.
      focusFirst: false,
      position: position,
      minWidth: 260,
      maxWidth: 360,
      children: (close) => webTabMenuRows(app, commands, close),
    );
    // Acted on after the menu closed and handed focus back.
    switch (choice) {
      case WebFocusPane(:final paneId):
        app.focusPane(paneId, reveal: true);
      case WebClosePane(:final paneId):
        unawaited(app.requestClosePane(paneId));
      case WebSelectTab(:final id):
        app.selectSwarm(id);
      case WebCloseTab(:final id):
        unawaited(app.requestCloseSwarm(id));
      case WebRunCommand(:final command):
        commands.run(command);
      case null:
        break;
    }
  }
}
