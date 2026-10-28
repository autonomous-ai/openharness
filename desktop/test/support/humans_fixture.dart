import 'pm_chat_fixture.dart';
import 'super_tab_fixture.dart';

/// Seven people, so a cut-off list would hide some, with this week's scores.
ConversationServer humansSwarm() {
  final server = pmChatSwarm();
  (server.state['agents'] as List).first['displayName'] = 'River';
  server.state['people'] = [
    {'id': 'owner', 'email': 'ken@example.com', 'role': 'owner'},
    {'id': 'peer', 'email': 'dee@example.com', 'role': 'collaborator'},
    for (final name in [
      'tony',
      'scholes',
      'diego',
      'huy',
      'maximilian.alexander.longname',
    ])
      {'id': name, 'email': '$name@example.com', 'role': 'collaborator'},
  ];
  server.state['projects'] = [projectFixture('lead', 'Pilot', 'lead')];
  server.state['machines'] = [
    {'machineId': 'studio', 'name': 'Mac Studio', 'contributorId': 'owner'},
  ];
  Map<String, dynamic> score(
    String id,
    int points,
    int rank,
    int shipped,
    int unblocked,
    int lent,
  ) => {
    'personId': id,
    'points': points,
    'rank': rank,
    'medal': points > 0 && rank <= 3
        ? ['gold', 'silver', 'bronze'][rank - 1]
        : null,
    'shipped': {'count': shipped, 'medianAskToShipMs': 7200000},
    'unblocked': {'count': unblocked, 'agentMs': 0, 'medianAnswerMs': null},
    'lent': {'machines': lent, 'agentMs': lent * 36000000},
    'streakDays': shipped,
  };
  server.leaderboard = {
    'projectId': 'lead',
    'week': DateTime.utc(2026, 10, 26).millisecondsSinceEpoch,
    'goal': {
      'openRequests': 9,
      'thisWeek': {'shipped': 7, 'points': 46, 'medianAskToShipMs': 7200000},
      'lastWeek': {'shipped': 4, 'points': 20, 'medianAskToShipMs': null},
    },
    'people': [
      score('peer', 21, 1, 6, 3, 0),
      score('owner', 13, 2, 1, 4, 2),
      score('tony', 6, 3, 2, 0, 0),
      score('scholes', 4, 4, 0, 2, 1),
      score('diego', 2, 5, 0, 1, 1),
      score('huy', 0, 6, 0, 0, 0),
      score('maximilian.alexander.longname', 0, 6, 0, 0, 0),
    ],
    'waiting': {
      'total': 1,
      'people': [
        {
          'personId': 'peer',
          'count': 1,
          'conversationIds': ['offline'],
        },
      ],
    },
  };
  return server;
}

/// Adds workgroups #1 to #[count] to the Pilot project, created in that order.
void addNumberedWorkgroups(ConversationServer server, int count) {
  final conversations = server.state['conversations'] as List;
  for (var number = 1; number <= count; number++) {
    conversations.add({
      ...conversationFixture('g$number', 'Workgroup $number'),
      'number': number,
    });
  }
}
