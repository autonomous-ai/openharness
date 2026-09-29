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

  /// Only through [updateGroupRoster]: a write that skipped its queue could undo one in flight.
  Future<void> _writeGroupRoster(Map<String, Object> roster) =>
      _storage.write(_groupKey, jsonEncode(roster));

  /// Reads, changes and writes the stored roster as one step. Two changes that overlap — a roster
  /// swap still waiting on the network, and a member taken in meanwhile — must not lose either:
  /// whichever runs second starts from what the first wrote.
  Future<T> updateGroupRoster<T>(
    Future<(Map<String, Object>, T)> Function(Object? current) change,
  ) {
    // In order within this runtime, and under the store's own lock across runtimes (browser tabs).
    final run = _groupChanges.then(
      (_) => _storage.synchronized('viewer_group', () async {
        final (next, out) = await change(await groupRoster());
        await _writeGroupRoster(next);
        return out;
      }),
    );
    // The queue survives a failed change: the next one still runs.
    _groupChanges = run.then<void>((_) {}, onError: (Object _) {});
    return run;
  }

  Future<void> _groupChanges = Future<void>.value();

  Future<void> _write(List<MachinePeer> peers) => _storage.write(
    _peersKey,
    jsonEncode([for (final peer in peers) peer.toJson()]),
  );
}
