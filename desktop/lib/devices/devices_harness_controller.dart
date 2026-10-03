import 'package:flutter/foundation.dart';

import '../core/models.dart';
import '../core/project_folder.dart';
import '../state/app_state.dart';

const devicesHarnessId = 'autonomous/devices';

/// One Devices conversation, opened through the normal DSH creation/receipt path.
class DevicesHarnessController extends ChangeNotifier {
  DevicesHarnessController(this.app);
  final AppNotifier app;
  Future<void>? _opening;
  MachineState? _owner;
  String? _account;
  AgentCreationAttempt? _creation;
  ProjectFolderRequest? _folder;
  bool _disposed = false;
  String? error;
  bool get opening => _opening != null;

  Future<void> open() {
    if (_opening != null) return _opening!;
    error = null;
    _opening = _open().whenComplete(() {
      _opening = null;
      if (!_disposed) notifyListeners();
    });
    notifyListeners();
    return _opening!;
  }

  bool _current(MachineState owner) =>
      !_disposed &&
      app.devicesEnabled &&
      app.currentUser?.id == _account &&
      identical(app.stateOf(owner.machine.machineId), owner) &&
      app.swarms.any((tab) => tab.isDevices);

  Future<void> _open() async {
    if (!app.devicesEnabled) return;
    final owner = app.machineStates.values
        .where((machine) => machine.isLocalMachine && !machine.machine.isShared)
        .firstOrNull;
    if (owner == null || owner.isOffline) {
      error =
          'Connect Harness on this computer to open the Devices conversation.';
      return;
    }
    if (!identical(_owner, owner) || _account != app.currentUser?.id) {
      _owner = owner;
      _account = app.currentUser?.id;
      _creation = null;
      _folder = null;
    }
    final machineId = owner.machine.machineId;
    Agent? existing() => owner.agents
        .where((agent) => agent.dsh == devicesHarnessId)
        .firstOrNull;
    try {
      if (owner.agentsLoadInFlight case final loading?) {
        await loading;
      } else if (owner.agentLoadStatus != AgentLoadStatus.loaded) {
        await app.reloadMachineData(machineId);
      }
      if (!_current(owner)) return;
      if (owner.agentLoadStatus != AgentLoadStatus.loaded ||
          owner.agentsLoadError != null) {
        error = 'Couldn’t read existing conversations. Reconnect Harness and try again.';
        return;
      }
      var agent = existing();
      if (agent == null) {
        await app.probeEngines(machineId);
        if (!_current(owner)) return;
        final engine = [
          'codex',
          'claude',
          'opencode',
        ].where((id) => owner.engines[id]?.installed == true).firstOrNull;
        if (engine == null) {
          error = 'Install Codex, Claude Code, or OpenCode to open the Devices conversation.';
          return;
        }
        if (_creation != null &&
            !_creation!.awaitingConfirmation &&
            _creation!.agentId == null) {
          _creation = null;
        }
        _creation ??= AgentCreationAttempt(background: true);
        _folder ??= ProjectFolderRequest.generated(
          label: 'devices',
          at: DateTime.now(),
        );
        final failure = await app.createAgent(
          machineId,
          engine: engine,
          folder: null,
          projectFolder: _folder,
          dsh: devicesHarnessId,
          name: 'Devices',
          bypassPermission: false,
          permissionMode: 'ask',
          attempt: _creation,
        );
        if (!_current(owner)) return;
        if (failure != null) {
          // This package ships with the CLI and is deliberately absent from
          // dsh_list. The Store exposes it through the account's experiment.
          // A missing bundle requires a Harness update,
          // not a Store install or a raw INVALID_DSH message in the dashboard.
          error = switch (_creation!.refusal) {
            'INVALID_DSH' || 'UNSUPPORTED' || 'UNSUPPORTED_ON_REMOTE' => 'Update Harness on this computer to use Devices chat, then try again.',
            _ when _creation!.awaitingConfirmation => 'Still waiting for your chat to start. Check again to reconnect to the same conversation.',
            _ => 'Couldn’t start Devices chat. Try again in a moment.',
          };
          return;
        }
        agent = existing();
      }
      if (agent == null) {
        error = 'Devices is still starting. Try again in a moment.';
        return;
      }
      if (agent.isStopped) {
        final resumed = await app.resumeAgent(machineId, agent.id);
        if (!_current(owner)) return;
        if (resumed.error != null) {
          error = 'Couldn’t resume Devices chat. Try again in a moment.';
          return;
        }
      }
      if (!_current(owner)) return;
      await app.showDevicesTerminal(machineId, agent.id);
    } catch (_) {
      if (_current(owner)) error = 'Couldn’t open Devices. Update Harness on this computer and try again.';
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
