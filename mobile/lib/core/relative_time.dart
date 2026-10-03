/// A device seen this recently reads as "active now" rather than "5 minutes ago".
const activeNowWithin = Duration(minutes: 5);

const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

String _ago(int n, String unit) => '$n $unit${n == 1 ? '' : 's'} ago';

/// "2 days ago". Coarse on purpose: the person is deciding "do I recognise this device", not auditing
/// a log. The same wording as `harness devices list` and the mobile app, so one device reads the same
/// everywhere. A time in the future (clock skew) reads as "just now".
String relativeAgo(DateTime at, DateTime now) {
  final d = now.difference(at);
  if (d.isNegative || d < const Duration(minutes: 1)) return 'just now';
  if (d < const Duration(hours: 1)) return _ago(d.inMinutes, 'minute');
  if (d < const Duration(days: 1)) return _ago(d.inHours, 'hour');
  if (d < const Duration(days: 2)) return 'yesterday';
  final days = d.inDays;
  if (days < 14) return '$days days ago';
  if (days < 60) return '${days ~/ 7} weeks ago';
  if (days < 365) return '${days ~/ 30} months ago';
  return 'over a year ago';
}

/// `1 Oct 2026, 14:05` in local time — spelled out so it reads the same in every locale.
String fullDateTime(DateTime at) {
  final local = at.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${local.day} ${_months[local.month - 1]} ${local.year}, ${two(local.hour)}:${two(local.minute)}';
}

/// `active now` / `last active 2 days ago` / `added 3 weeks ago` (no session was ever recorded for it).
String activityPhrase({
  DateTime? lastSeen,
  required DateTime addedAt,
  required DateTime now,
}) {
  if (lastSeen == null) return 'added ${relativeAgo(addedAt, now)}';
  return now.difference(lastSeen) < activeNowWithin
      ? 'active now'
      : 'last active ${relativeAgo(lastSeen, now)}';
}
