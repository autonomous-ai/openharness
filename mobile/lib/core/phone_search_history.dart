import 'dart:async';
import 'dart:convert';

import 'local_key_value_store.dart';

/// The agents and commands reached from the search, most recent first.
///
/// The phone's half of the desktop's `SwarmNavigationHistory`: the part that
/// ranks. A search earns its keep in the first three rows, before a word is
/// typed, and without this the box opens on whichever agent a daemon happened to
/// stamp last — the one from an hour ago no nearer than one from last month.
///
/// ⚠️ **Only ids are kept**, never a name, a path or a line of terminal. They
/// outlive a restart and mean nothing to anything that cannot already read the
/// account's agent list.
class PhoneSearchHistory {
  PhoneSearchHistory(this._storage);

  final LocalKeyValueStore? _storage;
  static const _agentsKey = 'phone_recent_agents_v1';
  static const _commandsKey = 'phone_recent_commands_v1';

  /// Long enough to cover the agents anyone switches between, short enough that
  /// the whole list stays one small write.
  static const _kept = 32;

  final _agents = <String>[];
  final _commands = <String>[];
  Timer? _saving;
  bool _disposed = false;
  Future<void>? _loading;

  /// Agent ids ([phoneAgentId]) most recent first.
  List<String> get recent => List.unmodifiable(_agents);

  /// Command ids most recent first: with nothing typed, `>` opens on these.
  List<String> get recentCommands => List.unmodifiable(_commands);

  /// Folds what the last run remembered in BEHIND what this one has already
  /// visited, so a read that lands late cannot reorder the present.
  ///
  /// Idempotent and shared: every opening of the box asks, and they all wait on
  /// the one read rather than racing each other for the state file's lock.
  Future<void> load() => _loading ??= _load();

  Future<void> _load() async {
    await _read(_agentsKey, _agents, prefix: 'agent:');
    await _read(_commandsKey, _commands);
  }

  Future<void> _read(
    String key,
    List<String> into, {
    String? prefix,
  }) async {
    try {
      final raw = await _storage?.read(key);
      if (raw == null || _disposed) return;
      final ids = jsonDecode(raw);
      if (ids is! List) return;
      for (final id in ids.take(_kept)) {
        if (id is! String || into.contains(id)) continue;
        if (prefix != null && !id.startsWith(prefix)) continue;
        into.add(id);
      }
    } catch (_) {
      // A damaged list is an empty one; the next visit writes a good one.
    }
  }

  void remember(String id) => _touch(_agents, id);

  void rememberCommand(String id) => _touch(_commands, id);

  void _touch(List<String> list, String id) {
    if (list.firstOrNull == id) return;
    list
      ..remove(id)
      ..insert(0, id);
    if (list.length > _kept) list.removeLast();
    _save();
  }

  void _save() {
    if (_storage == null || _disposed) return;
    // Agents are opened in bursts; one write after it settles is enough.
    _saving?.cancel();
    _saving = Timer(const Duration(milliseconds: 600), () {
      unawaited(_write(_agentsKey, _agents));
      unawaited(_write(_commandsKey, _commands));
    });
  }

  Future<void> _write(String key, List<String> ids) async {
    try {
      await _storage?.write(key, jsonEncode(ids));
    } catch (_) {
      // Losing the order only costs the next search its head start.
    }
  }

  void dispose() {
    _disposed = true;
    _saving?.cancel();
  }
}
