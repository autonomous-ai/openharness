import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/widgets/empty_state.dart';
import '../state/app_state.dart';
import '../state/terminal_pane.dart';
import '../widgets/link_machine_screen.dart';
import '../widgets/web_pane_panel.dart';
import '../core/models.dart';
import 'viewer_location.dart';

/// A browser companion to hn. This pane is never added to a swarm, never persisted, and never
/// opens a terminal stream. Closing the tab only closes its viewer surface.
class ViewerPage extends StatefulWidget {
  const ViewerPage({super.key, required this.app, required this.location});
  final AppNotifier app;
  final ViewerLocation location;
  @override
  State<ViewerPage> createState() => _ViewerPageState();
}

class _ViewerPageState extends State<ViewerPage> {
  TerminalPane? _pane;

  /// A state of the viewer in words: on the theme's page, in the app's empty-state style, with
  /// Retry where trying again can help.
  Widget _message(String text, {VoidCallback? retry}) => Material(
    color: Theme.of(context).scaffoldBackgroundColor,
    child: EmptyState(
      icon: AppIcons.monitor,
      title: text,
      action: retry == null
          ? null
          : OutlinedButton(
              // A thumb's target on a phone.
              style: const ButtonStyle(
                tapTargetSize: MaterialTapTargetSize.padded,
              ),
              onPressed: retry,
              child: const Text('Retry'),
            ),
    ),
  );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.app,
    builder: (context, _) {
      final app = widget.app, location = widget.location;
      final machine = app.stateOf(location.machineId);
      if (machine == null) {
        if (app.machineListError != null) {
          return _message(
            app.machineListError!,
            retry: () {
              app.retryMachines();
            },
          );
        }
        if (!app.machineInventoryLoaded || app.machinesLoading) {
          return _message('Finding this machine…');
        }
        return _message(
          'This machine is not available to this account.',
          retry: () {
            app.retryMachines();
          },
        );
      }
      if (machine.machine.isShared) {
        return _message('Sign in as the owner to open this viewer.');
      }
      if (machine.needsLink) {
        return Center(
          child: LinkMachineScreen(notifier: app, machineState: machine),
        );
      }
      if (machine.nodeOnline == false) {
        return _message(
          '${machine.machine.name} is offline.',
          retry: () {
            app.retryOfflineMachine(location.machineId);
          },
        );
      }
      if (machine.agentLoadStatus == AgentLoadStatus.error ||
          machine.connectionStatus == ConnectionStatus.disconnected) {
        return _message(
          'The machine is disconnected. Reconnect to open its viewer.',
          retry: () {
            app.reloadMachineData(location.machineId);
          },
        );
      }
      if (machine.connectionStatus != ConnectionStatus.connected ||
          machine.agentLoadStatus != AgentLoadStatus.loaded) {
        return _message('Connecting to ${machine.machine.name}…');
      }
      final agent = machine.agents
          .where((a) => a.id == location.agentId)
          .firstOrNull;
      if (agent == null) {
        return _message(
          'This harness is no longer available.',
          retry: () {
            app.reloadMachineData(location.machineId);
          },
        );
      }
      if (agent.viewerUrl == null) {
        return _message(
          agent.viewerError ??
              (agent.viewerName != null
                  ? '${agent.viewerName} is starting. You can keep working in hn.'
                  : 'This harness has no viewer.'),
          retry: () {
            app.reloadMachineData(location.machineId);
          },
        );
      }
      final pane =
          _pane?.machineId == location.machineId &&
              _pane?.ownerAgentId == location.agentId
          ? _pane!
          : (_pane = TerminalPane(
              id: -1,
              machineId: location.machineId,
              ownerAgentId: location.agentId,
              kind: PaneKind.web,
            ));
      pane.url = agent.viewerUrl;
      pane.viewerError = agent.viewerError;
      return WebPanePanel(
        key: ValueKey('${location.machineId}/${location.agentId}'),
        notifier: app,
        pane: pane,
        title: agent.viewerName ?? 'Viewer',
        ownerName: agent.name,
        ownerEngine: agent.identityEngine,
        ownerDisplayName: agent.identityDisplayName,
        verdict: agent.verdict,
      );
    },
  );
}
