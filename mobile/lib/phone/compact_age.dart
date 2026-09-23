/// How long ago [at] was, in the fewest characters a row's trailing edge can
/// hold: `now`, `4m`, `2h`, `3d`, `5w`, `1y`.
///
/// A time in the future — a machine whose clock runs ahead of the phone's —
/// reads as `now` rather than as a negative age.
String compactAge(DateTime at, DateTime now) {
  final age = now.difference(at);
  if (age.inMinutes < 1) return 'now';
  if (age.inHours < 1) return '${age.inMinutes}m';
  if (age.inDays < 1) return '${age.inHours}h';
  if (age.inDays < 7) return '${age.inDays}d';
  if (age.inDays < 365) return '${age.inDays ~/ 7}w';
  return '${age.inDays ~/ 365}y';
}

/// How long ago a harness was last active, as the desktop's monitor writes it — `49m`, `3h`, `2d`.
///
/// Not [compactAge]: the monitor has no `now`, `w` or `y`, and a row that reads `1w` on the phone
/// beside `9d` on the desktop is the same agent looking like two. `—` when the machine never said.
String harnessActivityAge(DateTime? activity, DateTime now) {
  if (activity == null) return '—';
  final elapsed = now.difference(activity);
  if (elapsed.inDays >= 1) return '${elapsed.inDays}d';
  if (elapsed.inHours >= 1) return '${elapsed.inHours}h';
  return '${elapsed.inMinutes.clamp(0, 59)}m';
}
