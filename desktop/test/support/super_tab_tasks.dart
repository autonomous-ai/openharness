import 'super_tab_fixture.dart';

/// Task chats of a project from before Swarm v4, for the tests of what a task chat still shows.
const _repo = 'https://github.com/autonomous-ai/openharness/pull';

Map<String, dynamic> taskFixture(
  String id,
  String title,
  int number, {
  String? requester,
  String? status,
  String? agent,
  Map<String, dynamic>? liveness,
  int? pullRequest,
  bool merged = false,
  bool archived = false,
  DateTime? shippedAt,
  List<String>? releasing,
  Map<String, dynamic>? released,
  Map<String, String>? checks,
  List<Map<String, dynamic>>? acceptance,
  int? messages,
}) => {
  ...conversationFixture(id, title),
  'projectId': 'lead',
  'number': number,
  'archived': archived,
  'requesterId': ?requester,
  if (status != null)
    'assignment': {
      'id': 'as-$id',
      'agentId': agent ?? 'finch',
      'status': status,
      'progressAt': 1,
    },
  'liveness': ?liveness,
  if (pullRequest != null) ...{
    'pullRequestUrls': ['$_repo/$pullRequest'],
    'cards': {
      'pullRequests': [
        {
          'url': '$_repo/$pullRequest',
          'messageId': 'pr-$id',
          if (merged) 'mergedAt': 1,
        },
      ],
    },
  },
  if (shippedAt != null) 'shippedAt': shippedAt.millisecondsSinceEpoch,
  'releasing': ?releasing,
  'released': ?released,
  'pullRequestChecks': ?checks,
  if (acceptance != null) 'checks': acceptance,
  if (messages != null) 'lastMessageSequence': messages,
};

/// The project of the mockup Dee confirmed: two tasks nobody is on
/// yet, one working with its pull request, one waiting on the reader, and one
/// shipped two days ago and archived since.
ConversationServer tasksServer() {
  final server = ConversationServer();
  server.state['projects'] = [projectFixture('lead', 'openharness', 'lead')];
  server.state['people'] = [
    {'id': 'owner', 'email': 'dee@example.com', 'role': 'owner'},
    {'id': 'scholes', 'email': 'scholes@example.com', 'role': 'member'},
    {'id': 'tony', 'email': 'tony@example.com', 'role': 'member'},
    {'id': 'ken', 'email': 'ken15@example.com', 'role': 'member'},
  ];
  server.state['agents'] = [
    {
      'id': 'finch',
      'name': 'Engineer',
      'displayName': 'Finch2',
      'machineId': 'studio',
      'harnessId': 'h1',
      'contributorId': 'owner',
      'configuration': {'engine': 'claude'},
    },
  ];
  (server.state['conversations'] as List).removeWhere(
    (g) => (g as Map)['id'] == 'offline',
  );
  (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
    taskFixture(
      'shipped-means',
      'Shipped means merged',
      10,
      requester: 'scholes',
    ),
    taskFixture('preview', 'Remove the old preview route', 11),
    taskFixture(
      'tag',
      'One tag per ask',
      12,
      requester: 'owner',
      status: 'working',
      pullRequest: 2867,
    ),
    taskFixture(
      'test-copy',
      'First run of the test copy',
      13,
      requester: 'ken',
      status: 'needs_human',
      liveness: {
        'state': 'waiting',
        'why': 'person',
        'personId': 'owner',
        'since': 1,
      },
    ),
    taskFixture(
      'sender',
      'Task chat keeps its sender',
      9,
      requester: 'scholes',
      status: 'done',
      pullRequest: 2870,
      merged: true,
      archived: true,
      shippedAt: DateTime(2026, 11, 2, 9),
    ),
  ]);
  return server;
}
