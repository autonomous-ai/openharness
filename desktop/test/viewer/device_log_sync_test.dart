import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/e2ee/bytes.dart';
import 'package:harness/e2ee/keys.dart';
import 'package:harness/viewer/device_log.dart';
import 'package:harness/viewer/device_log_sync.dart';
import 'package:harness/viewer/group_sync.dart';
import 'package:harness/viewer/viewer_key_store.dart';

/// The viewer's half of the device key log (`lib/viewer/device_log_sync.dart`), against a backend
/// that keeps the log honestly — or is told to lie.

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

/// A store whose next write of the device log can be held mid-way, to interleave two changes of it.
class _GatedMemory extends _Memory {
  Completer<void>? _hold;
  Completer<void>? _holding;

  /// Hold the next device-log write; the returned future completes once a write is being held.
  Future<void> holdNextLogWrite(Completer<void> release) {
    _hold = release;
    return (_holding = Completer<void>()).future;
  }

  @override
  Future<void> write(String key, String value) async {
    final hold = _hold;
    if (key == 'viewer_e2ee_devlog' && hold != null) {
      _hold = null;
      _holding!.complete();
      await hold.future;
    }
    await super.write(key, value);
  }
}

/// A store whose writes of one key wait while [hold] is set.
class _HeldWrites extends _Memory {
  _HeldWrites(this.key);

  final String key;
  Completer<void>? hold;

  @override
  Future<void> write(String key, String value) async {
    if (key == this.key) await hold?.future;
    await super.write(key, value);
  }
}

/// A store whose sign-in id cannot be read once [broken] is set.
class _NoSignIn extends _Memory {
  bool broken = false;

  @override
  Future<String?> read(String key) async {
    if (broken && key == 'viewer_e2ee_sign_in') throw StateError('unreadable');
    return super.read(key);
  }
}

/// A store whose writes of the kept logs of other accounts fail after [allowed] more, once set.
class _FailingArchive extends _Memory {
  int? allowed;

  @override
  Future<void> write(String key, String value) async {
    final left = allowed;
    if (key == 'viewer_e2ee_devlog_archive' && left != null) {
      if (left <= 0) throw StateError('disk full');
      allowed = left - 1;
    }
    await super.write(key, value);
  }
}

/// A store whose next write of the sign-in id waits for [hold], then fails.
class _LostSignIn extends _Memory {
  Completer<void>? hold;

  @override
  Future<void> write(String key, String value) async {
    final h = hold;
    if (key == 'viewer_e2ee_sign_in' && h != null) {
      hold = null;
      await h.future;
      throw StateError('disk full');
    }
    await super.write(key, value);
  }
}

/// Lets whatever is runnable run (crypto included), for at most [ms].
Future<void> _settle(Future<void> f, [int ms = 300]) =>
    Future.any([f, Future<void>.delayed(Duration(milliseconds: ms))]);

const _acct = 'acct-1';
final _mid2 = 'b' * 32, _mid3 = 'c' * 32;

class _Backend {
  _Backend([this.acct = _acct]) : state = DevLogState.empty(acct);

  /// The account this backend serves.
  final String acct;
  final entries = <DevLogEntry>[];
  DevLogState state;
  List<DevLogEntry>? lie;
  final fetched = <int>[];
  bool offline = false;

  /// Hold the next fetch until this completes; [fetchHeld] completes once it is being held.
  Completer<void>? holdFetch;
  Completer<void>? fetchHeld;

  Future<void> add(E2eeIdentity who, String kind, String machineId, String label) async {
    final pub = b64e(who.pub);
    final e = await signDevLogEntry(
      nextDevLogEntry(state, op: 'add', pub: pub, kind: kind, machineId: machineId, label: label, signer: pub, at: 1000),
      who,
    );
    await _push(e);
  }

  Future<void> removeBy(String target, E2eeIdentity by) async {
    final t = state.active[target]!;
    final e = await signDevLogEntry(
      nextDevLogEntry(state, op: 'remove', pub: t.pub, kind: t.kind, machineId: t.machineId, label: t.label, signer: b64e(by.pub), at: 2000),
      by,
    );
    await _push(e);
  }

  Future<void> _push(DevLogEntry e) async {
    state = (await applyDevLogEntries(state, [e.toJson()])).state;
    entries.add(e);
  }

  Future<DeviceLogFetched?> fetch(int since) async {
    fetched.add(since);
    final hold = holdFetch;
    if (hold != null) {
      holdFetch = null;
      fetchHeld?.complete();
      await hold.future;
    }
    if (offline) return null;
    final log = lie ?? entries;
    final head = log.isEmpty
        ? DevLogState.empty(acct).head
        : (await applyDevLogEntries(DevLogState.empty(acct), [for (final e in log) e.toJson()])).state.head;
    return (acct: acct, head: head, entries: [for (final e in log) if (e.seq > since) e.toJson()]);
  }

  Future<DeviceLogAppendAnswer?> append(DevLogEntry entry) async {
    if (entry.seq != state.head.seq + 1 || entry.prev != state.head.hash) {
      return (head: state.head, error: 'STALE_HEAD');
    }
    try {
      await _push(entry);
    } on DevLogError catch (e) {
      return (head: null, error: e.code);
    }
    return (head: state.head, error: null);
  }
}

void main() {
  late _Backend backend;
  late ViewerKeyStore keys;
  late List<DevLogMember> announced;
  late List<DeviceRemovalNotice> removed;
  late int signedOut;
  late E2eeIdentity box2, box3;

  ViewerDeviceLog makeLog() => ViewerDeviceLog(
    keys: keys,
    fetch: backend.fetch,
    append: backend.append,
    label: () => 'my-phone',
    onAnnounce: announced.add,
    onRemoved: removed.add,
    onSignedOut: () async => signedOut++,
    now: () => 5000,
    sleep: (_) async {},
  );

  setUp(() async {
    backend = _Backend();
    keys = ViewerKeyStore(storage: _Memory());
    announced = [];
    removed = [];
    signedOut = 0;
    box2 = await E2eeIdentity.fromSeed(List.filled(32, 2));
    box3 = await E2eeIdentity.fromSeed(List.filled(32, 3));
  });

  test('registers this app and pins every machine already in the log, announcing none', () async {
    await backend.add(box2, 'machine', _mid2, 'box2');
    final log = makeLog();
    await log.register();
    final me = b64e((await keys.identity()).pub);
    expect(backend.state.active[me]?.kind, 'viewer');
    expect(backend.state.active[me]?.label, 'my-phone');
    expect(b64e((await keys.peer(_mid2))!.pub), b64e(box2.pub));
    expect(announced, isEmpty);
  });

  test('a machine added later is pinned and announced once', () async {
    final log = makeLog();
    await log.register();
    await backend.add(box3, 'machine', _mid3, 'box3');
    await log.refresh();
    await log.refresh();
    expect(await keys.peer(_mid3), isNotNull);
    expect(announced.map((m) => m.label), ['box3']);
    // …and the trust group this app swaps with machines names it, for machines that predate the log.
    final roster = GroupRoster.parse(await keys.groupRoster());
    expect(roster.members.map((m) => m.pub), contains(b64e(box3.pub)));
  });

  test('a machine this app had already linked is not news', () async {
    await keys.pin(_mid3, box3.pub, label: 'box3');
    final log = makeLog();
    await log.register();
    await backend.add(box3, 'machine', _mid3, 'box3');
    await log.refresh();
    expect(announced, isEmpty);
  });

  test('a removed machine is unpinned', () async {
    await backend.add(box2, 'machine', _mid2, 'box2');
    final log = makeLog();
    await log.register();
    expect(await log.remove(b64e(box2.pub)), isNull);
    expect(await keys.peer(_mid2), isNull);
    expect(backend.state.active[b64e(box2.pub)], isNull);
  });

  test('its own key removed signs it out', () async {
    await backend.add(box2, 'machine', _mid2, 'box2');
    final log = makeLog();
    await log.register();
    await backend.removeBy(b64e((await keys.identity()).pub), box2);
    await log.refresh();
    expect(signedOut, 1);
  });

  test('signing in again after a removal comes back under a new key, without signing out', () async {
    await backend.add(box2, 'machine', _mid2, 'box2');
    final log = makeLog();
    await log.register();
    final old = b64e((await keys.identity()).pub);
    await backend.removeBy(old, box2);
    // Signed out by the removal before reading the log (a revoked session answers 401 first)…
    await log.register(freshSignIn: true);
    final now = b64e((await keys.identity()).pub);
    expect(now, isNot(old));
    expect(backend.state.active[now]?.kind, 'viewer');
    expect(signedOut, 0);
  });

  test('opening under a removed key still signs out', () async {
    await backend.add(box2, 'machine', _mid2, 'box2');
    final log = makeLog();
    await log.register();
    await backend.removeBy(b64e((await keys.identity()).pub), box2);
    await log.register();
    expect(signedOut, 1);
  });

  test('freezes on a rewritten log and pins nothing more from it', () async {
    await backend.add(box2, 'machine', _mid2, 'box2');
    final log = makeLog();
    await log.register();
    final forged = _Backend();
    await forged.add(box2, 'machine', _mid2, 'box2');
    await forged.add(box3, 'machine', _mid3, 'evil');
    await forged.add(await E2eeIdentity.fromSeed(List.filled(32, 9)), 'viewer', '', 'x');
    backend.lie = forged.entries;
    await log.refresh();
    expect((await log.list()).frozen?.reason, 'fork');
    expect(await keys.peer(_mid3), isNull);
  });

  test('freezes on a rollback, and trusting again shows the change first', () async {
    await backend.add(box2, 'machine', _mid2, 'box2');
    final log = makeLog();
    await log.register();
    backend.lie = backend.entries.sublist(0, 1);
    await log.refresh();
    expect((await log.list()).frozen?.reason, 'rollback');
    backend.lie = null;
    await backend.add(box3, 'machine', _mid3, 'box3');
    final preview = await log.rebaseline(confirm: false);
    expect(preview!.added.map((m) => m.label), ['box3']);
    expect((await log.list()).frozen, isNotNull);
    await log.rebaseline(confirm: true);
    expect((await log.list()).frozen, isNull);
    expect(await keys.peer(_mid3), isNotNull);
  });

  test('a machine answering with a different entry at a verified position freezes it', () async {
    await backend.add(box2, 'machine', _mid2, 'box2');
    final log = makeLog();
    await log.register();
    final other = _Backend();
    await other.add(box3, 'machine', _mid3, 'box3');
    await other.add(box2, 'machine', _mid2, 'box2');
    await log.heard(b64e(box2.pub), {'head': other.state.head.toJson(), 'frozen': false});
    expect((await log.list()).frozen?.reason, 'fork');
  });

  test('says which machines report a frozen log', () async {
    await backend.add(box2, 'machine', _mid2, 'box2');
    final log = makeLog();
    await log.register();
    await log.heard(b64e(box2.pub), {'head': backend.state.head.toJson(), 'frozen': true});
    expect((await log.list()).frozenPeers, ['box2']);
  });

  test('a removal the trust group made before the log is written into it, without hanging the read', () async {
    await backend.add(box2, 'machine', _mid2, 'box2');
    await keys.writeGroupRoster(GroupRoster(const [], [GroupTombstone(b64e(box2.pub), 900)]).toJson());
    final log = makeLog();
    await log.register().timeout(const Duration(seconds: 5));
    for (var i = 0; i < 50 && backend.state.active[b64e(box2.pub)] != null; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    expect(backend.state.removed, contains(b64e(box2.pub)));
    expect(await keys.peer(_mid2), isNull);
    // …and the log is still readable afterwards.
    await log.refresh().timeout(const Duration(seconds: 5));
  });

  group('what is new, and what stays visible', () {
    test('a key the pins and roster held before the log read that adds it is still announced and pending', () async {
      final log = makeLog();
      await log.register();
      await keys.pin(_mid3, box3.pub, label: 'box3'); // the trust group got there first
      await backend.add(box3, 'machine', _mid3, 'box3');
      await log.refresh();
      await log.refresh();
      expect(announced.map((m) => m.label), ['box3']);
      final listing = await log.list();
      expect(listing.pending, [b64e(box3.pub)]);
      expect(listing.members.firstWhere((r) => r.member.pub == b64e(box3.pub)).pending, isTrue);
    });

    test('a first read announces nothing and reports the baseline; an empty log announces the first later device', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      await backend.add(box3, 'machine', _mid3, 'box3');
      final log = makeLog();
      await log.refresh();
      expect(announced, isEmpty);
      final listing = await log.list();
      expect(listing.baselineSeen, isFalse);
      expect(listing.joinedSeq, 2);
      expect(listing.pending, isEmpty);

      backend = _Backend();
      keys = ViewerKeyStore(storage: _Memory());
      final empty = makeLog();
      await empty.refresh();
      await backend.add(box2, 'machine', _mid2, 'box2');
      await empty.refresh();
      expect(announced.map((m) => m.label), ['box2']);
    });

    test('pending survives a new instance on the same store; dismiss and seeBaseline persist', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final log = makeLog();
      await log.register();
      await backend.add(box3, 'machine', _mid3, 'box3');
      final other = await E2eeIdentity.fromSeed(List.filled(32, 9));
      await backend.add(other, 'viewer', '', 'tablet');
      await log.refresh();
      final again = makeLog();
      expect((await again.list()).pending, [b64e(box3.pub), b64e(other.pub)]);
      await again.dismiss(pub: b64e(box3.pub));
      expect((await makeLog().list()).pending, [b64e(other.pub)]);
      expect((await again.list()).baselineSeen, isFalse);
      await again.seeBaseline();
      expect((await makeLog().list()).baselineSeen, isTrue);
      await again.dismiss();
      expect((await makeLog().list()).pending, isEmpty);
    });

    test('a file from before the joined point migrates: nothing up to notifiedUpTo is announced again', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      await backend.add(box3, 'machine', _mid3, 'box3');
      final log = makeLog();
      await log.register();
      final stripped = Map<String, Object?>.from((await keys.deviceLog())! as Map)
        ..remove('joinedSeq')
        ..remove('preLog')
        ..remove('pending')
        ..remove('announced')
        ..remove('baselineSeen');
      await keys.writeDeviceLog(stripped);
      await backend.add(await E2eeIdentity.fromSeed(List.filled(32, 9)), 'viewer', '', 'late');
      await log.refresh();
      expect(announced.map((m) => m.label), ['late']);
      final listing = await log.list();
      expect(listing.joinedSeq, 3);
      expect(listing.baselineSeen, isTrue);
    });

    test('a write path keeps the marks (accept, freeze, dismiss)', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final log = makeLog();
      await log.register();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await log.refresh();
      await log.dismiss(pub: 'nobody');
      backend.lie = backend.entries.sublist(0, 1);
      await log.refresh();
      final file = (await keys.deviceLog())! as Map;
      expect(file['joinedSeq'], 1);
      expect(file['pending'], [b64e(box3.pub)]);
      expect(file['baselineSeen'], isFalse);
      expect(file['frozen'], isNotNull);
    });
  });

  group('removal notices', () {
    late E2eeIdentity tablet;
    setUp(() async {
      tablet = await E2eeIdentity.fromSeed(List.filled(32, 9));
      await backend.add(box3, 'machine', _mid3, 'box3'); // on the account before this app joined
    });

    Future<ViewerDeviceLog> joined() async {
      final log = makeLog();
      await log.register();
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.refresh();
      return log;
    }

    test('none for a removal this app signed', () async {
      final log = await joined();
      expect(await log.remove(b64e(box2.pub)), isNull);
      expect(removed, isEmpty);
    });

    test('a device that removed itself signed out', () async {
      final log = await joined();
      await backend.add(tablet, 'viewer', '', 'tablet');
      await backend.removeBy(b64e(tablet.pub), tablet);
      await log.refresh();
      expect(removed.single.selfRemoved, isTrue);
      expect(removed.single.label, 'tablet');
    });

    test('a removal by a trusted key is normal, naming the signer', () async {
      final log = await joined();
      await log.dismiss();
      await backend.removeBy(b64e(box3.pub), box2);
      await log.refresh();
      expect(removed.single.signerLabel, 'box2');
      expect(removed.single.signerPending, isFalse);
      expect(removed.single.selfRemoved, isFalse);
    });

    test('a removal by a signer nobody looked at is red', () async {
      final log = await joined();
      await backend.removeBy(b64e(box3.pub), box2);
      await log.refresh();
      expect(removed.single.signerPending, isTrue);
    });

    test('a removal applied while frozen still says so, and is kept for the history', () async {
      final log = await joined();
      backend.lie = backend.entries.sublist(0, 2);
      await log.refresh();
      backend.lie = null;
      await backend.removeBy(b64e(box3.pub), box2);
      await log.refresh();
      expect(removed.single.signerPending, isTrue);
      expect(((await keys.deviceLog())! as Map)['looseRemoved'], hasLength(1));
      expect((await log.history()).rows.firstWhere((r) => r.op == 'removed').whileFrozen, isTrue);
    });
  });

  group('a fork', () {
    test('suspends the new keys at or after the split, unpins them and keeps the rest', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final log = makeLog();
      await log.register();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await log.refresh();
      final other = _Backend();
      await other.add(box2, 'machine', _mid2, 'box2');
      await other.add(await E2eeIdentity.fromSeed(List.filled(32, 9)), 'viewer', '', 'evil');
      await other.add(box3, 'machine', _mid3, 'box3');
      Map<String, Object?> hashes(DevLogState s) => {
        'head': s.head.toJson(),
        'hashes': [for (var i = 0; i < s.hashes.length; i++) {'seq': i + 1, 'hash': s.hashes[i]}],
      };
      await log.heard(b64e(box2.pub), hashes(other.state));
      expect((await log.list()).frozen?.reason, 'fork');
      expect(await log.suspendedPubs(), {b64e(box3.pub)});
      expect(await keys.peer(_mid3), isNull);
      expect(await keys.peer(_mid2), isNotNull);
      expect((await log.list()).members.firstWhere((r) => r.member.pub == b64e(box3.pub)).suspended, isTrue);
      await log.rebaseline(confirm: true);
      expect(await log.suspendedPubs(), isEmpty);
      expect(await keys.peer(_mid3), isNotNull);
    });

    Map<String, Object?> gossipOf(DevLogState s) => {
      'head': s.head.toJson(),
      'hashes': [for (var i = 0; i < s.hashes.length; i++) {'seq': i + 1, 'hash': s.hashes[i]}],
    };

    Future<(ViewerDeviceLog, _Backend)> forkedSetup() async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final log = makeLog();
      await log.register(); // box2 (1), this app (2)
      await backend.add(box3, 'machine', _mid3, 'box3'); // 3: new since joining
      await log.refresh();
      final other = _Backend();
      await other.add(box2, 'machine', _mid2, 'box2');
      await other.add(await E2eeIdentity.fromSeed(List.filled(32, 9)), 'viewer', '', 'evil');
      await other.add(box3, 'machine', _mid3, 'box3');
      return (log, other);
    }

    test('a log already frozen on a fork still learns the split from a machine that is ahead', () async {
      final (log, other) = await forkedSetup();
      backend.lie = other.entries; // same length, a different entry at 2
      await log.refresh();
      expect((await log.list()).frozen?.reason, 'fork');
      expect(await log.suspendedPubs(), isEmpty);
      await other.add(await E2eeIdentity.fromSeed(List.filled(32, 7)), 'viewer', '', 'later');
      await log.heard(b64e(box2.pub), gossipOf(other.state));
      expect(await log.suspendedPubs(), {b64e(box3.pub)});
      expect(await keys.peer(_mid3), isNull);
    });

    test('a removal signed by a suspended key does not count while frozen', () async {
      final (log, other) = await forkedSetup();
      await log.heard(b64e(box2.pub), gossipOf(other.state));
      expect(await log.suspendedPubs(), {b64e(box3.pub)});
      await backend.removeBy(b64e(box2.pub), box3); // the suspended key tries to take out a trusted machine
      await log.refresh();
      expect(removed, isEmpty);
      expect((await log.list()).members.map((r) => r.member.pub), contains(b64e(box2.pub)));
      expect(await keys.peer(_mid2), isNotNull);
      expect(((await keys.deviceLog())! as Map)['looseRemoved'], isNull);
    });

    test('without hashes nothing is suspended', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final log = makeLog();
      await log.register();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await log.refresh();
      final other = _Backend();
      await other.add(box3, 'machine', _mid3, 'box3');
      await other.add(box2, 'machine', _mid2, 'box2');
      await other.add(await E2eeIdentity.fromSeed(List.filled(32, 9)), 'viewer', '', 'x');
      await log.heard(b64e(box2.pub), {'head': other.state.head.toJson()});
      expect(await log.suspendedPubs(), isEmpty);
    });

    test('devLogDivergence finds the first differing position the one before confirms', () async {
      final log = _Backend();
      await log.add(box2, 'machine', _mid2, 'box2');
      await log.add(box3, 'machine', _mid3, 'box3');
      final mine = log.state;
      Map<String, Object?> theirs(List<String> h) => {
        'head': {'seq': h.length, 'hash': h.last},
        'hashes': [for (var i = 0; i < h.length; i++) {'seq': i + 1, 'hash': h[i]}],
      };
      expect(devLogDivergence(mine, theirs([mine.hashes[0], 'x'])), 2);
      expect(devLogDivergence(mine, theirs(['x', 'y'])), 1);
      expect(devLogDivergence(mine, theirs(mine.hashes)), isNull);
      expect(devLogDivergence(mine, null), isNull);
      expect(devLogDivergence(mine, {'head': mine.head.toJson()}), isNull);
    });

    test('gossip carries the newest hashes', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final log = makeLog();
      await log.register();
      final g = (await log.gossip())!;
      expect((g['hashes']! as List).length, 2);
      expect((g['hashes']! as List).last, {'seq': 2, 'hash': backend.state.head.hash});
    });
  });

  group('history', () {
    test('lists every entry newest first, caches, fetches only what is missing, and falls back offline', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final log = makeLog();
      await log.register();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await backend.removeBy(b64e(box3.pub), box2);
      final h = await log.history();
      expect(h.complete, isTrue);
      expect([for (final r in h.rows) '${r.seq}:${r.op}'], ['4:removed', '3:added', '2:added', '1:added']);
      expect(h.rows.first.by?.label, 'box2');
      expect(h.rows.first.active, isFalse);
      expect(h.rows[2].thisDevice, isTrue);
      backend.fetched.clear();
      await backend.add(await E2eeIdentity.fromSeed(List.filled(32, 9)), 'viewer', '', 'late');
      await log.history();
      expect(backend.fetched, [4, 4]);
      backend.offline = true;
      final fresh = makeLog();
      final off = await fresh.history();
      expect(off.complete, isFalse);
      expect([for (final r in off.rows) r.seq], [5, 4, 3, 2, 1]);
    });

    test('freezes when the backend serves a different entry at a verified position', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final log = makeLog();
      await log.register();
      final forged = _Backend();
      await forged.add(box2, 'machine', _mid2, 'box2');
      await forged.add(box3, 'machine', _mid3, 'not-me');
      final fresh = ViewerDeviceLog(
        keys: keys,
        fetch: (since) async {
          // The head is the real one; the entry served at position 2 is not what this app verified.
          final real = (await backend.fetch(since))!;
          return (acct: real.acct, head: real.head, entries: since < 2 ? [backend.entries[0].toJson(), forged.entries[1].toJson()] : real.entries);
        },
        append: backend.append,
        label: () => 'my-phone',
        now: () => 5000,
        sleep: (_) async {},
      );
      final h = await fresh.history();
      expect(h.complete, isFalse);
      expect((await fresh.list()).frozen?.reason, 'fork');
    });
  });

  group('changes to the file never cross', () {
    late _GatedMemory store;
    late E2eeIdentity tablet;
    setUp(() async {
      store = _GatedMemory();
      keys = ViewerKeyStore(storage: store);
      tablet = await E2eeIdentity.fromSeed(List.filled(32, 9));
      await backend.add(box2, 'machine', _mid2, 'box2');
      final log = makeLog();
      await log.register();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await log.refresh();
      expect(announced.map((m) => m.label), ['box3']);
    });

    Future<void> expectSettled(ViewerDeviceLog log) async {
      final listing = await log.list();
      expect(listing.pending, [b64e(tablet.pub)], reason: 'box3 dismissed, tablet still new');
      expect(((await keys.deviceLog())! as Map)['state']['head']['seq'], 4);
      // Nothing was rolled back, so nothing is read — or announced — a second time.
      await log.refresh();
      expect(announced.map((m) => m.label), ['box3', 'tablet']);
      expect((await log.list()).frozen, isNull);
    }

    test('a dismissal that read the file before an accept wrote it does not roll the head back', () async {
      final log = makeLog();
      await backend.add(tablet, 'viewer', '', 'tablet');
      final release = Completer<void>();
      final held = store.holdNextLogWrite(release);
      final dismissed = log.dismiss(pub: b64e(box3.pub));
      await held; // the dismissal has read the file and is writing it
      final refreshed = log.refresh();
      await _settle(refreshed);
      release.complete();
      await Future.wait([dismissed, refreshed]);
      await expectSettled(log);
    });

    test('an accept that read the file before a dismissal wrote it does not undo the dismissal', () async {
      final log = makeLog();
      await backend.add(tablet, 'viewer', '', 'tablet');
      final release = Completer<void>();
      final held = store.holdNextLogWrite(release);
      final refreshed = log.refresh();
      await held; // the accept of tablet is writing the file
      final dismissed = log.dismiss(pub: b64e(box3.pub));
      await _settle(dismissed);
      release.complete();
      await Future.wait([dismissed, refreshed]);
      await expectSettled(log);
    });

    test('seeing the baseline while a peer hands over its tail keeps both', () async {
      final log = makeLog();
      final before = backend.state.head;
      await backend.add(tablet, 'viewer', '', 'tablet');
      final release = Completer<void>();
      final held = store.holdNextLogWrite(release);
      final seen = log.seeBaseline();
      await held;
      final heard = log.heard(b64e(box2.pub), {
        'head': backend.state.head.toJson(),
        'frozen': false,
        'tail': [for (final e in backend.entries) if (e.seq > before.seq) e.toJson()],
      });
      await _settle(heard);
      release.complete();
      await Future.wait([seen, heard]);
      final file = (await keys.deviceLog())! as Map;
      expect(file['baselineSeen'], isTrue);
      expect(file['state']['head']['seq'], 4);
      expect(announced.map((m) => m.label), ['box3', 'tablet']);
    });

    test('a page that arrives after a peer moved the log is read again, not taken for a fork', () async {
      final log = makeLog();
      await backend.add(tablet, 'viewer', '', 'tablet');
      final viaPeer = backend.entries[3]; // tablet, seq 4
      final other = await E2eeIdentity.fromSeed(List.filled(32, 7));
      await backend.add(other, 'viewer', '', 'laptop'); // seq 5
      backend
        ..holdFetch = Completer<void>()
        ..fetchHeld = Completer<void>();
      final release = backend.holdFetch!;
      final refreshed = log.refresh(); // asks for everything after seq 3
      await backend.fetchHeld!.future;
      final head4 = (await applyDevLogEntries(DevLogState.empty(_acct), [for (final e in backend.entries.take(4)) e.toJson()])).state.head;
      await log.heard(b64e(box2.pub), {'head': head4.toJson(), 'frozen': false, 'tail': [viaPeer.toJson()]});
      release.complete();
      await refreshed;
      final listing = await log.list();
      expect(listing.frozen, isNull);
      expect(((await keys.deviceLog())! as Map)['state']['head']['seq'], 5);
      expect(announced.map((m) => m.label), ['box3', 'tablet', 'laptop']);
    });
  });

  group('the joined point, reviews, history and dismissals', () {
    late E2eeIdentity evil;
    setUp(() async => evil = await E2eeIdentity.fromSeed(List.filled(32, 9)));

    ViewerDeviceLog logWith(DeviceLogFetch f) => ViewerDeviceLog(
      keys: keys,
      fetch: f,
      append: backend.append,
      label: () => 'my-phone',
      onAnnounce: announced.add,
      onRemoved: removed.add,
      onSignedOut: () async => signedOut++,
      now: () => 5000,
      sleep: (_) async {},
    );

    Map<String, Object?> gossipOf(DevLogState s) => {
      'head': s.head.toJson(),
      'hashes': [for (var i = 0; i < s.hashes.length; i++) {'seq': i + 1, 'hash': s.hashes[i]}],
    };

    test('the joined point is the VERIFIED head, never the one the backend claims', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      await backend.add(box3, 'machine', _mid3, 'box3');
      var first = true;
      final log = logWith((since) async {
        final got = await backend.fetch(since);
        if (got == null || !first) return got;
        first = false;
        return (acct: got.acct, head: DevLogHead(1000, 'x' * 64), entries: got.entries);
      });
      await log.refresh();
      final listing = await log.list();
      expect(listing.frozen, isNull);
      expect(listing.joinedSeq, 2);
      // A key forged below the claimed 1000 is still new.
      await backend.add(evil, 'viewer', '', 'evil');
      await log.refresh();
      expect(announced.map((m) => m.label), ['evil']);
      expect((await log.list()).pending, [b64e(evil.pub)]);
    });

    test('a head that is not a position is not read at all', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final log = logWith((since) async {
        final got = await backend.fetch(since);
        return got == null ? null : (acct: got.acct, head: DevLogHead(-1, 'h'), entries: got.entries);
      });
      await log.refresh();
      final listing = await log.list();
      expect(listing.members, isEmpty);
      // Not read at all — judged against it, a fresh file would read as rolled back and freeze.
      expect(listing.frozen, isNull);
    });

    group('rebaseline(confirm)', () {
      late ViewerDeviceLog log;
      setUp(() async {
        await backend.add(box2, 'machine', _mid2, 'box2');
        log = makeLog();
        await log.register();
        backend.lie = backend.entries.sublist(0, 1);
        await log.refresh(); // frozen (rolled back)
        backend.lie = null;
      });

      test('a key the preview did not show is pending and announced', () async {
        final preview = await log.rebaseline(confirm: false);
        expect(preview, isNotNull);
        await backend.add(evil, 'viewer', '', 'evil'); // between preview and confirm
        expect(await log.rebaseline(confirm: true), isNotNull);
        expect((await log.list()).pending, [b64e(evil.pub)]);
        expect(announced.map((m) => m.label), ['evil']);
      });

      test('refuses when the backend head is no longer the one previewed', () async {
        final preview = (await log.rebaseline(confirm: false))!;
        await backend.add(evil, 'viewer', '', 'evil');
        expect((await log.rebaseline(confirm: true, expectedHead: preview.head))!.logChanged, isTrue);
        expect((await log.list()).frozen, isNotNull);
        expect(announced, isEmpty);
        final again = (await log.rebaseline(confirm: false))!;
        expect((await log.rebaseline(confirm: true, expectedHead: again.head))!.logChanged, isFalse);
        expect((await log.list()).frozen, isNull);
      });
    });

    group('a fork does not cost the user the devices they reviewed', () {
      late ViewerDeviceLog log;
      late _Backend other;
      setUp(() async {
        await backend.add(box2, 'machine', _mid2, 'box2');
        log = makeLog();
        await log.register(); // box2 (1), this app (2)
        await backend.add(box3, 'machine', _mid3, 'box3'); // 3: new since joining
        await log.refresh();
        other = _Backend();
        await other.add(box2, 'machine', _mid2, 'box2');
        await other.add(evil, 'viewer', '', 'evil');
        await other.add(box3, 'machine', _mid3, 'box3');
      });

      test('O2: a key already marked as seen is not suspended', () async {
        await log.dismiss(pubs: [b64e(box3.pub)]);
        await log.heard(b64e(box2.pub), gossipOf(other.state));
        expect((await log.list()).frozen?.reason, 'fork');
        expect(await log.suspendedPubs(), isEmpty);
      });

      test('O2: a key let in by a review is not suspended', () async {
        backend.lie = backend.entries.sublist(0, 1);
        await log.refresh();
        backend.lie = null;
        await log.rebaseline(confirm: true);
        expect((await log.list()).pending, contains(b64e(box3.pub)));
        await log.heard(b64e(box2.pub), gossipOf(other.state));
        expect(await log.suspendedPubs(), isEmpty);
      });

      test('O2: a key that is new here is still suspended', () async {
        await log.heard(b64e(box2.pub), gossipOf(other.state));
        expect(await log.suspendedPubs(), {b64e(box3.pub)});
      });

      test('"It\'s mine" on a suspended key lifts its suspension; a list that was merely viewed does not', () async {
        await log.heard(b64e(box2.pub), gossipOf(other.state));
        await log.dismiss(pubs: [b64e(box3.pub)]);
        expect(await log.suspendedPubs(), {b64e(box3.pub)});
        expect((await log.list()).pending, [b64e(box3.pub)]); // still flagged
        expect(await keys.peer(_mid3), isNull);
        await log.dismiss(pub: b64e(box3.pub));
        expect(await log.suspendedPubs(), isEmpty);
        expect((await log.list()).pending, isEmpty);
        expect(await keys.peer(_mid3), isNotNull);
      });
    });

    test('two history() calls at once share one walk and freeze nothing', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final log = makeLog();
      await log.register();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await backend.add(evil, 'viewer', '', 'evil');
      await log.refresh();
      // Each page takes a moment, so the two walks really are in flight together.
      final fresh = logWith((since) async {
        await Future<void>.delayed(const Duration(milliseconds: 5));
        return backend.fetch(since);
      });
      final both = await Future.wait([fresh.history(), fresh.history()]);
      expect((await fresh.list()).frozen, isNull);
      expect(both[0].complete, isTrue);
      expect([for (final r in both[1].rows) r.seq], [4, 3, 2, 1]);
    });

    test('dismiss with a list clears only what it names', () async {
      final log = makeLog();
      await log.register();
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.refresh();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await log.refresh();
      await log.dismiss(pubs: [b64e(box2.pub)]);
      expect((await log.list()).pending, [b64e(box3.pub)]);
    });

    test('keys trusted at joining whose entry came after the joined point are in the baseline', () async {
      await keys.pin(_mid2, box2.pub, label: 'box2'); // trusted before the log
      await backend.add(box3, 'machine', _mid3, 'box3');
      final log = makeLog();
      await log.refresh();
      await backend.add(box2, 'machine', _mid2, 'box2'); // seq 2 > joinedSeq 1
      await log.refresh();
      final listing = await log.list();
      expect(listing.baseline.toSet(), {b64e(box2.pub), b64e(box3.pub)});
      expect(listing.pending, isEmpty);
    });

    test('a removal is described by the label and kind the key had, not the remove entry\'s own', () async {
      await backend.add(box3, 'machine', _mid3, 'box3');
      final log = makeLog();
      await log.register();
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.refresh();
      await log.dismiss();
      final lie = await signDevLogEntry(
        nextDevLogEntry(backend.state, op: 'remove', pub: b64e(box2.pub), kind: 'viewer', machineId: '', label: 'Totally Fine', signer: b64e(box3.pub), at: 2000),
        box3,
      );
      await backend._push(lie);
      await log.refresh();
      expect(removed.single.label, 'box2');
      expect(removed.single.kind, 'machine');
      final h = await log.history();
      expect(h.rows.first.label, 'box2');
      expect(h.rows.first.kind, 'machine');
    });
  });

  group('a backend that moves the list under a running read', () {
    late E2eeIdentity evil;
    setUp(() async => evil = await E2eeIdentity.fromSeed(List.filled(32, 9)));

    ViewerDeviceLog logWith(DeviceLogFetch f) => ViewerDeviceLog(
      keys: keys,
      fetch: f,
      append: backend.append,
      label: () => 'my-phone',
      onAnnounce: announced.add,
      onRemoved: removed.add,
      onSignedOut: () async => signedOut++,
      now: () => 5000,
      sleep: (_) async {},
    );

    Future<void> editFile(void Function(Map<String, Object?> file) edit) async {
      final file = Map<String, Object?>.from(await keys.deviceLog() as Map);
      edit(file);
      await keys.writeDeviceLog(file);
    }

    test('a backend that flips the account id and back keeps a fork\'s marks', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      var wrong = false;
      final log = logWith((since) async {
        if (wrong) return (acct: 'x', head: DevLogState.empty('x').head, entries: <Object?>[]);
        return backend.fetch(since);
      });
      await log.register();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await log.refresh();
      await editFile((f) => f['suspended'] = [b64e(box3.pub)]);
      expect((await log.list()).pending, [b64e(box3.pub)]);
      wrong = true;
      await log.refresh();
      expect((await log.list()).frozen?.reason, 'invalid');
      wrong = false;
      await log.refresh(); // the real log again
      final listing = await log.list();
      expect(listing.frozen?.reason, 'invalid');
      expect(listing.suspended, [b64e(box3.pub)]);
      expect(listing.pending, [b64e(box3.pub)]);
      expect(listing.members.firstWhere((r) => r.member.pub == b64e(box3.pub)).suspended, isTrue);
    });

    test('rebaseline: unreadable is null, a moved list is logChanged', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final log = makeLog();
      await log.register();
      backend.offline = true;
      expect(await log.rebaseline(confirm: false), isNull);
      backend.offline = false;
      final preview = (await log.rebaseline(confirm: false))!;
      expect(preview.logChanged, isFalse);
      await backend.add(evil, 'viewer', '', 'evil');
      final moved = await log.rebaseline(confirm: true, expectedHead: preview.head);
      expect(moved!.logChanged, isTrue);
      expect(moved.added, isEmpty);
    });

    test('a rebaseline during the history walk does not freeze the fresh log', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      await backend.add(box3, 'machine', _mid3, 'box3');
      var armed = false;
      final alt = _Backend();
      await alt.add(evil, 'viewer', '', 'evil');
      await alt.add(box2, 'machine', _mid2, 'box2');
      final log = logWith((since) async {
        if (armed && since == 0) {
          // The person confirms a review while this page is on its way: the file, and what the backend
          // serves, are another list now.
          armed = false;
          await editFile((f) => f['state'] = alt.state.toJson());
          backend.lie = alt.entries;
        }
        return backend.fetch(since);
      });
      await log.register();
      armed = true;
      final h = await log.history();
      expect((await log.list()).frozen, isNull);
      expect(h.complete, isFalse);
    });

    test('a peer tail that arrives while the first read is still open announces nothing', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      await backend.add(box3, 'machine', _mid3, 'box3');
      await backend.add(evil, 'viewer', '', 'evil');
      late ViewerDeviceLog log;
      var calls = 0;
      log = logWith((since) async {
        calls++;
        final got = await backend.fetch(since);
        // The first read comes in one entry at a time; between its pages a peer hands over the rest.
        if (calls == 1) return (acct: got!.acct, head: got.head, entries: got.entries.sublist(0, 1));
        if (calls == 2) {
          await log.heard(b64e(box2.pub), {
            'head': backend.state.head.toJson(),
            'frozen': false,
            'tail': [for (final e in backend.entries.skip(1)) e.toJson()],
          });
        }
        return got;
      });
      await log.refresh();
      expect(announced, isEmpty);
      expect((await log.list()).joinedSeq, 3);
      expect((await keys.deviceLog() as Map).containsKey('joining'), isFalse);
      await backend.add(await E2eeIdentity.fromSeed(List.filled(32, 7)), 'viewer', '', 'later');
      await log.refresh();
      expect(announced.map((m) => m.label), ['later']);
    });
  });

  group('signing in again, and to other accounts', () {
    late E2eeIdentity evil, phone;
    setUp(() async {
      evil = await E2eeIdentity.fromSeed(List.filled(32, 9));
      phone = await E2eeIdentity.fromSeed(List.filled(32, 7));
    });

    /// A log whose backend is whichever [at] says now — another account's, after a sign-in.
    ViewerDeviceLog at(_Backend Function() at, {DeviceLogFetch? fetch}) => ViewerDeviceLog(
      keys: keys,
      fetch: fetch ?? (since) => at().fetch(since),
      append: (e) => at().append(e),
      label: () => 'my-phone',
      onAnnounce: announced.add,
      onRemoved: removed.add,
      onSignedOut: () async => signedOut++,
      now: () => 5000,
      sleep: (_) async {},
    );

    Future<Map<Object?, Object?>> file() async => await keys.deviceLog() as Map;

    /// A fork suspended box3, still pending, and the list is frozen on it.
    Future<void> forked(ViewerDeviceLog log) async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.register(freshSignIn: true);
      await backend.add(box3, 'machine', _mid3, 'box3');
      await log.refresh();
      final f = Map<String, Object?>.from(await file());
      f['suspended'] = [b64e(box3.pub)];
      f['frozen'] = {'reason': 'fork', 'at': 1, 'lastGoodHead': backend.state.head.toJson()};
      await keys.writeDeviceLog(f);
      await keys.unlink(_mid3); // as the suspension does
    }

    Future<Set<String>> rosterPubs() async => {for (final m in GroupRoster.parse(await keys.groupRoster()).members) m.pub};

    test('signing in again by hand to the same account keeps the list and every mark on it', () async {
      var current = backend;
      final log = at(() => current);
      await forked(log);
      final owner = (await file())['owner'];
      await log.register(freshSignIn: true);
      final listing = await log.list();
      expect((await file())['owner'], isNot(owner));
      expect(listing.frozen?.reason, 'fork');
      expect(listing.suspended, [b64e(box3.pub)]);
      expect(listing.pending, [b64e(box3.pub)]);
      expect(listing.joinedSeq, 1);
      // That sign-in is the file's now: the backend saying another account freezes, never starts over.
      final f = Map<String, Object?>.from(await file())..['frozen'] = null;
      await keys.writeDeviceLog(f);
      current = _Backend('x');
      await log.refresh();
      expect((await log.list()).frozen?.reason, 'invalid');
      expect((await log.list()).suspended, [b64e(box3.pub)]);
    });

    test('a sign-in the backend forced, onto a made-up account and back, gives the first account its marks back', () async {
      var current = backend;
      final log = at(() => current);
      await forked(log);
      final fake = _Backend('x');
      await fake.add(box3, 'machine', _mid3, 'box3');
      await fake.add(evil, 'viewer', '', 'evil');
      current = fake;
      await log.register(freshSignIn: true);
      expect(((await file())['state'] as Map)['acct'], 'x');
      expect(await rosterPubs(), contains(b64e(evil.pub)));
      expect(await keys.peer(_mid3), isNull);
      expect(await log.suspendedPubs(), contains(b64e(box3.pub)));
      current = backend;
      await log.register(freshSignIn: true);
      final listing = await log.list();
      expect(((await file())['state'] as Map)['acct'], _acct);
      expect(listing.frozen?.reason, 'fork');
      expect(listing.suspended, [b64e(box3.pub)]);
      expect(listing.pending, [b64e(box3.pub)]);
      expect(listing.joinedSeq, 1);
    });

    test('a sign-in by hand to another account starts it fresh, and switching back restores the first', () async {
      var current = backend;
      final log = at(() => current);
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.register(freshSignIn: true);
      await backend.add(box3, 'machine', _mid3, 'box3');
      await log.refresh();
      expect((await log.list()).pending, [b64e(box3.pub)]);
      final other = _Backend('acct-2');
      await other.add(phone, 'viewer', '', 'theirs');
      current = other;
      await log.register(freshSignIn: true);
      var listing = await log.list();
      expect(((await file())['state'] as Map)['acct'], 'acct-2');
      expect(listing.pending, isEmpty);
      expect(listing.baselineSeen, isFalse);
      current = backend;
      await log.register(freshSignIn: true);
      listing = await log.list();
      expect(((await file())['state'] as Map)['acct'], _acct);
      expect(listing.pending, [b64e(box3.pub)]);
      expect(announced.map((m) => m.label), ['box3']);
    });

    test('only the newest few other accounts are kept', () async {
      var current = backend;
      final log = at(() => current);
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.register(freshSignIn: true);
      for (var i = 0; i < 5; i++) {
        current = _Backend('acct-b$i');
        await log.register(freshSignIn: true);
      }
      expect((await keys.deviceLogArchive()).keys, ['acct-b0', 'acct-b1', 'acct-b2', 'acct-b3']);
    });

    test('a session from before sign-in ids takes the list over but never starts it over', () async {
      var current = backend;
      final log = at(() => current);
      await forked(log);
      await keys.writeSignInEpoch('');
      final restarted = at(() => current);
      current = _Backend('x');
      await restarted.refresh();
      final listing = await restarted.list();
      expect(listing.frozen?.reason, 'fork');
      expect(listing.suspended, [b64e(box3.pub)]);
      expect(((await file())['state'] as Map)['acct'], _acct);
      expect(await keys.signInEpoch(), startsWith('adopted:'));
      current = backend;
      await restarted.refresh();
      expect((await file())['owner'], await keys.signInEpoch());
    });

    test('a file from before it recorded its sign-in starts over for a sign-in by hand to another account', () async {
      var current = backend;
      final log = at(() => current);
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.register();
      final f = Map<String, Object?>.from(await file())
        ..remove('owner')
        ..['pending'] = ['x'];
      await keys.writeDeviceLog(f);
      current = _Backend('acct-2');
      await log.register(freshSignIn: true);
      expect(((await file())['state'] as Map)['acct'], 'acct-2');
      expect((await log.list()).pending, isEmpty);
      expect((await keys.deviceLogArchive()).keys, [_acct]);
    });

    test('no sign-in id at hand (the store cannot be read) never starts the list over', () async {
      final store = _NoSignIn();
      keys = ViewerKeyStore(storage: store);
      var current = backend;
      final log = at(() => current);
      await forked(log);
      store.broken = true;
      final restarted = at(() => current);
      current = _Backend('x');
      await restarted.refresh();
      final listing = await restarted.list();
      expect(((await file())['state'] as Map)['acct'], _acct);
      expect(listing.suspended, [b64e(box3.pub)]);
      expect(listing.pending, [b64e(box3.pub)]);
      expect(listing.joinedSeq, 1);
      expect(await keys.deviceLogArchive(), isEmpty);
    });

    test('a kept list is restored only for the account it is the list of', () async {
      var current = backend;
      final log = at(() => current);
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.register(freshSignIn: true);
      // A kept file filed under another account's id (a damaged archive) whose fork suspended evil.
      final kept = Map<String, Object?>.from(await file())
        ..['suspended'] = [b64e(evil.pub)]
        ..['pending'] = <String>[];
      await keys.writeDeviceLogArchive({'acct-2': kept});
      expect(await log.suspendedPubs(), contains(b64e(evil.pub)));
      current = _Backend('acct-2');
      await log.register(freshSignIn: true);
      expect(((await file())['state'] as Map)['acct'], 'acct-2');
      expect((await log.list()).frozen, isNull);
    });

    test('a read on its way when the person signs in judges by that sign-in', () async {
      final store = _HeldWrites('viewer_e2ee_sign_in');
      keys = ViewerKeyStore(storage: store);
      var current = backend;
      final log = at(() => current);
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.register(freshSignIn: true);
      final other = _Backend('acct-2');
      current = other;
      other.holdFetch = Completer<void>();
      other.fetchHeld = Completer<void>();
      final release = other.holdFetch!;
      final reading = log.refresh();
      await other.fetchHeld!.future;
      // The new sign-in is not on disk yet when that read lands.
      final saved = store.hold = Completer<void>();
      final signingIn = log.register(freshSignIn: true);
      release.complete();
      await reading;
      saved.complete();
      await signingIn;
      expect((await log.list()).frozen, isNull);
      expect(((await file())['state'] as Map)['acct'], 'acct-2');
      // The account left is kept as it was — not frozen by a read judged by the old sign-in.
      expect(((await keys.deviceLogArchive())[_acct] as Map)['frozen'], isNull);
    });

    test('removed by a new key, signed in again to the same account: the key is still new', () async {
      final log = at(() => backend);
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.register(freshSignIn: true);
      await backend.add(evil, 'viewer', '', 'evil');
      await log.refresh();
      expect((await log.list()).pending, [b64e(evil.pub)]);
      final me = await keys.identity();
      await backend.removeBy(b64e(me.pub), evil);
      await log.refresh();
      expect(signedOut, 1);
      await keys.forgetIdentity(); // what the app does on being signed out
      await log.register(freshSignIn: true);
      final listing = await log.list();
      expect(listing.pending, [b64e(evil.pub)]);
      expect(listing.joinedSeq, 1);
      expect(backend.state.active[b64e((await keys.identity()).pub)], isNotNull);
    });

    test('a first read the backend cuts short ends the joining: what it held back is news', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      await backend.add(box3, 'machine', _mid3, 'box3');
      await backend.add(evil, 'viewer', '', 'evil');
      var calls = 0;
      final log = at(() => backend, fetch: (since) async {
        calls++;
        final got = await backend.fetch(since);
        if (calls == 1) return (acct: got!.acct, head: got.head, entries: got.entries.sublist(0, 1));
        if (calls == 2) return null; // the link drops
        return got;
      });
      await log.refresh();
      expect((await file()).containsKey('joining'), isFalse);
      await log.heard(b64e(box2.pub), {
        'head': backend.state.head.toJson(),
        'frozen': false,
        'tail': [for (final e in backend.entries.skip(1)) e.toJson()],
      });
      expect(announced.map((m) => m.label), ['box3', 'evil']);
      final listing = await log.list();
      expect(listing.joinedSeq, 1);
      expect(listing.pending, [b64e(box3.pub), b64e(evil.pub)]);
    });

    test('"Got it" on the already-on-your-account list ends the joining', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      await backend.add(evil, 'viewer', '', 'evil');
      late ViewerDeviceLog log;
      var calls = 0;
      log = at(() => backend, fetch: (since) async {
        calls++;
        final got = await backend.fetch(since);
        if (calls == 1) return (acct: got!.acct, head: got.head, entries: got.entries.sublist(0, 1));
        if (calls == 2) await log.seeBaseline();
        return got;
      });
      await log.refresh();
      expect(announced.map((m) => m.label), ['evil']);
      final listing = await log.list();
      expect(listing.pending, [b64e(evil.pub)]);
      expect(listing.baselineSeen, isTrue);
    });

    test('a key taken into an acknowledged already-on-your-account list shows that list again', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      await backend.add(evil, 'viewer', '', 'evil');
      var calls = 0;
      final log = at(() => backend, fetch: (since) async {
        calls++;
        final got = await backend.fetch(since);
        if (calls == 1) return (acct: got!.acct, head: got.head, entries: got.entries.sublist(0, 1));
        if (calls == 2) {
          // Acknowledged by a client that did not end the joining.
          await keys.writeDeviceLog(Map<String, Object?>.from(await file())..['baselineSeen'] = true);
        }
        return got;
      });
      await log.refresh();
      expect(announced, isEmpty);
      final listing = await log.list();
      expect(listing.baselineSeen, isFalse);
      expect(listing.baseline, contains(b64e(evil.pub)));
    });
  });

  group('departed keys, and lists kept across sign-ins', () {
    late E2eeIdentity evil, phone;
    setUp(() async {
      evil = await E2eeIdentity.fromSeed(List.filled(32, 9));
      phone = await E2eeIdentity.fromSeed(List.filled(32, 7));
    });

    /// A log whose backend is whichever [at] says now — another account's, after a sign-in.
    ViewerDeviceLog at(_Backend Function() at, {int now = 5000}) => ViewerDeviceLog(
      keys: keys,
      fetch: (since) => at().fetch(since),
      append: (e) => at().append(e),
      label: () => 'my-phone',
      onAnnounce: announced.add,
      onRemoved: removed.add,
      onSignedOut: () async => signedOut++,
      now: () => now,
      sleep: (_) async {},
    );

    Future<Map<Object?, Object?>> file() async => await keys.deviceLog() as Map;

    group('a new key that leaves before anyone looked stays flagged', () {
      late ViewerDeviceLog log;
      setUp(() async {
        await backend.add(box2, 'machine', _mid2, 'box2');
        log = makeLog();
        await log.register(); // box2 (1), this app (2)
        await backend.add(evil, 'viewer', '', 'evil'); // 3: new, pending
        await log.refresh();
      });
      Future<List<String>> departed(ViewerDeviceLog l) async => [for (final d in (await l.list()).departed) d.pub];

      test('removed by itself: survives a new instance, keeps its history rows new, goes on dismiss', () async {
        await backend.removeBy(b64e(evil.pub), evil);
        await log.refresh();
        final listing = await log.list();
        expect(listing.pending, isEmpty);
        final d = listing.departed.single;
        expect([d.pub, d.label, d.kind, d.addedAt, d.removedAt, d.removedBy, d.selfRemoved],
            [b64e(evil.pub), 'evil', 'viewer', 1000, 2000, b64e(evil.pub), true]);
        expect(d.fingerprint, fingerprint(evil.pub));
        final again = makeLog();
        expect(await departed(again), [b64e(evil.pub)]);
        final rows = (await again.history()).rows.where((r) => r.pub == b64e(evil.pub));
        expect([for (final r in rows) (r.op, r.pending)], [('signedOut', true), ('added', true)]);
        await again.dismiss(pub: b64e(evil.pub));
        expect(await departed(again), isEmpty);
        expect((await again.history()).rows.any((r) => r.pending), isFalse);
      });

      test('removed by another key: says by whom', () async {
        await backend.removeBy(b64e(evil.pub), box2);
        await log.refresh();
        final d = (await log.list()).departed.single;
        expect([d.removedBy, d.removedByLabel, d.selfRemoved], [b64e(box2.pub), 'box2', false]);
      });

      test('added and removed within one page: announced, and departed', () async {
        await backend.add(phone, 'viewer', '', 'phone');
        await backend.removeBy(b64e(phone.pub), phone);
        await log.refresh();
        expect(announced.map((m) => m.label), contains('phone'));
        expect(await departed(log), [b64e(phone.pub)]);
      });

      test('removed while the list is frozen: departed too', () async {
        final f = Map<String, Object?>.from(await file());
        f['frozen'] = {'reason': 'fork', 'at': 1, 'lastGoodHead': backend.state.head.toJson()};
        await keys.writeDeviceLog(f);
        await backend.removeBy(b64e(evil.pub), box2);
        await log.refresh();
        expect((await file())['looseRemoved'], hasLength(1));
        expect(await departed(log), [b64e(evil.pub)]);
      });

      test('a key already marked as seen is not departed', () async {
        await log.dismiss(pub: b64e(evil.pub));
        await backend.removeBy(b64e(evil.pub), evil);
        await log.refresh();
        expect(await departed(log), isEmpty);
      });

      test('clears for its own pub, a list naming it, or every one — never for another key', () async {
        await backend.removeBy(b64e(evil.pub), evil);
        await log.refresh();
        await log.seeBaseline();
        await log.dismiss(pubs: [b64e(box2.pub)]);
        await log.dismiss(pub: b64e(box2.pub));
        expect(await departed(log), [b64e(evil.pub)]);
        await log.dismiss(pubs: [b64e(evil.pub)]);
        expect(await departed(log), isEmpty);
        final f = Map<String, Object?>.from(await file())..['departed'] = [
          {'pub': 'k', 'label': 'x', 'kind': 'viewer', 'machineId': '', 'fingerprint': 'F', 'addedAt': 1,
           'removedAt': 2, 'removedBy': 'k', 'removedByLabel': '', 'selfRemoved': true},
          {'pub': 'junk', 'kind': 'evil'},
          {'pub': 'odd', 'label': 'x', 'kind': 'evil', 'machineId': '', 'fingerprint': 'F', 'addedAt': 1,
           'removedAt': 2, 'removedBy': 'odd', 'removedByLabel': '', 'selfRemoved': true},
        ];
        await keys.writeDeviceLog(f);
        expect(await departed(log), ['k']);
        await log.dismiss();
        expect(await departed(log), isEmpty);
      });

      test('kept up to the cap, the oldest going first', () async {
        for (var i = 40; i < 40 + 33; i++) {
          final k = await E2eeIdentity.fromSeed(List.filled(32, i));
          await backend.add(k, 'viewer', '', 'k$i');
          await backend.removeBy(b64e(k.pub), k);
        }
        await log.refresh();
        final d = (await log.list()).departed;
        expect(d, hasLength(32));
        expect(d.first.label, 'k41');
        expect(d.last.label, 'k72');
      });
    });

    group('a sign-in by hand starts the list over only shortly after it was made', () {
      const now = 30 * 60 * 1000;

      /// Signed in on [backend] (box3 new there), then the sign-in [epoch] (not yet the list's), whose
      /// first read — at [now] — is of another account.
      Future<void> later(String epoch) async {
        var current = backend;
        final log = at(() => current);
        await backend.add(box2, 'machine', _mid2, 'box2');
        await log.register(freshSignIn: true);
        expect(await keys.signInEpoch(), matches(RegExp(r'^[0-9a-f]{32}@5000$')));
        await backend.add(box3, 'machine', _mid3, 'box3');
        await log.refresh();
        await keys.writeSignInEpoch(epoch);
        final restarted = at(() => current, now: now);
        current = _Backend('acct-2');
        await restarted.refresh();
      }

      test('one made over 10 minutes ago, with no read of its account yet, only freezes', () async {
        await later('${'f' * 32}@${now - 11 * 60 * 1000}');
        expect(((await file())['state'] as Map)['acct'], _acct);
        expect((await file())['frozen'], containsPair('reason', 'invalid'));
        expect((await file())['pending'], [b64e(box3.pub)]);
        expect(await keys.deviceLogArchive(), isEmpty);
      });

      test('one with no time recorded only freezes', () async {
        await later('f' * 32);
        expect(((await file())['state'] as Map)['acct'], _acct);
        expect((await file())['frozen'], containsPair('reason', 'invalid'));
      });

      test('one made just now starts it over', () async {
        await later('${'f' * 32}@${now - 9 * 60 * 1000}');
        expect(((await file())['state'] as Map)['acct'], 'acct-2');
        expect((await keys.deviceLogArchive()).keys, [_acct]);
      });
    });

    test('a restore that fails half way has the kept list live first: its marks are never lost', () async {
      final store = _FailingArchive();
      keys = ViewerKeyStore(storage: store);
      var current = backend;
      final log = at(() => current);
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.register(freshSignIn: true);
      await backend.add(box3, 'machine', _mid3, 'box3');
      await log.refresh();
      current = _Backend('acct-2');
      await log.register(freshSignIn: true);
      store.allowed = 1; // the list left is kept; taking the restored one out of the archive fails
      current = backend;
      await log.register(freshSignIn: true);
      expect(((await file())['state'] as Map)['acct'], _acct);
      expect((await file())['pending'], [b64e(box3.pub)]);
      expect((await keys.deviceLogArchive()).keys, contains(_acct));
    });

    test('gossip waits for the new sign-in\'s first read', () async {
      final log = at(() => backend);
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.register(freshSignIn: true);
      final other = _Backend();
      await other.add(evil, 'viewer', '', 'evil');
      await other.add(phone, 'viewer', '', 'phone'); // another entry at the same position: a fork
      final hashes = [for (var i = 0; i < other.state.hashes.length; i++) {'seq': i + 1, 'hash': other.state.hashes[i]}];
      log.beginSignIn(fresh: true);
      expect(await log.gossip(), isNull);
      await log.heard(b64e(box2.pub), {'head': other.state.head.toJson(), 'frozen': false, 'hashes': hashes});
      expect((await file())['frozen'], isNull);
      await log.register(); // same account: the list is this sign-in's now
      expect(await log.gossip(), isNotNull);
      await log.heard(b64e(box2.pub), {'head': other.state.head.toJson(), 'frozen': false, 'hashes': hashes});
      expect((await file())['frozen'], containsPair('reason', 'fork'));
    });

    group('beginSignIn', () {
      test('a read before register already judges by the new sign-in, and register mints nothing more', () async {
        var current = backend;
        final log = at(() => current);
        await backend.add(box2, 'machine', _mid2, 'box2');
        await log.register(freshSignIn: true);
        final before = await keys.signInEpoch();
        current = _Backend('acct-2');
        log.beginSignIn(fresh: true);
        await log.refresh();
        expect(((await file())['state'] as Map)['acct'], 'acct-2');
        expect((await file())['frozen'], isNull);
        final minted = await keys.signInEpoch();
        expect(minted, isNot(before));
        await log.register();
        expect(await keys.signInEpoch(), minted);
        expect((await file())['owner'], minted);
      });

      test('a sign-in id that could not be kept is not judged by: no read starts the list over on it', () async {
        final store = _LostSignIn();
        keys = ViewerKeyStore(storage: store);
        var current = backend;
        final log = at(() => current);
        await backend.add(box2, 'machine', _mid2, 'box2');
        await log.register(freshSignIn: true);
        current = _Backend('acct-2');
        final saving = store.hold = Completer<void>();
        final registering = log.register(freshSignIn: true);
        await _settle(Future<void>.delayed(const Duration(milliseconds: 50)));
        saving.complete();
        await registering;
        expect(((await file())['state'] as Map)['acct'], _acct);
        expect(await keys.deviceLogArchive(), isEmpty);
      });

      test('a stored session mints nothing', () async {
        final log = makeLog();
        await log.register();
        final before = await keys.signInEpoch();
        log.beginSignIn(fresh: false);
        await log.register();
        expect(await keys.signInEpoch(), before);
      });

      test('this app\'s old key removed, read before register: no sign-out', () async {
        final log = at(() => backend);
        await backend.add(box2, 'machine', _mid2, 'box2');
        await log.register(freshSignIn: true);
        final me = await keys.identity();
        await backend.removeBy(b64e(me.pub), box2);
        log.beginSignIn(fresh: true);
        await log.refresh();
        expect(signedOut, 0);
        await log.register();
        expect(signedOut, 0);
        expect(backend.state.active[b64e((await keys.identity()).pub)], isNotNull);
      });
    });

    group('a suspension kept in another account\'s list shows, and lifts, in this one', () {
      /// On [backend] a fork suspended the machine evil; then signed in by hand to acct-2, whose log
      /// has evil.
      Future<ViewerDeviceLog> moved() async {
        var current = backend;
        final log = at(() => current);
        await backend.add(box2, 'machine', _mid2, 'box2');
        await log.register(freshSignIn: true);
        await backend.add(evil, 'machine', _mid3, 'evil');
        await log.refresh();
        final f = Map<String, Object?>.from(await file())..['suspended'] = [b64e(evil.pub)];
        await keys.writeDeviceLog(f);
        await keys.unlink(_mid3); // as the suspension does
        final b = _Backend('acct-2');
        await b.add(phone, 'viewer', '', 'phone');
        await b.add(evil, 'machine', _mid3, 'evil');
        current = b;
        await log.register(freshSignIn: true);
        return log;
      }

      test('is suspended and new in the list, never trusted', () async {
        final log = await moved();
        final row = (await log.list()).members.firstWhere((r) => r.member.pub == b64e(evil.pub));
        expect([row.suspended, row.pending], [true, true]);
        expect(await keys.peer(_mid3), isNull);
      });

      test('"It\'s mine" lifts it here and in the kept list', () async {
        final log = await moved();
        await log.dismiss(pub: b64e(evil.pub));
        expect(await log.suspendedPubs(), isNot(contains(b64e(evil.pub))));
        expect(b64e((await keys.peer(_mid3))!.pub), b64e(evil.pub));
      });

      test('a review does not lift it (it never showed it as suspended): only "It\'s mine" does', () async {
        final log = await moved();
        final r = await log.rebaseline(confirm: true);
        expect(r, isNotNull);
        expect(await log.suspendedPubs(), contains(b64e(evil.pub)));
        expect(((await keys.deviceLogArchive())[_acct] as Map)['suspended'], [b64e(evil.pub)]);
        final row = (await log.list()).members.firstWhere((r) => r.member.pub == b64e(evil.pub));
        expect([row.suspended, row.pending], [true, true]);
        expect(await keys.peer(_mid3), isNull);
      });
    });

    test('a kept list restored is suspended where another kept list says so', () async {
      var current = backend;
      final log = at(() => current);
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.register(freshSignIn: true);
      await backend.add(phone, 'viewer', '', 'phone');
      await log.refresh();
      await log.dismiss(pub: b64e(phone.pub));
      final b = _Backend('acct-2');
      await b.add(phone, 'viewer', '', 'phone');
      current = b;
      await log.register(freshSignIn: true);
      // A fork in acct-2 suspended phone; then back to the first account, where phone is on the list.
      final f = Map<String, Object?>.from(await file())..['suspended'] = [b64e(phone.pub)];
      await keys.writeDeviceLog(f);
      current = backend;
      await log.register(freshSignIn: true);
      expect(((await file())['state'] as Map)['acct'], _acct);
      final row = (await log.list()).members.firstWhere((r) => r.member.pub == b64e(phone.pub));
      expect([row.suspended, row.pending], [true, true]);
    });

    test('a review of another account\'s list after a sign-in keeps the one it leaves', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      await makeLog().register();
      final f = Map<String, Object?>.from(await file());
      f['state'] = {...(f['state'] as Map).cast<String, Object?>(), 'acct': 'old'};
      f['suspended'] = ['k'];
      await keys.writeDeviceLog(f);
      await keys.writeSignInEpoch('f' * 32); // signed in again, long ago: the list is not its yet
      final log = makeLog();
      final r = await log.rebaseline(confirm: true);
      expect(r!.otherAccount, isFalse);
      expect(((await file())['state'] as Map)['acct'], _acct);
      expect((await file())['owner'], 'f' * 32);
      expect((await keys.deviceLogArchive()).keys, ['old']);
    });

    group('another account\'s list under the sign-in the live list belongs to', () {
      /// Signed in to the first account, a new key K pending; the backend then serves an empty
      /// "acct-2" under the same sign-in.
      Future<ViewerDeviceLog> switched([_Memory? store]) async {
        if (store != null) keys = ViewerKeyStore(storage: store);
        var current = backend;
        final log = at(() => current);
        await backend.add(box2, 'machine', _mid2, 'box2');
        await log.register(freshSignIn: true);
        await backend.add(evil, 'viewer', '', 'K');
        await log.refresh();
        expect((await file())['pending'], [b64e(evil.pub)]);
        current = _Backend('acct-2');
        await log.refresh();
        expect(((await file())['state'] as Map)['acct'], _acct);
        expect((await file())['frozen'], containsPair('reason', 'invalid'));
        announced.clear();
        return log;
      }

      test('refuses the preview and the confirm (otherAccount), writing nothing', () async {
        final store = _Memory();
        final log = await switched(store);
        final before = Map.of(store.values);
        final preview = await log.rebaseline(confirm: false);
        expect([preview!.otherAccount, preview.logChanged, preview.added, preview.removed], [true, false, isEmpty, isEmpty]);
        expect((await log.rebaseline(confirm: true))!.otherAccount, isTrue);
        expect((await log.rebaseline(confirm: true, expectedHead: _Backend('acct-2').state.head))!.otherAccount, isTrue);
        // Said before logChanged: a confirm on another head is still about another account.
        final stale = (await log.rebaseline(confirm: true, expectedHead: const DevLogHead(99, 'x')))!;
        expect([stale.otherAccount, stale.logChanged], [true, false]);
        expect(store.values, before); // nothing written: the list, its marks, trust
        expect(await keys.deviceLogArchive(), isEmpty);
        expect(announced, isEmpty);
        expect((await log.list()).pending, [b64e(evil.pub)]);
      });

      test('a sign-in by hand made since goes ahead', () async {
        await switched();
        await keys.writeSignInEpoch('f' * 32);
        final log = at(() => _Backend('acct-2'));
        final r = await log.rebaseline(confirm: true);
        expect(r!.otherAccount, isFalse);
        expect(((await file())['state'] as Map)['acct'], 'acct-2');
        expect((await keys.deviceLogArchive()).keys, [_acct]);
      });

      test('a list stamped by a sign-in, then this app taken over by an adopted one: neither goes ahead', () async {
        final store = _Memory();
        await switched(store);
        expect((await file())['owner'], isNotNull);
        await keys.writeSignInEpoch('adopted:x'); // a session taken over (an older version refreshed the token)
        final log = at(() => _Backend('acct-2'));
        final before = Map.of(store.values);
        expect((await log.rebaseline(confirm: false))!.otherAccount, isTrue);
        expect((await log.rebaseline(confirm: true))!.otherAccount, isTrue);
        expect(store.values, before);
        expect(await keys.deviceLogArchive(), isEmpty);
        expect((await log.list()).pending, [b64e(evil.pub)]);
      });

      /// A list no sign-in stamped yet (written before sign-in ids existed, or by an older version after
      /// a downgrade) on the first account with K pending, under [epoch] (made long ago); the backend
      /// then serves an empty "acct-2".
      Future<ViewerDeviceLog> unstamped(_Memory store, String epoch) async {
        keys = ViewerKeyStore(storage: store);
        await keys.writeSignInEpoch(epoch);
        var current = backend;
        final log = at(() => current);
        await backend.add(box2, 'machine', _mid2, 'box2');
        await log.register();
        await backend.add(evil, 'viewer', '', 'K');
        await log.refresh();
        await keys.writeDeviceLog(Map<String, Object?>.from(await file())..remove('owner'));
        current = _Backend('acct-2');
        await log.refresh();
        expect(((await file())['state'] as Map)['acct'], _acct);
        expect((await file())['frozen'], containsPair('reason', 'invalid'));
        expect((await file())['pending'], [b64e(evil.pub)]);
        expect((await file()).containsKey('owner'), isFalse);
        announced.clear();
        return log;
      }

      test('an unstamped list under an adopted sign-in (the session it was written under) refuses too', () async {
        final store = _Memory();
        final log = await unstamped(store, 'adopted:a');
        final before = Map.of(store.values);
        expect((await log.rebaseline(confirm: false))!.otherAccount, isTrue);
        expect((await log.rebaseline(confirm: true))!.otherAccount, isTrue);
        expect(store.values, before);
        expect(await keys.deviceLogArchive(), isEmpty);
      });

      test('an unstamped list under a sign-in by hand is that sign-in moving accounts: the review goes ahead', () async {
        final log = await unstamped(_Memory(), 'f' * 32);
        final r = await log.rebaseline(confirm: true);
        expect(r!.otherAccount, isFalse);
        expect(((await file())['state'] as Map)['acct'], 'acct-2');
        expect((await file())['owner'], 'f' * 32);
        expect((await keys.deviceLogArchive()).keys, [_acct]);
      });
    });
  });

  group('a review (rebaseline)', () {
    late E2eeIdentity evil, phone, k5, k6, k7;
    setUp(() async {
      evil = await E2eeIdentity.fromSeed(List.filled(32, 9));
      phone = await E2eeIdentity.fromSeed(List.filled(32, 7));
      k5 = await E2eeIdentity.fromSeed(List.filled(32, 15));
      k6 = await E2eeIdentity.fromSeed(List.filled(32, 16));
      k7 = await E2eeIdentity.fromSeed(List.filled(32, 17));
    });

    ViewerDeviceLog at(_Backend Function() at) => ViewerDeviceLog(
      keys: keys,
      fetch: (since) => at().fetch(since),
      append: (e) => at().append(e),
      label: () => 'my-phone',
      onAnnounce: announced.add,
      onRemoved: removed.add,
      onSignedOut: () async => signedOut++,
      now: () => 5000,
      sleep: (_) async {},
    );

    Future<Map<Object?, Object?>> file() async => await keys.deviceLog() as Map;
    List<String> pubs(Object? list) => [for (final d in (list as List? ?? const [])) (d as Map)['pub'] as String];

    test('after the list froze on another account, a key added below the old joined point is news', () async {
      var current = backend;
      final log = at(() => current);
      await backend.add(box2, 'machine', _mid2, 'box2');
      await backend.add(box3, 'machine', _mid3, 'box3');
      await backend.add(phone, 'viewer', '', 'phone');
      await backend.add(k5, 'viewer', '', 'k5');
      await log.refresh();
      expect((await file())['joinedSeq'], 4);
      final b = _Backend('acct-2');
      await b.add(k7, 'viewer', '', 'k7');
      // Signed in again by hand long ago: the backend held the new account's list back past the window.
      await keys.writeSignInEpoch('f' * 32);
      final signedIn = at(() => current);
      current = b;
      await signedIn.refresh();
      expect((await file())['frozen'], containsPair('reason', 'invalid'));
      await signedIn.rebaseline(confirm: true); // "Trust again"
      expect(((await file())['state'] as Map)['acct'], 'acct-2');
      expect((await file())['joinedSeq'], 0);
      announced.clear();
      await b.add(evil, 'viewer', '', 'evil'); // seq 2: below the old account's joined point
      await signedIn.refresh();
      expect(announced.map((m) => m.label), ['evil']);
      final listing = await signedIn.list();
      expect(listing.pending, contains(b64e(evil.pub)));
      expect(listing.baseline, isNot(contains(b64e(evil.pub))));
    });

    test('after a rollback 4 → 1 it was reviewed on, a key added at 2 is news', () async {
      var current = backend;
      final log = at(() => current);
      await backend.add(box2, 'machine', _mid2, 'box2');
      await backend.add(box3, 'machine', _mid3, 'box3');
      await backend.add(phone, 'viewer', '', 'phone');
      await backend.add(k5, 'viewer', '', 'k5');
      await log.refresh();
      expect((await file())['joinedSeq'], 4);
      backend.lie = backend.entries.sublist(0, 1);
      await log.refresh();
      expect((await file())['frozen'], containsPair('reason', 'rollback'));
      final preview = await log.rebaseline(confirm: false);
      expect(preview!.added, isEmpty);
      await log.rebaseline(confirm: true, expectedHead: preview.head);
      expect((await file())['frozen'], isNull);
      expect((await file())['joinedSeq'], 1);
      final rolled = _Backend();
      await rolled.add(box2, 'machine', _mid2, 'box2'); // the same entry 1
      await rolled.add(evil, 'viewer', '', 'evil');
      current = rolled;
      await log.refresh();
      expect(announced.map((m) => m.label), ['evil']);
      expect((await file())['pending'], [b64e(evil.pub)]);
    });

    group('back to an account this app kept the list of', () {
      /// The first account: phone new and pending, evil suspended by a fork, k7 joined and left before
      /// anyone looked; then signed in by hand to acct-2; then the backend serves the first account
      /// again with no sign-in (frozen: a review does not switch accounts — see [back]).
      Future<ViewerDeviceLog> away() async {
        var current = backend;
        final log = at(() => current);
        await backend.add(box2, 'machine', _mid2, 'box2');
        await log.register(freshSignIn: true);
        await backend.add(phone, 'viewer', '', 'phone');
        await backend.add(evil, 'machine', _mid3, 'evil');
        await backend.add(k7, 'viewer', '', 'k7');
        await backend.removeBy(b64e(k7.pub), box2);
        await log.refresh();
        final f = Map<String, Object?>.from(await file())..['suspended'] = [b64e(evil.pub)];
        await keys.writeDeviceLog(f);
        await keys.unlink(_mid3); // as the suspension does
        final b = _Backend('acct-2');
        await b.add(k5, 'viewer', '', 'k5');
        current = b;
        await log.register(freshSignIn: true);
        expect(((await file())['state'] as Map)['acct'], 'acct-2');
        current = backend; // no sign-in: the backend says the first account
        await log.refresh();
        expect(((await file())['state'] as Map)['acct'], 'acct-2');
        expect((await file())['frozen'], containsPair('reason', 'invalid'));
        announced.clear();
        return log;
      }

      /// …then signed in again by hand (long ago: the list froze rather than started over) — the only
      /// way back to the first account.
      Future<ViewerDeviceLog> back() async {
        await away();
        await keys.writeSignInEpoch('e' * 32);
        final log = at(() => backend);
        await log.refresh();
        expect(((await file())['state'] as Map)['acct'], 'acct-2');
        expect((await file())['frozen'], containsPair('reason', 'invalid'));
        return log;
      }

      test('without a sign-in, neither the preview nor "Trust again" goes back to it', () async {
        final log = await away();
        final before = '${await keys.deviceLog()}';
        expect((await log.rebaseline(confirm: false))!.otherAccount, isTrue);
        expect((await log.rebaseline(confirm: true))!.otherAccount, isTrue);
        expect('${await keys.deviceLog()}', before);
        expect((await keys.deviceLogArchive()).keys, [_acct]);
        expect(announced, isEmpty);
        expect(await keys.peer(_mid3), isNull);
      });

      Future<void> wentOn(ViewerDeviceLog log) async {
        final f = await file();
        expect((f['state'] as Map)['acct'], _acct);
        expect(f['frozen'], isNull);
        expect(f['pending'], containsAll([b64e(phone.pub), b64e(evil.pub)]));
        expect(f['suspended'], [b64e(evil.pub)]);
        expect(pubs(f['departed']), [b64e(k7.pub)]);
        expect(announced, isEmpty);
        expect(await keys.peer(_mid3), isNull);
        final row = (await log.list()).members.firstWhere((r) => r.member.pub == b64e(evil.pub));
        expect([row.suspended, row.pending], [true, true]);
        expect((await keys.deviceLogArchive()).keys, isNot(contains(_acct)));
      }

      test('the preview compares against the kept list, not the account being left', () async {
        final log = await back();
        final preview = await log.rebaseline(confirm: false);
        expect(preview!.added, isEmpty);
        expect(preview.removed, isEmpty);
      });

      test('"Trust again" goes on from its marks: pending, departed, suspended, nothing re-announced', () async {
        final log = await back();
        await log.rebaseline(confirm: true);
        await wentOn(log);
        expect((await file())['owner'], 'e' * 32);
        expect((await keys.deviceLogArchive()).keys, ['acct-2']);
      });

      test('…even when keeping the account left pushes it out of the archive', () async {
        final log = await back();
        final live = Map<String, Object?>.from(await file());
        final all = await keys.deviceLogArchive();
        for (final acct in ['x1', 'x2', 'x3']) {
          all[acct] = {...live, 'state': {...(live['state'] as Map).cast<String, Object?>(), 'acct': acct}};
        }
        await keys.writeDeviceLogArchive(all);
        await log.rebaseline(confirm: true);
        await wentOn(log);
      });
    });

    group('what the reviewed list took out', () {
      late ViewerDeviceLog log;
      setUp(() async {
        await backend.add(box2, 'machine', _mid2, 'box2');
        await backend.add(k5, 'viewer', '', 'k5');
        log = makeLog();
        await log.register(); // this app: 3
        await backend.add(phone, 'viewer', '', 'phone'); // 4: new, pending
        await log.refresh();
        expect((await file())['pending'], [b64e(phone.pub)]);
      });

      Future<void> freeze(int keep) async {
        backend.lie = backend.entries.sublist(0, keep);
        await log.refresh();
        expect((await file())['frozen'], containsPair('reason', 'rollback'));
        backend.lie = null;
      }

      test('a pending key the reviewed list does not have stays flagged as departed', () async {
        backend.lie = backend.entries.sublist(0, 3);
        await log.refresh();
        await log.rebaseline(confirm: true);
        expect((await file())['pending'], isEmpty);
        final d = (await log.list()).departed.single;
        expect([d.pub, d.label, d.removedBy, d.selfRemoved], [b64e(phone.pub), 'phone', '', false]);
      });

      test('a pending key removed while frozen is departed, with who removed it', () async {
        await freeze(3);
        await backend.removeBy(b64e(phone.pub), box2);
        await log.rebaseline(confirm: true);
        final d = (await log.list()).departed.single;
        expect([d.pub, d.removedBy, d.removedByLabel], [b64e(phone.pub), b64e(box2.pub), 'box2']);
      });

      test('a key added and removed while frozen is departed; a reviewed-out key nobody flagged is not', () async {
        await freeze(3);
        await backend.add(evil, 'viewer', '', 'evil');
        await backend.removeBy(b64e(evil.pub), box2);
        await backend.removeBy(b64e(k5.pub), box2); // known since joining: not new
        await log.rebaseline(confirm: true);
        final d = (await log.list()).departed;
        expect([for (final x in d) x.pub], [b64e(evil.pub)]);
        expect([d.single.label, d.single.removedBy], ['evil', b64e(box2.pub)]);
      });

      test('a key that joined and left before the freeze, and was looked at, is not flagged again', () async {
        await backend.add(k6, 'viewer', '', 'k6');
        await backend.removeBy(b64e(k6.pub), box2);
        await log.refresh();
        expect([for (final d in (await log.list()).departed) d.pub], [b64e(k6.pub)]);
        await log.dismiss(pub: b64e(k6.pub));
        await freeze(5);
        await log.rebaseline(confirm: true);
        expect((await log.list()).departed, isEmpty);
      });
    });

    test('a sign-in by hand that never registers expects this app\'s removal for one read only', () async {
      final log = at(() => backend);
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.register(freshSignIn: true);
      log.beginSignIn(fresh: true);
      await log.refresh(); // the read it was waiting for: nothing removed
      final me = await keys.identity();
      await backend.removeBy(b64e(me.pub), box2);
      await log.refresh();
      expect(signedOut, 1);
    });
  });

  test('forgetting the identity mints a new one', () async {
    final before = b64e((await keys.identity()).pub);
    await keys.forgetIdentity();
    expect(b64e((await keys.identity()).pub), isNot(before));
  });
}
