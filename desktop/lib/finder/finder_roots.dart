import 'dart:convert';

import '../core/local_key_value_store.dart';

/// Which folder each chat's Finder shows, by machine and agent — what lets a
/// Finder come back beside its chat after the app restarts. Viewer tiles are
/// never in the saved layout (`PaneKind`), so this is the Finder's own note,
/// kept in this computer's small preferences store.
class FinderRoots {
  FinderRoots(this._storage);

  static const storageKey = 'finder.roots';

  /// Old entries go first once this many are kept: an agent stopped while
  /// the app was closed never says so here.
  static const capacity = 200;

  final LocalKeyValueStore? Function() _storage;
  final _roots = <(String, String), String>{};
  Future<void>? _loading;

  String? rootOf(String machineId, String agentId) =>
      _roots[(machineId, agentId)];

  /// Reads the saved folders once. A folder set before it lands wins.
  Future<void> load() => _loading ??= _load();

  Future<void> _load() async {
    final String? raw;
    try {
      raw = await _storage()?.read(storageKey);
    } catch (_) {
      return; // unreadable: no Finder comes back, nothing breaks
    }
    if (raw == null) return;
    final Object? entries;
    try {
      entries = jsonDecode(raw);
    } on FormatException {
      return;
    }
    if (entries is! List) return;
    for (final entry in entries) {
      if (entry is! Map) continue;
      final machine = entry['machineId'], agent = entry['agentId'];
      final root = entry['root'];
      if (machine is! String || agent is! String || root is! String) continue;
      _roots.putIfAbsent((machine, agent), () => root);
    }
  }

  void set(String machineId, String agentId, String root) {
    _roots.remove((machineId, agentId));
    _roots[(machineId, agentId)] = root;
    while (_roots.length > capacity) {
      _roots.remove(_roots.keys.first);
    }
    _save();
  }

  void forget(String machineId, String agentId) {
    if (_roots.remove((machineId, agentId)) != null) _save();
  }

  /// A chat that became another agent (a switch) keeps its Finder.
  void move(String machineId, String from, String to) {
    final root = _roots.remove((machineId, from));
    if (root != null) set(machineId, to, root);
  }

  void _save() {
    final store = _storage();
    if (store == null) return;
    final value = jsonEncode([
      for (final MapEntry(key: (machine, agent), value: root)
          in _roots.entries)
        {'machineId': machine, 'agentId': agent, 'root': root},
    ]);
    store.write(storageKey, value).catchError((Object _) {});
  }
}
