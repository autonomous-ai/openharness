import '../e2ee/bytes.dart';
import '../e2ee/keys.dart';
import 'device_log.dart';

/// The device key log read as a history — the Dart port of cli/src/lib/e2ee/deviceHistory.ts. The rows
/// are the wire format of the daemon's `GET /api/devices/history`, so [DevLogHistoryRow.fromJson]
/// reads exactly what the CLI's `devLogHistory` writes. Change both together.

/// A key that was new here and was removed before anyone marked it as seen: it stays flagged — "joined
/// your account and left before you looked" — until it is dismissed. The same JSON as an item of the
/// daemon's `GET /api/devices` `departed` (cli deviceLogStore.ts `DevLogDeparted`).
class DeviceLogDeparted {
  const DeviceLogDeparted({
    required this.pub,
    required this.label,
    required this.kind,
    required this.machineId,
    required this.fingerprint,
    required this.addedAt,
    required this.removedAt,
    required this.removedBy,
    required this.removedByLabel,
    required this.selfRemoved,
  });

  final String pub;
  final String label;

  /// `machine` | `viewer`.
  final String kind;
  final String machineId;
  final String fingerprint;

  /// The `at` of the entry that added it (picked by that device).
  final int addedAt;

  /// The `at` of the entry that removed it (picked by its signer).
  final int removedAt;

  /// The key that signed the removal, and what it was called then ('' when not known).
  final String removedBy;
  final String removedByLabel;

  /// It removed itself (signed out).
  final bool selfRemoved;

  Map<String, Object?> toJson() => {
    'pub': pub,
    'label': label,
    'kind': kind,
    'machineId': machineId,
    'fingerprint': fingerprint,
    'addedAt': addedAt,
    'removedAt': removedAt,
    'removedBy': removedBy,
    'removedByLabel': removedByLabel,
    'selfRemoved': selfRemoved,
  };

  static DeviceLogDeparted? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final pub = raw['pub'],
        label = raw['label'],
        kind = raw['kind'],
        machineId = raw['machineId'];
    final fp = raw['fingerprint'],
        addedAt = raw['addedAt'],
        removedAt = raw['removedAt'];
    final by = raw['removedBy'],
        byLabel = raw['removedByLabel'],
        self = raw['selfRemoved'];
    if (pub is! String ||
        pub.isEmpty ||
        label is! String ||
        (kind != 'machine' && kind != 'viewer')) {
      return null;
    }
    if (machineId is! String ||
        fp is! String ||
        addedAt is! int ||
        removedAt is! int) {
      return null;
    }
    if (by is! String || byLabel is! String || self is! bool) return null;
    return DeviceLogDeparted(
      pub: pub,
      label: label,
      kind: kind as String,
      machineId: machineId,
      fingerprint: fp,
      addedAt: addedAt,
      removedAt: removedAt,
      removedBy: by,
      removedByLabel: byLabel,
      selfRemoved: self,
    );
  }

  /// A `departed` list as the daemon (or a stored file) has it: what cannot be read is left out.
  static List<DeviceLogDeparted> listFromJson(Object? raw) => [
    if (raw is List)
      for (final d in raw) ?DeviceLogDeparted.fromJson(d),
  ];
}

/// A device taken out of the account after this app joined it — the same JSON as the daemon's
/// `device_key_removed` frame (cli deviceLogSyncer.ts `DeviceRemovalNotice`).
class DeviceRemovalNotice {
  const DeviceRemovalNotice({
    required this.pub,
    required this.label,
    required this.kind,
    required this.fingerprint,
    required this.signer,
    required this.signerLabel,
    required this.signerFingerprint,
    required this.signerPending,
    required this.selfRemoved,
    required this.at,
  });

  final String pub;
  final String label;
  final String kind;
  final String fingerprint;
  final String signer;
  final String signerLabel;
  final String signerFingerprint;

  /// The signer is itself a new device nobody has looked at.
  final bool signerPending;

  /// The device removed itself (signed out).
  final bool selfRemoved;
  final int at;

  Map<String, Object?> toJson() => {
    'pub': pub,
    'label': label,
    'kind': kind,
    'fingerprint': fingerprint,
    'signer': signer,
    'signerLabel': signerLabel,
    'signerFingerprint': signerFingerprint,
    'signerPending': signerPending,
    'selfRemoved': selfRemoved,
    'at': at,
  };

  static DeviceRemovalNotice? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final pub = raw['pub'],
        label = raw['label'],
        kind = raw['kind'],
        fp = raw['fingerprint'];
    final signer = raw['signer'],
        signerLabel = raw['signerLabel'],
        signerFp = raw['signerFingerprint'];
    if (pub is! String ||
        label is! String ||
        kind is! String ||
        fp is! String) {
      return null;
    }
    if (signer is! String || signerLabel is! String || signerFp is! String) {
      return null;
    }
    return DeviceRemovalNotice(
      pub: pub,
      label: label,
      kind: kind,
      fingerprint: fp,
      signer: signer,
      signerLabel: signerLabel,
      signerFingerprint: signerFp,
      signerPending: raw['signerPending'] == true,
      selfRemoved: raw['selfRemoved'] == true,
      at: raw['at'] is int ? raw['at'] as int : 0,
    );
  }
}

class DevLogHistoryBy {
  const DevLogHistoryBy({
    required this.pub,
    required this.label,
    required this.fingerprint,
  });

  final String pub;
  final String label;
  final String fingerprint;

  static DevLogHistoryBy? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final pub = raw['pub'], label = raw['label'], fp = raw['fingerprint'];
    if (pub is! String || label is! String || fp is! String) return null;
    return DevLogHistoryBy(pub: pub, label: label, fingerprint: fp);
  }
}

class DevLogHistoryRow {
  const DevLogHistoryRow({
    required this.seq,
    required this.op,
    required this.pub,
    required this.kind,
    required this.machineId,
    required this.label,
    this.previousLabel,
    required this.fingerprint,
    this.by,
    required this.at,
    required this.thisDevice,
    required this.afterJoin,
    required this.pending,
    required this.active,
    required this.whileFrozen,
  });

  final int seq;

  /// `added` | `renamed` | `removed` | `signedOut`.
  final String op;
  final String pub;
  final String kind;
  final String machineId;
  final String label;

  /// For `renamed`: the name it had before, when known.
  final String? previousLabel;
  final String fingerprint;

  /// For `removed`: the key that signed the removal.
  final DevLogHistoryBy? by;
  final int at;
  final bool thisDevice;

  /// Added after this device joined.
  final bool afterJoin;

  /// Still new: nobody marked it as seen here.
  final bool pending;

  /// The key is active in the log now.
  final bool active;

  /// A removal applied while the list was frozen (unchained, so unverified).
  final bool whileFrozen;

  static DevLogHistoryRow? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final seq = raw['seq'],
        op = raw['op'],
        pub = raw['pub'],
        kind = raw['kind'];
    final machineId = raw['machineId'], label = raw['label'];
    final fp = raw['fingerprint'], at = raw['at'];
    if (seq is! int || op is! String || pub is! String || kind is! String) {
      return null;
    }
    if (machineId is! String || label is! String || fp is! String) return null;
    if (at is! int) return null;
    final previous = raw['previousLabel'];
    return DevLogHistoryRow(
      seq: seq,
      op: op,
      pub: pub,
      kind: kind,
      machineId: machineId,
      label: label,
      previousLabel: previous is String ? previous : null,
      fingerprint: fp,
      by: DevLogHistoryBy.fromJson(raw['by']),
      at: at,
      thisDevice: raw['thisDevice'] == true,
      afterJoin: raw['afterJoin'] == true,
      pending: raw['pending'] == true,
      active: raw['active'] == true,
      whileFrozen: raw['whileFrozen'] == true,
    );
  }
}

class DeviceLogHistory {
  const DeviceLogHistory({required this.rows, required this.complete});

  final List<DevLogHistoryRow> rows;

  /// false when only part of the log could be read (offline).
  final bool complete;

  static DeviceLogHistory? fromJson(Object? raw) {
    if (raw is! Map || raw['rows'] is! List) return null;
    return DeviceLogHistory(
      rows: [
        for (final r in raw['rows'] as List) ?DevLogHistoryRow.fromJson(r),
      ],
      complete: raw['complete'] == true,
    );
  }
}

String _fp(String pub) {
  try {
    return fingerprint(b64d(pub));
  } catch (_) {
    return '';
  }
}

/// Newest first. [entries] may have gaps at the front (offline: only the recent tail is known).
/// [loose] are removals applied while frozen: they are not part of the chain, and are shown as such.
List<DevLogHistoryRow> devLogHistory(
  List<DevLogEntry> entries, {
  required String selfPub,
  int? joinedSeq,
  required List<String> pending,
  required Map<String, DevLogMember> active,
  List<DevLogEntry> loose = const [],
}) {
  final seen = <String>{};
  final ordered = <(DevLogEntry, bool)>[];
  final sorted = [...entries]..sort((a, b) => a.seq.compareTo(b.seq));
  for (final e in sorted) {
    if (seen.add('${e.seq}:${e.sig}')) ordered.add((e, false));
  }
  for (final e in loose) {
    if (seen.add('${e.seq}:${e.sig}')) ordered.add((e, true));
  }
  // The name each key last went by, to say "renamed from" and to name a signer that is gone.
  final labels = {for (final m in active.values) m.pub: m.label};
  final known = <String, ({String label, String kind, String machineId})>{};
  final rows = <DevLogHistoryRow>[];
  for (final (e, isLoose) in ordered) {
    // A removal names the key as the log had it BEFORE: the remove entry's own label, kind and machine
    // id are chosen by whoever signed it, and say nothing checked. When the add is outside what is
    // known (offline, the newest entries only) the key is named by its fingerprint alone: an empty
    // label, shown as "A device", and no kind or machine id of the signer's.
    final prior = e.op == 'remove' ? known[e.pub] : null;
    DevLogHistoryRow row(
      String op, {
      String? previousLabel,
      DevLogHistoryBy? by,
    }) => DevLogHistoryRow(
      seq: e.seq,
      op: op,
      pub: e.pub,
      kind: e.op == 'remove' ? prior?.kind ?? 'viewer' : e.kind,
      machineId: e.op == 'remove' ? prior?.machineId ?? '' : e.machineId,
      label: e.op == 'remove' ? prior?.label ?? '' : e.label,
      previousLabel: previousLabel,
      fingerprint: _fp(e.pub),
      by: by,
      at: e.at,
      thisDevice: e.pub == selfPub,
      afterJoin: joinedSeq != null && e.seq > joinedSeq,
      pending: pending.contains(e.pub),
      active: active.containsKey(e.pub),
      whileFrozen: isLoose,
    );
    if (e.op == 'add') {
      final before = known[e.pub];
      final member = active[e.pub];
      if (before != null || (member != null && member.seq < e.seq)) {
        rows.add(row('renamed', previousLabel: before?.label));
      } else {
        rows.add(row('added'));
      }
      known[e.pub] = (label: e.label, kind: e.kind, machineId: e.machineId);
      labels[e.pub] = e.label;
    } else if (e.signer == e.pub) {
      rows.add(row('signedOut'));
      known.remove(e.pub);
    } else {
      final label = known[e.signer]?.label ?? labels[e.signer] ?? '';
      rows.add(
        row(
          'removed',
          by: DevLogHistoryBy(
            pub: e.signer,
            label: label,
            fingerprint: _fp(e.signer),
          ),
        ),
      );
      known.remove(e.pub);
    }
  }
  rows.sort((a, b) => b.seq.compareTo(a.seq));
  return rows;
}

String _name(String label) => label.trim().isEmpty ? 'A device' : label.trim();

/// How the apps word a [DeviceRemovalNotice], so the band and the notification say the same thing.
extension DeviceRemovalCopy on DeviceRemovalNotice {
  /// Removed by a new device nobody has looked at (a signed-out device is never red: it is its own act).
  bool get red => signerPending && !selfRemoved;

  String get title => selfRemoved
      ? 'Device signed out'
      : red
      ? 'Removed by a new device'
      : 'Device removed';

  String get sentence {
    final name = _name(label);
    if (selfRemoved) return '$name signed out of your account.';
    final signerName = signerLabel.trim().isEmpty
        ? 'another device'
        : signerLabel.trim();
    if (!red) return '$name was removed from your account by $signerName.';
    final groups = signerFingerprint
        .split('·')
        .take(2)
        .where((g) => g.isNotEmpty)
        .join('·');
    final short = groups.isEmpty ? '' : ' · $groups…';
    return '$name was removed from your account by a new device you haven’t looked at ($signerName$short).';
  }
}

/// How the apps word a [DeviceLogDeparted]: "`label` joined your account and left before you looked."
/// and, unless it signed itself out or nothing took it out (a review of the list), who took it out: " Removed by `signer`." With [red] — the signer is
/// itself a device nobody has looked at — the sentence says so too, not the colour alone.
extension DeviceDepartedCopy on DeviceLogDeparted {
  String sentence({required bool red}) {
    final head =
        '${_name(label)} joined your account and left before you looked.';
    if (selfRemoved || removedBy.isEmpty || removedBy == pub) return head;
    final signer = removedByLabel.trim().isEmpty
        ? 'another device'
        : removedByLabel.trim();
    return red
        ? '$head Removed by $signer, a new device you haven’t looked at.'
        : '$head Removed by $signer.';
  }
}

/// What the row says happened, in words: `iPad added`, `Old Mac renamed to Mac`, `iPad removed by Mac`.
/// A signer with no known name is "another device".
String historySentence(DevLogHistoryRow row) {
  final name = _name(row.label);
  final signer = row.by?.label.trim() ?? '';
  final text = switch (row.op) {
    'renamed' =>
      row.previousLabel == null || row.previousLabel!.trim().isEmpty
          ? '$name renamed'
          : '${row.previousLabel!.trim()} renamed to $name',
    'removed' =>
      row.by == null
          ? '$name removed'
          : '$name removed by ${signer.isEmpty ? 'another device' : signer}',
    'signedOut' => '$name signed out',
    _ => '$name added',
  };
  return row.whileFrozen ? '$text · applied while the list was frozen' : text;
}
