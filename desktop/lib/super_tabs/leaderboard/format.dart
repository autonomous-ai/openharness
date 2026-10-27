/// How the leaderboard writes its numbers.
library;

const _minute = 60000, _hour = 3600000;
const weekMs = 7 * 86400000;

/// "6 min" under an hour, then hours with one decimal unless whole: "3 h", "3.1 h".
String leaderboardDuration(int ms) {
  if (ms < _hour) return '${(ms / _minute).round()} min';
  final hours = ms / _hour;
  final rounded = (hours * 10).round() / 10;
  return rounded == rounded.roundToDouble()
      ? '${rounded.round()} h'
      : '${rounded.toStringAsFixed(1)} h';
}

/// Whole agent-hours, as the points count them.
String leaderboardHours(int ms) => '${(ms / _hour).round()}';

String plural(int count, String one, [String? many]) =>
    '$count ${count == 1 ? one : many ?? '${one}s'}';

/// "this week", "last week", "2 weeks ago", from the week's Monday and this one.
String weekName(int? week, int currentWeek) {
  final back = week == null ? 0 : ((currentWeek - week) / weekMs).round();
  return switch (back) {
    0 => 'this week',
    1 => 'last week',
    _ => '$back weeks ago',
  };
}

/// The Monday 00:00 UTC of the week [now] is in.
int leaderboardWeekOf(DateTime now) {
  final utc = now.toUtc();
  final day = DateTime.utc(utc.year, utc.month, utc.day);
  return day
      .subtract(Duration(days: day.weekday - DateTime.monday))
      .millisecondsSinceEpoch;
}

String capitalized(String text) =>
    text.isEmpty ? text : '${text[0].toUpperCase()}${text.substring(1)}';
