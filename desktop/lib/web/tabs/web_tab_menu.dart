import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../../state/app_state.dart';
import '../../state/harness_activity.dart';
import '../../state/terminal_pane.dart';
import '../../state/workspace_chrome.dart';
import '../../state/workspace_status.dart';
import '../../widgets/pane_grid.dart' show soloPaneId;
import '../../widgets/finger_target.dart';
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

/// The active tab's rows about sharing it, in the desktop tab menu's order.
const _tabSharingRows = [
  ('shared_tab.invite', 'Invite People…'),
  ('agent_messages.show', 'Show Agent Messages'),
  ('shared_tab.stop', 'Stop Sharing Tab'),
  ('shared_tab.leave', 'Leave Tab'),
];

/// The menu's rows: this tab's harnesses (a phone draws one at a time), then
/// every tab, then this tab's sharing and Agent Messages, then rename.
/// Harnesses and tabs both close from their row. It opens from the phone's tab
/// switcher only, so its rows and closes are a finger's size.
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
        child: KeyedSubtree(
          key: ValueKey(key),
          child: fingerTarget(content, enabled: true),
        ),
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
          constraints: const BoxConstraints.tightFor(
            width: kFingerTarget,
            height: kFingerTarget,
          ),
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
    // This tab's sharing with other accounts (1c) and its Agent Messages, as
    // the desktop tab menu offers them: everything a native menu has is
    // clickable here. Move Here is never offered in a browser (no "here").
    for (final (command, title) in _tabSharingRows)
      if (commands.canRun(command))
        row(
          'web-tab-run:$command',
          WebRunCommand(command),
          PaneMenuRow(selected: false, title: title),
        ),
    // New tabs are the `+` beside the switcher, as on desktop.
    if (commands.canRun('swarm.rename'))
      row(
        'web-tab-run:swarm.rename',
        const WebRunCommand('swarm.rename'),
        const PaneMenuRow(selected: false, title: 'Rename Tab…'),
      ),
  ];
}
