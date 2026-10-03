import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/machine_resources.dart';
import '../core/models.dart';
import '../shared/theme/workspace_bar_style.dart'
    show workspaceBarGroupSeparator;
import 'app_state.dart';

/// The footer always describes this computer, independently of pane focus.
/// Sample only the local machine while the app is visible.
/// These optional reads never connect a machine or launch a harness.
class MachineResourceMonitor extends ChangeNotifier {
  MachineResourceMonitor(this.app);
  final AppNotifier app;
  final _samples = <String, (MachineState, MachineResources, DateTime)>{};
  Timer? _timer;
  String? _lastScope;
  bool _started = false, _disposed = false, _busy = false, _again = false;
  int _revision = 0;

  MachineState? get localMachine => app.machineStates.values
      .where((state) => state.isLocalMachine && !state.machine.isShared)
      .firstOrNull;

  String get _scopeIdentity {
    final state = localMachine;
    return '${state?.machine.machineId}/${state != null && available(state)}';
  }

  bool available(MachineState state) =>
      !state.machine.isShared &&
      !state.needsLink &&
      state.nodeOnline != false &&
      state.connectionStatus == ConnectionStatus.connected;

  MachineResources? reading(MachineState? state) {
    if (state == null || !available(state)) return null;
    final sample = _samples[state.machine.machineId];
    return identical(sample?.$1, state) &&
            DateTime.now().difference(sample!.$3) <= const Duration(seconds: 45)
        ? sample.$2
        : null;
  }

  String get scopeName => localMachine?.machine.displayName ?? 'This computer';
  String metricsLabel({bool ram = true, bool gpu = true}) {
    final value = reading(localMachine);
    return 'CPU ${resourcePercent(value?.cpuPercent)}'
        '${ram ? '${workspaceBarGroupSeparator}RAM ${resourcePercent(value?.memoryPercent)}' : ''}'
        '${gpu ? '${workspaceBarGroupSeparator}GPU ${resourcePercent(value?.busiestGpu?.utilizationPercent)}' : ''}';
  }

  String get label => metricsLabel();

  String get detail {
    final state = localMachine, value = reading(state);
    return '$scopeName  $label\n'
        'This computer’s CPU and RAM usage, including other apps.\n'
        '${value?.busiestGpu == null ? 'GPU reading unavailable.' : 'GPU shows the busiest device: ${value!.busiestGpu!.name}.'}\n'
        '${state != null && !available(state) ? 'Machine disconnected. ' : ''}'
        'Unavailable readings use a dash.';
  }

  void start() {
    if (_started || _disposed) return;
    _started = true;
    app.addListener(_inventoryChanged);
    app.foreground.addListener(_environmentChanged);
    _environmentChanged();
  }

  void _inventoryChanged() {
    final removed = _samples.keys.where((id) {
      final state = app.stateOf(id);
      return state == null ||
          !identical(state, _samples[id]!.$1) ||
          !available(state);
    }).toList();
    for (final id in removed) {
      _samples.remove(id);
    }
    if (removed.isNotEmpty) _revision++;
    final scope = _scopeIdentity;
    final changed = scope != _lastScope;
    _lastScope = scope;
    notifyListeners();
    if (_started && (changed || removed.isNotEmpty)) unawaited(refresh());
  }

  void _environmentChanged() {
    _revision++;
    _timer?.cancel();
    _samples.clear();
    _lastScope = _scopeIdentity;
    notifyListeners();
    if (app.foreground.value) unawaited(refresh());
  }

  Future<void> refresh() async {
    if (_disposed || !app.foreground.value) return;
    if (_busy) {
      _again = true;
      return;
    }
    _timer?.cancel();
    _busy = true;
    final revision = _revision;
    final scope = localMachine;
    final targets = [?scope].where(available);
    try {
      await Future.wait(
        targets.map((state) async {
          final id = state.machine.machineId;
          final value = await app.readMachineResources(id);
          if (_disposed ||
              revision != _revision ||
              !identical(app.stateOf(id), state) ||
              !available(state)) {
            return;
          }
          if (value == null) {
            _samples.remove(id);
          } else {
            _samples[id] = (state, value, DateTime.now());
          }
          notifyListeners();
        }),
      );
    } finally {
      _busy = false;
      if (!_disposed && _started && app.foreground.value) {
        if (_again) {
          _again = false;
          unawaited(refresh());
        } else {
          _timer = Timer(const Duration(seconds: 15), refresh);
        }
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _revision++;
    _timer?.cancel();
    if (_started) {
      app.removeListener(_inventoryChanged);
      app.foreground.removeListener(_environmentChanged);
    }
    _samples.clear();
    super.dispose();
  }
}
