import 'dart:typed_data';

import '../e2ee/bytes.dart';
import '../e2ee/keys.dart';
import '../e2ee/primitives.dart';

/// The device key log — an account's append-only, hash-chained list of the identity keys its devices
/// hold (cli/src/lib/e2ee/deviceLog.ts, ported). Every device trusts the keys the log leaves active,
/// so signing in is all it takes for an app to reach the account's machines, with no remote password.
///
/// Pure: no I/O. Signatures and hashes cover [devLogMessage] — the fields length-prefixed in a fixed
/// order, numbers in decimal — never JSON. ⚠️ Held, with the CLI, the backend and
/// mobile/lib/viewer/device_log.dart, to `test/viewer/device_log.vectors.json`: change the format
/// in every copy together.

const devLogVersion = 1;
const devLogMaxActive = 256;
const devLogLabelMax = 60;

final _machineIdRe = RegExp(r'^[a-f0-9]{32}$');
final _controlRe = RegExp(r'[\u0000-\u001f\u007f]');
const _maxSafe = 9007199254740991;
final String devLogZeroHash = b64e(Uint8List(32));

class DevLogEntry {
  const DevLogEntry({
    required this.v,
    required this.acct,
    required this.seq,
    required this.prev,
    required this.op,
    required this.pub,
    required this.kind,
    required this.machineId,
    required this.label,
    required this.at,
    required this.signer,
    this.sig = '',
  });

  final int v;
  final String acct;
  final int seq;
  final String prev;

  /// `add` | `remove`.
  final String op;
  final String pub;

  /// `machine` | `viewer`.
  final String kind;
  final String machineId;
  final String label;
  final int at;
  final String signer;
  final String sig;

  DevLogEntry withSig(String sig) => DevLogEntry(
    v: v, acct: acct, seq: seq, prev: prev, op: op, pub: pub, kind: kind,
    machineId: machineId, label: label, at: at, signer: signer, sig: sig,
  );

  Map<String, Object?> toJson() => {
    'v': v, 'acct': acct, 'seq': seq, 'prev': prev, 'op': op, 'pub': pub, 'kind': kind,
    'machineId': machineId, 'label': label, 'at': at, 'signer': signer, 'sig': sig,
  };

  /// deviceLog.ts `parseDevLogEntry`: every field present, of its type and within bounds.
  static DevLogEntry? parse(Object? raw) {
    if (raw is! Map) return null;
    final v = raw['v'], acct = raw['acct'], seq = raw['seq'], prev = raw['prev'];
    final op = raw['op'], pub = raw['pub'], kind = raw['kind'];
    final machineId = raw['machineId'], label = raw['label'], at = raw['at'];
    final signer = raw['signer'], sig = raw['sig'];
    if (v != devLogVersion) return null;
    if (acct is! String || acct.isEmpty || acct.length > 128) return null;
    if (seq is! int || seq < 1 || seq > _maxSafe) return null;
    if (!_bytesOf(prev, 32) || !_bytesOf(pub, 32) || !_bytesOf(signer, 32) || !_bytesOf(sig, 64)) {
      return null;
    }
    if (op != 'add' && op != 'remove') return null;
    if (kind != 'machine' && kind != 'viewer') return null;
    if (machineId is! String) return null;
    if (kind == 'machine' ? !_machineIdRe.hasMatch(machineId) : machineId != '') return null;
    if (label is! String || label.length > devLogLabelMax || _controlRe.hasMatch(label)) return null;
    if (at is! int || at <= 0 || at > _maxSafe) return null;
    return DevLogEntry(
      v: v as int, acct: acct, seq: seq, prev: prev as String, op: op as String, pub: pub as String,
      kind: kind as String, machineId: machineId, label: label, at: at,
      signer: signer as String, sig: sig as String,
    );
  }
}

bool _bytesOf(Object? s, int n) {
  if (s is! String || s.length > 128) return false;
  try {
    final u = b64d(s);
    return u.length == n && b64e(u) == s;
  } catch (_) {
    return false;
  }
}

class DevLogMember {
  const DevLogMember({
    required this.pub,
    required this.kind,
    required this.machineId,
    required this.label,
    required this.addedAt,
    required this.seq,
  });

  final String pub;
  final String kind;
  final String machineId;
  final String label;
  final int addedAt;
  final int seq;

  DevLogMember withLabel(String label) => DevLogMember(
    pub: pub, kind: kind, machineId: machineId, label: label, addedAt: addedAt, seq: seq,
  );

  Map<String, Object?> toJson() => {
    'pub': pub, 'kind': kind, 'machineId': machineId, 'label': label, 'addedAt': addedAt, 'seq': seq,
  };

  static DevLogMember? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final pub = raw['pub'], kind = raw['kind'], machineId = raw['machineId'];
    final label = raw['label'], addedAt = raw['addedAt'], seq = raw['seq'];
    if (pub is! String || kind is! String || machineId is! String || label is! String) return null;
    if (addedAt is! int || seq is! int) return null;
    return DevLogMember(pub: pub, kind: kind, machineId: machineId, label: label, addedAt: addedAt, seq: seq);
  }
}

class DevLogHead {
  const DevLogHead(this.seq, this.hash);

  final int seq;
  final String hash;

  Map<String, Object?> toJson() => {'seq': seq, 'hash': hash};

  static DevLogHead? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final seq = raw['seq'], hash = raw['hash'];
    if (seq is! int || seq < 0 || hash is! String) return null;
    return DevLogHead(seq, hash);
  }

  @override
  bool operator ==(Object other) => other is DevLogHead && other.seq == seq && other.hash == hash;

  @override
  int get hashCode => Object.hash(seq, hash);
}

class DevLogState {
  DevLogState({
    required this.acct,
    required this.head,
    required this.hashes,
    required this.active,
    required this.removed,
  });

  factory DevLogState.empty(String acct) => DevLogState(
    acct: acct, head: DevLogHead(0, devLogZeroHash), hashes: [], active: {}, removed: [],
  );

  final String acct;
  DevLogHead head;

  /// hashes[i] is the hash of the entry with seq i + 1.
  final List<String> hashes;

  /// Active keys, by pub.
  final Map<String, DevLogMember> active;

  /// Keys a `remove` took out. A removed key never comes back.
  final List<String> removed;

  DevLogState copy() => DevLogState(
    acct: acct, head: head, hashes: [...hashes], active: {...active}, removed: [...removed],
  );

  Map<String, Object?> toJson() => {
    'acct': acct,
    'head': head.toJson(),
    'hashes': hashes,
    'active': {for (final e in active.entries) e.key: e.value.toJson()},
    'removed': removed,
  };

  static DevLogState? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final acct = raw['acct'], head = DevLogHead.fromJson(raw['head']);
    final hashes = raw['hashes'], active = raw['active'], removed = raw['removed'];
    if (acct is! String || head == null || hashes is! List || active is! Map || removed is! List) return null;
    final members = <String, DevLogMember>{};
    for (final e in active.entries) {
      final m = DevLogMember.fromJson(e.value);
      if (e.key is String && m != null) members[e.key as String] = m;
    }
    return DevLogState(
      acct: acct,
      head: head,
      hashes: hashes.whereType<String>().toList(),
      active: members,
      removed: removed.whereType<String>().toList(),
    );
  }
}

class DevLogError implements Exception {
  const DevLogError(this.code, this.seq);

  final String code;
  final int seq;

  @override
  String toString() => 'device log entry $seq: $code';
}

class DevLogApplied {
  DevLogApplied(this.state);

  final DevLogState state;
  final List<DevLogMember> added = [];
  final List<DevLogMember> removed = [];
  final List<DevLogMember> relabeled = [];
}

/// The bytes a signature covers.
Uint8List devLogMessage(DevLogEntry e) => lvCat([
  'harness-devlog-v1', '${e.v}', e.acct, '${e.seq}', b64d(e.prev), e.op, b64d(e.pub),
  e.kind, e.machineId, e.label, '${e.at}', b64d(e.signer),
]);

/// The entry's hash: what the next entry's `prev` names.
String devLogHash(DevLogEntry e) => b64e(sha256(lvCat([devLogMessage(e), b64d(e.sig)])));

Future<DevLogEntry> signDevLogEntry(DevLogEntry unsigned, E2eeIdentity identity) async =>
    unsigned.withSig(b64e(await identity.sign(devLogMessage(unsigned))));

/// The next entry to append on top of [state], unsigned.
DevLogEntry nextDevLogEntry(
  DevLogState state, {
  required String op,
  required String pub,
  required String kind,
  required String machineId,
  required String label,
  required String signer,
  required int at,
}) => DevLogEntry(
  v: devLogVersion, acct: state.acct, seq: state.head.seq + 1, prev: state.head.hash, op: op,
  pub: pub, kind: kind, machineId: machineId, label: label, at: at, signer: signer,
);

/// Apply [entries], in order, on top of [state]. All or nothing: the first entry that breaks a rule
/// throws a [DevLogError] and [state] is left as it was.
Future<DevLogApplied> applyDevLogEntries(DevLogState state, List<Object?> entries) async {
  final s = state.copy();
  final out = DevLogApplied(s);
  for (final raw in entries) {
    final expectedSeq = s.head.seq + 1;
    final e = DevLogEntry.parse(raw);
    if (e == null) throw DevLogError('BAD_ENTRY', expectedSeq);
    if (e.acct != s.acct) throw DevLogError('WRONG_ACCOUNT', e.seq);
    if (e.seq != expectedSeq) throw DevLogError('OUT_OF_ORDER', e.seq);
    if (e.prev != s.head.hash) throw DevLogError('BROKEN_CHAIN', e.seq);
    if (!await verifySignature(b64d(e.signer), devLogMessage(e), b64d(e.sig))) {
      throw DevLogError('BAD_SIGNATURE', e.seq);
    }
    if (e.op == 'add') {
      if (e.signer != e.pub) throw DevLogError('NOT_SELF_SIGNED', e.seq);
      if (s.removed.contains(e.pub)) throw DevLogError('KEY_REMOVED', e.seq);
      final current = s.active[e.pub];
      if (current != null) {
        if (current.kind != e.kind || current.machineId != e.machineId) {
          throw DevLogError('KIND_CHANGED', e.seq);
        }
        if (current.label == e.label) throw DevLogError('NO_CHANGE', e.seq);
        final relabeled = current.withLabel(e.label);
        s.active[e.pub] = relabeled;
        out.relabeled.add(relabeled);
      } else {
        if (e.kind == 'machine' &&
            s.active.values.any((m) => m.kind == 'machine' && m.machineId == e.machineId)) {
          throw DevLogError('MACHINE_TAKEN', e.seq);
        }
        if (s.active.length >= devLogMaxActive) throw DevLogError('TOO_MANY', e.seq);
        final member = DevLogMember(
          pub: e.pub, kind: e.kind, machineId: e.machineId, label: e.label, addedAt: e.at, seq: e.seq,
        );
        s.active[e.pub] = member;
        out.added.add(member);
      }
    } else {
      if (s.active[e.signer] == null) throw DevLogError('SIGNER_NOT_ACTIVE', e.seq);
      final gone = s.active.remove(e.pub);
      if (gone == null) throw DevLogError('NOT_ACTIVE', e.seq);
      s.removed.add(e.pub);
      out.removed.add(gone);
    }
    final hash = devLogHash(e);
    s.hashes.add(hash);
    s.head = DevLogHead(e.seq, hash);
  }
  return out;
}

/// The hash [state] holds for [seq]; null when it does not reach that far.
String? devLogHashAt(DevLogState state, int seq) {
  if (seq == 0) return devLogZeroHash;
  return seq >= 1 && seq <= state.hashes.length ? state.hashes[seq - 1] : null;
}

/// How another device's head relates to ours: `same`, `behind` (they are ahead of us), `ahead`
/// (we are ahead of them), or `fork` — two different entries at one position.
String compareDevLogHead(DevLogState state, DevLogHead theirs) {
  if (theirs.seq > state.head.seq) return 'behind';
  if (devLogHashAt(state, theirs.seq) != theirs.hash) return 'fork';
  return theirs.seq == state.head.seq ? 'same' : 'ahead';
}
