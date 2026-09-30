import 'dart:async';
import 'dart:math';

import '../e2ee/bytes.dart';
import '../e2ee/keys.dart';
import 'device_log.dart';
import 'group_sync.dart';
import 'viewer_key_store.dart';

/// The account's device key log, on a device with no harness CLI — the viewer's half of
/// cli/src/lib/e2ee/deviceLogSyncer.ts.
///
/// Signing in is what puts this app's key into the log ([register]); every machine the log names is
/// then pinned here with no password, and every machine trusts this app. A backend that rewrites the
/// log or rolls it back FREEZES it here: nothing more is pinned from it until someone reviews what
/// changed ([rebaseline]). A machine this app had never trusted is announced ("New device: X").

/// What `GET /api/device-keys?since=` answered; null from the fetcher when there is no log to read.
typedef DeviceLogFetched = ({String acct, DevLogHead head, List<Object?> entries});

/// `POST /api/device-keys`: the new head, or a refusal (with the current head on `STALE_HEAD`).
typedef DeviceLogAppendAnswer = ({DevLogHead? head, String? error});

typedef DeviceLogFetch = Future<DeviceLogFetched?> Function(int since);
typedef DeviceLogAppend = Future<DeviceLogAppendAnswer?> Function(DevLogEntry entry);

class DeviceLogFreeze {
  const DeviceLogFreeze(this.reason, this.at, this.lastGoodHead);

  /// `fork` | `rollback` | `invalid` — see deviceLogStore.ts.
  final String reason;
  final int at;
  final DevLogHead lastGoodHead;

  Map<String, Object?> toJson() => {'reason': reason, 'at': at, 'lastGoodHead': lastGoodHead.toJson()};

  static DeviceLogFreeze? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final reason = raw['reason'], at = raw['at'], head = DevLogHead.fromJson(raw['lastGoodHead']);
    if (reason is! String || at is! int || head == null) return null;
    return DeviceLogFreeze(reason, at, head);
  }
}

class _File {
  _File(this.state, this.recent, this.frozen, this.notifiedUpTo);

  DevLogState? state;
  List<DevLogEntry> recent;
  DeviceLogFreeze? frozen;
  int notifiedUpTo;

  Map<String, Object?> toJson() => {
    'state': state?.toJson(),
    'recent': [for (final e in recent.skip(max(0, recent.length - _recentKept))) e.toJson()],
    'frozen': frozen?.toJson(),
    'notifiedUpTo': notifiedUpTo,
  };

  static _File parse(Object? raw) {
    if (raw is! Map) return _File(null, [], null, 0);
    final recent = raw['recent'];
    return _File(
      DevLogState.fromJson(raw['state']),
      recent is List ? recent.map(DevLogEntry.parse).whereType<DevLogEntry>().toList() : [],
      DeviceLogFreeze.fromJson(raw['frozen']),
      raw['notifiedUpTo'] is int ? raw['notifiedUpTo'] as int : 0,
    );
  }
}

const _recentKept = 64;
const _appendAttempts = 5;
const _pages = 20;

/// One device on the account, for the Devices list.
class DeviceLogRow {
  const DeviceLogRow(this.member, {required this.fingerprint, required this.self});

  final DevLogMember member;
  final String fingerprint;
  final bool self;
}

class DeviceLogListing {
  const DeviceLogListing({required this.members, required this.frozen, required this.frozenPeers});

  static const empty = DeviceLogListing(members: [], frozen: null, frozenPeers: []);

  final List<DeviceLogRow> members;
  final DeviceLogFreeze? frozen;

  /// Machines whose own copy of the log is frozen, as their last `group_sync` said.
  final List<String> frozenPeers;
}

class DeviceLogRebaseline {
  const DeviceLogRebaseline(this.head, this.added, this.removed);

  final DevLogHead head;
  final List<DevLogMember> added;
  final List<DevLogMember> removed;
}

class ViewerDeviceLog {
  ViewerDeviceLog({
    required this.keys,
    required this.fetch,
    required this.append,
    required this.label,
    this.onAnnounce,
    this.onSignedOut,
    this.onChanged,
    int Function()? now,
    Future<void> Function(Duration)? sleep,
  }) : _now = now ?? (() => DateTime.now().millisecondsSinceEpoch),
       _sleep = sleep ?? Future.delayed;

  final ViewerKeyStore keys;
  final DeviceLogFetch fetch;
  final DeviceLogAppend append;

  /// How this app calls itself in the account's list of devices.
  final String Function() label;

  /// A machine this app had never trusted joined the account: "New device: X".
  final void Function(DevLogMember member)? onAnnounce;

  /// This app's own key was removed from the account: it is signed out.
  final Future<void> Function()? onSignedOut;

  /// The list, or whether it is frozen, changed.
  final void Function()? onChanged;

  final int Function() _now;
  final Future<void> Function(Duration) _sleep;
  final Map<String, bool> _frozenPeers = {};
  Future<void>? _refreshing;
  final _random = Random();
  final Set<String> _removing = {};

  /// Set while a sign-in by hand registers: this app's old key being removed is then expected, and is
  /// replaced rather than signed out over.
  bool _signingInAgain = false;
  bool _signedOut = false;

  /// This app's key is gone from the log: sign out, once.
  Future<void> _signOut() async {
    if (_signedOut) return;
    _signedOut = true;
    await onSignedOut?.call();
  }

  Future<_File> _read() async => _File.parse(await keys.deviceLog());
  Future<void> _write(_File f) => keys.writeDeviceLog(f.toJson());
  Future<String> _selfPub() async => b64e((await keys.identity()).pub);

  /// Read the log and put this app's key into it. Never throws.
  ///
  /// [freshSignIn]: the person has just signed in, by hand. A key the log removed is then spent, not
  /// a reason to sign out — this app may have been signed out by the removal before it could read it
  /// (a revoked session answers 401 first), and signing in again must not end in a second sign-out.
  /// A stored session (the app opening) under a removed key signs out, as it always did.
  Future<void> register({bool freshSignIn = false}) async {
    _signingInAgain = freshSignIn;
    _signedOut = false;
    try {
      await refresh();
      var identity = await keys.identity();
      var pub = b64e(identity.pub);
      final name = _clip(label());
      for (var attempt = 0; attempt < _appendAttempts; attempt++) {
        final file = await _read();
        final state = file.state;
        if (state == null || file.frozen != null) return;
        if (state.removed.contains(pub)) {
          if (!freshSignIn) {
            await _signOut();
            return;
          }
          await keys.forgetIdentity();
          await refresh();
          identity = await keys.identity();
          pub = b64e(identity.pub);
          continue;
        }
        final mine = state.active[pub];
        if (mine != null && (mine.label == name || mine.kind != 'viewer')) return;
        final entry = await signDevLogEntry(
          nextDevLogEntry(state, op: 'add', pub: pub, kind: 'viewer', machineId: '', label: name, signer: pub, at: _now()),
          identity,
        );
        final answer = await append(entry);
        if (answer == null) return;
        if (answer.error == null) {
          await refresh();
          return;
        }
        if (answer.error != 'STALE_HEAD') return;
        await refresh();
        await _sleep(Duration(milliseconds: 200 + _random.nextInt(800) * (attempt + 1)));
      }
    } catch (_) {
      // The next sign-in, resume or push tries again.
    } finally {
      _signingInAgain = false;
    }
  }

  /// Read and verify whatever the log gained. Concurrent calls share one read. Never throws.
  Future<void> refresh() => _refreshing ??= _doRefresh().catchError((Object _) {}).whenComplete(() => _refreshing = null);

  Future<void> _doRefresh() async {
    var bootstrap = ((await _read()).state?.head.seq ?? 0) == 0;
    for (var page = 0; page < _pages; page++) {
      final file = await _read();
      final since = file.state?.head.seq ?? 0;
      final got = await fetch(since);
      if (got == null) return;
      if (file.state == null || file.state!.acct != got.acct) {
        // First read, or signed in to another account: that account's log starts from nothing here.
        await _write(_File(DevLogState.empty(got.acct), [], null, 0));
        bootstrap = true;
        if (got.head.seq == 0) return;
        if (since != 0) continue;
      }
      final current = await _read();
      final state = current.state!;
      if (current.frozen != null) {
        await _looseRemovals(got.entries);
        return;
      }
      if (got.head.seq < state.head.seq) return _freeze('rollback');
      if (got.head.seq == state.head.seq) {
        if (got.head.hash != state.head.hash) await _freeze('fork');
        return;
      }
      if (got.entries.isEmpty) return _freeze('invalid');
      if (!await _accept(got.entries, bootstrap)) return;
      if ((await _read()).state!.head.seq >= got.head.seq) return;
    }
  }

  Future<bool> _accept(List<Object?> entries, bool bootstrap) async {
    final file = await _read();
    final DevLogApplied applied;
    try {
      applied = await applyDevLogEntries(file.state!, entries);
    } on DevLogError catch (err) {
      await _freeze(err.code == 'BROKEN_CHAIN' || err.code == 'OUT_OF_ORDER' ? 'fork' : 'invalid');
      return false;
    }
    final selfPub = await _selfPub();
    final known = await _knownPubs();
    final news = bootstrap
        ? const <DevLogMember>[]
        : [
            for (final m in applied.added)
              if (m.seq > file.notifiedUpTo && m.pub != selfPub && !known.contains(m.pub)) m,
          ];
    await _write(_File(
      applied.state,
      [...file.recent, ...entries.map(DevLogEntry.parse).whereType<DevLogEntry>()],
      null,
      applied.state.head.seq,
    ));
    await _trust(bootstrap ? applied.state.active.values.toList() : [...applied.added, ...applied.relabeled]);
    for (final m in applied.removed) {
      await _drop(m);
    }
    for (final m in news) {
      onAnnounce?.call(m);
    }
    if (applied.state.removed.contains(selfPub) && !_signingInAgain) await _signOut();
    onChanged?.call();
    return true;
  }

  /// What this app already trusted — its pins and its trust group — so a key the log adds that is
  /// among them is not news.
  Future<Set<String>> _knownPubs() async {
    final roster = GroupRoster.parse(await keys.groupRoster());
    return {
      for (final p in await keys.peers()) b64e(p.pub),
      for (final m in roster.members) m.pub,
    };
  }

  /// Pin every machine the log adds, and put it in the trust group this app swaps with machines, so
  /// a machine that predates the log hears of it too. A removal the group made first stands.
  Future<void> _trust(List<DevLogMember> members) async {
    final selfPub = await _selfPub();
    final stored = GroupRoster.parse(await keys.groupRoster());
    final inRoster = {for (final m in stored.members) m.pub};
    final tombstoned = {for (final t in stored.removed) if (!inRoster.contains(t.pub)) t.pub};
    final now = _now();
    final adopt = [
      for (final m in members)
        if (m.pub != selfPub && !tombstoned.contains(m.pub)) m,
    ];
    final incoming = [
      for (final m in adopt)
        ?GroupMember.tryParse({
          'pub': m.pub,
          'kind': m.kind,
          'label': m.label,
          'at': min(m.addedAt, now),
          if (m.machineId.isNotEmpty) 'machineId': m.machineId,
        }),
    ];
    if (incoming.isNotEmpty) {
      final merged = mergeGroupRoster(stored, GroupRoster(incoming, const []), selfPub);
      await keys.writeGroupRoster(merged.roster.toJson());
    }
    for (final m in adopt) {
      if (m.kind != 'machine') continue;
      final current = await keys.peer(m.machineId);
      if (current != null && b64e(current.pub) == m.pub) continue;
      await keys.pin(m.machineId, b64d(m.pub), label: m.label);
    }
    // A removal the group made before the log existed must not be undone by the log. Not awaited:
    // this runs inside a read of the log, and a removal reads the log again when it lands — waiting
    // for it here would wait for this very read to finish.
    final state = (await _read()).state;
    if (state != null && state.active[selfPub] != null) {
      for (final pub in tombstoned) {
        if (state.active[pub] != null && !_removing.contains(pub)) unawaited(remove(pub));
      }
    }
  }

  Future<void> _drop(DevLogMember m) async {
    final selfPub = await _selfPub();
    final stored = GroupRoster.parse(await keys.groupRoster());
    final merged = mergeGroupRoster(stored, GroupRoster(const [], [GroupTombstone(m.pub, _now())]), selfPub);
    await keys.writeGroupRoster(merged.roster.toJson());
    if (m.kind == 'machine') {
      final current = await keys.peer(m.machineId);
      if (current != null && b64e(current.pub) == m.pub) await keys.unlink(m.machineId);
    }
  }

  /// While frozen, a removal still counts — if a key this app trusts signed it.
  Future<void> _looseRemovals(List<Object?> entries) async {
    final file = await _read();
    final state = file.state;
    if (state == null) return;
    var changed = false;
    for (final raw in entries) {
      final e = DevLogEntry.parse(raw);
      if (e == null || e.op != 'remove' || state.active[e.signer] == null) continue;
      final target = state.active[e.pub];
      if (target == null) continue;
      if (!await verifySignature(b64d(e.signer), devLogMessage(e), b64d(e.sig))) continue;
      state.active.remove(e.pub);
      state.removed.add(e.pub);
      await _drop(target);
      changed = true;
    }
    if (changed) {
      await _write(file);
      onChanged?.call();
    }
  }

  Future<void> _freeze(String reason) async {
    final file = await _read();
    if (file.frozen != null || file.state == null) return;
    file.frozen = DeviceLogFreeze(reason, _now(), file.state!.head);
    await _write(file);
    onChanged?.call();
  }

  /// Remove a device from the account, signed by this app. It stops being trusted here at once.
  /// Null when done, else why not.
  Future<String?> remove(String pub) async {
    _removing.add(pub);
    try {
      return await _removeOnce(pub);
    } finally {
      _removing.remove(pub);
    }
  }

  Future<String?> _removeOnce(String pub) async {
    final identity = await keys.identity();
    final selfPub = b64e(identity.pub);
    for (var attempt = 0; attempt < _appendAttempts; attempt++) {
      final file = await _read();
      final state = file.state;
      if (state == null) return 'UNAVAILABLE';
      final target = state.active[pub];
      if (target == null) return 'NOT_IN_LOG';
      if (state.active[selfPub] == null) return 'NOT_ACTIVE';
      await _drop(target);
      final entry = await signDevLogEntry(
        nextDevLogEntry(state, op: 'remove', pub: pub, kind: target.kind, machineId: target.machineId,
            label: target.label, signer: selfPub, at: _now()),
        identity,
      );
      final answer = await append(entry);
      if (answer == null) return 'UNAVAILABLE';
      if (answer.error == null) {
        await refresh();
        return null;
      }
      if (answer.error != 'STALE_HEAD') return answer.error;
      await refresh();
      await _sleep(Duration(milliseconds: 200 + _random.nextInt(800) * (attempt + 1)));
    }
    return 'UNAVAILABLE';
  }

  /// Signing out of this app: its key leaves the account's devices (best effort).
  Future<void> leave() async {
    try {
      await remove(await _selfPub());
    } catch (_) {}
  }

  /// What trusting the backend's log again would change; with [confirm], do it.
  Future<DeviceLogRebaseline?> rebaseline({required bool confirm}) async {
    final entries = <Object?>[];
    var acct = '';
    DevLogHead? head;
    for (var page = 0; page < _pages; page++) {
      final got = await fetch(entries.length);
      if (got == null) return null;
      acct = got.acct;
      head = got.head;
      entries.addAll(got.entries);
      if (got.entries.isEmpty || entries.length >= got.head.seq) break;
    }
    final DevLogState next;
    try {
      next = (await applyDevLogEntries(DevLogState.empty(acct), entries)).state;
    } on DevLogError {
      return null;
    }
    if (head == null || next.head != head) return null;
    final file = await _read();
    final before = file.state?.active ?? const <String, DevLogMember>{};
    final added = [for (final m in next.active.values) if (before[m.pub] == null) m];
    final removed = [for (final m in before.values) if (next.active[m.pub] == null) m];
    if (confirm) {
      await _write(_File(next, entries.map(DevLogEntry.parse).whereType<DevLogEntry>().toList(), null, next.head.seq));
      await _trust(next.active.values.toList());
      for (final m in removed) {
        await _drop(m);
      }
      onChanged?.call();
    }
    return DeviceLogRebaseline(next.head, added, removed);
  }

  /// What rides this app's side of a `group_sync`.
  Future<Map<String, Object?>?> gossip() async {
    final file = await _read();
    final state = file.state;
    if (state == null) return null;
    return {'head': state.head.toJson(), 'frozen': file.frozen != null};
  }

  /// A machine's answer to this app's `group_sync`: its head, whether it is frozen, and the entries
  /// this app lacks if it is behind.
  Future<void> heard(String machinePub, Object? raw) async {
    final file = await _read();
    final state = file.state;
    if (state == null || raw is! Map) return;
    _frozenPeers[machinePub] = raw['frozen'] == true;
    final theirs = DevLogHead.fromJson(raw['head']);
    if (theirs == null) return;
    final relation = compareDevLogHead(state, theirs);
    if (relation == 'fork') return _freeze('fork');
    if (relation == 'behind') {
      final tail = raw['tail'];
      final missing = tail is List
          ? [for (final e in tail) if ((DevLogEntry.parse(e)?.seq ?? 0) > state.head.seq) e]
          : const <Object?>[];
      if (missing.isNotEmpty && file.frozen == null) await _accept(missing, false);
      unawaited(refresh());
    }
  }

  /// The account's devices as this app's log has them.
  Future<DeviceLogListing> list() async {
    final file = await _read();
    final selfPub = await _selfPub();
    final members = (file.state?.active.values.toList() ?? [])..sort((a, b) => a.seq.compareTo(b.seq));
    final labels = {for (final m in members) m.pub: m.label};
    return DeviceLogListing(
      members: [
        for (final m in members) DeviceLogRow(m, fingerprint: fingerprint(b64d(m.pub)), self: m.pub == selfPub),
      ],
      frozen: file.frozen,
      frozenPeers: [
        for (final e in _frozenPeers.entries)
          if (e.value) labels[e.key] ?? fingerprint(b64d(e.key)),
      ],
    );
  }
}

String _clip(String label) {
  final clean = label.replaceAll(RegExp(r'[\u0000-\u001f\u007f]'), ' ').trim();
  return clean.length > devLogLabelMax ? clean.substring(0, devLogLabelMax) : clean;
}
