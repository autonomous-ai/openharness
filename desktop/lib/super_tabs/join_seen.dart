import 'dart:async';
import 'dart:convert';

import '../core/local_key_value_store.dart';

/// The Swarms this computer already decided the join's add for
/// (`AppNotifier.addMachineOnJoin`), per account (Scholes, 2026-11-05, task
/// #3160): a domain auto-join, a Workspace-open join or a join on the phone or
/// web reached no Desktop join flow, so discovery asks here which of the Swarms
/// it lists are new on this computer, and the add runs once for each.
///
/// The first pass for an account takes the Swarms already open or hidden here
/// as seen, so an update never adds a long-time member's computer to Swarms
/// they chose not to add it to. Each pass drops the Swarms no longer listed:
/// joining one again is a new membership.
class SwarmJoinSeen {
  SwarmJoinSeen(this.store);

  final LocalKeyValueStore store;

  static String keyFor(String account) => 'swarm_join_seen.$account';

  final _records = <String, Future<_Record>>{};

  /// Recorded in this run, which a list read just before may not show yet.
  final _recent = <String, Set<String>>{};
  Future<void> _writes = Future.value();

  /// The Swarms of [listed] new for [account] on this computer, in their order.
  /// [knownHere]: the Swarms open or hidden here, taken as seen on the first
  /// pass.
  Future<List<String>> fresh(
    String account,
    List<String> listed, {
    required Set<String> knownHere,
  }) async {
    final record = await _load(account);
    final recent = _recent[account] ?? const {};
    var changed = false;
    if (!record.baseline) {
      record.baseline = true;
      record.seen.addAll(listed.where(knownHere.contains));
      changed = true;
    }
    final before = record.seen.length;
    record.seen.removeWhere(
      (id) => !listed.contains(id) && !recent.contains(id),
    );
    if (record.seen.length != before) changed = true;
    if (changed) await _save(account, record);
    return [
      for (final id in listed)
        if (!record.seen.contains(id)) id,
    ];
  }

  /// Records that the add was decided for [tabId]: it never runs there again
  /// for [account] on this computer.
  Future<void> mark(String account, String tabId) async {
    final record = await _load(account);
    (_recent[account] ??= {}).add(tabId);
    if (record.seen.add(tabId)) await _save(account, record);
  }

  Future<_Record> _load(String account) => _records[account] ??= _read(account);

  Future<_Record> _read(String account) async {
    try {
      final raw = await store.read(keyFor(account));
      if (raw == null) return _Record();
      final json = jsonDecode(raw) as Map<String, dynamic>;
      return _Record(
        baseline: json['baseline'] == true,
        seen: {
          for (final id in json['seen'] as List? ?? const [])
            if (id is String) id,
        },
      );
    } catch (_) {
      // Unreadable: taken as none, so the first pass sets it again.
      return _Record();
    }
  }

  /// One write at a time, each of the whole record as it is then.
  Future<void> _save(String account, _Record record) => _writes = _writes.then(
    (_) => store.write(
      keyFor(account),
      jsonEncode({
        'baseline': record.baseline,
        'seen': [...record.seen],
      }),
    ),
    onError: (_) {},
  );
}

class _Record {
  _Record({this.baseline = false, Set<String>? seen}) : seen = seen ?? {};
  bool baseline;
  final Set<String> seen;
}
