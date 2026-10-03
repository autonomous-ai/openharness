import 'dart:convert';

import 'local_key_value_store.dart';
import 'launch_setup.dart';

/// Recent choices are scoped to the machine that owns their paths.
class ProjectHistory {
  ProjectHistory(this._storage);
  final LocalKeyValueStore? _storage;
  static const _key = 'new_agent_projects_v1';
  final _recent = <String, List<String>>{};
  final _selected = <String, String?>{};
  final _worktrees = <String, Map<String, bool>>{};
  Future<void>? _loading;
  Future<void> _saving = Future.value();
  int _revision = 0;
  ({String machineId, String folder})? lastLaunched;

  List<String> recent(String machine) =>
      List.unmodifiable(_recent[machine] ?? []);
  bool hasSelection(String machine) => _selected.containsKey(machine);
  String? selected(String machine) => _selected[machine];
  bool? worktreeFor(String machine, String path) => _worktrees[machine]?[path];

  Future<void> load() => _loading ??= _load();
  Future<void> _load() async {
    final revision = _revision;
    try {
      final raw = await _storage?.read(_key);
      if (raw == null || _revision != revision) return;
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return;
      final last = decoded['_lastLaunch'];
      if (last is Map &&
          last['machine'] is String &&
          last['folder'] is String &&
          _valid(last['folder'])) {
        lastLaunched = (
          machineId: last['machine'] as String,
          folder: last['folder'] as String,
        );
      }
      for (final entry in decoded.entries.take(64)) {
        if (entry.key == '_lastLaunch') continue;
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
        if (value.containsKey('selected') &&
            (value['selected'] == null ||
                value['selected'] is String && _valid(value['selected']))) {
          _selected[entry.key] = value['selected'];
        }
        if (value['worktrees'] case final Map choices) {
          _worktrees[entry.key] = {
            for (final choice in choices.entries.take(40))
              if (choice.key is String &&
                  _valid(choice.key) &&
                  choice.value is bool)
                choice.key as String: choice.value as bool,
          };
        }
      }
    } catch (_) {
      // A missing preference never blocks creation.
    }
  }

  static bool _valid(String path) =>
      path.startsWith('/') &&
      !isInternalLaunchFolder(path) &&
      path.length <= 4096 &&
      !RegExp(r'[\x00-\x1f\x7f]').hasMatch(path);

  Future<void> select(
    String machine,
    String? path, {
    bool launched = false,
  }) async {
    await load();
    if (path != null && !_valid(path)) return;
    _revision++;
    _selected[machine] = path;
    if (launched && path != null) {
      lastLaunched = (machineId: machine, folder: path);
    }
    if (path != null) {
      _recent[machine] = [
        path,
        ...?_recent[machine]?.where((item) => item != path),
      ].take(40).toList();
    }
    await _save();
  }

  /// A worktree preference belongs to this folder on this machine. It does
  /// not change the selected project or add a worktree folder to recents.
  Future<void> selectWorktree(String machine, String path, bool enabled) async {
    if (!_valid(path)) return;
    await load();
    _revision++;
    _worktrees[machine] = {
      path: enabled,
      for (final entry
          in (_worktrees[machine] ?? {}).entries
              .where((entry) => entry.key != path)
              .take(39))
        entry.key: entry.value,
    };
    await _save();
  }

  Future<void> _save() async {
    final snapshot = jsonEncode({
      if (lastLaunched case final last?)
        '_lastLaunch': {'machine': last.machineId, 'folder': last.folder},
      for (final id in {
        ..._worktrees.keys,
        ..._selected.keys,
      }.toList().reversed.take(64))
        id: {
          if (_selected.containsKey(id)) 'selected': _selected[id],
          'recent': _recent[id] ?? [],
          if (_worktrees.containsKey(id)) 'worktrees': _worktrees[id],
        },
    });
    _saving = _saving.then((_) async {
      try {
        await _storage?.write(_key, snapshot);
      } catch (_) {}
    });
    await _saving;
  }
}
