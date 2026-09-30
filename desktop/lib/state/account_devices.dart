import '../viewer/device_log.dart';
import '../viewer/device_log_sync.dart';

/// One device on the account, as the Devices list draws it — whichever end verified the log: this
/// computer's daemon (a desktop build, `GET /api/devices`) or this app itself (a viewer build,
/// `viewer/device_log_sync.dart`).
class AccountDevice {
  const AccountDevice({
    required this.pub,
    required this.label,
    required this.kind,
    required this.machineId,
    required this.addedAt,
    required this.fingerprint,
    required this.self,
    this.lastSeen,
  });

  final String pub;
  final String label;

  /// `machine` | `viewer`.
  final String kind;
  final String machineId;
  final DateTime addedAt;
  final String fingerprint;

  /// This computer (or this app).
  final bool self;

  /// When this key last opened an E2EE session, as the backend saw it; null when it does not know.
  final DateTime? lastSeen;

  bool get isMachine => kind == 'machine';

  AccountDevice withLastSeen(DateTime? at) => AccountDevice(
    pub: pub, label: label, kind: kind, machineId: machineId, addedAt: addedAt,
    fingerprint: fingerprint, self: self, lastSeen: at,
  );

  static AccountDevice? fromDaemon(Object? raw) {
    if (raw is! Map) return null;
    final pub = raw['pub'], label = raw['label'], kind = raw['kind'], machineId = raw['machineId'];
    final addedAt = raw['addedAt'], fp = raw['fingerprint'], self = raw['self'];
    if (pub is! String || label is! String || kind is! String || addedAt is! int || fp is! String) return null;
    return AccountDevice(
      pub: pub, label: label, kind: kind, machineId: machineId is String ? machineId : '',
      addedAt: DateTime.fromMillisecondsSinceEpoch(addedAt), fingerprint: fp, self: self == true,
    );
  }

  static AccountDevice fromRow(DeviceLogRow row) => AccountDevice(
    pub: row.member.pub, label: row.member.label, kind: row.member.kind, machineId: row.member.machineId,
    addedAt: DateTime.fromMillisecondsSinceEpoch(row.member.addedAt), fingerprint: row.fingerprint, self: row.self,
  );
}

/// The account's devices and whether the list can be trusted as it stands.
class AccountDevices {
  const AccountDevices({required this.devices, this.frozenReason, this.frozenPeers = const []});

  final List<AccountDevice> devices;

  /// Set when this end's copy of the log is FROZEN: the backend served a list that does not match
  /// what was verified before (`fork`, `rollback` or `invalid`). No device is added until someone
  /// reviews the change.
  final String? frozenReason;

  /// Machines that say their own copy is frozen.
  final List<String> frozenPeers;

  bool get frozen => frozenReason != null || frozenPeers.isNotEmpty;

  /// Apps not seen in [unusedAfter]: most likely a browser whose data was cleared, which never signs
  /// its own removal. Offered for removal together; never this app, never a computer (whose
  /// absence is visible in the machine list anyway), never one the backend has no record of.
  List<AccountDevice> unused(DateTime now, {Duration unusedAfter = const Duration(days: 90)}) => [
    for (final d in devices)
      if (!d.self && !d.isMachine && d.lastSeen != null && now.difference(d.lastSeen!) > unusedAfter) d,
  ];

  AccountDevices withLastSeen(Map<String, int> seen) => AccountDevices(
    devices: [
      for (final d in devices)
        d.withLastSeen(seen[d.pub] == null ? null : DateTime.fromMillisecondsSinceEpoch(seen[d.pub]!)),
    ],
    frozenReason: frozenReason,
    frozenPeers: frozenPeers,
  );

  static AccountDevices? fromDaemon(Map<String, dynamic>? raw) {
    if (raw == null) return null;
    final members = raw['members'];
    final frozen = raw['frozen'];
    final peers = raw['frozenPeers'];
    return AccountDevices(
      devices: members is List ? members.map(AccountDevice.fromDaemon).whereType<AccountDevice>().toList() : const [],
      frozenReason: frozen is Map && frozen['reason'] is String ? frozen['reason'] as String : null,
      frozenPeers: peers is List ? peers.whereType<String>().toList() : const [],
    ).withLastSeen(parseLastSeen(raw['lastSeen']));
  }

  static AccountDevices fromListing(DeviceLogListing listing) => AccountDevices(
    devices: listing.members.map(AccountDevice.fromRow).toList(),
    frozenReason: listing.frozen?.reason,
    frozenPeers: listing.frozenPeers,
  );
}

/// What trusting the backend's list again would change.
class DevicesRebaseline {
  const DevicesRebaseline({required this.added, required this.removed});

  final List<String> added;
  final List<String> removed;

  static DevicesRebaseline? fromDaemon(Map<String, dynamic>? raw) {
    if (raw == null) return null;
    String name(Object? m) => m is Map && m['label'] is String && (m['label'] as String).isNotEmpty ? m['label'] as String : 'A device';
    final added = raw['added'], removed = raw['removed'];
    return DevicesRebaseline(
      added: added is List ? added.map(name).toList() : const [],
      removed: removed is List ? removed.map(name).toList() : const [],
    );
  }

  static DevicesRebaseline fromViewer(DeviceLogRebaseline r) => DevicesRebaseline(
    added: [for (final m in r.added) m.label.isEmpty ? 'A device' : m.label],
    removed: [for (final m in r.removed) m.label.isEmpty ? 'A device' : m.label],
  );
}

/// A device that joined the account and this end had never trusted: "New device: X".
class NewDeviceNotice {
  const NewDeviceNotice({required this.pub, required this.label, required this.kind});

  final String pub;
  final String label;
  final String kind;

  String get sentence {
    final name = label.isEmpty ? 'A device' : label;
    return kind == 'machine'
        ? '$name joined your account and can reach your machines.'
        : '$name signed in to your account and can reach your machines.';
  }

  static NewDeviceNotice fromMember(DevLogMember m) => NewDeviceNotice(pub: m.pub, label: m.label, kind: m.kind);
}

/// `{pub: ms}` as the backend answers `GET /api/device-keys/seen`; anything else is dropped.
Map<String, int> parseLastSeen(Object? raw) => {
  if (raw is Map)
    for (final e in raw.entries)
      if (e.key is String && e.value is int) e.key as String: e.value as int,
};
