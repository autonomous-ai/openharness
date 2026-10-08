import 'dart:math';

import 'device_log.dart';

/// The machines the account's device key log took out and has not let back in under a new key, each
/// with the seq of its latest removal — read from this app's stored copy of the log
/// (`ViewerKeyStore.deviceLog`). Only the entries that copy keeps (the newest few dozen) are seen, so
/// this is a hint for what a list says about a machine, never a reason to trust or distrust one: the
/// log itself already unpinned it.
Map<String, int> removedMachinesOf(Object? stored) {
  if (stored is! Map) return const {};
  final state = DevLogState.fromJson(stored['state']);
  if (state == null) return const {};
  final keyed = {
    for (final m in state.active.values)
      if (m.kind == 'machine') m.machineId,
  };
  final removed = <String, int>{};
  // A removal applied while the log was frozen is kept apart from the chained tail.
  for (final list in [stored['recent'], stored['looseRemoved']]) {
    if (list is! List) continue;
    for (final e in list.map(DevLogEntry.parse).whereType<DevLogEntry>()) {
      if (e.op != 'remove' || e.kind != 'machine') continue;
      if (e.machineId.isEmpty || keyed.contains(e.machineId)) continue;
      removed[e.machineId] = max(removed[e.machineId] ?? 0, e.seq);
    }
  }
  return removed;
}
