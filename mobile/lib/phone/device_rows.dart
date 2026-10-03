import 'package:harness_mobile/core/relative_time.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';

/// This phone's own row, which the Devices page shows on its own card rather than in the list.
DeviceLogRow? selfRow(List<DeviceLogRow> rows) {
  for (final row in rows) {
    if (row.self) return row;
  }
  return null;
}

/// The rows under the "This device" card: the new devices (those in [newPubs]) first, newest first,
/// then the rest by last activity ([seen], `{pub: ms}`), falling back to when they were added. Ties
/// keep log order — `List.sort` is not stable, so the index breaks them.
List<DeviceLogRow> orderDeviceRows(
  List<DeviceLogRow> rows,
  Map<String, int> seen,
  Set<String> newPubs,
) {
  final listed = [
    for (var i = 0; i < rows.length; i++)
      if (!rows[i].self)
        (index: i, row: rows[i], isNew: newPubs.contains(rows[i].member.pub)),
  ];
  int when(({int index, DeviceLogRow row, bool isNew}) r) => r.isNew
      ? r.row.member.addedAt
      : seen[r.row.member.pub] ?? r.row.member.addedAt;
  listed.sort((a, b) {
    if (a.isNew != b.isNew) return a.isNew ? -1 : 1;
    final byTime = when(b).compareTo(when(a));
    return byTime != 0 ? byTime : a.index.compareTo(b.index);
  });
  return [for (final r in listed) r.row];
}

/// Names more than one device goes by (trimmed; an empty name counts as one name). Their rows add the
/// start of the key code, since two rows that read the same cannot be told apart otherwise.
Set<String> sharedNames(List<DeviceLogRow> rows) {
  final seen = <String>{};
  final shared = <String>{};
  for (final row in rows) {
    final name = row.member.label.trim();
    if (!seen.add(name)) shared.add(name);
  }
  return shared;
}

/// The line under a device's name in the list: `Computer · active now`, `App · last active 2 days ago`.
/// With [sameName] it ends in the first group of the key code, the one thing that tells two devices
/// of the same name apart without putting the whole code in the row.
String deviceDetailLine(
  DeviceLogRow row,
  int? seenMs,
  DateTime now, {
  required bool sameName,
}) {
  final what = row.member.kind == 'machine' ? 'Computer' : 'App';
  final when = activityPhrase(
    lastSeen: seenMs == null
        ? null
        : DateTime.fromMillisecondsSinceEpoch(seenMs),
    addedAt: DateTime.fromMillisecondsSinceEpoch(row.member.addedAt),
    now: now,
  );
  final tail = sameName && row.fingerprint.isNotEmpty
      ? ' · ${row.fingerprint.split('·').first}…'
      : '';
  return '$what · $when$tail';
}
