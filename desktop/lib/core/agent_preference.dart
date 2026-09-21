import 'local_key_value_store.dart';

/// Remembers an agent choice, independently of a machine, profile or permission.
class AgentPreference {
  AgentPreference(this.storage);
  final LocalKeyValueStore? storage;
  static const _key = 'new_agent_engine';
  static const _recentKey = 'new_agent_recent';

  /// How many agents [recent] keeps: more than the New Harness list shows, so
  /// an agent that is chosen again does not push out one used last week.
  static const recentCapacity = 8;

  String? value;

  /// The agents harnesses were created with, most recent first — what New
  /// Harness lists before anything is typed.
  List<String> recent = const [];

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
    try {
      final stored = await storage?.read(_recentKey);
      if (stored == null) return;
      final ids = [
        for (final id in stored.split('\n'))
          if (id.trim().isNotEmpty) id.trim(),
      ];
      // An agent remembered while this was loading is newer than the file:
      // it stays first, and the stored ones follow it.
      recent = [
        ...recent,
        for (final id in ids)
          if (!recent.contains(id)) id,
      ].take(recentCapacity).toList(growable: false);
    } catch (_) {
      /* No history is an empty list, never an error. */
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

  /// [agent] was just used to create a harness: it moves to the front of
  /// [recent].
  Future<void> remember(String agent) {
    recent = [
      agent,
      ...recent.where((id) => id != agent),
    ].take(recentCapacity).toList(growable: false);
    return _writes = _writes.then((_) async {
      try {
        // Written after the stored list has been read and merged in behind
        // it, or an agent used before the load finished would replace the
        // whole history on disk with itself.
        await load();
        await storage?.write(_recentKey, recent.join('\n'));
      } catch (_) {
        /* The list in memory still serves this session. */
      }
    });
  }
}
