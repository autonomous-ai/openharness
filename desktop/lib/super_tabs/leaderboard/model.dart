/// The leaderboard read's answer, mirrored by hand from the backend's
/// `backend/src/superTabs/leaderboard/contract.ts`. People are member ids; the
/// column names them from the members the Swarm already shows.
library;

enum SuperTabMedal { gold, silver, bronze }

int _int(Object? value) => value is num ? value.round() : 0;
int? _optional(Object? value) => value is num ? value.round() : null;
Map<String, dynamic> _map(Object? value) =>
    value is Map ? value.cast<String, dynamic>() : const {};
List<Map<String, dynamic>> _list(Object? value) =>
    value is List ? value.whereType<Map>().map(_map).toList() : const [];
String? _text(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

class SuperTabLeaderboard {
  SuperTabLeaderboard.fromJson(Map<String, dynamic> json)
    : projectId = json['projectId'] as String? ?? '',
      week = _int(json['week']),
      people = _list(json['people']).map(SuperTabPersonScore.fromJson).toList(),
      waiting = SuperTabWaiting.fromJson(_map(json['waiting'])),
      agents = _list(json['agents']).map(SuperTabAgentScore.fromJson).toList(),
      byModel = _list(json['byModel'])
          .map(SuperTabModelScore.fromJson)
          .toList(),
      weeks = _list(json['weeks']).map(SuperTabTeamWeek.fromJson).toList();

  final String projectId;

  /// The week's Monday 00:00 UTC, in epoch milliseconds.
  final int week;

  /// Most points first.
  final List<SuperTabPersonScore> people;
  final SuperTabWaiting waiting;

  /// The project's PM and Buddies, most points first; empty from a server
  /// before them.
  final List<SuperTabAgentScore> agents;

  /// Every model that worked the week, most points first; empty from a
  /// server before them.
  final List<SuperTabModelScore> byModel;

  /// The board's week and the three before it, newest first; empty from a
  /// server before them.
  final List<SuperTabTeamWeek> weeks;
}

/// The team's week for This week (Dee, 2026-10-29).
class SuperTabTeamWeek {
  SuperTabTeamWeek.fromJson(Map<String, dynamic> json)
    : week = _int(json['week']),
      shipped = _int(json['shipped']),
      medianRequestMs = _optional(json['medianRequestMs']),
      reviewed = _int(_map(json['firstReview'])['reviewed']),
      passed = _int(_map(json['firstReview'])['passed']);

  /// Its Monday 00:00 UTC, in epoch milliseconds.
  final int week;

  /// Requests shipped with a PR, and their median time from first assignment
  /// to shipping.
  final int shipped;
  final int? medianRequestMs;

  /// Its attempts with a first review on record, and how many passed it.
  final int reviewed, passed;

  /// The share that passed first time, as a whole percent; null with none
  /// reviewed.
  int? get passedPercent =>
      reviewed == 0 ? null : (passed * 100 / reviewed).round();
}

/// A permanent agent, the PM or a Buddy, scored by name like a person
/// (Dee, 2026-10-29).
class SuperTabAgentScore {
  SuperTabAgentScore.fromJson(Map<String, dynamic> json)
    : agentId = json['agentId'] as String? ?? '',
      displayName = json['displayName'] as String? ?? '',
      buddy = json['kind'] == 'buddy',
      personId = _text(json['personId']),
      machineId = json['machineId'] as String? ?? '',
      points = _int(json['points']),
      rank = _int(json['rank']),
      shipped = _int(json['shipped']);

  final String agentId, displayName, machineId;

  /// A Buddy, else the project's PM.
  final bool buddy;

  /// A Buddy's person; null for the PM.
  final String? personId;

  /// The PM's: requests of the groups it led that shipped; a Buddy's: groups
  /// opened from its proposals that shipped.
  final int points, rank, shipped;
}

/// The temporary workers by what they ran on, never by agent (Dee,
/// 2026-10-29).
class SuperTabModelScore {
  SuperTabModelScore.fromJson(Map<String, dynamic> json)
    : engine = json['engine'] as String? ?? '',
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

  /// This week's attempts with a first review on record, and how many passed.
  final int reviewed, passed;

  /// Review verdicts it gave.
  final int reviews;

  /// One key per row: engine, model and effort.
  String get key => 'model-$engine-${model ?? ''}-${effort ?? ''}';
}

class SuperTabPersonScore {
  SuperTabPersonScore.fromJson(Map<String, dynamic> json)
    : personId = json['personId'] as String? ?? '',
      points = _int(json['points']),
      rank = _int(json['rank']),
      medal = SuperTabMedal.values.asNameMap()[json['medal']],
      shipped = _int(_map(json['shipped'])['count']),
      medianAskToShipMs = _optional(_map(json['shipped'])['medianAskToShipMs']),
      unblocked = _int(_map(json['unblocked'])['count']),
      unblockedMs = _int(_map(json['unblocked'])['agentMs']),
      medianAnswerMs = _optional(_map(json['unblocked'])['medianAnswerMs']),
      lentMachines = _int(_map(json['lent'])['machines']),
      lentMs = _int(_map(json['lent'])['agentMs']),
      streakDays = _int(json['streakDays']),
      displayName = _text(json['displayName']),
      prevWeekPoints = _optional(json['prevWeekPoints']),
      details = json['details'] is Map
          ? SuperTabPersonDetails.fromJson(_map(json['details']))
          : null;

  final String personId;
  final int points, rank;
  final SuperTabMedal? medal;
  final int shipped, unblocked, lentMachines, streakDays;

  /// Agent time the person's answers freed, and agent time run on their machines.
  final int unblockedMs, lentMs;
  final int? medianAskToShipMs, medianAnswerMs;

  /// The profile name, else the email's local part; null from a server before names.
  final String? displayName;

  /// The same scoring for the week before; null from a server before it.
  final int? prevWeekPoints;

  /// What the numbers are made of; null from a server before details.
  final SuperTabPersonDetails? details;
}

/// A person's week item by item, each list newest first and only what the
/// reader can read. An item without a title is left out.
class SuperTabPersonDetails {
  SuperTabPersonDetails.fromJson(Map<String, dynamic> json)
    : shipped = [
        for (final item in _list(json['shipped']))
          if (_text(item['title']) case final title?)
            (title: title, prUrl: _text(item['prUrl'])),
      ],
      unblocked = [
        for (final item in _list(json['unblocked']))
          if (_text(item['title']) case final title?)
            (
              title: title,
              conversationId: _text(item['conversationId']),
              kind: _text(item['kind']),
              waitedMinutes: _int(item['waitedMinutes']),
            ),
      ],
      lent = [
        for (final item in _list(json['lent']))
          if (_text(item['machineName']) case final machineName?)
            (
              machineName: machineName,
              busyHours: item['busyHours'] is num
                  ? (item['busyHours'] as num).toDouble()
                  : 0.0,
            ),
      ];

  /// Pull requests that merged.
  final List<({String title, String? prUrl})> shipped;

  /// Questions answered: decision, approval, needs_human or tag_reply, and
  /// how long the agent waited.
  final List<
    ({String title, String? conversationId, String? kind, int waitedMinutes})
  >
  unblocked;

  /// Machines whose agents ran, and for how long.
  final List<({String machineName, double busyHours})> lent;
}

class SuperTabWaitingPerson {
  SuperTabWaitingPerson.fromJson(Map<String, dynamic> json)
    : personId = json['personId'] as String? ?? '',
      count = _int(json['count']),
      conversationIds = (json['conversationIds'] as List? ?? const [])
          .whereType<String>()
          .toList();
  final String personId;
  final int count;
  final List<String> conversationIds;
}

/// Who agents wait on now: counts in name order, never a ranking.
class SuperTabWaiting {
  SuperTabWaiting.fromJson(Map<String, dynamic> json)
    : total = _int(json['total']),
      people = _list(json['people'])
          .map(SuperTabWaitingPerson.fromJson)
          .toList();
  final int total;
  final List<SuperTabWaitingPerson> people;
}
