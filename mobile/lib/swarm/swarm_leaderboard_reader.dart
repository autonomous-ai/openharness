/// The leaderboard read's answer, how the board writes its numbers, and the
/// reader that keeps one project's board current (the desktop's
/// `desktop/lib/super_tabs/leaderboard` model, format and reader); the page
/// is `swarm_leaderboard.dart`.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'package:harness_mobile/widgets/engine_identity.dart'
    show engineIdentity;

import 'swarm_request.dart';

/// A place among the top three with points.
enum SwarmMedal { gold, silver, bronze }

const swarmWeekMs = 7 * 86400000;
const _minute = 60000, _hour = 3600000;

int _int(Object? value) => value is num ? value.round() : 0;
int? _optional(Object? value) => value is num ? value.round() : null;
Map<String, dynamic> _map(Object? value) =>
    value is Map ? value.cast<String, dynamic>() : const {};
List<T> _rows<T>(Object? value, T Function(Map<String, dynamic>) read) =>
    List.unmodifiable([
      if (value is List)
        for (final row in value)
          if (row is Map) read(_map(row)),
    ]);
String? _text(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

/// One project's week as the leaderboard read answers it
/// (`backend/src/superTabs/leaderboard/contract.ts`): each person who reads
/// the project with their points, most first, and its PM and Buddies, and
/// the models its workers ran on, ranked the same way. The
/// desktop's `SuperTabLeaderboard` (`desktop/lib/super_tabs/leaderboard`),
/// kept to what the phone shows.
class SwarmLeaderboard {
  SwarmLeaderboard.fromJson(Map<String, dynamic> json)
    : week = _int(json['week']),
      people = _rows(json['people'], SwarmScore.fromJson),
      agents = _rows(json['agents'], SwarmAgentScore.fromJson),
      byModel = _rows(json['byModel'], SwarmModelScore.fromJson);

  /// The week's Monday 00:00 UTC, in epoch milliseconds.
  final int week;

  /// Most points first.
  final List<SwarmScore> people;

  /// The project's PM and Buddies, most points first; empty from a server
  /// before them.
  final List<SwarmAgentScore> agents;

  /// Every model that worked the week, most points first; empty from a
  /// server before them.
  final List<SwarmModelScore> byModel;
}

/// A permanent agent, the PM or a Buddy, scored by name like a person (the
/// desktop's `SuperTabAgentScore`).
class SwarmAgentScore {
  SwarmAgentScore.fromJson(Map<String, dynamic> json)
    : agentId = json['agentId'] as String? ?? '',
      displayName = json['displayName'] as String? ?? '',
      buddy = json['kind'] == 'buddy',
      personId = _text(json['personId']),
      points = _int(json['points']),
      rank = _int(json['rank']),
      shipped = _int(json['shipped']);

  /// [displayName] is the backend's: "Former PM" or "Former Buddy" for one
  /// no longer this project's.
  final String agentId, displayName;

  /// A Buddy, else the project's PM.
  final bool buddy;

  /// A Buddy's person; null for the PM, and for one no longer this project's.
  final String? personId;

  /// The PM's: requests of the groups it led that shipped; a Buddy's: groups
  /// opened from its proposals that shipped.
  final int points, rank, shipped;
}

/// The temporary workers by what they ran on, never by agent (the desktop's
/// `SuperTabModelScore`).
class SwarmModelScore {
  SwarmModelScore.fromJson(Map<String, dynamic> json)
    : engine = json['engine'] is String ? json['engine'] as String : '',
      model = _text(json['model']),
      effort = _text(json['effort']),
      grid = json['grid'] == true,
      points = _int(json['points']),
      rank = _int(json['rank']),
      shipped = _int(_map(json['shipped'])['count']),
      medianAttemptMs = _optional(_map(json['shipped'])['medianAttemptMs']),
      medianRequestMs = _optional(_map(json['shipped'])['medianRequestMs']),
      reviewed = _int(_map(json['firstReview'])['reviewed']),
      passed = _int(_map(json['firstReview'])['passed']),
      reviews = _int(json['reviews']);

  final String engine;

  /// Null when the engine reported none; [effort] null for attempts recorded
  /// before efforts were.
  final String? model, effort;

  /// Served on the Swarm's grid.
  final bool grid;
  final int points, rank, shipped;

  /// Median time to ship from the shipping attempt's assignment, and from the
  /// request's first assignment.
  final int? medianAttemptMs, medianRequestMs;

  /// The week's attempts with a first review on record, and how many passed.
  final int reviewed, passed;

  /// Review verdicts it gave.
  final int reviews;

  /// One key per row: engine, model and effort.
  String get key => 'model-$engine-${model ?? ''}-${effort ?? ''}';
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
      streakDays = _int(json['streakDays']),
      displayName = switch (json['displayName']) {
        final String name when name.isNotEmpty => name,
        _ => null,
      };

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

/// Whether a person's row wears the crown: first on the board, with points.
/// At the start of a week everyone ties at 0, and no one has taken #1 yet.
/// Only people wear it; agents and models do not (the desktop's member list,
/// 10-29).
bool swarmCrowned({required int rank, required int points}) =>
    rank == 1 && points > 0;

/// "Opus 5.5": a model as people know it, else its engine's name.
String swarmModelLabel(String engine, String? model) =>
    model == null ? engineIdentity(engine).label : _modelDisplayName(model);

/// One model in the Models list: the share of its work this week that passed
/// its first review, approved without changes.
typedef SwarmModelApproval = ({
  String name,
  int reviewed,
  int passed,
  int percent,
});

/// Fewer first reviews than this in a week say nothing about a model (the
/// desktop's `leaderboardModelMinReviewed`).
const swarmModelMinReviewed = 3;

/// The week's models with at least [swarmModelMinReviewed] first reviews, one
/// row per name whichever engine ran it at whichever effort, the most often
/// approved first; of two alike, the one reviewed more, then by name (the
/// desktop's `leaderboardModelShares`, 10-29: the number alone).
List<SwarmModelApproval> swarmModelApprovals(List<SwarmModelScore> scores) {
  final counts = <String, (int, int)>{};
  for (final score in scores) {
    final name = swarmModelLabel(score.engine, score.model);
    final (reviewed, passed) = counts[name] ?? (0, 0);
    counts[name] = (reviewed + score.reviewed, passed + score.passed);
  }
  return [
    for (final MapEntry(key: name, value: (reviewed, passed)) in counts.entries)
      if (reviewed >= swarmModelMinReviewed)
        (
          name: name,
          reviewed: reviewed,
          passed: passed.clamp(0, reviewed),
          percent: (passed.clamp(0, reviewed) * 100 / reviewed).round(),
        ),
  ]..sort(
    // The share itself, not its rounding: 67 of 100 is above 133 of 200.
    (a, b) => switch (b.passed * a.reviewed - a.passed * b.reviewed) {
      0 => switch (b.reviewed - a.reviewed) {
        0 => a.name.compareTo(b.name),
        final order => order,
      },
      final order => order,
    },
  );
}

/// A model as people know it: "Opus 5.5" for `claude-opus-5-5`, "Opus" for
/// the `opus` alias, "GPT-5.6 Sol" for `gpt-5.6-sol`. Other names stay
/// exact. The desktop's `modelDisplayName`
/// (`desktop/lib/core/runtime_model_name.dart`), copied as it stands and
/// held to it by `test/swarm/desktop_parity_test.dart`.
String _modelDisplayName(String model) {
  // Claude may report only a family alias. Never invent a version for it.
  final claude = RegExp(
    r'^(?:claude-)?(fable|opus|sonnet|haiku)(?:-(\d+(?:[-.]\d{1,2})*))?(\[1m\])?$',
    caseSensitive: false,
  ).firstMatch(model);
  if (claude != null) {
    final family = claude[1]!.toLowerCase();
    final version = claude[2]?.replaceAll('-', '.');
    return '${family[0].toUpperCase()}${family.substring(1)}'
        '${version == null ? '' : ' $version'}${claude[3] ?? ''}';
  }
  final gpt = RegExp(
    r'^gpt-(\d+(?:\.\d+)*)(?:-(astra|sol|terra|luna|codex))?$',
    caseSensitive: false,
  ).firstMatch(model);
  if (gpt != null) {
    final family = gpt[2]?.toLowerCase();
    return 'GPT-${gpt[1]}${family == null ? '' : ' ${family[0].toUpperCase()}${family.substring(1)}'}';
  }
  // Unknown names, dated IDs and local/provider-qualified IDs stay exact.
  return model;
}

String _plural(int count, String one, [String? many]) =>
    '$count ${count == 1 ? one : many ?? '${one}s'}';

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
      if (const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) {
        // Refused: the person left the Swarm or was removed, or the project
        // is not theirs to read. Nothing of the board stays on screen.
        board = null;
        error = failure.message;
        unavailable = false;
      } else if (failure.statusCode == 404) {
        // A server from before the leaderboard has no route for it, which
        // reaches the phone without the backend's NOT_FOUND code.
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
