/// The leaderboard read's answer, how the board writes its numbers, and the
/// reader that keeps one project's board current (the desktop's
/// `desktop/lib/super_tabs/leaderboard` model, format and reader); the page
/// is `swarm_leaderboard.dart`.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'swarm_request.dart';

/// A place among the top three with points.
enum SwarmMedal { gold, silver, bronze }

const swarmWeekMs = 7 * 86400000;
const _minute = 60000, _hour = 3600000;

int _int(Object? value) => value is num ? value.round() : 0;
int? _optional(Object? value) => value is num ? value.round() : null;
Map<String, dynamic> _map(Object? value) =>
    value is Map ? value.cast<String, dynamic>() : const {};

/// One project's week as the leaderboard read answers it
/// (`backend/src/superTabs/leaderboard/contract.ts`): what it shipped, and
/// each person who reads the project with their points, most first. The
/// desktop's `SuperTabLeaderboard` (`desktop/lib/super_tabs/leaderboard`),
/// kept to what the phone shows.
class SwarmLeaderboard {
  SwarmLeaderboard.fromJson(Map<String, dynamic> json)
    : week = _int(json['week']),
      period = switch (_map(json['period'])['name']) {
        final String name when name.isNotEmpty => name,
        _ => null,
      },
      shipped = _int(_map(_map(json['goal'])['thisWeek'])['shipped']),
      shippedBefore = _int(_map(_map(json['goal'])['lastWeek'])['shipped']),
      people = List.unmodifiable([
        for (final row in json['people'] as List? ?? const [])
          if (row is Map)
            SwarmScore.fromJson(
              _map(row),
              period: switch (_map(json['period'])['name']) {
                final String name when name.isNotEmpty => name,
                _ => null,
              },
            ),
      ]);

  /// The week's Monday 00:00 UTC, in epoch milliseconds.
  final int week;

  /// The rolling period this sums; null from a server that sums weeks.
  final String? period;

  /// What the project shipped in the week.
  final int shipped;

  /// What it shipped the week before.
  final int shippedBefore;

  /// Most points first.
  final List<SwarmScore> people;
}

/// The rolling periods the board offers, the default in the middle (the
/// desktop's `leaderboardPeriods`).
const swarmPeriods = ['24h', '7d', '30d'];
const swarmDefaultPeriod = '7d';

/// "Last 7d": a period in the picker.
String swarmPeriodLabel(String period) => 'Last $period';

String _periodLength(String period) => switch (period) {
  '24h' => '24 hours',
  '30d' => '30 days',
  _ => '7 days',
};

/// "in the last 7 days": what a period's numbers cover, in a sentence.
String swarmPeriodSpan(String period) => 'in the last ${_periodLength(period)}';

/// "the 7 days before"; null for Last 30d, which has no comparison.
String? swarmPeriodEarlier(String period) =>
    period == '30d' ? null : 'the ${_periodLength(period)} before';

/// One person's week on the board.
class SwarmScore {
  SwarmScore.fromJson(Map<String, dynamic> json, {String? period})
    : spanName = period == null ? 'this week' : swarmPeriodSpan(period),
      earlierName = period == null
          ? 'last week'
          : 'the ${_periodLength(period)} before',
      personId = json['personId'] as String? ?? '',
      points = _int(json['points']),
      rank = _int(json['rank']),
      medal = SwarmMedal.values.asNameMap()[json['medal']],
      shipped = _int(_map(json['shipped'])['count']),
      medianAskToShipMs = _optional(_map(json['shipped'])['medianAskToShipMs']),
      unblocked = _int(_map(json['unblocked'])['count']),
      unblockedMs = _int(_map(json['unblocked'])['agentMs']),
      medianAnswerMs = _optional(_map(json['unblocked'])['medianAnswerMs']),
      lentMachines = _int(_map(json['lent'])['machines']),
      lentMs = _int(_map(json['lent'])['agentMs']),
      streakDays = _int(json['streakDays']),
      displayName = switch (json['displayName']) {
        final String name when name.isNotEmpty => name,
        _ => null,
      },
      prevWeekPoints = _optional(json['prevWeekPoints']),
      details = json['details'] is Map
          ? SwarmPersonDetails.fromJson(_map(json['details']))
          : null;

  final String personId;

  /// [rank] 1 has the most points; people with the same points share one.
  final int points, rank;
  final SwarmMedal? medal;
  final int shipped, unblocked, lentMachines, streakDays;

  /// Agent time the person's answers freed, and agent time run on their
  /// machines.
  final int unblockedMs, lentMs;
  final int? medianAskToShipMs, medianAnswerMs;

  /// The profile name; null from a server before names.
  final String? displayName;

  /// What the points cover and what [prevWeekPoints] covers, in a sentence.
  final String spanName, earlierName;

  /// The same scoring for the time before; null from a server before it, and
  /// for Last 30d, which has no comparison.
  final int? prevWeekPoints;

  /// What the numbers are made of; null from a server before details.
  final SwarmPersonDetails? details;
}

/// A person's period item by item, each list newest first and only what the
/// reader can read (the desktop's `SuperTabPersonDetails`). An item without a
/// title, or a machine without a name, is left out.
class SwarmPersonDetails {
  SwarmPersonDetails.fromJson(Map<String, dynamic> json)
    : shipped = List.unmodifiable([
        for (final item in _maps(json['shipped']))
          if (_text(item['title']) case final title?)
            (title: title, link: _webLink(item['prUrl'])),
      ]),
      unblocked = List.unmodifiable([
        for (final item in _maps(json['unblocked']))
          if (_text(item['title']) case final title?)
            (title: title, waitedMinutes: _int(item['waitedMinutes'])),
      ]),
      lent = List.unmodifiable([
        for (final item in _maps(json['lent']))
          if (_text(item['machineName']) case final name?)
            (
              machineName: _withoutLocal(name),
              busyHours: item['busyHours'] is num
                  ? (item['busyHours'] as num).toDouble()
                  : 0.0,
            ),
      ]);

  /// Pull requests that merged; [link] only a web page's, as a link from the
  /// server is data and any other scheme could open a file or an app.
  final List<({String title, Uri? link})> shipped;

  /// Questions answered, and how long the agent waited.
  final List<({String title, int waitedMinutes})> unblocked;

  /// Machines whose agents ran, and for how long; named without `.local`.
  final List<({String machineName, double busyHours})> lent;
}

List<Map<String, dynamic>> _maps(Object? value) => [
  if (value is List)
    for (final item in value)
      if (item is Map) _map(item),
];

String? _text(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

Uri? _webLink(Object? value) {
  final uri = value is String ? Uri.tryParse(value) : null;
  return uri != null &&
          (uri.scheme == 'https' || uri.scheme == 'http') &&
          uri.host.isNotEmpty
      ? uri
      : null;
}

/// A machine's name without its `.local`, as the desktop shows it.
String _withoutLocal(String name) {
  const suffix = '.local';
  return name.length > suffix.length && name.toLowerCase().endsWith(suffix)
      ? name.substring(0, name.length - suffix.length)
      : name;
}

/// "6 min" under an hour, then hours with one decimal unless whole: "3 h",
/// "3.1 h" (the desktop's `leaderboardDuration`).
String swarmDuration(int ms) {
  if (ms < _hour) return '${(ms / _minute).round()} min';
  final rounded = (ms / _hour * 10).round() / 10;
  return rounded == rounded.roundToDouble()
      ? '${rounded.round()} h'
      : '${rounded.toStringAsFixed(1)} h';
}

/// Whole agent-hours, as the points count them.
int swarmHours(int ms) => (ms / _hour).round();

/// "8 shipped", "1 unblocked", "40 hours lent": each number that would not
/// read zero, in words (the desktop's `leaderboardNumbers`).
List<String> swarmNumbers(SwarmScore score) {
  final hours = swarmHours(score.lentMs);
  return [
    if (score.shipped > 0) '${score.shipped} shipped',
    if (score.unblocked > 0) '${score.unblocked} unblocked',
    if (hours > 0) '${_plural(hours, 'hour')} lent',
  ];
}

/// "up 8 from last week", "down 4 …"; null when level, or from a server
/// without last week (the desktop's `leaderboardTrend`).
String? swarmTrend(SwarmScore score) {
  final before = score.prevWeekPoints;
  if (before == null || before == score.points) return null;
  final change = score.points - before;
  return '${change > 0 ? 'up' : 'down'} ${change.abs()} from ${score.earlierName}';
}

String _plural(int count, String one) =>
    '$count ${count == 1 ? one : '${one}s'}';

/// The Monday 00:00 UTC of the week [now] is in.
int swarmWeekOf(DateTime now) {
  final utc = now.toUtc();
  final day = DateTime.utc(utc.year, utc.month, utc.day);
  return day
      .subtract(Duration(days: day.weekday - DateTime.monday))
      .millisecondsSinceEpoch;
}

/// "This week", "Last week", "2 weeks ago", from the week's Monday and this
/// one's; null is this week.
String swarmWeekName(int? week, int currentWeek) {
  final back = week == null ? 0 : ((currentWeek - week) / swarmWeekMs).round();
  return switch (back) {
    0 => 'This week',
    1 => 'Last week',
    _ => '$back weeks ago',
  };
}

/// Reads one project's leaderboard: once [start]ed, at once and every
/// [every] while the app is in front ([inFront]); the board sums a week, so
/// it moves slowly. A failed refresh keeps the last board and says why (the
/// desktop's `SuperTabLeaderboardReader`).
class SwarmLeaderboardReader extends ChangeNotifier {
  SwarmLeaderboardReader({
    required this.tabId,
    required this.projectId,
    required this.request,
    required this.inFront,
    this.every = const Duration(minutes: 5),
  });

  final String tabId, projectId;
  final SwarmRequest request;
  final bool Function() inFront;
  final Duration every;

  /// The week as last read; null before a read of the week shown lands.
  SwarmLeaderboard? board;

  /// Why the last read failed; null once one succeeds.
  String? error;

  /// The server has no leaderboard: it is from before one.
  bool unavailable = false;

  /// The Monday of the week shown; null for this week.
  int? week;

  String _period = swarmDefaultPeriod;
  bool _weeksOnly = false;

  /// The rolling period shown; null while the server only sums weeks (a server
  /// before periods), which keeps the week picker. Told once per reader.
  String? get period => _weeksOnly ? null : _period;

  int _read = 0;
  Timer? _timer;
  bool _disposed = false;

  bool get loading => board == null && error == null && !unavailable;

  /// Reads now, and every [every] after while the app is in front.
  void start() {
    _timer ??= Timer.periodic(every, (_) {
      if (inFront()) unawaited(refresh());
    });
    unawaited(refresh());
  }

  /// Shows another rolling period.
  Future<void> showPeriod(String period) {
    if (period == _period) return Future.value();
    _period = period;
    // Another period's numbers under this one's name would mislead.
    board = null;
    error = null;
    _notify();
    return refresh();
  }

  /// Shows another week, null for this one.
  Future<void> showWeek(int? week) {
    if (week == this.week) return Future.value();
    this.week = week;
    // Another week's numbers under this week's name would mislead until the
    // read lands.
    board = null;
    error = null;
    _notify();
    return refresh();
  }

  Future<void> refresh() async {
    if (_disposed) return;
    final read = ++_read, week = this.week, period = this.period;
    try {
      final answer = await request(
        'GET',
        '/api/super-tabs/${Uri.encodeComponent(tabId)}/leaderboard'
            '?projectId=${Uri.encodeQueryComponent(projectId)}'
            '${period != null
                ? '&period=$period'
                : week == null
                ? ''
                : '&week=$week'}',
      );
      if (read != _read || _disposed) return;
      if (answer is! Map) throw const FormatException();
      board = SwarmLeaderboard.fromJson(answer.cast<String, dynamic>());
      if (board!.period == null) _weeksOnly = true;
      error = null;
      unavailable = false;
    } on SuperTabFailure catch (failure) {
      if (read != _read || _disposed) return;
      // A server before periods refuses the question, and only that one: any
      // other failure, however early, leaves the periods on for the next read.
      if (failure.statusCode == 400 && period != null) {
        _weeksOnly = true;
        return refresh();
      }
      if (failure.statusCode == 404) {
        board = null;
        error = null;
        unavailable = true;
      } else {
        error = failure.message;
      }
    } catch (_) {
      if (read != _read || _disposed) return;
      error = "Couldn't read the leaderboard.";
    }
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}

/// A person's week as the desktop's `LeaderboardPersonWeek` words it: the
/// points and place, what landed, what they answered, what they lent, and
/// their streak.
List<(String, String)> swarmPersonWeek(SwarmScore score) {
  String median(int? ms, String what) =>
      ms == null ? '' : ' · median ${swarmDuration(ms)}$what';
  return [
    (
      'Points',
      score.medal == null
          ? '${score.points} ${score.spanName}'
          : '${score.points} ${score.spanName} · place ${score.rank}',
    ),
    (
      'Shipped',
      score.shipped == 0
          ? 'Nothing landed yet'
          : '${_plural(score.shipped, 'ask')} landed'
                '${median(score.medianAskToShipMs, ' to ship')}',
    ),
    (
      'Unblocked',
      score.unblocked == 0
          ? 'Nothing answered yet'
          : '${score.unblocked} answered${median(score.medianAnswerMs, '')}'
                ' · ${swarmDuration(score.unblockedMs)} of agent time freed',
    ),
    (
      'Lent',
      score.lentMachines == 0
          ? 'Nothing lent yet'
          : '${_plural(score.lentMachines, 'machine')}'
                ' · ${swarmHours(score.lentMs)} agent-hours',
    ),
    (
      'Streak',
      score.streakDays == 0
          ? 'No streak yet'
          : '${_plural(score.streakDays, 'day')} shipping',
    ),
  ];
}

/// The points first in a person's details, as the desktop's
/// `LeaderboardPersonWeek` says them, the time before beside them rather than
/// a difference: "21 points in the last 7 days · 15 the 7 days before".
String swarmPersonPoints(SwarmScore score) => [
  '${_plural(score.points, 'point')} ${score.spanName}',
  if (score.prevWeekPoints case final before?) '$before ${score.earlierName}',
].join(' · ');

/// "waited 1.6 h": how long an answered question's agent waited.
String swarmWaited(int minutes) => 'waited ${swarmDuration(minutes * 60000)}';

/// "12.5 h busy": how long a lent machine's agents ran.
String swarmBusy(double hours) =>
    '${swarmDuration((hours * 3600000).round())} busy';
