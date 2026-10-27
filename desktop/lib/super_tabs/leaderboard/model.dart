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

class SuperTabLeaderboard {
  SuperTabLeaderboard.fromJson(Map<String, dynamic> json)
    : projectId = json['projectId'] as String? ?? '',
      week = _int(json['week']),
      goal = SuperTabTeamGoal.fromJson(_map(json['goal'])),
      people = _list(json['people']).map(SuperTabPersonScore.fromJson).toList(),
      waiting = SuperTabWaiting.fromJson(_map(json['waiting']));

  final String projectId;

  /// The week's Monday 00:00 UTC, in epoch milliseconds.
  final int week;
  final SuperTabTeamGoal goal;

  /// Most points first.
  final List<SuperTabPersonScore> people;
  final SuperTabWaiting waiting;
}

class SuperTabWeekGoal {
  SuperTabWeekGoal.fromJson(Map<String, dynamic> json)
    : shipped = _int(json['shipped']),
      points = _int(json['points']),
      medianAskToShipMs = _optional(json['medianAskToShipMs']);
  final int shipped, points;
  final int? medianAskToShipMs;
}

class SuperTabTeamGoal {
  SuperTabTeamGoal.fromJson(Map<String, dynamic> json)
    : openRequests = _int(json['openRequests']),
      thisWeek = SuperTabWeekGoal.fromJson(_map(json['thisWeek'])),
      lastWeek = SuperTabWeekGoal.fromJson(_map(json['lastWeek']));
  final int openRequests;
  final SuperTabWeekGoal thisWeek, lastWeek;
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
      streakDays = _int(json['streakDays']);

  final String personId;
  final int points, rank;
  final SuperTabMedal? medal;
  final int shipped, unblocked, lentMachines, streakDays;

  /// Agent time the person's answers freed, and agent time run on their machines.
  final int unblockedMs, lentMs;
  final int? medianAskToShipMs, medianAnswerMs;
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
