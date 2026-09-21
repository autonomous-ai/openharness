import 'dart:convert';

import 'local_key_value_store.dart';

/// Recent choices are scoped to the machine that owns their paths.
class ProjectHistory {
  ProjectHistory(this._storage);
  final LocalKeyValueStore? _storage;
  static const _key = 'new_agent_projects_v1';
  final _recent = <String, List<String>>{};
  final _selected = <String, String?>{};
  Future<void>? _loading;
  Future<void> _saving = Future.value();
  int _revision = 0;

  List<String> recent(String machine) =>
      List.unmodifiable(_recent[machine] ?? []);
  bool hasSelection(String machine) => _selected.containsKey(machine);
  String? selected(String machine) => _selected[machine];

  Future<void> load() => _loading ??= _load();
  Future<void> _load() async {
    final revision = _revision;
    try {
      final raw = await _storage?.read(_key);
      if (raw == null || _revision != revision) return;
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return;
      for (final entry in decoded.entries.take(64)) {
        if (entry.key is! String || entry.value is! Map) continue;
        final value = entry.value as Map;
        final paths = value['recent'];
        if (paths is List) {
          _recent[entry.key] = paths
              .whereType<String>()
              .where(_valid)
              .take(40)
              .toSet()
              .toList();
        }
        if (value['selected'] == null ||
            value['selected'] is String && _valid(value['selected'])) {
          _selected[entry.key] = value['selected'];
        }
      }
    } catch (_) {
      // A missing preference never blocks creation.
    }
  }

  static bool _valid(String path) =>
      path.startsWith('/') &&
      path.length <= 4096 &&
      !RegExp(r'[\x00-\x1f\x7f]').hasMatch(path);

  Future<void> select(String machine, String? path) async {
    await load();
    if (path != null && !_valid(path)) return;
    _revision++;
    _selected[machine] = path;
    if (path != null) {
      _recent[machine] = [
        path,
        ...?_recent[machine]?.where((item) => item != path),
      ].take(40).toList();
    }
    final snapshot = jsonEncode({
      for (final id in _selected.keys.toList().reversed.take(64))
        id: {'selected': _selected[id], 'recent': _recent[id] ?? []},
    });
    _saving = _saving.then((_) async {
      try {
        await _storage?.write(_key, snapshot);
      } catch (_) {}
    });
    await _saving;
  }
}
