import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';
import '../core/test_run.dart';

/// News for the toolbar, separate from connection state or optional setup.
/// Viewing a panel acknowledges its news; account-scoped receipts survive restart.
class ToolbarNotices extends ChangeNotifier {
  ToolbarNotices({LocalKeyValueStore? storage})
    : _storage = storage ?? (kUnderTest ? null : HarnessFileStore.shared);

  final LocalKeyValueStore? _storage;
  String? _scope;
  bool _loaded = false, _disposed = false, _catalogInitialized = false;
  bool _machinesVisible = false, _modelsVisible = false, _catalogLoaded = false;
  Set<String> _machines = {}, _ready = {}, _catalog = {};
  Set<String> _seenMachines = {}, _seenReady = {}, _knownModels = {};
  Set<String> _newInPanel = {};
  int _machineCount = 0, _modelCount = 0;
  int _revision = 0;
  Future<void> _writes = Future.value();

  int get machineCount => _machineCount;
  int get modelCount => _modelCount;
  Set<String> get newModelIds => Set.unmodifiable(_newInPanel);
  static String storageKey(String scope) =>
      'toolbar.notices.${base64Url.encode(utf8.encode(scope))}';

  void sync({
    required String scope,
    required Set<String> machines,
    required Set<String> readyModels,
    required Set<String> catalog,
    required bool catalogLoaded,
    required bool machinesVisible,
    required bool modelsVisible,
  }) {
    if (_disposed) return;
    final changedScope = _scope != scope;
    if (changedScope) {
      _revision++;
      _scope = scope;
      _loaded = false;
      _catalogInitialized = false;
      _seenMachines = {};
      _seenReady = {};
      _knownModels = {};
      _newInPanel = {};
      _machineCount = _modelCount = 0;
    }
    _machines = Set.of(machines);
    _ready = Set.of(readyModels);
    _catalog = Set.of(catalog);
    _catalogLoaded = catalogLoaded;
    _machinesVisible = machinesVisible;
    _modelsVisible = modelsVisible;
    if (changedScope) {
      notifyListeners();
      unawaited(_load(scope, _revision));
    } else {
      _apply();
    }
  }

  Future<void> _load(String scope, int revision) async {
    Map<String, dynamic> data = {};
    try {
      // A quick account switch must not read before its previous acknowledgement.
      await _writes;
      final raw = await _storage?.read(storageKey(scope));
      if (raw != null) {
        final decoded = jsonDecode(raw);
        if (decoded is Map<String, dynamic>) data = decoded;
      }
    } catch (_) {
      // A preference failure never blocks a machine or model.
    }
    if (_disposed || _revision != revision) return;
    Set<String> ids(String key) => data[key] is List
        ? (data[key] as List).whereType<String>().toSet()
        : {};
    _seenMachines = ids('machines');
    _seenReady = ids('ready');
    _knownModels = ids('catalog');
    _catalogInitialized = data['catalog'] is List;
    _loaded = true;
    _apply();
  }

  void _apply() {
    if (!_loaded || _disposed) return;
    var save = false;
    if (_machinesVisible && !_seenMachines.containsAll(_machines)) {
      _seenMachines.addAll(_machines);
      save = true;
    }
    if (_modelsVisible && !_seenReady.containsAll(_ready)) {
      _seenReady.addAll(_ready);
      save = true;
    }
    // The initial catalog is a baseline, not hundreds of "new" releases.
    if (_catalogLoaded && !_catalogInitialized) {
      _knownModels.addAll(_catalog);
      _catalogInitialized = true;
      save = true;
    }
    final newInPanel = _modelsVisible
        ? {
            ..._newInPanel.intersection(_catalog),
            ..._catalog.difference(_knownModels),
          }
        : <String>{};
    if (_modelsVisible && !_knownModels.containsAll(_catalog)) {
      _knownModels.addAll(_catalog);
      save = true;
    }
    final machines = _machines.difference(_seenMachines).length;
    final models = _ready.difference(_seenReady).length;
    final changed =
        machines != _machineCount ||
        models != _modelCount ||
        !setEquals(_newInPanel, newInPanel);
    _machineCount = machines;
    _modelCount = models;
    _newInPanel = newInPanel;
    if (save) _save();
    if (changed) notifyListeners();
  }

  void _save() {
    final key = storageKey(_scope!);
    final value = jsonEncode({
      'machines': _seenMachines.toList(),
      'ready': _seenReady.toList(),
      if (_catalogInitialized) 'catalog': _knownModels.toList(),
    });
    _writes = _writes.then((_) async {
      try {
        await _storage?.write(key, value);
      } catch (_) {}
    });
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
