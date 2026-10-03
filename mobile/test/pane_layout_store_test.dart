import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/state/pane_layout_store.dart';
import 'package:harness_mobile/state/swarm.dart';

class _Store implements LocalKeyValueStore {
  final values = <String, String>{};
  final writes = <String>[];
  final gates = <Completer<void>>[];
  bool holdWrites = false;
  bool failReads = false;

  @override
  Future<String?> read(String key) async {
    if (failReads) throw StateError('storage unavailable');
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    writes.add(value);
    if (holdWrites) {
      final gate = Completer<void>();
      gates.add(gate);
      await gate.future;
    }
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  test(
    'restoration drops malformed and duplicate panes, and caps old layouts',
    () async {
      final storage = _Store()
        ..values['terminal_pane_layout'] = jsonEncode([
          null,
          {'machineId': 'studio', 'agentId': 'one'},
          {'machineId': 'studio', 'agentId': 'one'},
          for (var i = 0; i < 15; i++)
            {'machineId': 'studio', 'agentId': 'agent-$i'},
        ]);
      final layout = await PaneLayoutStore(storage: storage).load();
      expect(layout, hasLength(PaneLayoutStore.maxPanes));
      expect(layout.map((p) => p.agentId).toSet(), hasLength(layout.length));
      expect(layout.first.agentId, 'one');
    },
  );

  test(
    'invalid or unreadable layouts return a usable first-run state',
    () async {
      final storage = _Store();
      final store = PaneLayoutStore(storage: storage);
      for (final raw in ['', 'broken', '{}']) {
        storage.values['terminal_pane_layout'] = raw;
        expect(await store.load(), isEmpty);
      }
      for (final raw in [
        'broken',
        '[]',
        '{"version":2,"swarms":[]}',
        '{"version":1,"swarms":{}}',
      ]) {
        storage.values['swarm_layout_v1'] = raw;
        expect(await store.loadSwarms(), isNull);
      }
      storage.failReads = true;
      expect(await store.load(), isEmpty);
      expect(await store.loadSwarms(), isNull);
    },
  );

  test(
    'rapid navigation saves the latest captured snapshot after a failed write',
    () async {
      final storage = _Store()..holdWrites = true;
      final store = PaneLayoutStore(storage: storage);
      final swarm = Swarm(id: 'one', name: 'initial');
      final first = store.saveSwarms([swarm], 'one');
      swarm.name = 'intermediate';
      final second = store.saveSwarms([swarm], 'one');
      swarm.name = 'latest';
      final last = store.saveSwarms([swarm], 'one');
      swarm.name = 'not yet saved';
      expect(storage.writes, hasLength(1));
      storage.holdWrites = false;
      storage.gates.single.completeError(StateError('disk unavailable'));
      await Future.wait([first, second, last, store.flushSwarms()]);
      expect(storage.writes, hasLength(2));
      expect(
        ((await store.loadSwarms())!['swarms'] as List).single['name'],
        'latest',
      );
      await store.saveSwarms([swarm], 'one');
      await store.flushSwarms();
      expect(
        ((await store.loadSwarms())!['swarms'] as List).single['name'],
        'not yet saved',
      );
    },
  );
}
