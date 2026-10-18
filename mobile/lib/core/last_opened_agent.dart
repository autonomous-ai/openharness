import 'dart:convert';

import 'local_key_value_store.dart';

/// One agent, named by the machine it runs on — what a relaunch reopens, a pager page shows, and
/// every pane it opens is about.
typedef AgentRef = ({String machineId, String agentId});

/// The agent the phone had on screen, so a relaunch can put the person back on it.
///
/// ⚠️ **Only ever overwritten, never cleared.** Clearing it was the pager's way of saying "the
/// terminal was left", back when leaving it meant landing on a list of agents that the next launch
/// could start on instead. There is no such list any more — the terminal is the phone's home
/// screen — so the only question this answers is *which* agent it opens on, and "none" is not one
/// of the answers. A record naming an agent that
/// has since been deleted simply matches nothing, and the home screen falls through to the first
/// agent of the tab the phone was last in ([readTab]).
class LastOpenedAgent {
  LastOpenedAgent(this._storage);

  final LocalKeyValueStore? _storage;
  static const _key = 'phone_last_agent_v1';

  /// The desk tab the phone was in — kept beside the agent because it is what a relaunch falls back
  /// on when that agent cannot be opened (`AgentHome._firstOfLastTab`). Its own key: the two are
  /// written at different moments, and neither should cost the other a rewrite.
  static const _tabKey = 'phone_last_tab_v1';

  AgentRef? _value;
  String? _tab;

  /// The agent this record names right now, as far as this run knows — the last one [remember]ed,
  /// or what the previous run left once a read has brought it in. Null when neither has happened.
  /// For the machine cache's launch record (`MachineCache.save`), which is written for the machine
  /// the NEXT launch reopens.
  AgentRef? get current => _value ?? _readBack;
  AgentRef? _readBack;
  Future<void> _writes = Future.value();
  Future<AgentRef?>? _read;

  /// Start reading now, so the home screen does not have to start it later.
  ///
  /// ⚠️ **This read is on the phone's critical path, and it used to begin at the
  /// worst possible moment.** `AgentHome` starts it from `initState` and holds
  /// the whole screen on "Getting things ready…" until it lands — but `initState`
  /// only runs once the app is already `authenticated`, so the read joined the
  /// back of a queue of state-file operations the launch had just made, behind
  /// an exclusive lock it now had to wait its turn for.
  ///
  /// Called from `bootstrap`, the same read instead overlaps the sign-in check
  /// and the machine fetch, and [read] finds the answer waiting. Idempotent, so
  /// the prefetch and the screen share one read rather than racing for the lock.
  void prefetch() => _read ??= _load();

  /// The [prefetch] in flight or landed, WITHOUT taking it — for the launch to learn which machine
  /// to dial first (`AppNotifier._warmStartMachines`), while [read] stays the home screen's own
  /// one-shot. Null when nothing was prefetched, or the home screen has already taken it.
  Future<AgentRef?>? get prefetched => _read;

  /// What the previous run left, or null. Anything malformed reads as nothing — a missing
  /// preference must never hold the app on its launch screen.
  ///
  /// Served from the in-flight or completed [prefetch] when there is one. Not
  /// cached beyond that: [remember] writes through `_value`, and a stale read is
  /// how a relaunch reopens the agent before last.
  Future<AgentRef?> read() {
    final pending = _read;
    if (pending == null) return _load();
    // One-shot: the next caller wants what is on disk now, not what was there
    // when the launch began.
    _read = null;
    return pending;
  }

  Future<AgentRef?> _load() async {
    try {
      final raw = await _storage?.read(_key);
      if (raw == null) return null;
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final machineId = decoded['machineId'];
      final agentId = decoded['agentId'];
      if (machineId is! String || machineId.isEmpty) return null;
      if (agentId is! String || agentId.isEmpty) return null;
      final read = (machineId: machineId, agentId: agentId);
      _readBack = read;
      return read;
    } catch (_) {
      return null;
    }
  }

  /// The tab the previous run was last in, or null. Anything unreadable reads as nothing.
  Future<String?> readTab() async {
    try {
      final raw = await _storage?.read(_tabKey);
      return raw == null || raw.isEmpty ? null : raw;
    } catch (_) {
      return null;
    }
  }

  void rememberTab(String tabId) {
    if (_tab == tabId) return;
    _tab = tabId;
    _write((storage) => storage.write(_tabKey, tabId));
  }

  void remember(AgentRef agent) {
    if (_value == agent) return;
    _value = agent;
    final encoded = jsonEncode({
      'machineId': agent.machineId,
      'agentId': agent.agentId,
    });
    _write((storage) => storage.write(_key, encoded));
  }

  void _write(Future<void> Function(LocalKeyValueStore storage) write) {
    final storage = _storage;
    if (storage == null) return;
    _writes = _writes.then((_) async {
      try {
        await write(storage);
      } catch (_) {
        // Losing the record only costs the reopen; the terminal itself is unaffected.
      }
    });
  }
}
