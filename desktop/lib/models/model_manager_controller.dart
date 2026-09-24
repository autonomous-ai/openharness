import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';
import '../core/models.dart';
import '../core/project_folder.dart';
import '../core/test_run.dart';
import '../state/app_state.dart';
import '../widgets/grid_model_picker.dart' show modelPickerSupports;
import 'local_model.dart';
import 'api_connections_controller.dart';

const modelManagerName = 'Model Manager';

/// Shared by the toolbar, panel and picker. The daemon owns downloads and
/// engines; closing a surface never cancels work or creates a conversation.
class ModelManagerController extends ChangeNotifier {
  ModelManagerController(
    this.app, {
    LocalKeyValueStore? storage,
    this.poll = true,
  }) : _storage = storage ?? (kUnderTest ? null : HarnessFileStore.shared);
  final AppNotifier app;
  final LocalKeyValueStore? _storage;
  final bool poll;
  ApiConnectionsController? _apis;
  ApiConnectionsController get apis => _apis ??= ApiConnectionsController(app);
  static const introKey = 'models.introduction.dismissed';
  MachineState? _machine;
  Future<void>? _preparing, _opening, _refreshing;
  Timer? _timer;
  bool _started = false, _disposed = false, _preferencesLoaded = false;
  bool _introDismissed = false, _autoPrepared = false;
  AgentCreationAttempt? _creation;
  ProjectFolderRequest? _folder;
  DateTime? _lastModelsRead, _lastLocalRead;
  bool _panelVisible = false;
  int _actionRevision = 0;
  String? _dismissedReadyId;
  GridModels? models;
  List<LocalModel> localModels = const [];
  double? memoryBytes;
  String? hardware, error, _managerError;
  bool preparing = false, opening = false, scanning = false, loaded = false;
  bool inventoryAvailable = false, operationBusy = false;
  LocalModelOperation? pendingOperation;
  String? pendingId;
  bool pendingStart = true;

  MachineState? get machine => app.localMachineState;
  Agent? get manager => machine?.agents
      .where((a) => a.dsh == AppNotifier.gridHarness)
      .firstOrNull;
  List<GridSection> get sections => models?.sections ?? const [];
  bool get hasOwnModels => localModels.any((model) => model.running);
  bool get busy =>
      operationBusy || pendingId != null || pendingOperation?.active == true;
  bool get showIntroduction =>
      _preferencesLoaded &&
      !_introDismissed &&
      loaded &&
      localModels.isNotEmpty &&
      !hasOwnModels &&
      !busy &&
      app.machineStates.values.any(
        (m) => m.agents.any(
          (a) =>
              a.dsh != AppNotifier.gridHarness &&
              !a.isStopped &&
              modelPickerSupports(a.engine),
        ),
      );
  LocalModel? get readyModel => localModels
      .where(
        (m) =>
            m.running &&
            m.operation?.started == true &&
            m.operation?.id != _dismissedReadyId,
      )
      .firstOrNull;
  LocalModelOperation? operationFor(LocalModel model) =>
      pendingOperation?.modelId == model.id
      ? pendingOperation
      : model.operation;

  void dismissReady() {
    _dismissedReadyId = readyModel?.operation?.id;
    _changed();
  }

  void start() {
    if (_started || _disposed) return;
    _started = true;
    app.addListener(_observe);
    app.foreground.addListener(_foregroundChanged);
    app.gridPictures.addListener(_pictureChanged);
    unawaited(_loadPreferences());
    _observe();
    if (poll) {
      _timer = Timer.periodic(const Duration(seconds: 4), (_) {
        // A minimised or background app reads nothing, busy or not: the daemon owns the operation
        // either way, and the one refresh on return ([_foregroundChanged]) catches up.
        if (!app.inForeground) return;
        if (busy ||
            _panelVisible ||
            _lastLocalRead == null ||
            DateTime.now().difference(_lastLocalRead!) >
                const Duration(seconds: 60)) {
          unawaited(refresh());
        }
      });
    }
  }

  Future<void> _loadPreferences() async {
    try {
      _introDismissed = await _storage?.read(introKey) == 'true';
    } catch (_) {}
    _preferencesLoaded = true;
    _changed();
  }

  void _observe() {
    if (_disposed) return;
    final current = machine;
    if (!identical(current, _machine)) {
      _machine = current;
      _autoPrepared = false;
      _creation = null;
      _folder = null;
      _preparing = null;
      _opening = null;
      _refreshing = null;
      _lastModelsRead = null;
      _lastLocalRead = null;
      preparing = false;
      opening = false;
      scanning = false;
      loaded = false;
      inventoryAvailable = false;
      operationBusy = false;
      pendingOperation = null;
      pendingId = null;
      _dismissedReadyId = null;
      models = null;
      localModels = const [];
      memoryBytes = null;
      hardware = null;
      error = null;
      _managerError = null;
    }
    if (current?.connectionStatus != ConnectionStatus.connected) {
      inventoryAvailable = false;
    }
    if (current != null &&
        current.connectionStatus == ConnectionStatus.connected &&
        current.agentLoadStatus == AgentLoadStatus.loaded &&
        !_autoPrepared) {
      _autoPrepared = true;
      unawaited(prepare());
      // In the background the first read waits for the app to come back ([_foregroundChanged]).
      if (app.inForeground) unawaited(refresh());
    }
    _changed();
  }

  /// Back in front of the person: exactly one refresh, whatever the background skipped.
  void _foregroundChanged() {
    if (_disposed || !app.inForeground) return;
    final owner = machine;
    if (owner == null || owner.connectionStatus != ConnectionStatus.connected) {
      return;
    }
    unawaited(refresh());
  }

  /// Another surface's read, or the daemon's `grid_models_changed` push, changed the app's picture
  /// of this machine's grids: take it, with no read of our own.
  void _pictureChanged() {
    final owner = machine;
    if (_disposed || owner == null) return;
    final picture = app.gridPictures[owner.machine.machineId];
    if (picture == null || identical(picture, models)) return;
    models = picture;
    _changed();
  }

  bool _current(MachineState owner) => !_disposed && identical(machine, owner);
  void _changed() {
    if (!_disposed) notifyListeners();
  }

  Future<void> dismissIntroduction() async {
    _introDismissed = true;
    _changed();
    try {
      await _storage?.write(introKey, 'true');
    } catch (_) {}
  }

  Future<void> prepare() {
    final owner = machine;
    return _preparing ??= _prepare().whenComplete(() {
      if (identical(machine, owner)) _preparing = null;
    });
  }

  Future<void> _prepare() async {
    final owner = machine;
    if (owner == null || manager != null) return;
    preparing = true;
    _managerError = null;
    _changed();
    try {
      final id = owner.machine.machineId;
      await app.probeDsh(id);
      if (!_current(owner)) return;
      if (owner.dsh[AppNotifier.gridHarness]?.installed != true) {
        final failure = await app.installDsh(id, AppNotifier.gridHarness);
        if (!_current(owner)) return;
        if (failure != null) {
          _managerError = failure;
          return;
        }
      }
      if (manager != null) return;
      _creation ??= AgentCreationAttempt(background: true);
      _folder ??= ProjectFolderRequest.generated(
        label: 'model-manager',
        at: DateTime.now(),
      );
      final failure = await app.createAgent(
        id,
        engine: 'codex',
        folder: null,
        projectFolder: _folder,
        dsh: AppNotifier.gridHarness,
        name: modelManagerName,
        attempt: _creation,
      );
      if (_current(owner)) _managerError = failure;
    } catch (_) {
      if (_current(owner)) {
        _managerError = 'Model Manager could not open. Try again.';
      }
    } finally {
      if (_current(owner)) {
        preparing = false;
        _changed();
      }
    }
  }

  Future<void> open() {
    final owner = machine;
    return _opening ??= _open().whenComplete(() {
      if (identical(machine, owner)) _opening = null;
    });
  }

  Future<void> _open() async {
    final owner = machine;
    if (owner == null) {
      error = 'Connect this computer to open Model Manager.';
      _changed();
      return;
    }
    opening = true;
    error = null;
    _changed();
    try {
      if (_creation?.agentId == null &&
          _creation?.awaitingConfirmation == false &&
          !preparing) {
        _creation = null;
      }
      await prepare();
      if (!_current(owner)) return;
      final agent = manager;
      if (agent == null) {
        error =
            _managerError ??
            'Model Manager is still starting. Try again in a moment.';
        return;
      }
      if (agent.isStopped) {
        final result = await app.resumeAgent(owner.machine.machineId, agent.id);
        if (!_current(owner)) return;
        if (result.error != null) {
          error = result.error;
          return;
        }
      }
      await _showAgent(owner, agent.id, modelManagerName);
    } catch (_) {
      if (_current(owner)) error = 'Could not open Model Manager. Try again.';
    } finally {
      if (_current(owner)) {
        opening = false;
        _changed();
      }
    }
  }

  Future<void> _showAgent(
    MachineState owner,
    String agentId,
    String title,
  ) async {
    // paneOfAgent searches only the selected tab. Opening from another session
    // must reveal the existing manager, including one still attaching.
    final tab = app.swarms
        .where(
          (swarm) => swarm.panes.any(
            (pane) =>
                pane.machineId == owner.machine.machineId &&
                pane.agentId == agentId,
          ),
        )
        .firstOrNull;
    if (tab != null) {
      app.selectSwarm(tab.id);
      await app.selectAgent(owner.machine.machineId, agentId);
      return;
    }
    app.newSwarm(name: title);
    await app.assignAgentToPane(null, owner.machine.machineId, agentId);
  }

  void setPanelVisible(bool visible) {
    _panelVisible = visible;
  }

  Future<void> refresh({bool force = false}) {
    final owner = machine;
    return _refreshing ??= _refresh(force: force).whenComplete(() {
      if (identical(machine, owner)) _refreshing = null;
    });
  }

  Future<void> _refresh({required bool force}) async {
    final owner = machine;
    if (owner == null || owner.connectionStatus != ConnectionStatus.connected) {
      inventoryAvailable = false;
      error = 'Connect this computer to see its models.';
      _changed();
      return;
    }
    scanning = true;
    _changed();
    final readShared =
        force ||
        _lastModelsRead == null ||
        DateTime.now().difference(_lastModelsRead!) >
            const Duration(seconds: 20);
    await Future.wait([
      if (readShared)
        app.refreshGridModels(owner.machine.machineId).then((answer) {
          if (_current(owner)) {
            // The panel says so when ITS read could not reach the machine ("Shared models are
            // unavailable." with Try again) — that failure is kept out of the shared picture, so no
            // other surface blanks. Answered, it shows the picture: a push that landed meanwhile is newer.
            models = answer.reachable
                ? app.gridPictures[owner.machine.machineId] ?? answer
                : answer;
            _lastModelsRead = DateTime.now();
          }
        }),
      (() async {
        final revision = _actionRevision;
        try {
          final answer = await app.localModels(
            owner.machine.machineId,
            refresh: force,
          );
          if (!_current(owner) || revision != _actionRevision) return;
          // `notice` is a sentence BESIDE the list. A reply carrying `error` never reaches here:
          // the RPC layer fails it whole and keeps nothing, which is how a daemon that sent its
          // warning in `error` once emptied this list. `error` is still read for a daemon too old
          // to send models at all.
          error = (answer['notice'] ?? answer['error']) as String?;
          if (answer['models'] is! List) {
            inventoryAvailable = false;
            return;
          }
          localModels = (answer['models'] as List)
              .whereType<Map<String, dynamic>>()
              .map(LocalModel.fromJson)
              .where((m) => m.id.isNotEmpty)
              .toList();
          final memory = answer['memoryBytes'];
          memoryBytes = memory is num && memory.isFinite && memory > 0
              ? memory.toDouble()
              : null;
          hardware = answer['hardware'] as String?;
          operationBusy = answer['busy'] == true;
          inventoryAvailable = true;
          loaded = true;
          _lastLocalRead = DateTime.now();
          // A daemon receipt supersedes our acknowledgement, including a completed
          // operation after a dropped connection. Never replay an uncertain click.
          if (pendingOperation != null &&
              (!operationBusy ||
                  localModels.any(
                    (m) => m.operation?.id == pendingOperation?.id,
                  ))) {
            pendingOperation = null;
          }
        } catch (_) {
          if (_current(owner) && revision == _actionRevision) {
            inventoryAvailable = false;
            error = 'Models are unavailable. Try again.';
          }
        }
      })(),
    ]);
    if (_current(owner)) {
      scanning = false;
      _changed();
    }
  }

  Future<void> toggle(LocalModel model) async {
    final owner = machine;
    if (owner == null || busy || !inventoryAvailable) return;
    final startModel = !model.canStop;
    if (startModel && !model.canStart) return;
    pendingId = model.id;
    _actionRevision++;
    inventoryAvailable = false;
    pendingStart = startModel;
    error = null;
    unawaited(dismissIntroduction());
    _changed();
    try {
      final answer = await app.controlLocalModel(
        owner.machine.machineId,
        model.id,
        start: startModel,
      );
      if (!_current(owner)) return;
      error = answer['error'] as String?;
      pendingOperation = LocalModelOperation.parse(answer['operation']);
      operationBusy = pendingOperation?.active == true;
    } catch (_) {
      if (_current(owner)) error = 'Checking whether the model started. Your click will not be repeated.';
    } finally {
      if (_current(owner)) {
        pendingId = null;
        _changed();
        // Finish any inventory request issued before this click, then ask for
        // its receipt. A stale read must never overwrite a new acknowledgement.
        await _refreshing;
        if (_current(owner)) await refresh();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _apis?.dispose();
    _timer?.cancel();
    if (_started) {
      app.removeListener(_observe);
      app.foreground.removeListener(_foregroundChanged);
      app.gridPictures.removeListener(_pictureChanged);
    }
    super.dispose();
  }
}
