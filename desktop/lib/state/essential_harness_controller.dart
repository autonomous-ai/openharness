import '../core/models.dart';
import '../core/harness_defaults.dart';
import '../core/project_folder.dart';
import 'app_state.dart';

/// A Store essential: one reusable harness, created with one click and no New Harness form. It
/// starts on the engine its package names (OpenCode with a free model that keeps nothing and trains
/// on nothing), and the person can switch agents from the pane header like any harness.
class EssentialHarness {
  const EssentialHarness({
    required this.id,
    required this.name,
    required this.folderLabel,
    this.firstTask,
  });

  final String id;
  final String name;

  /// The generated project folder's name, before its date.
  final String folderLabel;

  /// What the harness is asked when it is created, so it is useful at once. Null to wait for the
  /// person.
  final String? firstTask;
}

const harnessMonitorEssential = EssentialHarness(
  id: 'autonomous/harness-monitor',
  name: 'Harness Monitor',
  folderLabel: 'harness-monitor',
);

const memoriesEssential = EssentialHarness(
  id: 'autonomous/memories',
  name: 'Memories',
  folderLabel: 'memories',
  // The package's own skill builds it without questions (store/agents/memories/skills/about-you).
  firstTask: 'Build my About You.',
);

/// The Store's Essentials, in the order it lists them.
const storeEssentials = [memoriesEssential, harnessMonitorEssential];

EssentialHarness? essentialFor(String id) =>
    storeEssentials.where((e) => e.id == id).firstOrNull;

/// One action, one reusable harness: open the one that exists, wherever it is, or create it in a tab
/// of its own. A lost create reply keeps its receipt for the next click.
class EssentialHarnessController {
  EssentialHarnessController(this.app, this.essential);
  final AppNotifier app;
  final EssentialHarness essential;
  Future<String?>? _opening;
  MachineState? _owner;
  AgentCreationAttempt? _creation;
  ProjectFolderRequest? _folder;
  bool _disposed = false;
  bool get opening => _opening != null;

  /// Whether a click would open one rather than create one: one in a tab on any machine, or one on
  /// the machine a new one would be made on (stopped ones included), exactly as [open] looks.
  bool get exists =>
      _inTab() != null ||
      (app.ownedActionMachine?.agents.any((a) => a.dsh == essential.id) ??
          false);

  /// The first tab showing this harness, with its machine and agent.
  ({String tab, MachineState machine, Agent agent})? _inTab() {
    for (final tab in app.swarms) {
      for (final pane in tab.panes) {
        final machine = app.stateOf(pane.machineId);
        final agent = machine?.agents
            .where(
              (a) =>
                  a.dsh == essential.id &&
                  (a.id == pane.agentId || a.id == pane.ownerAgentId),
            )
            .firstOrNull;
        if (agent != null) {
          return (tab: tab.id, machine: machine!, agent: agent);
        }
      }
    }
    return null;
  }

  Future<String?> open() =>
      _opening ??= _open().whenComplete(() => _opening = null);
  bool _current(MachineState owner) =>
      !_disposed && identical(app.stateOf(owner.machine.machineId), owner);

  Future<String?> _open() async {
    if (_disposed) return null;
    final id = essential.id, name = essential.name;
    // Reuse the tab even after focus moves to a different machine, including an offline harness that
    // is still open.
    if (_inTab() case (:final tab, machine: final owner, :final agent)) {
      app.selectSwarm(tab);
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
        app.showHarnessViewer(machineId, agent.id);
      } catch (_) {
        return _current(owner) ? 'Could not open $name. Try again.' : null;
      }
      return null;
    }
    final owner = app.ownedActionMachine;
    if (owner == null) return 'Connect a machine to open $name.';
    if (!identical(_owner, owner)) {
      _owner = owner;
      _creation = null;
      _folder = null;
    }
    final machineId = owner.machine.machineId;
    Agent? existing() => owner.agents.where((a) => a.dsh == id).firstOrNull;
    try {
      var agent = existing();
      if (agent == null) {
        await app.probeDsh(machineId);
        if (!_current(owner)) return null;
        if (owner.dsh[id]?.installed != true) {
          final error = await app.installDsh(machineId, id);
          if (!_current(owner)) return null;
          if (error != null) return error;
        }
        agent = existing();
        if (agent == null) {
          if (_creation != null &&
              !_creation!.awaitingConfirmation &&
              _creation!.agentId == null) {
            _creation = null;
          }
          _creation ??= AgentCreationAttempt(background: true);
          _folder ??= ProjectFolderRequest.generated(
            label: essential.folderLabel,
            at: DateTime.now(),
          );
          await app.agentPreference.load();
          if (!_current(owner)) return null;
          // The machine's own catalog names the package's engine: a CLI older than the Essentials still
          // says Claude Code for Memories, and its OpenCode would run the training default instead of
          // the package's model.
          final listed = owner.dsh[id]?.engine ?? '';
          final engine =
              app.agentPreference.engineFor(id) ??
              (listed.isNotEmpty ? listed : defaultHarnessEngine);
          final error = await app.createAgent(
            machineId,
            engine: engine,
            folder: null,
            projectFolder: _folder,
            dsh: id,
            name: name,
            // Asked at once only on the free engine it was made for: on another engine the person's
            // own tokens pay for it, and some engines take no first message at all.
            prompt: engine == defaultHarnessEngine ? essential.firstTask : null,
            attempt: _creation,
          );
          if (!_current(owner)) return null;
          if (error != null) return error;
          agent = existing();
        }
      }
      if (agent == null) {
        return '$name is still starting. Try again in a moment.';
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
        app.newSwarm(name: name);
        if (app.activeSwarm.panes.isNotEmpty) {
          return 'Close a tab to make room for $name.';
        }
        await app.assignAgentToPane(null, machineId, agent.id);
        if (!_current(owner)) return null;
      }
      if (!app.viewerPaneShown(machineId, agent.id)) {
        await app.toggleViewerPane(machineId, agent.id);
      }
      app.showHarnessViewer(machineId, agent.id);
      return null;
    } catch (_) {
      return _current(owner) ? 'Could not open $name. Try again.' : null;
    }
  }

  void dispose() {
    _disposed = true;
  }
}
