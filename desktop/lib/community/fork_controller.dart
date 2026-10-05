import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../core/models.dart';
import '../core/local_key_value_store.dart';
import '../state/app_state.dart';
import '../state/harness_placement.dart';
import 'fork_link.dart';
import 'fork_project.dart';

class ForkController extends ChangeNotifier {
  ForkController(
    this.app,
    this.importer,
    this.store, {
    this.viewerTimeout = const Duration(seconds: 90),
  });
  final AppNotifier app;
  final ForkProjectImporter importer;
  final LocalKeyValueStore store;
  final Duration viewerTimeout;
  String? message, error;
  bool busy = false, _disposed = false;
  Future<bool>? _opening;
  AgentCreationAttempt? _attempt;
  String? _key;
  VoidCallback? _cancelViewerWait;
  bool _current(MachineState owner) =>
      !_disposed &&
      app.status == AppStatus.authenticated &&
      identical(owner, app.localMachineState);
  Future<bool> open(ForkLink link) =>
      _opening ??= _open(link).whenComplete(() => _opening = null);
  void _status(String value) {
    message = value;
    if (!_disposed) notifyListeners();
  }

  Future<bool> _open(ForkLink link) async {
    final owner = app.localMachineState;
    if (owner == null || owner.connectionStatus != ConnectionStatus.connected) {
      error = 'Connect This computer to open your fork.';
      notifyListeners();
      return false;
    }
    busy = true;
    error = null;
    try {
      _status('Preparing your fork…');
      final project = await importer.prepare(link);
      if (!_current(owner)) return false;
      final existing = owner.agents
          .where((agent) => project.ownsFolder(agent.project?.cwd))
          .firstOrNull;

      // Reopening a running viewer needs no setup. Otherwise check the whole
      // installation, including viewer.use, before launching or resuming chat.
      if (existing?.viewerUrl == null || existing!.isStopped) {
        _status('Preparing ${project.title}…');
        await app.probeDsh(owner.machine.machineId, force: true);
        if (!_current(owner)) return false;
        if (owner.dsh[project.dsh]?.installed != true) {
          await importer.install(project);
          if (!_current(owner)) return false;
          await app.probeDsh(owner.machine.machineId, force: true);
        }
        if (!_current(owner)) return false;
        if (owner.dsh[project.dsh]?.installed != true) {
          throw const FormatException(
            'The harness is not ready yet. Retry to check the installation.',
          );
        }
        final viewerId = owner.dsh[project.dsh]?.viewerUse;
        if (viewerId != null && owner.dsh[viewerId]?.installed != true) {
          _status('Installing the viewer…');
          await importer.installViewer(viewerId);
          if (!_current(owner)) return false;
          await app.probeDsh(owner.machine.machineId, force: true);
        }
        if (!_current(owner)) return false;
        await importer.checkRuntime(project, viewerId: viewerId);
        if (!_current(owner)) return false;
        await importer.prepareRuntime(project);
        if (!_current(owner)) return false;
      }
      if (existing != null) {
        if (existing.isStopped) {
          final resumed = await app.resumeAgent(
            owner.machine.machineId,
            existing.id,
          );
          if (!_current(owner)) return false;
          if (resumed.error != null) {
            error = resumed.error;
            return false;
          }
        }
        final tab = app.swarms
            .where(
              (tab) => tab.panes.any(
                (pane) =>
                    pane.machineId == owner.machine.machineId &&
                    (pane.agentId == existing.id ||
                        pane.ownerAgentId == existing.id),
              ),
            )
            .firstOrNull;
        if (tab != null) {
          app.selectSwarm(tab.id);
        } else {
          app.newSwarm(name: project.title);
          await app.assignAgentToPane(
            null,
            owner.machine.machineId,
            existing.id,
          );
          if (!_current(owner)) return false;
        }
        return await _awaitViewer(owner, existing.id);
      }
      _status('Opening ${project.title}…');
      final receiptKey = 'community.launch.${link.requestId}';
      if (_key != link.key || _attempt == null) {
        final saved = await store.read(receiptKey);
        if (!_current(owner)) return false;
        _key = link.key;
        _attempt = AgentCreationAttempt(
          creationId: saved ?? link.requestId.replaceAll('-', ''),
        );
      }
      final result = await app.createAgent(
        owner.machine.machineId,
        engine: project.engine,
        folder: project.folder,
        dsh: project.dsh,
        name: project.title,
        bypassPermission: false,
        permissionMode: 'ask',
        attempt: _attempt,
        placement: HarnessPlacement.newTab,
      );
      if (!_current(owner)) return false;
      if (result != null) {
        error = result;
        // Keep an uncertain receipt. Only a confirmed refusal gets a fresh retry.
        if (!_attempt!.awaitingConfirmation) {
          final random = Random.secure();
          final next = List.generate(
            16,
            (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
          ).join();
          await store.write(receiptKey, next);
          _attempt = null;
        }
        return false;
      }
      final agentId = _attempt?.agentId;
      if (agentId == null) return false;
      return await _awaitViewer(owner, agentId);
    } catch (e) {
      if (!_disposed) {
        error = e is FormatException
            ? e.message
            : 'Could not open your fork. Check your connection and try again.';
      }
      return false;
    } finally {
      busy = false;
      if (!_disposed) notifyListeners();
    }
  }

  /// Creation confirms a conversation, not its asynchronously started viewer.
  /// Keep the same receipt on timeout; Retry can recover the existing workspace
  /// after installation/discovery without starting a second conversation.
  Future<bool> _awaitViewer(MachineState owner, String agentId) async {
    _status('Opening the viewer…');
    final ready = Completer<bool>();
    void finish(bool value) {
      if (!ready.isCompleted) ready.complete(value);
    }

    void check() {
      if (!_current(owner)) return finish(false);
      final agent = owner.agents.where((a) => a.id == agentId).firstOrNull;
      if (agent?.viewerError != null) {
        error = 'The viewer could not open. Retry to check its installation.';
        finish(false);
      } else if (agent?.viewerUrl != null) {
        finish(true);
      }
    }

    _cancelViewerWait = () => finish(false);
    app.addListener(check);
    final timer = Timer(viewerTimeout, () {
      error =
          'Your chat is open, but the viewer is not ready. '
          'Retry to check it without creating another fork.';
      finish(false);
    });
    try {
      check();
      if (!await ready.future || !_current(owner)) return false;
      if (!app.viewerPaneShown(owner.machine.machineId, agentId)) {
        await app.toggleViewerPane(owner.machine.machineId, agentId);
      }
      return _current(owner) &&
          app.viewerPaneShown(owner.machine.machineId, agentId);
    } finally {
      timer.cancel();
      app.removeListener(check);
      _cancelViewerWait = null;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _cancelViewerWait?.call();
    super.dispose();
  }
}
