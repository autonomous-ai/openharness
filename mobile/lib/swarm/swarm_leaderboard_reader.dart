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
      shipped = _int(_map(_map(json['goal'])['thisWeek'])['shipped']),
      shippedBefore = _int(_map(_map(json['goal'])['lastWeek'])['shipped']),
      people = List.unmodifiable([
        for (final row in json['people'] as List? ?? const [])
          if (row is Map) SwarmScore.fromJson(_map(row)),
      ]);

  /// The week's Monday 00:00 UTC, in epoch milliseconds.
  final int week;

  /// What the project shipped in the week.
  final int shipped;

  /// What it shipped the week before.
  final int shippedBefore;

  /// Most points first.
  final List<SwarmScore> people;
}

/// One person's week on the board.
class SwarmScore {
  SwarmScore.fromJson(Map<String, dynamic> json)
    : personId = json['personId'] as String? ?? '',
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
      streakDays = _int(json['streakDays']);

  final String personId;

  /// [rank] 1 has the most points; people with the same points share one.
  final int points, rank;
  final SwarmMedal? medal;
  final int shipped, unblocked, lentMachines, streakDays;

  /// Agent time the person's answers freed, and agent time run on their
  /// machines.
  final int unblockedMs, lentMs;
  final int? medianAskToShipMs, medianAnswerMs;
}

String swarmCup(SwarmMedal medal) => switch (medal) {
  SwarmMedal.gold => '🥇',
  SwarmMedal.silver => '🥈',
  SwarmMedal.bronze => '🥉',
};

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

/// Lent time as the board writes it: "40h".
String swarmLentHours(int ms) => '${swarmHours(ms)}h';

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
    final read = ++_read, week = this.week;
    try {
      final answer = await request(
        'GET',
        '/api/super-tabs/${Uri.encodeComponent(tabId)}/leaderboard'
            '?projectId=${Uri.encodeQueryComponent(projectId)}'
            '${week == null ? '' : '&week=$week'}',
      );
      if (read != _read || _disposed) return;
      if (answer is! Map) throw const FormatException();
      board = SwarmLeaderboard.fromJson(answer.cast<String, dynamic>());
      error = null;
      unavailable = false;
    } on SuperTabFailure catch (failure) {
      if (read != _read || _disposed) return;
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
          ? '${score.points} this week'
          : '${score.points} this week · place ${score.rank}',
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
