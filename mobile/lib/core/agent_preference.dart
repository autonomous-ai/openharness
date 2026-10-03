import 'dart:convert';

import 'local_key_value_store.dart';

/// Remembers an agent choice, independently of a machine, profile or permission.
class AgentPreference {
  AgentPreference(this.storage);
  final LocalKeyValueStore? storage;
  static const _key = 'new_agent_engine';
  static const _recentKey = 'new_agent_engine_history_v1';
  String? value;
  List<String> _recent = [];
  List<String> get recent => List.unmodifiable(_recent);
  Future<void>? _loading;
  Future<void> _writes = Future.value();

  Future<void> load() => _loading ??= _read();
  Future<void> _read() async {
    try {
      final stored = await storage?.read(_key);
      value = stored;
      if (stored != null) _recent = [stored];
      final raw = await storage?.read(_recentKey);
      if (raw == null) return;
      final decoded = jsonDecode(raw);
      if (decoded is List) {
        _recent = {
          ?stored,
          ...decoded.whereType<String>().where((id) => id.isNotEmpty),
        }.take(40).toList();
        value ??= _recent.firstOrNull;
      }
    } catch (_) {
      /* A missing preference never blocks a new agent. */
    }
  }

  Future<void> select(String engine) async {
    await load();
    value = engine;
    _recent = [
      engine,
      ..._recent.where((id) => id != engine),
    ].take(40).toList();
    final snapshot = jsonEncode(_recent);
    return _writes = _writes.then((_) async {
      try {
        await storage?.write(_key, engine);
        await storage?.write(_recentKey, snapshot);
      } catch (_) {
        /* Keep the current choice usable if persistence fails. */
      }
    });
  }
}
