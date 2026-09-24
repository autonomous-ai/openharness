import 'dart:convert';

import 'local_key_value_store.dart';

/// Remembers an agent choice, independently of a machine, profile or permission.
class AgentPreference {
  AgentPreference(this.storage);
  final LocalKeyValueStore? storage;
  static const _key = 'new_agent_engine';
  static const _recentKey = 'new_agent_recent';
  static const _launchKey = 'new_harness_preferences_v1';

  /// How many agents [recent] keeps: more than the New Harness list shows, so
  /// an agent that is chosen again does not push out one used last week.
  static const recentCapacity = 8;

  String? value;
  String? harness;
  bool advancedOpen = false;
  List<String> recentHarnesses = const [];
  final _enginesByHarness = <String, String>{};
  String? engineFor(String? harnessId) =>
      _enginesByHarness[harnessId ?? 'coding'];

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
      if (revision == _revision && revision == 0) {
        if (stored?.contains('/') == true) {
          harness = stored;
        } else {
          value = stored;
        }
      }
    } catch (_) {
      /* A missing preference never blocks a new agent. */
    }
    try {
      final stored = await storage?.read(_recentKey);
      final ids = [
        for (final id in (stored ?? '').split('\n'))
          if (id.trim().isNotEmpty) id.trim(),
      ];
      // An agent remembered while this was loading is newer than the file:
      // it stays first, and the stored ones follow it.
      recent = <String>{
        ...recent,
        for (final id in ids)
          if (!id.contains('/') && !recent.contains(id)) id,
      }.take(recentCapacity).toList(growable: false);
      recentHarnesses = <String>{
        ...recentHarnesses,
        if (harness != null && !recentHarnesses.contains(harness)) harness!,
        for (final id in ids)
          if (id.contains('/') && !recentHarnesses.contains(id)) id,
      }.take(recentCapacity).toList(growable: false);
    } catch (_) {
      /* No history is an empty list, never an error. */
    }
    try {
      final stored = await storage?.read(_launchKey);
      if (stored == null || revision != _revision || revision != 0) return;
      final data = jsonDecode(stored);
      if (data is! Map) return;
      List<String> ids(Object? raw, bool packages) => raw is List
          ? raw
                .whereType<String>()
                .where((id) => id.isNotEmpty && id.contains('/') == packages)
                .toSet()
                .take(recentCapacity)
                .toList()
          : const [];
      value =
          data['engine'] is String && !(data['engine'] as String).contains('/')
          ? data['engine'] as String
          : value;
      harness =
          data['harness'] is String && (data['harness'] as String).contains('/')
          ? data['harness'] as String
          : null;
      recent = ids(data['agents'], false);
      recentHarnesses = ids(data['harnesses'], true);
      advancedOpen = data['advancedOpen'] == true;
      if (data['enginesByHarness'] case final Map choices) {
        for (final entry in choices.entries) {
          if (entry.key is String &&
              entry.value is String &&
              !(entry.value as String).contains('/')) {
            _enginesByHarness[entry.key as String] = entry.value as String;
          }
        }
      }
    } catch (_) {
      /* A malformed preference never blocks launch. */
    }
  }

  Future<void> select(String engine) async {
    _revision++;
    if (engine.contains('/')) {
      harness = engine;
    } else {
      value = engine;
      harness = null;
    }
    return _save();
  }

  /// [agent] was just used to create a harness: it moves to the front of
  /// [recent].
  Future<void> remember(String agent, {String? harnessId}) async {
    await load();
    _revision++;
    if (agent.contains('/')) {
      harnessId = agent;
      agent = value ?? '';
    }
    harness = harnessId;
    if (agent.isNotEmpty) {
      value = agent;
      _enginesByHarness[harnessId ?? 'coding'] = agent;
    }
    recent = [
      if (agent.isNotEmpty) agent,
      ...recent.where((id) => id != agent),
    ].take(recentCapacity).toList(growable: false);
    if (harnessId != null) {
      recentHarnesses = [
        harnessId,
        ...recentHarnesses.where((id) => id != harnessId),
      ].take(recentCapacity).toList(growable: false);
    }
    return _save();
  }

  Future<void> setAdvanced(bool open) async {
    await load();
    advancedOpen = open;
    _revision++;
    await _save();
  }

  Future<void> _save() {
    final snapshot = jsonEncode({
      'engine': value,
      'harness': harness,
      'agents': recent,
      'harnesses': recentHarnesses,
      'enginesByHarness': _enginesByHarness,
      'advancedOpen': advancedOpen,
    });
    return _writes = _writes.then((_) async {
      try {
        await storage?.write(_launchKey, snapshot);
      } catch (_) {
        /* The list in memory still serves this session. */
      }
    });
  }
}
