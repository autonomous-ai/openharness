import 'pm_chat_fixture.dart';
import 'super_tab_fixture.dart';

/// Seven people, so a cut-off list would hide some, with this week's scores.
/// Dee, Ken and Tony carry the newer fields (display name, last week, details);
/// the rest read as a server from before them.
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
      {
        ...score('peer', 21, 1, 6, 3, 0),
        'displayName': 'Dee',
        'prevWeekPoints': 15,
        'details': {
          'shipped': [
            {
              'title': 'Desktop: a machine shows its agents as one count',
              'prUrl': 'https://github.com/autonomous-ai/openharness/pull/1824',
              'mergedAt': '2026-10-28T03:00:00.000Z',
            },
            {'title': 'Swarm digest pauses with the Swarm', 'prUrl': null},
          ],
          'unblocked': [
            {
              'title': 'Which sign-in page ships first?',
              'conversationId': 'offline',
              'kind': 'decision',
              'waitedMinutes': 95,
            },
          ],
          'lent': <Map<String, dynamic>>[],
        },
      },
      {
        ...score('owner', 13, 2, 1, 4, 2),
        'displayName': 'Ken',
        'prevWeekPoints': 20,
        'details': {
          'shipped': <Map<String, dynamic>>[],
          'unblocked': <Map<String, dynamic>>[],
          'lent': [
            {'machineName': 'MACs-Mac-Studio.local', 'busyHours': 12.5},
            {'machineName': 'Build box', 'busyHours': 7},
          ],
        },
      },
      {
        ...score('tony', 6, 3, 2, 0, 0),
        'displayName': 'Tony',
        'prevWeekPoints': 6,
      },
      // From a server before names, last week and details.
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
