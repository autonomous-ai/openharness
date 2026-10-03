import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/harness_resources.dart';
import '../core/models.dart';
import '../shared/theme/workspace_bar_style.dart'
    show workspaceBarGroupSeparator;
import 'app_state.dart';
import 'harness_sessions.dart';

/// Live inventory with optional demand-driven resource sampling.
/// The footer uses inventory only; resource readings belong in Harness Monitor.
/// It never starts an agent, opens a connection, or scans conversation files.
class HarnessMonitor extends ChangeNotifier {
  HarnessMonitor(
    this.app, {
    DateTime Function()? now,
    this.sampleResources = true,
  }) : _now = now ?? DateTime.now;
  final AppNotifier app;
  final bool sampleResources;
  final DateTime Function() _now;
  final _samples = <String, (MachineState, MachineHarnessResources)>{};
  Timer? _timer;
  bool _started = false, _disposed = false, _busy = false, _expanded = false;
  final _receivedAt = <String, DateTime>{};
  int _revision = 0;

  List<HarnessSession> get sessions => harnessSessions(app, includeLive: true);
  List<HarnessSession> get live => sessions
      .where((row) => row.live && !row.machine.machine.isShared)
      .toList();

  HarnessResources? reading(HarnessSession row) {
    final snapshot = _samples[row.machineId];
    return row.running &&
            identical(snapshot?.$1, row.machine) &&
            _fresh(row.machineId)
        ? snapshot?.$2.agents[row.agent.id]
        : null;
  }

  bool _fresh(String id) =>
      _receivedAt[id] != null &&
      _now().difference(_receivedAt[id]!) <= const Duration(seconds: 45);

  /// Shared-server RSS belongs to the server, not to each conversation.
  /// Count it once per machine/profile and label it separately in the panel.
  List<HarnessResources> get sharedReadings => _sharedReadings(live);

  List<HarnessResources> _sharedReadings(List<HarnessSession> rows) => [
    for (final entry in _samples.entries)
      if (identical(app.stateOf(entry.key), entry.value.$1) &&
          _fresh(entry.key))
        for (final shared in entry.value.$2.shared)
          if (rows.any(
            (row) =>
                row.machineId == entry.key && shared.$1.contains(row.agent.id),
          ))
            shared.$2,
  ];

  String? get sharedLabel => _sharedMemoryLabel(sharedReadings);

  String get label => 'Harnesses ${live.length}';

  /// Capture once per render/update, then reuse for every width and tooltip.
  /// This is not retained between updates: changes in scope, liveness or sample
  /// age are visible immediately without an invalidation cache or another timer.
  HarnessMonitorSummary get summary {
    final rows = live;
    return HarnessMonitorSummary._fromReadings([
      for (final row in rows) (row.machineId, reading(row)),
    ], _sharedReadings(rows));
  }

  String metricsLabel({
    bool ram = true,
    bool gpu = true,
    bool storage = true,
  }) => summary.metricsLabel(ram: ram, gpu: gpu, storage: storage);

  String get resourceDetail => summary.resourceDetail;
  String get detail =>
      '${live.length} open across connected machines. Click to open Harness Monitor.';

  void start() {
    if (_started || _disposed) return;
    _started = true;
    app.foreground.addListener(_environmentChanged);
    app.addListener(_inventoryChanged);
    _environmentChanged();
  }

  void setExpanded(bool value) {
    if (_expanded == value) return;
    _expanded = value;
    _timer?.cancel();
    if (_started && app.foreground.value) unawaited(refresh());
  }

  void _inventoryChanged() {
    // Remove credentials' old scope immediately; late responses carry a revision
    // and AppNotifier independently rejects a replaced account or connection.
    final removed = _samples.keys.where((id) {
      final machine = app.stateOf(id);
      return !identical(machine, _samples[id]?.$1) ||
          machine?.connectionStatus != ConnectionStatus.connected;
    }).toList();
    for (final id in removed) {
      _samples.remove(id);
      _receivedAt.remove(id);
    }
    if (removed.isNotEmpty) _revision++;
    notifyListeners();
  }

  void _environmentChanged() {
    _revision++;
    _timer?.cancel();
    _samples.clear();
    _receivedAt.clear();
    notifyListeners();
    if (app.foreground.value) unawaited(refresh());
  }

  Future<void> refresh() async {
    if (_disposed || _busy || !app.foreground.value || !sampleResources) return;
    _timer?.cancel();
    _busy = true;
    final revision = _revision;
    final machines = {for (final row in live) row.machineId: row.machine};
    try {
      final readings = await Future.wait(
        machines.entries.map(
          (entry) async => (
            entry.key,
            entry.value,
            await app.readHarnessResources(entry.key),
          ),
        ),
      );
      if (_disposed || revision != _revision || !app.foreground.value) return;
      _samples.clear();
      for (final (id, machine, result) in readings) {
        if (result != null && identical(machine, app.stateOf(id))) {
          _samples[id] = (machine, result);
          _receivedAt[id] = _now();
        }
      }
      notifyListeners();
    } finally {
      _busy = false;
      if (!_disposed && _started && app.foreground.value) {
        _timer = Timer(Duration(seconds: _expanded ? 3 : 15), refresh);
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _revision++;
    _timer?.cancel();
    if (_started) {
      app.foreground.removeListener(_environmentChanged);
      app.removeListener(_inventoryChanged);
    }
    _samples.clear();
    super.dispose();
  }
}

/// Value-only presentation of one resource reading. Native toolbar fields and
/// responsive Flutter labels can share it without rescanning the session roster.
class HarnessMonitorSummary {
  const HarnessMonitorSummary._(
    this.liveCount,
    this.cpu,
    this.memory,
    this.gpu,
    this.storage,
    this.sharedLabel,
  );

  factory HarnessMonitorSummary._fromReadings(
    List<(String, HarnessResources?)> sessions,
    List<HarnessResources> shared,
  ) {
    final readings = [for (final row in sessions) row.$2, ...shared];
    String total(
      double? Function(HarnessResources) value,
      String Function(double) format,
    ) {
      var sum = 0.0, known = false;
      for (final reading in readings) {
        final number = reading == null ? null : value(reading);
        if (number != null) {
          sum += number;
          known = true;
        }
      }
      return known || readings.isEmpty ? format(sum) : '—';
    }

    final folders = <String, Map<String, double>>{};
    for (final (machine, resource) in sessions) {
      final path = resource?.workspacePath, bytes = resource?.workspaceBytes;
      if (path != null && bytes != null) {
        (folders[machine] ??= {})[path] = bytes;
      }
    }
    var bytes = 0.0, count = 0;
    for (final machine in folders.values) {
      final included = <String>[];
      for (final path
          in machine.keys.toList()
            ..sort((a, b) => a.length.compareTo(b.length))) {
        if (included.any(
          (parent) => path == parent || path.startsWith('$parent/'),
        )) {
          continue;
        }
        included.add(path);
        count++;
        bytes += machine[path]!;
      }
    }
    return HarnessMonitorSummary._(
      sessions.length,
      total((r) => r.cpuPercent, (v) => '${v.round()}%'),
      total((r) => r.memoryBytes, _wholeBytes),
      total((r) => r.gpuPercent, (v) => '${v.round()}%'),
      sessions.isNotEmpty && count == 0 ? '—' : _wholeBytes(bytes),
      _sharedMemoryLabel(shared),
    );
  }

  final int liveCount;
  final String cpu, memory, gpu, storage;
  final String? sharedLabel;

  static String _wholeBytes(double bytes) => bytes >= 1e9
      ? '${(bytes / 1e9).round()} GB'
      : '${(bytes / 1e6).round()} MB';

  String get label => 'Harnesses $liveCount';

  /// CPU uses one core as its denominator. The tooltip explains partial totals.
  String metricsLabel({
    bool ram = true,
    bool gpu = true,
    bool storage = true,
  }) =>
      'CPU $cpu'
      '${ram ? '${workspaceBarGroupSeparator}RAM $memory' : ''}'
      '${gpu ? '${workspaceBarGroupSeparator}GPU ${this.gpu}' : ''}'
      '${storage ? '${workspaceBarGroupSeparator}SSD ${this.storage}' : ''}';

  String get resourceDetail =>
      '$liveCount open harnesses across connected machines. Totals cover these harnesses only.\n'
      '${metricsLabel()}\n'
      'CPU: 100% is one core. RAM includes child processes and shared servers counted once; shared memory pages can overlap.\n'
      'GPU: harness process GPU use on supported macOS and Linux NVIDIA drivers. First samples and unavailable counters show —. Cloud model GPU usage is not reported.\n'
      'SSD: workspace disk space, shared and nested folders counted once per machine. Files remain after stopping.\n'
      'Totals include available readings and may be partial. — means unavailable. Click to open Harness Monitor.';

  String get detail =>
      '$liveCount open across connected machines, including idle and starting harnesses. Click to open Harness Monitor.\n'
      '${HarnessResources.explanation}${sharedLabel == null ? '' : '\n$sharedLabel, included once in the session monitor.'}';
}

String? _sharedMemoryLabel(List<HarnessResources> rows) {
  if (rows.isEmpty) return null;
  final known = rows.where((r) => r.memoryBytes != null).toList();
  final memory = known.fold<double>(0, (sum, r) => sum + r.memoryBytes!);
  return 'Shared Codex servers · ${formatHarnessMemory(known.isEmpty ? null : memory)}${known.isNotEmpty && known.length < rows.length ? '+' : ''} RAM';
}
