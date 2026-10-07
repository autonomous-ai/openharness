import 'dart:convert';
import 'dart:typed_data';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';
import '../e2ee/bytes.dart';
import '../e2ee/keys.dart';

/// A machine this device linked to by its remote password, and the identity it pinned for it — the
/// same shape as the harness CLI's `machinePeers.json` rows.
class MachinePeer {
  const MachinePeer({
    required this.machineId,
    required this.pub,
    required this.linkedAt,
    this.label = '',
  });

  final String machineId;
  final Uint8List pub;
  final String label;
  final DateTime linkedAt;

  /// Null for a row that is not one — a damaged file loses that row, not every link.
  static MachinePeer? tryParse(Object? json) {
    if (json is! Map) return null;
    final machineId = json['machineId'], pub = json['pub'];
    final linkedAt = json['linkedAt'], label = json['label'];
    if (machineId is! String || pub is! String || linkedAt is! int) return null;
    try {
      return MachinePeer(
        machineId: machineId,
        pub: b64d(pub),
        label: label is String ? label : '',
        linkedAt: DateTime.fromMillisecondsSinceEpoch(linkedAt),
      );
    } on FormatException {
      return null;
    }
  }

  Map<String, Object> toJson() => {
    'machineId': machineId,
    'pub': b64e(pub),
    'label': label,
    'linkedAt': linkedAt.millisecondsSinceEpoch,
  };
}

/// This device's E2EE identity and the machines it has linked — what the harness CLI keeps under
/// its `e2e/` directory, kept here where there is no CLI.
///
/// TODO(security): the identity seed lives in the state file — 0600 on a desktop, the app sandbox
/// on iOS — the protection the CLI gives its own and less than Keychain/DPAPI would. Moving it
/// into the platform keystore is a follow-up.
class ViewerKeyStore {
  ViewerKeyStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared;

  final LocalKeyValueStore _storage;
  Future<E2eeIdentity>? _identity;

  static const _seedKey = 'viewer_e2ee_identity_seed';
  static const _peersKey = 'viewer_e2ee_machine_peers';
  static const _groupKey = 'viewer_e2ee_group';
  static const _devLogKey = 'viewer_e2ee_devlog';
  static const _devLogArchiveKey = 'viewer_e2ee_devlog_archive';
  static const _signInKey = 'viewer_e2ee_sign_in';
  static const _signInAcctKey = 'viewer_e2ee_sign_in_acct';

  /// Minted on first use and kept: every linked machine has pinned it.
  Future<E2eeIdentity> identity() => _identity ??= _loadOrMintIdentity();

  Future<E2eeIdentity> _loadOrMintIdentity() =>
      _storage.synchronized('viewer_identity', () async {
        final stored = await _storage.read(_seedKey);
        if (stored != null) return E2eeIdentity.fromSeed(b64d(stored));
        final minted = await E2eeIdentity.generate();
        await _storage.write(_seedKey, b64e(minted.seed));
        return minted;
      });

  /// Newest link first.
  Future<List<MachinePeer>> peers() async {
    final raw = await _storage.read(_peersKey);
    if (raw == null) return const [];
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return const [];
    }
    if (decoded is! List) return const [];
    return decoded.map(MachinePeer.tryParse).whereType<MachinePeer>().toList()
      ..sort((a, b) => b.linkedAt.compareTo(a.linkedAt));
  }

  Future<MachinePeer?> peer(String machineId) async {
    for (final peer in await peers()) {
      if (peer.machineId == machineId) return peer;
    }
    return null;
  }

  Future<void> pin(String machineId, List<int> pub, {String label = ''}) =>
      _storage.synchronized('viewer_peers', () async {
        await _write([
          for (final peer in await peers())
            if (peer.machineId != machineId) peer,
          MachinePeer(
            machineId: machineId,
            pub: Uint8List.fromList(pub),
            label: label,
            linkedAt: DateTime.now(),
          ),
        ]);
      });

  /// False when [machineId] was not linked.
  Future<bool> unlink(String machineId) =>
      _storage.synchronized('viewer_peers', () async {
        final current = await peers();
        final remaining = current
            .where((peer) => peer.machineId != machineId)
            .toList();
        if (remaining.length == current.length) return false;
        await _write(remaining);
        return true;
      });

  /// The trust group as this device last knew it (`group_sync.dart`), as stored JSON; null when
  /// there is none yet or it cannot be read.
  Future<Object?> groupRoster() async {
    final raw = await _storage.read(_groupKey);
    if (raw == null) return null;
    try {
      return jsonDecode(raw);
    } on FormatException {
      return null;
    }
  }

  Future<void> writeGroupRoster(Map<String, Object> roster) =>
      _storage.write(_groupKey, jsonEncode(roster));

  /// This device's verified copy of the account's device key log (`device_log_sync.dart`), as stored
  /// JSON; null when there is none yet or it cannot be read.
  Future<Object?> deviceLog() async {
    final raw = await _storage.read(_devLogKey);
    if (raw == null) return null;
    try {
      return jsonDecode(raw);
    } on FormatException {
      return null;
    }
  }

  Future<void> writeDeviceLog(Map<String, Object?> log) =>
      _storage.write(_devLogKey, jsonEncode(log));

  /// The device key logs of accounts this device was signed in to before, by account id, as stored
  /// JSON; empty when there are none or they cannot be read.
  Future<Map<String, Object?>> deviceLogArchive() async {
    final raw = await _storage.read(_devLogArchiveKey);
    if (raw == null) return {};
    try {
      final decoded = jsonDecode(raw);
      return decoded is Map ? decoded.cast<String, Object?>() : {};
    } on FormatException {
      return {};
    }
  }

  Future<void> writeDeviceLogArchive(Map<String, Object?> archive) =>
      _storage.write(_devLogArchiveKey, jsonEncode(archive));

  /// Which sign-in by hand this device is under (`device_log_sync.dart` keeps its marks per sign-in);
  /// null when none was recorded.
  Future<String?> signInEpoch() => _storage.read(_signInKey);

  Future<void> writeSignInEpoch(String epoch) =>
      _storage.write(_signInKey, epoch);

  /// The account the sign-in by hand [epoch] was made to, as the profile said right after it; null
  /// when none was recorded for that sign-in (one recorded for an earlier sign-in never answers).
  Future<String?> signInAcct(String epoch) async {
    final raw = await _storage.read(_signInAcctKey);
    if (raw == null) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map && decoded['epoch'] == epoch && decoded['acct'] is String) {
        return decoded['acct'] as String;
      }
    } on FormatException {
      // Unreadable: none recorded.
    }
    return null;
  }

  Future<void> writeSignInAcct(String epoch, String acct) =>
      _storage.write(_signInAcctKey, jsonEncode({'epoch': epoch, 'acct': acct}));

  /// What this device trusts — its pins and its trust group — as stored: kept with an account's
  /// device key log when this device signs in to another one ([writeTrust] puts it back).
  Future<Map<String, Object?>> trustSnapshot() async => {
    'peers': await _storage.read(_peersKey),
    'group': await _storage.read(_groupKey),
  };

  /// Trust exactly what [snapshot] ([trustSnapshot]) holds; an empty one trusts nothing.
  Future<void> writeTrust(Map<Object?, Object?> snapshot) async {
    await _storage.synchronized('viewer_peers', () => _put(_peersKey, snapshot['peers']));
    await _put(_groupKey, snapshot['group']);
  }

  Future<void> _put(String key, Object? value) =>
      value is String ? _storage.write(key, value) : _storage.delete(key);

  /// This device was removed from the account's device key log: its identity is spent. The next one
  /// minted is a new device, which every other device announces as one. The log as this device
  /// verified it stays, with every mark on it: signing in again to the same account goes on from there.
  Future<void> forgetIdentity() =>
      _storage.synchronized('viewer_identity', () async {
        _identity = null;
        await _storage.delete(_seedKey);
      });

  Future<void> _write(List<MachinePeer> peers) => _storage.write(
    _peersKey,
    jsonEncode([for (final peer in peers) peer.toJson()]),
  );
}
