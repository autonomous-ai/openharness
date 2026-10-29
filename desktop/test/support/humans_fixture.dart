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

/// The Pilot project's PM River (212 points), a Builder Luna the board does
/// not score, and Dee's Buddy Sparky; another project's Buddy is named Luna.
ConversationServer membersSwarm() {
  final server = humansSwarm();
  final agents = server.state['agents'] as List;
  final lead = (agents.first as Map).cast<String, dynamic>()
    ..['machineId'] = 'studio';
  server.state['agents'] = <Object>[
    lead,
    {
      ...lead,
      'id': 'luna',
      'harnessId': 'h-luna',
      'name': 'Luna',
      'displayName': 'Luna',
      'projectId': 'lead',
    },
    {
      ...lead,
      'id': 'sparky',
      'harnessId': 'h-sparky',
      'name': 'Sparky',
      'displayName': 'Sparky',
      'buddyOf': {'personId': 'peer', 'generation': 'g'},
    },
  ];
  server.leaderboard!['agents'] = [
    {
      'agentId': 'lead-agent',
      'displayName': 'River',
      'kind': 'pm',
      'personId': null,
      'machineId': 'studio',
      'points': 212,
      'rank': 1,
      'shipped': 70,
    },
    {
      'agentId': 'sparky',
      'displayName': 'Sparky',
      'kind': 'buddy',
      'personId': 'peer',
      'machineId': 'studio',
      'points': 12,
      'rank': 2,
      'shipped': 4,
    },
    // Another agent named like one in the list is never taken for it.
    {
      'agentId': 'elsewhere',
      'displayName': 'Luna',
      'kind': 'buddy',
      'personId': 'owner',
      'machineId': 'studio',
      'points': 88,
      'rank': 3,
      'shipped': 3,
    },
  ];
  return server;
}

/// One model's week on the board: the tasks it ran, its first reviews and
/// how many passed. A board from a server before task counts has no
/// `attempts` ([attempts] null).
Map<String, dynamic> modelScore(
  String engine,
  String? model,
  String? effort, {
  required int? attempts,
  int reviewed = 0,
  int passed = 0,
  int reviews = 0,
}) => {
  'engine': engine,
  'model': model,
  'effort': effort,
  'grid': false,
  'points': 0,
  'rank': 1,
  'attempts': ?attempts,
  'shipped': {'count': 0, 'medianAttemptMs': null, 'medianRequestMs': null},
  'firstReview': {'reviewed': reviewed, 'passed': passed},
  'reviews': reviews,
};

/// The week's models (Dee, 2026-10-29): 32 tasks, Opus at two efforts 14 of
/// them together.
ConversationServer modelsSwarm([ConversationServer? base]) {
  final server = base ?? humansSwarm();
  server.leaderboard!['byModel'] = [
    // One model at two efforts is one row: 14 tasks, 11 of 12 passed.
    modelScore(
      'claude',
      'claude-opus-5-5',
      'high',
      attempts: 12,
      reviewed: 10,
      passed: 9,
    ),
    modelScore(
      'claude',
      'claude-opus-5-5',
      'xhigh',
      attempts: 2,
      reviewed: 2,
      passed: 2,
    ),
    modelScore(
      'codex',
      'gpt-6.1-sol',
      null,
      attempts: 9,
      reviewed: 8,
      passed: 6,
    ),
    modelScore(
      'claude',
      'claude-sonnet-5-5',
      'medium',
      attempts: 6,
      reviewed: 5,
      passed: 4,
    ),
    // Fourth, and no first review yet.
    modelScore('claude', 'claude-haiku-5-5', 'low', attempts: 3),
    // Only reviewed others' work: no task of its own.
    modelScore('codex', 'gpt-6.1-luna', null, attempts: 0, reviews: 5),
  ];
  return server;
}
