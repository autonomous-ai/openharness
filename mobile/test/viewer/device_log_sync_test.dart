import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/e2ee/keys.dart';
import 'package:harness_mobile/viewer/device_log.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';
import 'package:harness_mobile/viewer/group_sync.dart';
import 'package:harness_mobile/viewer/viewer_key_store.dart';

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

const _acct = 'acct-1';
final _mid2 = 'b' * 32, _mid3 = 'c' * 32;

class _Backend {
  final entries = <DevLogEntry>[];
  DevLogState state = DevLogState.empty(_acct);
  List<DevLogEntry>? lie;

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
    final log = lie ?? entries;
    final head = log.isEmpty
        ? DevLogState.empty(_acct).head
        : (await applyDevLogEntries(DevLogState.empty(_acct), [for (final e in log) e.toJson()])).state.head;
    return (acct: _acct, head: head, entries: [for (final e in log) if (e.seq > since) e.toJson()]);
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
  late int signedOut;
  late E2eeIdentity box2, box3;

  ViewerDeviceLog makeLog() => ViewerDeviceLog(
    keys: keys,
    fetch: backend.fetch,
    append: backend.append,
    label: () => 'my-phone',
    onAnnounce: announced.add,
    onSignedOut: () async => signedOut++,
    now: () => 5000,
    sleep: (_) async {},
  );

  setUp(() async {
    backend = _Backend();
    keys = ViewerKeyStore(storage: _Memory());
    announced = [];
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

  test('forgetting the identity mints a new one', () async {
    final before = b64e((await keys.identity()).pub);
    await keys.forgetIdentity();
    expect(b64e((await keys.identity()).pub), isNot(before));
  });
}
