import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../../state/app_state.dart';
import '../../state/harness_activity.dart';
import '../../state/terminal_pane.dart';
import '../../state/workspace_chrome.dart';
import '../../state/workspace_status.dart';
import '../../widgets/pane_grid.dart' show soloPaneId;
import '../../widgets/pane_menu.dart';

/// What a row of the tab menu asks for, carried out once the menu is gone.
sealed class WebTabChoice {
  const WebTabChoice();
}

class WebFocusPane extends WebTabChoice {
  const WebFocusPane(this.paneId);
  final int paneId;
}

class WebClosePane extends WebTabChoice {
  const WebClosePane(this.paneId);
  final int paneId;
}

class WebSelectTab extends WebTabChoice {
  const WebSelectTab(this.id);
  final String id;
}

class WebCloseTab extends WebTabChoice {
  const WebCloseTab(this.id);
  final String id;
}

class WebRunCommand extends WebTabChoice {
  const WebRunCommand(this.command);
  final String command;
}

/// A pane's name in the menu: its harness, or the harness a viewer watches.
String webPaneTitle(AppNotifier app, TerminalPane pane) {
  final id = pane.isWeb ? pane.ownerAgentId : pane.agentId;
  final agent = app
      .stateOf(pane.machineId)
      ?.agents
      .where((agent) => agent.id == id)
      .firstOrNull;
  final name = agent?.displayName ?? 'Harness';
  return pane.isWeb ? '$name · viewer' : name;
}

/// What a row says about its harness or tab. Idle says nothing: it is the
/// resting state, and a column of it only hides the rows that are not.
String? _statusLabel(HarnessActivity? activity) =>
    activity == HarnessActivity.idle ? null : activity?.label;

/// The menu's rows: this tab's harnesses (a phone draws one at a time), then
/// every tab, then rename. Harnesses and tabs both close from their row.
List<Widget> webTabMenuRows(
  AppNotifier app,
  WorkspaceCommands commands,
  void Function(WebTabChoice?) close,
) {
  final names = workspaceTabNames(app);
  final shown = soloPaneId(app);
  Widget row(String key, WebTabChoice choice, PaneMenuRow content) =>
      paneMenuItem(
        onTap: () => close(choice),
        child: KeyedSubtree(key: ValueKey(key), child: content),
      );
  Widget closable({
    required String key,
    required WebTabChoice choice,
    required String closeTooltip,
    required WebTabChoice closeChoice,
    required PaneMenuRow content,
  }) => paneMenuItem(
    onTap: () => close(choice),
    child: Row(
      children: [
        Expanded(
          child: KeyedSubtree(key: ValueKey(key), child: content),
        ),
        IconButton(
          key: ValueKey('$key:close'),
          tooltip: closeTooltip,
          visualDensity: VisualDensity.compact,
          iconSize: 16,
          onPressed: () => close(closeChoice),
          icon: const Icon(AppIcons.close),
        ),
      ],
    ),
  );
  return [
    if (app.panes.length > 1) ...[
      paneMenuHeader('Harnesses in this tab'),
      for (final pane in app.panes)
        closable(
          key: 'web-pane:${pane.id}',
          choice: WebFocusPane(pane.id),
          closeTooltip: 'Close pane',
          closeChoice: WebClosePane(pane.id),
          content: PaneMenuRow(
            selected: pane.id == shown,
            title: webPaneTitle(app, pane),
            status: _statusLabel(
              harnessActivity(
                app,
                pane.machineId,
                (pane.isWeb ? pane.ownerAgentId : pane.agentId) ?? '',
              ),
            ),
          ),
        ),
    ],
    paneMenuHeader('Tabs'),
    for (final (index, tab) in app.swarms.indexed)
      closable(
        key: 'web-tab:${tab.id}',
        choice: WebSelectTab(tab.id),
        closeTooltip: 'Close tab',
        closeChoice: WebCloseTab(tab.id),
        content: PaneMenuRow(
          selected: tab.id == app.activeSwarmId,
          title: '${index + 1}:${names[tab.id] ?? tab.name}',
          status: _statusLabel(tabActivity(app, tab)),
        ),
      ),
    // New tabs are the `+` beside the switcher, as on desktop.
    if (commands.canRun('swarm.rename'))
      row(
        'web-tab-run:swarm.rename',
        const WebRunCommand('swarm.rename'),
        const PaneMenuRow(selected: false, title: 'Rename this tab'),
      ),
  ];
}
