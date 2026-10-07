import '../core/relative_time.dart';
import '../e2ee/bytes.dart';
import '../e2ee/keys.dart' as keys;
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
    this.seq,
    this.pending = false,
    this.suspended = false,
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

  /// The log entry that added it; null when the daemon predates the field.
  final int? seq;

  /// Joined after this end did and nobody marked it as seen.
  final bool pending;

  /// Not trusted here after a fork, until the list is reviewed.
  final bool suspended;

  bool get isMachine => kind == 'machine';

  AccountDevice withLastSeen(DateTime? at) => AccountDevice(
    pub: pub, label: label, kind: kind, machineId: machineId, addedAt: addedAt,
    fingerprint: fingerprint, self: self, lastSeen: at, seq: seq, pending: pending, suspended: suspended,
  );

  static AccountDevice? fromDaemon(Object? raw) {
    if (raw is! Map) return null;
    final pub = raw['pub'], label = raw['label'], kind = raw['kind'], machineId = raw['machineId'];
    final addedAt = raw['addedAt'], fp = raw['fingerprint'], self = raw['self'];
    if (pub is! String || label is! String || kind is! String || addedAt is! int || fp is! String) return null;
    return AccountDevice(
      pub: pub, label: label, kind: kind, machineId: machineId is String ? machineId : '',
      addedAt: DateTime.fromMillisecondsSinceEpoch(addedAt), fingerprint: fp, self: self == true,
      seq: raw['seq'] is int ? raw['seq'] as int : null,
      pending: raw['pending'] == true,
      suspended: raw['suspended'] == true,
    );
  }

  static AccountDevice fromRow(DeviceLogRow row) => AccountDevice(
    pub: row.member.pub, label: row.member.label, kind: row.member.kind, machineId: row.member.machineId,
    addedAt: DateTime.fromMillisecondsSinceEpoch(row.member.addedAt), fingerprint: row.fingerprint, self: row.self,
    seq: row.member.seq, pending: row.pending, suspended: row.suspended,
  );
}

/// Another key holds this computer's id on the account, so this computer cannot register (a desktop
/// build's daemon says so; `device_conflict`).
class DeviceConflict {
  const DeviceConflict({
    required this.pub,
    required this.label,
    required this.fingerprint,
    required this.addedAt,
    required this.afterJoin,
  });

  final String pub;
  final String label;
  final String fingerprint;
  final DateTime addedAt;

  /// The holder was added after this computer joined: someone took its place.
  final bool afterJoin;

  /// The listing's `conflict` and the `device_conflict` frame's payload are the same object.
  static DeviceConflict? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final pub = raw['pub'], label = raw['label'], fp = raw['fingerprint'], addedAt = raw['addedAt'];
    if (pub is! String || fp is! String || addedAt is! int) return null;
    return DeviceConflict(
      pub: pub,
      label: label is String ? label : '',
      fingerprint: fp,
      addedAt: DateTime.fromMillisecondsSinceEpoch(addedAt),
      afterJoin: raw['afterJoin'] == true,
    );
  }
}

/// What the Devices list says when the backend refused this device a place on the account ([code]).
String registerRefusalSentence(String code) => code == 'TOO_MANY'
    ? 'This device couldn’t join: your account has too many devices. Remove ones you no longer use.'
    : 'This device couldn’t join your account’s device list ($code).';

/// The account's devices and whether the list can be trusted as it stands.
class AccountDevices {
  const AccountDevices({
    required this.devices,
    this.frozenReason,
    this.frozenPeers = const [],
    this.pending = const [],
    this.joinedSeq,
    this.baselineSeen = true,
    this.baselineKeys,
    this.conflict,
    this.historyAvailable = true,
    this.departed = const [],
    this.registerError,
  });

  final List<AccountDevice> devices;

  /// Set when this end's copy of the log is FROZEN: the backend served a list that does not match
  /// what was verified before (`fork`, `rollback` or `invalid`). No device is added until someone
  /// reviews the change.
  final String? frozenReason;

  /// Machines that say their own copy is frozen.
  final List<String> frozenPeers;

  bool get frozen => frozenReason != null || frozenPeers.isNotEmpty;

  /// Keys that joined after this end did and nobody marked as seen.
  final List<String> pending;

  /// The log's head when this end joined; null when the daemon predates it.
  final int? joinedSeq;

  /// false until the "Already on your account" list was acknowledged.
  final bool baselineSeen;
  final DeviceConflict? conflict;

  /// Whether the history can be read from here: false for a daemon that predates it.
  final bool historyAvailable;

  /// Keys that joined and left before anyone looked, as this listing read them: the list is not where
  /// they are cleared (their own "Got it" is), so opening it must not mark them seen.
  final List<String> departed;

  /// Why the backend last refused this end a place in the log (`TOO_MANY`, …); null when it did not,
  /// or the daemon predates the field.
  final String? registerError;

  /// The keys the log's own listing named as the baseline panel's (`baseline`), when it sent them; null
  /// from a daemon that predates it, which falls back to the `seq <= joinedSeq` rule.
  final List<String>? baselineKeys;

  /// The devices that were on the account before this end joined it, which it never announced.
  List<AccountDevice> get baseline {
    final keys = baselineKeys;
    if (keys != null) {
      final set = keys.toSet();
      return [
        for (final d in devices)
          if (!d.self && set.contains(d.pub)) d,
      ];
    }
    final joined = joinedSeq;
    if (joined == null) return const [];
    return [
      for (final d in devices)
        if (!d.self && d.seq != null && d.seq! <= joined) d,
    ];
  }

  /// Apps not seen in [unusedAfter]: most likely a browser whose data was cleared, which never signs
  /// its own removal. Offered for removal together; never this app, never a computer (whose
  /// absence is visible in the machine list anyway), never one the backend has no record of.
  List<AccountDevice> unused(DateTime now, {Duration unusedAfter = const Duration(days: 90)}) => [
    for (final d in devices)
      if (!d.self && !d.isMachine && d.lastSeen != null && now.difference(d.lastSeen!) > unusedAfter) d,
  ];

  /// This computer (or app): shown on its own in the "This device" card, so the list below leaves it out.
  AccountDevice? get self {
    for (final d in devices) {
      if (d.self) return d;
    }
    return null;
  }

  /// The rows under the "This device" card: the new devices (those in [newPubs]) first, newest first,
  /// then the rest by last activity. Ties keep log order — `List.sort` is not stable, so the index breaks them.
  List<AccountDevice> listed(Set<String> newPubs) {
    final rows = [
      for (var i = 0; i < devices.length; i++)
        if (!devices[i].self) (index: i, device: devices[i], isNew: newPubs.contains(devices[i].pub)),
    ];
    rows.sort((a, b) {
      if (a.isNew != b.isNew) return a.isNew ? -1 : 1;
      final byTime = (b.isNew ? b.device.addedAt : b.device.lastSeen ?? b.device.addedAt).compareTo(
        a.isNew ? a.device.addedAt : a.device.lastSeen ?? a.device.addedAt,
      );
      return byTime != 0 ? byTime : a.index.compareTo(b.index);
    });
    return [for (final r in rows) r.device];
  }

  /// Names more than one device goes by (trimmed; an empty name counts as one name). Their rows add the
  /// start of the key code, since two rows that read the same cannot be told apart otherwise.
  Set<String> get sharedNames {
    final seen = <String>{};
    final shared = <String>{};
    for (final d in devices) {
      final name = d.label.trim();
      if (!seen.add(name)) shared.add(name);
    }
    return shared;
  }

  AccountDevices withLastSeen(Map<String, int> seen) => AccountDevices(
    devices: [
      for (final d in devices)
        d.withLastSeen(seen[d.pub] == null ? null : DateTime.fromMillisecondsSinceEpoch(seen[d.pub]!)),
    ],
    frozenReason: frozenReason,
    frozenPeers: frozenPeers,
    pending: pending,
    joinedSeq: joinedSeq,
    baselineSeen: baselineSeen,
    baselineKeys: baselineKeys,
    conflict: conflict,
    historyAvailable: historyAvailable,
    departed: departed,
    registerError: registerError,
  );

  static AccountDevices? fromDaemon(Map<String, dynamic>? raw) {
    if (raw == null) return null;
    final members = raw['members'];
    final frozen = raw['frozen'];
    final peers = raw['frozenPeers'];
    final pending = raw['pending'];
    return AccountDevices(
      devices: members is List ? members.map(AccountDevice.fromDaemon).whereType<AccountDevice>().toList() : const [],
      frozenReason: frozen is Map && frozen['reason'] is String ? frozen['reason'] as String : null,
      frozenPeers: peers is List ? peers.whereType<String>().toList() : const [],
      // An older daemon sends none of these: no `pending` array is how this end knows.
      pending: pending is List ? pending.whereType<String>().toList() : const [],
      joinedSeq: raw['joinedSeq'] is int ? raw['joinedSeq'] as int : null,
      baselineSeen: raw['baselineSeen'] is bool ? raw['baselineSeen'] as bool : true,
      baselineKeys: raw['baseline'] is List ? (raw['baseline'] as List).whereType<String>().toList() : null,
      conflict: DeviceConflict.fromJson(raw['conflict']),
      historyAvailable: pending is List,
      departed: [for (final d in DeviceLogDeparted.listFromJson(raw['departed'])) d.pub],
      registerError: raw['registerError'] is String ? raw['registerError'] as String : null,
    ).withLastSeen(parseLastSeen(raw['lastSeen']));
  }

  static AccountDevices fromListing(DeviceLogListing listing) => AccountDevices(
    devices: listing.members.map(AccountDevice.fromRow).toList(),
    frozenReason: listing.frozen?.reason,
    frozenPeers: listing.frozenPeers,
    pending: listing.pending,
    joinedSeq: listing.joinedSeq,
    baselineSeen: listing.baselineSeen,
    baselineKeys: listing.baseline,
    departed: [for (final d in listing.departed) d.pub],
    registerError: listing.registerError,
  );
}

/// What trusting the backend's list again would change.
class DevicesRebaseline {
  const DevicesRebaseline({
    required this.added,
    required this.removed,
    this.head,
    this.logChanged = false,
    this.otherAccount = false,
  });

  /// The "the list changed under the review" answer: nothing was trusted, review again.
  const DevicesRebaseline.changed()
    : added = const [],
      removed = const [],
      head = null,
      logChanged = true,
      otherAccount = false;

  /// The list is another account's than the one signed in to: nothing was trusted, and a review never
  /// switches accounts — signing in again does.
  const DevicesRebaseline.otherAccount()
    : added = const [],
      removed = const [],
      head = null,
      logChanged = false,
      otherAccount = true;

  final List<String> added;
  final List<String> removed;

  /// The head of the list this preview describes; handed back with the confirm so what gets trusted
  /// is what was shown.
  final DevLogHead? head;
  final bool logChanged;
  final bool otherAccount;

  /// Nothing was trusted ([logChanged] or [otherAccount]).
  bool get refused => logChanged || otherAccount;

  static DevicesRebaseline? fromDaemon(Map<String, dynamic>? raw) {
    if (raw == null) return null;
    if (raw['error'] == 'LOG_CHANGED') return const DevicesRebaseline.changed();
    if (raw['error'] == 'OTHER_ACCOUNT') return const DevicesRebaseline.otherAccount();
    String name(Object? m) => m is Map && m['label'] is String && (m['label'] as String).isNotEmpty ? m['label'] as String : 'A device';
    final added = raw['added'], removed = raw['removed'];
    return DevicesRebaseline(
      added: added is List ? added.map(name).toList() : const [],
      removed: removed is List ? removed.map(name).toList() : const [],
      head: DevLogHead.fromJson(raw['head']),
    );
  }

  static DevicesRebaseline fromViewer(DeviceLogRebaseline r) => r.otherAccount
      ? const DevicesRebaseline.otherAccount()
      : DevicesRebaseline(
          added: [for (final m in r.added) m.label.isEmpty ? 'A device' : m.label],
          removed: [for (final m in r.removed) m.label.isEmpty ? 'A device' : m.label],
          head: r.logChanged ? null : r.head,
          logChanged: r.logChanged,
        );
}

/// A device that joined the account and this end had never trusted: "New device: X".
class NewDeviceNotice {
  const NewDeviceNotice({
    required this.pub,
    required this.label,
    required this.kind,
    this.frameFingerprint,
    this.suspended = false,
  });

  final String pub;
  final String label;
  final String kind;

  /// A fork's suspension is on it (this app does not trust it until the list is reviewed): the banner's
  /// "It's mine" cannot settle it, so it opens the device instead.
  final bool suspended;

  /// The key code the `device_key_added` frame carried, when it did.
  final String? frameFingerprint;

  /// The key code to compare on the device itself: the frame's, else worked out from the key.
  String get fingerprint {
    final fromFrame = frameFingerprint;
    if (fromFrame != null && fromFrame.isNotEmpty) return fromFrame;
    try {
      return keys.fingerprint(b64d(pub));
    } catch (_) {
      return '';
    }
  }

  String get sentence {
    final name = label.isEmpty ? 'A device' : label;
    return kind == 'machine'
        ? '$name joined your account and can reach your machines.'
        : '$name signed in to your account and can reach your machines.';
  }

  static NewDeviceNotice fromMember(DevLogMember m, {bool suspended = false}) =>
      NewDeviceNotice(pub: m.pub, label: m.label, kind: m.kind, suspended: suspended);
}

/// `{pub: ms}` as the backend answers `GET /api/device-keys/seen`; anything else is dropped.
Map<String, int> parseLastSeen(Object? raw) => {
  if (raw is Map)
    for (final e in raw.entries)
      if (e.key is String && e.value is int) e.key as String: e.value as int,
};

/// The line under a device's name in the list: `Computer · active now`, `App · last active 2 days ago`.
/// With [sameName] — another device goes by the same name — it ends in the first group of the key code,
/// the one thing that tells the two apart without putting the whole code in the row.
String deviceDetailLine(AccountDevice d, {required DateTime now, required bool sameName}) {
  final what = d.isMachine ? 'Computer' : 'App';
  final when = activityPhrase(lastSeen: d.lastSeen, addedAt: d.addedAt, now: now);
  final tail = sameName && d.fingerprint.isNotEmpty ? ' · ${d.fingerprint.split('·').first}…' : '';
  return '$what · $when$tail';
}
