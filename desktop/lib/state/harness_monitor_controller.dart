import '../core/models.dart';
import '../core/harness_defaults.dart';
import '../core/project_folder.dart';
import 'app_state.dart';

const harnessMonitorId = 'autonomous/harness-monitor';
const harnessMonitorName = 'Harness Monitor';

/// One explicit dock action, one reusable DSH. A lost create reply keeps its receipt for the next click.
class HarnessMonitorController {
  HarnessMonitorController(this.app);
  final AppNotifier app;
  Future<String?>? _opening;
  MachineState? _owner;
  AgentCreationAttempt? _creation;
  ProjectFolderRequest? _folder;
  bool _disposed = false;
  bool get opening => _opening != null;

  Future<String?> open() =>
      _opening ??= _open().whenComplete(() => _opening = null);
  bool _current(MachineState owner) =>
      !_disposed && identical(app.stateOf(owner.machine.machineId), owner);

  Future<String?> _open() async {
    if (_disposed) return null;
    // The footer has fleet scope. Reuse the tab even after focus moves to a
    // different machine, including an offline monitor that is still open.
    for (final tab in app.swarms) {
      for (final pane in tab.panes) {
        final machine = app.stateOf(pane.machineId);
        final agent = machine?.agents
            .where(
              (a) =>
                  a.dsh == harnessMonitorId &&
                  (a.id == pane.agentId || a.id == pane.ownerAgentId),
            )
            .firstOrNull;
        if (agent == null) continue;
        app.selectSwarm(tab.id);
        final owner = machine!;
        final machineId = owner.machine.machineId;
        try {
          if (agent.isStopped &&
              owner.connectionStatus == ConnectionStatus.connected) {
            final result = await app.resumeAgent(machineId, agent.id);
            if (!_current(owner)) return null;
            if (result.error != null) return result.error;
          }
          if (!app.viewerPaneShown(machineId, agent.id)) {
            await app.toggleViewerPane(machineId, agent.id);
            if (!_current(owner)) return null;
          }
          app.showHarnessMonitor(machineId, agent.id);
        } catch (_) {
          return _current(owner)
              ? 'Could not open Harness Monitor. Try again.'
              : null;
        }
        return null;
      }
    }
    final owner = app.ownedActionMachine;
    if (owner == null) return 'Connect a machine to open Harness Monitor.';
    if (!identical(_owner, owner)) {
      _owner = owner;
      _creation = null;
      _folder = null;
    }
    final machineId = owner.machine.machineId;
    Agent? monitor() =>
        owner.agents.where((a) => a.dsh == harnessMonitorId).firstOrNull;
    try {
      var agent = monitor();
      if (agent == null) {
        await app.probeDsh(machineId);
        if (!_current(owner)) return null;
        if (owner.dsh[harnessMonitorId]?.installed != true) {
          final error = await app.installDsh(machineId, harnessMonitorId);
          if (!_current(owner)) return null;
          if (error != null) return error;
        }
        agent = monitor();
        if (agent == null) {
          if (_creation != null &&
              !_creation!.awaitingConfirmation &&
              _creation!.agentId == null) {
            _creation = null;
          }
          _creation ??= AgentCreationAttempt(background: true);
          _folder ??= ProjectFolderRequest.generated(
            label: 'harness-monitor',
            at: DateTime.now(),
          );
          await app.agentPreference.load();
          if (!_current(owner)) return null;
          final error = await app.createAgent(
            machineId,
            engine:
                app.agentPreference.engineFor(harnessMonitorId) ??
                defaultHarnessEngine,
            folder: null,
            projectFolder: _folder,
            dsh: harnessMonitorId,
            name: harnessMonitorName,
            attempt: _creation,
          );
          if (!_current(owner)) return null;
          if (error != null) return error;
          agent = monitor();
        }
      }
      if (agent == null) {
        return 'Harness Monitor is still starting. Try again in a moment.';
      }
      if (agent.isStopped) {
        final result = await app.resumeAgent(machineId, agent.id);
        if (!_current(owner)) return null;
        if (result.error != null) return result.error;
      }
      final tab = app.swarms
          .where(
            (s) => s.panes.any(
              (p) => p.machineId == machineId && p.agentId == agent!.id,
            ),
          )
          .firstOrNull;
      if (tab != null) {
        app.selectSwarm(tab.id);
      } else {
        app.newSwarm(name: harnessMonitorName);
        if (app.activeSwarm.panes.isNotEmpty) {
          return 'Close a tab to make room for Harness Monitor.';
        }
        await app.assignAgentToPane(null, machineId, agent.id);
        if (!_current(owner)) return null;
      }
      if (!app.viewerPaneShown(machineId, agent.id)) {
        await app.toggleViewerPane(machineId, agent.id);
      }
      app.showHarnessMonitor(machineId, agent.id);
      return null;
    } catch (_) {
      return _current(owner)
          ? 'Could not open Harness Monitor. Try again.'
          : null;
    }
  }

  void dispose() {
    _disposed = true;
  }
}
