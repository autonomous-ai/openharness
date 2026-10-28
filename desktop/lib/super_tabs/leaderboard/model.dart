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
