import 'dart:async';

import 'swarm_home_cache.dart';
import 'swarm_reader.dart';

/// What keeps an inbox's Home in its [SwarmHomeCache]: at once when a Swarm
/// was read again from nothing, left the list, or its access ended — what was
/// kept may hold what the person can no longer read. Any other change is kept
/// at most once each [wait], and what is left when Harness goes behind
/// ([flush]), so a busy Swarm costs one write in a while, not one a read. No
/// timer: nothing outlives the screens.
class SwarmHomeKeeper {
  SwarmHomeKeeper(this.cache, this.accountId, {required this.wait});

  final SwarmHomeCache cache;
  final String accountId;
  final Duration wait;

  /// Each Swarm's [SwarmReader.generation] as last kept.
  var _kept = <String, int>{};
  DateTime? _wrote;
  bool _pending = false;

  /// The account's Home as kept, or null.
  Future<List<SwarmHomeEntry>?> restore() => cache.read(accountId);

  /// The Swarms listed now ([swarms]) as their [readers] hold them. Nothing
  /// while all that is held is what was kept, and nothing has left.
  void keep(
    Map<String, SwarmReader> readers,
    List<({String id, String name})> swarms,
  ) {
    final read = readers.entries.any(
      (e) => e.value.generation != (_kept[e.key] ?? 0),
    );
    final left = _kept.keys.any((id) => !readers.containsKey(id));
    if (read || left) return _write(readers, swarms);
    if (readers.values.every((r) => r.generation == 0)) return;
    final last = _wrote;
    if (last == null || DateTime.now().difference(last) >= wait) {
      return _write(readers, swarms);
    }
    _pending = true;
  }

  /// Harness goes behind: a change not kept yet is kept now.
  void flush(
    Map<String, SwarmReader> readers,
    List<({String id, String name})> swarms,
  ) {
    if (_pending) _write(readers, swarms);
  }

  void _write(
    Map<String, SwarmReader> readers,
    List<({String id, String name})> swarms,
  ) {
    _pending = false;
    _wrote = DateTime.now();
    _kept = {for (final e in readers.entries) e.key: e.value.generation};
    unawaited(
      cache.write(accountId, [
        for (final swarm in swarms)
          if (readers[swarm.id] case final reader?
              when !reader.accessRevoked && reader.snapshot != null)
            (
              id: swarm.id,
              name: swarm.name,
              view: swarmHomeSwarm(reader.snapshot!, reader.partners),
            ),
      ]),
    );
  }
}
