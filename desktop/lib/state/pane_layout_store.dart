import 'dart:async';
import 'dart:convert';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';
import 'pane_preset.dart';
import 'terminal_pane.dart';
import 'swarm.dart';

/// Remembers which agents were on screen, so reopening the app returns to the
/// desk it was left on rather than to whatever happens to load first.
///
/// Only the intent is stored — machine and agent ids. Sizes, sessions and
/// stream ids are all facts about a particular run and would be lies by the
/// next one.
class PaneLayoutStore {
  PaneLayoutStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared;

  static const _key = 'terminal_pane_layout';

  /// Chosen shapes, by tile count. A SECOND key rather than a field on the
  /// layout entries: the two answer different questions — which agents were
  /// open, and what shape the grid was in — and the entry schema above already
  /// refuses anything it does not recognise, so widening it would make an old
  /// build drop a new build's whole layout rather than just the part it cannot
  /// use.
  ///
  /// A third key, `terminal_pane_splits`, is written by older builds and no
  /// longer read: dividers were draggable and their positions were remembered.
  /// Nothing deletes it — a downgrade would want it back, and a few hundred
  /// bytes of dead JSON costs less than a file this build has to migrate.
  static const _presetsKey = 'terminal_pane_presets';

  /// The ceiling on tiles, enforced on the way IN as well as out: a file written
  /// by a future build that allows more must not make this one try to open
  /// terminals it has nowhere to put.
  ///
  /// Nine, because ⌘1–⌘9 already addresses that many and a tenth would have no
  /// key. It is a CEILING, not a target — how many actually fit is decided by
  /// the window, since every terminal has a floor of 40 columns and 12 rows
  /// that both this app and the daemon enforce. On a 1280px window with the
  /// rail open that is about three columns; on a 2560px display, six.
  static const maxPanes = 9;

  final LocalKeyValueStore _storage;
  LocalKeyValueStore get storage => _storage;
  String? _pendingSwarmSnapshot;
  Completer<void>? _swarmSave;

  Future<void> flushSwarms() => _swarmSave?.future ?? Future<void>.value();

  /// Failure is silent and lands on an empty layout, which is exactly the
  /// first-run state. A corrupt state file is a reason to open the app the way
  /// a new user sees it, not a reason to refuse to start.
  Future<List<PaneLayoutEntry>> load() async {
    try {
      final raw = await _storage.read(_key);
      if (raw == null || raw.isEmpty) return const [];
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      final entries = <PaneLayoutEntry>[];
      for (final item in decoded) {
        final entry = PaneLayoutEntry.fromJson(item);
        // One agent cannot be in two tiles: the daemon keeps a single
        // controller per agent, so a duplicate would take its own twin over the
        // moment both opened. Dropping it here means a hand-edited or
        // downgraded file cannot produce that fight.
        if (entry == null ||
            entries.any(
              (existing) =>
                  existing.machineId == entry.machineId &&
                  existing.agentId == entry.agentId,
            )) {
          continue;
        }
        entries.add(entry);
        if (entries.length == maxPanes) break;
      }
      return entries;
    } catch (_) {
      return const [];
    }
  }

  /// A failed write costs the layout at the next launch, which is a far smaller
  /// wrong than an exception thrown out of a pane close.

  /// Chosen shapes, by tile count. An id this build does not know is dropped —
  /// a shape it cannot draw is worse than the default it can.
  Future<Map<int, PanePreset>> loadPresets() async {
    try {
      final raw = await _storage.read(_presetsKey);
      if (raw == null || raw.isEmpty) return const {};
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return const {};
      final out = <int, PanePreset>{};
      for (final entry in decoded.entries) {
        final count = int.tryParse(entry.key.toString());
        if (count == null || count < 2 || count > maxPanes) continue;
        final preset = PanePreset.byId(entry.value?.toString());
        if (preset == null) continue;
        if (!preset.supportsCount(count)) continue;
        out[count] = preset;
      }
      return out;
    } catch (_) {
      return const {};
    }
  }

  Future<void> savePresets(Map<int, PanePreset> presets) async {
    try {
      await _storage.write(
        _presetsKey,
        jsonEncode({
          for (final entry in presets.entries) '${entry.key}': entry.value.id,
        }),
      );
    } catch (_) {
      // Kept in memory for this run; see above.
    }
  }

  /// The id this computer's own machine was last served under, so a launch can
  /// tell whether the saved tiles still name it.
  ///
  /// The desk is keyed by machine id, and this computer's changes with the
  /// account (see [rekeyMachine]). A sign-in or sign-out inside the app re-keys
  /// as it happens; one that happened while the app was CLOSED — `harness
  /// logout` in a terminal, a session that expired overnight — cannot, so the
  /// next launch compares what it remembers against what the daemon now serves
  /// and re-keys then. Without this, every tile waits forever for a machine
  /// that no longer exists under that name.
  static const _localMachineKey = 'local_machine_id';

  Future<String?> loadLocalMachineId() async {
    try {
      final raw = await _storage.read(_localMachineKey);
      return raw == null || raw.isEmpty ? null : raw;
    } catch (_) {
      return null;
    }
  }

  Future<void> saveLocalMachineId(String machineId) async {
    try {
      await _storage.write(_localMachineKey, machineId);
    } catch (_) {
      // Remembered for this run only; the next launch re-keys from the file.
    }
  }

  /// Move every saved tile on machine [from] to machine [to] — and, with
  /// [dropOthers], leave out every tile on any other machine.
  ///
  /// The one case this exists for: THIS computer changes id when the account
  /// under it does. Signed out the daemon serves it under the computer id,
  /// signed in under the account's machineId, and a sign-in or sign-out swaps
  /// the two. The tiles are intent about this computer either way; the id is a
  /// fact about the daemon. Rewriting the file and restoring from it is how the
  /// desk follows without inventing a second, live way to re-key a tile.
  ///
  /// [dropOthers] is the sign-out: a guest has no machine to attach a remote
  /// tile to, and a tile waiting forever reads as broken, not as signed out.
  Future<void> rekeyMachine({
    required String from,
    required String to,
    bool dropOthers = false,
  }) async {
    await flushSwarms();
    final saved = await loadSwarms();
    if (saved == null) return;
    var changed = false;
    final swarms = saved['swarms'];
    if (swarms is! List) return;
    for (final raw in swarms) {
      if (raw is! Map || raw['panes'] is! List) continue;
      final kept = <Object?>[];
      for (final item in (raw['panes'] as List)) {
        if (item is! Map) continue;
        final machineId = item['machineId'];
        if (machineId == from) {
          kept.add({...item, 'machineId': to});
          changed = changed || from != to;
        } else if (!dropOthers || machineId == to) {
          kept.add(item);
        } else {
          changed = true;
        }
      }
      raw['panes'] = kept;
    }
    if (!changed) return;
    try {
      await _storage.write('swarm_layout_v1', jsonEncode(saved));
    } catch (_) {
      // The desk comes back under the old ids at the next launch, where the
      // remembered id (above) gets another chance at it.
    }
  }

  Future<Map<String, dynamic>?> loadSwarms() async {
    try {
      final value = await _storage.read('swarm_layout_v1');
      if (value == null) return null;
      final decoded = jsonDecode(value);
      if (decoded is! Map<String, dynamic> ||
          decoded['version'] != 1 ||
          decoded['swarms'] is! List) {
        return null;
      }
      return decoded;
    } catch (_) {
      return null;
    }
  }

  Future<void> saveSwarms(List<Swarm> swarms, String activeId) {
    // Capture each request before yielding, but keep only the latest snapshot
    // while a write is pending. Holding a navigation key must not queue a full
    // state-file rewrite for every intermediate focus or tab selection.
    try {
      _pendingSwarmSnapshot = jsonEncode({
        'version': 1,
        'activeId': activeId,
        'swarms': swarms.map((s) => s.toJson()).toList(),
      });
    } catch (_) {
      return Future<void>.value();
    }
    final active = _swarmSave;
    if (active != null) return active.future;
    final completion = Completer<void>();
    _swarmSave = completion;
    unawaited(_drainSwarmSnapshots(completion));
    return completion.future;
  }

  Future<void> _drainSwarmSnapshots(Completer<void> completion) async {
    while (_pendingSwarmSnapshot != null) {
      final snapshot = _pendingSwarmSnapshot!;
      _pendingSwarmSnapshot = null;
      try {
        await _storage.write('swarm_layout_v1', snapshot);
      } catch (_) {
        // Keep the current desk usable when storage is unavailable. A newer
        // queued snapshot still gets its own attempt.
      }
    }
    // Clear synchronously before completing: a save requested by a completion
    // listener must start a fresh drain rather than join an already-ended one.
    _swarmSave = null;
    completion.complete();
  }

  Future<void> save(List<PaneLayoutEntry> entries) async {
    try {
      final capped = entries.take(maxPanes).map((e) => e.toJson()).toList();
      await _storage.write(_key, jsonEncode(capped));
    } catch (_) {
      // Kept in memory for this run; see above.
    }
  }
}
