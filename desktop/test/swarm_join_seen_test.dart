import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/join_seen.dart';

import 'support/memory_key_value_store.dart';

// Task #3160 (Scholes, 11-05): a Swarm joined anywhere but Desktop's own join
// dialog never added this computer. Discovery now asks which listed Swarms
// are new here, so the join's add runs once for each.
void main() {
  late MemoryKeyValueStore store;
  setUp(() => store = MemoryKeyValueStore());

  test(
    'the first pass takes the Swarms already here as seen and returns the rest',
    () async {
      final seen = SwarmJoinSeen(store);
      expect(
        await seen.fresh(
          'mate',
          ['old', 'hidden', 'domain'],
          knownHere: {'old', 'hidden'},
        ),
        ['domain'],
      );
    },
  );

  test(
    'a recorded Swarm is never returned again, also after a restart',
    () async {
      final seen = SwarmJoinSeen(store);
      expect(await seen.fresh('mate', ['old', 'domain'], knownHere: {'old'}), [
        'domain',
      ]);
      await seen.mark('mate', 'domain');
      expect(
        await seen.fresh('mate', ['old', 'domain'], knownHere: const {}),
        isEmpty,
      );
      final restarted = SwarmJoinSeen(store);
      expect(
        await restarted.fresh('mate', ['old', 'domain'], knownHere: const {}),
        isEmpty,
      );
      // A Swarm joined later, on the web, is new even though nothing shows it here yet.
      expect(
        await restarted.fresh('mate', [
          'old',
          'domain',
          'web',
        ], knownHere: const {}),
        ['web'],
      );
    },
  );

  test('a Swarm not recorded yet stays new until it is', () async {
    final seen = SwarmJoinSeen(store);
    await seen.fresh('mate', const [], knownHere: const {});
    // A viewer's Swarm is never recorded, so it is asked about again.
    expect(await seen.fresh('mate', ['viewed'], knownHere: const {}), [
      'viewed',
    ]);
    expect(await seen.fresh('mate', ['viewed'], knownHere: const {}), [
      'viewed',
    ]);
  });

  test('each account keeps its own record', () async {
    final seen = SwarmJoinSeen(store);
    await seen.fresh('mate', ['pilot'], knownHere: {'pilot'});
    expect(await seen.fresh('other', ['pilot'], knownHere: const {}), [
      'pilot',
    ]);
  });

  test('a join recorded before the first pass still lets the first pass take what is here as seen', () async {
    final seen = SwarmJoinSeen(store);
    await seen.mark('mate', 'joined');
    expect(
      await seen.fresh('mate', ['old', 'joined', 'domain'], knownHere: {'old'}),
      ['domain'],
    );
  });

  test('a Swarm no longer listed is dropped from the record, unless recorded in this run', () async {
    final seen = SwarmJoinSeen(store);
    await seen.fresh('mate', ['a', 'b'], knownHere: {'a', 'b'});
    await seen.mark('mate', 'just-joined');
    await seen.fresh('mate', ['a'], knownHere: const {});
    final restarted = SwarmJoinSeen(store);
    // Left and joined again: a new membership, added again.
    expect(
      await restarted.fresh('mate', [
        'a',
        'b',
        'just-joined',
      ], knownHere: const {}),
      ['b'],
    );
  });

  test('an unreadable record is taken as none', () async {
    store.values[SwarmJoinSeen.keyFor('mate')] = '{not json';
    final seen = SwarmJoinSeen(store);
    expect(await seen.fresh('mate', ['old', 'new'], knownHere: {'old'}), [
      'new',
    ]);
  });

  test('a write that fails neither throws nor stops the next one', () async {
    final failing = _FailingOnce();
    final seen = SwarmJoinSeen(failing);
    await seen.fresh('mate', ['a', 'b'], knownHere: const {});
    await seen.mark('mate', 'a');
    await seen.mark('mate', 'b');
    final restarted = SwarmJoinSeen(failing);
    expect(
      await restarted.fresh('mate', ['a', 'b'], knownHere: const {}),
      isEmpty,
    );
  });
}

/// A store whose first write fails, as a full disk does once.
class _FailingOnce extends MemoryKeyValueStore {
  var _failed = false;

  @override
  Future<void> write(String key, String value) async {
    if (!_failed) {
      _failed = true;
      throw const FileSystemException('No space left on device');
    }
    await super.write(key, value);
  }
}
