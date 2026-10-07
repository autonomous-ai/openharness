import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/viewer/viewer_key_store.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;

/// A state file that can be briefly unreadable or unwritable — locked by another process, or
/// caught mid-rename — the way `HarnessFileStore` throws rather than answers.
class _FlakyStore implements LocalKeyValueStore {
  final values = <String, String>{};
  int failReads = 0;
  int failWrites = 0;
  int reads = 0;

  @override
  Future<String?> read(String key) async {
    reads++;
    if (failReads > 0) {
      failReads--;
      throw StateError('state.json is locked');
    }
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    if (failWrites > 0) {
      failWrites--;
      throw StateError('disk full');
    }
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async => values.remove(key);
}

const _peersKey = 'viewer_e2ee_machine_peers';
const _seedKey = 'viewer_e2ee_identity_seed';

void main() {
  group('identity', () {
    test('is minted once, kept, and the same on the next launch', () async {
      final storage = MemoryKeyValueStore();
      final first = await ViewerKeyStore(storage: storage).identity();
      expect(storage.values[_seedKey], b64e(first.seed));

      final store = ViewerKeyStore(storage: storage);
      final again = await store.identity();
      expect(again.pub, first.pub);
      expect(identical(await store.identity(), again), isTrue);
    });

    // ⚠️ A failed read used to be held as the answer for the life of the process: every dial
    // asks for the identity, so one locked moment at launch meant no machine connected again
    // until the app was killed.
    test('a read that failed once is asked again, not held', () async {
      final storage = _FlakyStore()..failReads = 1;
      final store = ViewerKeyStore(storage: storage);
      await expectLater(store.identity(), throwsStateError);
      final identity = await store.identity();
      expect(identity.pub, hasLength(32));
    });
  });

  group('peers', () {
    test('none linked is an empty list', () async {
      final store = ViewerKeyStore(storage: MemoryKeyValueStore());
      expect(await store.peers(), isEmpty);
      expect(await store.peer('m'), isNull);
    });

    test('pinning keeps the newest first and replaces a re-link', () async {
      final storage = MemoryKeyValueStore();
      final store = ViewerKeyStore(storage: storage);
      await store.pin('a', List.filled(32, 1));
      await Future<void>.delayed(const Duration(milliseconds: 2));
      await store.pin('b', List.filled(32, 2), label: 'Mac');
      await Future<void>.delayed(const Duration(milliseconds: 2));
      await store.pin('a', List.filled(32, 3));

      final peers = await store.peers();
      expect(peers.map((p) => p.machineId), ['a', 'b']);
      expect(peers.first.pub, List.filled(32, 3));
      expect((await store.peer('b'))!.label, 'Mac');

      // And the file says the same to the next launch.
      final reread = await ViewerKeyStore(storage: storage).peers();
      expect(reread.map((p) => p.machineId), ['a', 'b']);
      expect(reread.first.pub, List.filled(32, 3));
    });

    test(
      'unlinking drops only that machine, and says when there was none',
      () async {
        final store = ViewerKeyStore(storage: MemoryKeyValueStore());
        await store.pin('a', List.filled(32, 1));
        await store.pin('b', List.filled(32, 2));
        expect(await store.unlink('a'), isTrue);
        expect(await store.unlink('a'), isFalse);
        expect((await store.peers()).map((p) => p.machineId), ['b']);
      },
    );

    test('a damaged row loses that row, not every link', () async {
      final storage = MemoryKeyValueStore();
      storage.values[_peersKey] = jsonEncode([
        {'machineId': 'good', 'pub': b64e(List.filled(32, 9)), 'linkedAt': 5},
        {'machineId': 'no-pub', 'linkedAt': 5},
        {'machineId': 'bad-pub', 'pub': '!!!', 'linkedAt': 5},
        {
          'machineId': 'bad-date',
          'pub': b64e([1]),
          'linkedAt': 'yesterday',
        },
        'not a row',
        null,
      ]);
      final peers = await ViewerKeyStore(storage: storage).peers();
      expect(peers.map((p) => p.machineId), ['good']);
      expect(peers.single.label, '');
    });

    test('a file that is not a list reads as no links', () async {
      for (final raw in ['{"a":1}', 'not json', '"x"']) {
        final storage = MemoryKeyValueStore()..values[_peersKey] = raw;
        expect(await ViewerKeyStore(storage: storage).peers(), isEmpty);
      }
    });

    test('peers are read from disk once, then held', () async {
      final storage = _FlakyStore();
      final store = ViewerKeyStore(storage: storage);
      await store.peers();
      await store.peer('a');
      await store.peer('b');
      expect(storage.reads, 1);
    });

    // ⚠️ The same trap as the identity's, on the dial path: `viewerRelayCodecs` asks for the
    // peer before every connect and reconnect, and a rejected read held as the answer turned a
    // locked moment into a machine that never reconnected.
    test('a read that failed once is asked again, not held', () async {
      final storage = _FlakyStore()
        ..values[_peersKey] = jsonEncode([
          {'machineId': 'm', 'pub': b64e(List.filled(32, 1)), 'linkedAt': 1},
        ])
        ..failReads = 1;
      final store = ViewerKeyStore(storage: storage);
      await expectLater(store.peer('m'), throwsStateError);
      expect((await store.peer('m'))!.machineId, 'm');
    });

    test('a pin that did not reach the disk is not believed', () async {
      final storage = _FlakyStore()..failWrites = 1;
      final store = ViewerKeyStore(storage: storage);
      await expectLater(store.pin('m', List.filled(32, 1)), throwsStateError);
      expect(await store.peer('m'), isNull);
    });

    test('a row round-trips through its JSON', () {
      final peer = MachinePeer.tryParse({
        'machineId': 'm',
        'pub': b64e(List.filled(32, 4)),
        'label': 'Mac',
        'linkedAt': 1000,
      })!;
      expect(peer.toJson(), {
        'machineId': 'm',
        'pub': b64e(List.filled(32, 4)),
        'label': 'Mac',
        'linkedAt': 1000,
      });
    });
  });

  group('what one account trusts', () {
    test('a snapshot put back is the pins and the trust group it was taken of — never the held pins', () async {
      final storage = _FlakyStore();
      final store = ViewerKeyStore(storage: storage);
      await store.pin('a', List.filled(32, 1), label: 'A');
      await store.writeGroupRoster({'members': [], 'removed': []});
      final snapshot = await store.trustSnapshot();

      await store.writeTrust(const {});
      expect(
        await store.peers(),
        isEmpty,
        reason: 'the held list is replaced, not read stale',
      );
      expect(await store.groupRoster(), isNull);

      await store.pin('b', List.filled(32, 2));
      await store.writeTrust(snapshot);
      expect([for (final p in await store.peers()) p.machineId], ['a']);
      final reads = storage.reads;
      expect((await store.peer('a'))!.label, 'A');
      expect(storage.reads, reads, reason: 'read once, then held again');
      expect(await store.groupRoster(), {'members': [], 'removed': []});
      // And on disk, for the next launch.
      expect(
        [
          for (final p in await ViewerKeyStore(storage: storage).peers())
            p.machineId,
        ],
        ['a'],
      );
    });

    test(
      'the account of a sign-in by hand answers for that sign-in only',
      () async {
        final store = ViewerKeyStore(storage: MemoryKeyValueStore());
        expect(await store.signInAcct('e1'), isNull);
        await store.writeSignInAcct('e1', 'acct-1');
        expect(await store.signInAcct('e1'), 'acct-1');
        expect(await store.signInAcct('e2'), isNull);
      },
    );
  });
}
