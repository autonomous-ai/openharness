import 'local_key_value_store.dart';

/// Remembers an agent choice, independently of a machine, profile or permission.
class AgentPreference {
  AgentPreference(this.storage);
  final LocalKeyValueStore? storage;
  static const _key = 'new_agent_engine';
  String? value;
  Future<void>? _loading;
  Future<void> _writes = Future.value();
  int _revision = 0;

  Future<void> load() => _loading ??= _read();
  Future<void> _read() async {
    final revision = _revision;
    try {
      final stored = await storage?.read(_key);
      if (revision == _revision && revision == 0) value = stored;
    } catch (_) {
      /* A missing preference never blocks a new agent. */
    }
  }

  Future<void> select(String engine) {
    _revision++;
    value = engine;
    return _writes = _writes.then((_) async {
      try {
        await storage?.write(_key, engine);
      } catch (_) {
        /* Keep the current choice usable if persistence fails. */
      }
    });
  }
}
