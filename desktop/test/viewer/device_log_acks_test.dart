import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/e2ee/bytes.dart';
import 'package:harness/e2ee/keys.dart';
import 'package:harness/viewer/device_ack.dart';
import 'package:harness/viewer/device_log.dart';
import 'package:harness/viewer/device_log_sync.dart';
import 'package:harness/viewer/group_sync.dart';
import 'package:harness/viewer/viewer_key_store.dart';

/// "It's mine", once for the account (`lib/viewer/device_ack.dart`), as this app's copy of the device
/// key log takes it: an acknowledgement another trusted device signed takes a new key off the list here;
/// one this app is asked to share is signed and handed to the backend. Mirrors the CLI's
/// deviceLogSyncer.spec.ts ("It's mine", once for the account).

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

const _acct = 'acct-1';
final _mid2 = 'b' * 32;

/// The backend: keeps the log honestly, and serves whatever acknowledgements it holds, checked or not.
class _Backend {
  DevLogState state = DevLogState.empty(_acct);
  final entries = <DevLogEntry>[];
  final acks = <Object?>[];
  final askedAcks = <int>[];
  final posted = <DevAck>[];

  /// False: a backend from before acknowledgements (404 on both routes).
  bool ackRoute = true;
  bool ackReadThrows = false;

  Future<void> add(E2eeIdentity who, String kind, String machineId, String label) async {
    final pub = b64e(who.pub);
    await _push(await signDevLogEntry(
      nextDevLogEntry(state, op: 'add', pub: pub, kind: kind, machineId: machineId, label: label, signer: pub, at: 1000),
      who,
    ));
  }

  Future<void> removeBy(String target, E2eeIdentity by) async {
    final t = state.active[target]!;
    await _push(await signDevLogEntry(
      nextDevLogEntry(state, op: 'remove', pub: t.pub, kind: t.kind, machineId: t.machineId, label: t.label, signer: b64e(by.pub), at: 2000),
      by,
    ));
  }

  Future<void> _push(DevLogEntry e) async {
    state = (await applyDevLogEntries(state, [e.toJson()])).state;
    entries.add(e);
  }

  Future<DeviceLogFetched?> fetch(int since) async =>
      (acct: _acct, head: state.head, entries: [for (final e in entries) if (e.seq > since) e.toJson()]);

  Future<DeviceLogAppendAnswer?> append(DevLogEntry entry) async {
    if (entry.seq != state.head.seq + 1 || entry.prev != state.head.hash) return (head: state.head, error: 'STALE_HEAD');
    await _push(entry);
    return (head: state.head, error: null);
  }

  Future<List<Object?>?> fetchAcks(int since) async {
    askedAcks.add(since);
    if (ackReadThrows) throw StateError('down');
    if (!ackRoute) return null;
    return [...acks];
  }

  Future<bool> postAck(DevAck ack) async {
    if (!ackRoute) return false;
    posted.add(ack);
    acks.add(ack.toJson());
    return true;
  }

  /// An acknowledgement of [of] by [by], for the entry that added it unless [addSeq] says otherwise.
  Future<Map<String, Object?>> ack(E2eeIdentity by, String of, {int? addSeq, String acct = _acct}) async =>
      (await signDevAck(
        DevAck(v: 1, acct: acct, pub: of, addSeq: addSeq ?? state.active[of]?.seq ?? 1, signer: b64e(by.pub), at: 7000),
        by,
      )).toJson();
}

void main() {
  late _Backend backend;
  late ViewerKeyStore keys;
  late List<DevLogMember> announced;
  late int changed;
  late E2eeIdentity box2, phone, later;

  ViewerDeviceLog makeLog({bool acks = true}) => ViewerDeviceLog(
    keys: keys,
    fetch: backend.fetch,
    append: backend.append,
    fetchAcks: acks ? backend.fetchAcks : null,
    postAck: acks ? backend.postAck : null,
    label: () => 'my-phone',
    onAnnounce: announced.add,
    onChanged: () => changed++,
    now: () => 5000,
    sleep: (_) async {},
  );

  Future<Map<String, Object?>> file() async => ((await keys.deviceLog()) as Map).cast<String, Object?>();
  Future<String> self() async => b64e((await keys.identity()).pub);
  String pubOf(E2eeIdentity id) => b64e(id.pub);

  setUp(() async {
    backend = _Backend();
    keys = ViewerKeyStore(storage: _Memory());
    announced = [];
    changed = 0;
    box2 = await E2eeIdentity.fromSeed(List.filled(32, 2));
    phone = await E2eeIdentity.fromSeed(List.filled(32, 3));
    later = await E2eeIdentity.fromSeed(List.filled(32, 5));
  });

  /// box2 was on the account before this app joined (never new here); the phone joined after (new).
  Future<ViewerDeviceLog> joined({bool acks = true}) async {
    final log = makeLog(acks: acks);
    await backend.add(box2, 'machine', _mid2, 'box2');
    await log.register(freshSignIn: true);
    await backend.add(phone, 'viewer', '', 'phone');
    await log.refresh();
    expect((await log.list()).pending, [pubOf(phone)]);
    announced.clear();
    changed = 0;
    backend.askedAcks.clear();
    return log;
  }

  test('a trusted older device\'s "It\'s mine" takes the new key off the list here, and says on which', () async {
    final log = await joined();
    backend.acks.add(await backend.ack(box2, pubOf(phone)));
    await log.refresh();
    final listing = await log.list();
    expect(listing.pending, isEmpty);
    final row = listing.members.firstWhere((r) => r.member.pub == pubOf(phone));
    expect(row.pending, isFalse);
    expect(row.confirmed?.toJson(), {'by': pubOf(box2), 'label': 'box2', 'at': 5000});
    expect(listing.members.firstWhere((r) => r.member.pub == pubOf(box2)).confirmed, isNull);
    expect(changed, greaterThan(0));
  });

  test('asks from just below the oldest key new here, and not at all while nothing is new', () async {
    final log = await joined();
    await log.refresh();
    expect(backend.askedAcks, [backend.state.active[pubOf(phone)]!.seq - 1]);
    await log.dismiss(pub: pubOf(phone));
    backend.askedAcks.clear();
    await log.refresh();
    expect(backend.askedAcks, isEmpty);
  });

  test('a device confirmed while this app was closed is announced once, as every new key is, then taken off the list', () async {
    final log = makeLog();
    await backend.add(box2, 'machine', _mid2, 'box2');
    await log.register(freshSignIn: true);
    await backend.add(phone, 'viewer', '', 'phone');
    await backend.add(later, 'viewer', '', 'later');
    backend.acks.add(await backend.ack(box2, pubOf(phone)));
    await log.refresh();
    // The one-time "New device" never waits on, or is skipped for, anyone's word.
    expect(announced.map((m) => m.label), ['phone', 'later']);
    expect((await log.list()).pending, [pubOf(later)]);
    await log.refresh();
    expect(announced, hasLength(2));
  });

  test('stays as before when the acknowledgements cannot be read, or the read fails', () async {
    for (final fail in ['no route', 'throws']) {
      backend = _Backend();
      keys = ViewerKeyStore(storage: _Memory());
      announced = [];
      final log = makeLog();
      await backend.add(box2, 'machine', _mid2, 'box2');
      await log.register(freshSignIn: true);
      if (fail == 'no route') {
        backend.ackRoute = false;
      } else {
        backend.ackReadThrows = true;
      }
      await backend.add(phone, 'viewer', '', 'phone');
      backend.acks.add(await backend.ack(box2, pubOf(phone)));
      await log.refresh();
      expect(announced.map((m) => m.label), ['phone'], reason: fail);
      expect((await log.list()).pending, [pubOf(phone)], reason: fail);
    }
  });

  group('what is ignored', () {
    test('a key vouching for itself, a bad signature, the wrong entry, another account, this app\'s own', () async {
      final log = await joined();
      final good = await backend.ack(box2, pubOf(phone));
      backend.acks.addAll([
        await backend.ack(phone, pubOf(phone)),
        {...good, 'at': 7001},
        await backend.ack(box2, pubOf(phone), addSeq: backend.state.active[pubOf(phone)]!.seq - 1),
        await backend.ack(box2, pubOf(phone), acct: 'acct-2'),
        (await signDevAck(
          DevAck(v: 1, acct: _acct, pub: pubOf(phone), addSeq: backend.state.active[pubOf(phone)]!.seq, signer: await self(), at: 7000),
          await keys.identity(),
        )).toJson(),
        {'junk': true},
      ]);
      await log.refresh();
      expect((await log.list()).pending, [pubOf(phone)]);
      expect((await file())['confirmed'], isNull);
      expect(changed, 0);
    });

    test('a signer that is itself new here: two new devices must not vouch for each other', () async {
      final log = await joined();
      await backend.add(later, 'viewer', '', 'later');
      await log.refresh();
      backend.acks.addAll([await backend.ack(later, pubOf(phone)), await backend.ack(phone, pubOf(later))]);
      await log.refresh();
      expect((await log.list()).pending, [pubOf(phone), pubOf(later)]);
    });

    test('a signer that is gone (removed, or joined and left before anyone looked)', () async {
      final log = await joined();
      await backend.add(later, 'viewer', '', 'later');
      await log.refresh();
      final fromLater = await backend.ack(later, pubOf(phone));
      final fromBox2 = await backend.ack(box2, pubOf(phone));
      await backend.removeBy(pubOf(later), later);
      await backend.removeBy(pubOf(box2), box2);
      backend.acks.addAll([fromLater, fromBox2]);
      await log.refresh();
      expect((await log.list()).departed.map((d) => d.pub), [pubOf(later)]);
      expect((await log.list()).pending, [pubOf(phone)]);
    });

    test('a signer suspended here, or tombstoned in the trust group here', () async {
      for (final how in ['suspended', 'tombstoned']) {
        backend = _Backend();
        keys = ViewerKeyStore(storage: _Memory());
        final log = await joined();
        if (how == 'suspended') {
          await keys.writeDeviceLog({...await file(), 'suspended': [pubOf(box2)]});
        } else {
          await keys.writeGroupRoster(GroupRoster(const [], [GroupTombstone(pubOf(box2), 1000)]).toJson());
        }
        backend.acks.add(await backend.ack(box2, pubOf(phone)));
        await log.refresh();
        expect((await log.list()).pending, [pubOf(phone)], reason: how);
      }
    });

    test('never lifts a suspension: a key a fork suspended here stays new and suspended', () async {
      final log = await joined();
      await keys.writeDeviceLog({...await file(), 'suspended': [pubOf(phone)]});
      backend.acks.add(await backend.ack(box2, pubOf(phone)));
      await log.refresh();
      expect(backend.askedAcks, isEmpty);
      final listing = await log.list();
      expect(listing.pending, [pubOf(phone)]);
      expect(listing.suspended, [pubOf(phone)]);
    });

    test('nothing at all while the log is frozen here', () async {
      final log = await joined();
      await keys.writeDeviceLog({
        ...await file(),
        'frozen': {'reason': 'fork', 'at': 1, 'lastGoodHead': backend.state.head.toJson()},
      });
      backend.acks.add(await backend.ack(box2, pubOf(phone)));
      await log.refresh();
      expect(backend.askedAcks, isEmpty);
      expect((await log.list()).pending, [pubOf(phone)]);
    });
  });

  test('the mark goes with the key: a confirmed key removed later leaves none behind, and is not departed', () async {
    final log = await joined();
    backend.acks.add(await backend.ack(box2, pubOf(phone)));
    await log.refresh();
    expect((await file())['confirmed'], isA<Map>());
    await backend.removeBy(pubOf(phone), box2);
    await log.refresh();
    expect((await file())['confirmed'], isNull);
    expect((await log.list()).departed, isEmpty);
  });

  group('"It\'s mine" here is shared', () {
    test('for the one device the person pressed it for, signed by this app for the entry that added it', () async {
      for (final one in [true, false]) {
        backend = _Backend();
        keys = ViewerKeyStore(storage: _Memory());
        final log = await joined();
        final shared = one
            ? await log.dismiss(pub: pubOf(phone), confirm: true)
            : await log.dismiss(pubs: [pubOf(phone)], confirm: true);
        expect(shared, isTrue);
        expect((await log.list()).pending, isEmpty);
        expect(backend.posted, hasLength(1));
        final ack = backend.posted.single;
        expect(ack.signer, await self());
        expect(ack.pub, pubOf(phone));
        expect(ack.addSeq, backend.state.active[pubOf(phone)]!.seq);
        // What every other device checks it against: the same log.
        expect((await checkDevAck(backend.state, ack.toJson())).code, isNull);
      }
    });

    test('never for a list looked at, every device at once, or without "It\'s mine"', () async {
      final log = await joined();
      await backend.add(later, 'viewer', '', 'later');
      await log.refresh();
      expect(await log.dismiss(pubs: [pubOf(phone), pubOf(later)], confirm: true), isFalse);
      backend = _Backend();
      keys = ViewerKeyStore(storage: _Memory());
      final again = await joined();
      expect(await again.dismiss(pub: pubOf(phone)), isFalse);
      expect(await again.dismiss(confirm: true), isFalse);
      expect(backend.posted, isEmpty);
    });

    test('never for a key that was not new here, or this app\'s own', () async {
      final log = await joined();
      expect(await log.dismiss(pub: pubOf(box2), confirm: true), isFalse);
      expect(await log.dismiss(pub: await self(), confirm: true), isFalse);
      await log.dismiss(pub: pubOf(phone));
      expect(await log.dismiss(pub: pubOf(phone), confirm: true), isFalse);
      expect(backend.posted, isEmpty);
    });

    test('for a suspended key only when "It\'s mine" lifted the suspension here', () async {
      final log = await joined();
      await keys.writeDeviceLog({...await file(), 'suspended': [pubOf(phone)]});
      expect(await log.dismiss(pubs: [pubOf(phone)], confirm: true), isFalse);
      expect((await log.list()).suspended, [pubOf(phone)]);
      expect(await log.dismiss(pub: pubOf(phone), confirm: true), isTrue);
      expect((await log.list()).suspended, isEmpty);
    });

    test('not from a frozen log — the key is marked seen here all the same', () async {
      final log = await joined();
      await keys.writeDeviceLog({
        ...await file(),
        'frozen': {'reason': 'fork', 'at': 1, 'lastGoodHead': backend.state.head.toJson()},
      });
      expect(await log.dismiss(pub: pubOf(phone), confirm: true), isFalse);
      expect((await log.list()).pending, isEmpty);
      expect(backend.posted, isEmpty);
    });

    test('a backend that does not take it, or none to take it, leaves the dismissal here', () async {
      final log = await joined();
      backend.ackRoute = false;
      expect(await log.dismiss(pub: pubOf(phone), confirm: true), isFalse);
      expect((await log.list()).pending, isEmpty);
      backend = _Backend();
      keys = ViewerKeyStore(storage: _Memory());
      final alone = await joined(acks: false);
      expect(await alone.dismiss(pub: pubOf(phone), confirm: true), isFalse);
      expect((await alone.list()).pending, isEmpty);
    });
  });
}
