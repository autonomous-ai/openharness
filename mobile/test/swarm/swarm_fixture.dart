import 'dart:async';

import 'package:harness_mobile/swarm/swarm_request.dart';

/// Swarm answers as the backend sends them (docs/design/2026-10-26-swarm-state-parts.md, section 4), built by hand so a
/// test reads like the wire. Nothing here reaches a machine or the backend.

const me = 'person-me';
const tab = 'tab-1';
const project = 'project-1';
const leadChat = 'group-lead';

/// One part as a read carries it.
Map<String, dynamic> part(String key, int version, Map<String, dynamic> data) =>
    {'key': key, 'version': version, 'changedAt': version, 'data': data};

Map<String, dynamic> headData({
  String name = 'Phone Swarm',
  String ownerId = me,
  List<Map<String, dynamic>>? projects,
}) => {
  'version': 1,
  'id': tab,
  'name': name,
  'ownerId': ownerId,
  'paused': false,
  'projects':
      projects ??
      [
        {
          'id': project,
          'name': 'Mobile',
          'ownerId': me,
          'leadConversationId': leadChat,
          'visibility': 'public',
          'members': <Object>[],
          'updateMinutes': 5,
        },
      ],
  'rules': <Object>[],
  'invitations': <Object>[],
};

Map<String, dynamic> person(String id, {String role = 'owner'}) => {
  'id': id,
  'email': '$id@example.com',
  'role': role,
  'generation': 'gen-$id',
};

Map<String, dynamic> agent(
  String id, {
  String name = 'Builder',
  String? displayName,
  String machineId = 'mac-1',
}) => {
  'id': id,
  'projectId': project,
  'machineId': machineId,
  'harnessId': 'harness-$id',
  'contributorId': me,
  'name': name,
  'displayName': ?displayName,
  'configuration': {'engine': 'claude', 'model': 'opus', 'effort': 'high'},
};

Map<String, dynamic> groupData(
  String id, {
  String title = 'Work',
  int? number,
  List<String> agentIds = const [],
  String? leadId,
  String? status,
  String? workerId,
  List<String>? audience,
  int lastMessageSequence = 0,
  bool dormant = false,
}) => {
  'id': id,
  'projectId': project,
  'number': ?number,
  'title': title,
  'leadId': ?leadId,
  'agentIds': agentIds,
  'archived': false,
  'dormant': ?(dormant ? true : null),
  'brief': '',
  'checks': <Object>[],
  if (audience != null)
    'audience': {
      'people': [
        for (final id in audience) {'id': id, 'generation': 'gen-$id'},
      ],
    },
  if (status != null)
    'assignment': {
      'id': 'attempt-$id',
      'agentId': workerId ?? 'agent-builder',
      'status': status,
      'result': null,
    },
  'lastMessageSequence': lastMessageSequence,
  'pullRequestUrls': <String>[],
};

/// A first load of a Swarm with one project, its Lead's conversation and [groups] besides.
Map<String, dynamic> firstLoad({
  String cursor = 'c1',
  Map<String, dynamic>? head,
  List<Map<String, dynamic>> groups = const [],
  List<Map<String, dynamic>>? agents,
  Map<String, dynamic> derived = const {},
  int lastChangedAt = 100,
}) => {
  'format': 2,
  'tabId': tab,
  'cursor': cursor,
  'epoch': 1,
  'lastChangedAt': lastChangedAt,
  'githubApp': false,
  'head': part('head', 1, head ?? headData()),
  'members': [part(me, 1, person(me))],
  'agents': [
    for (final a
        in agents ??
            [
              agent('agent-lead', name: 'Lead', displayName: 'River'),
              agent('agent-builder', displayName: 'Nova'),
            ])
      part(a['id'] as String, 1, a),
  ],
  'groups': [
    part(
      leadChat,
      1,
      groupData(
        leadChat,
        title: 'Mobile',
        agentIds: ['agent-lead'],
        leadId: 'agent-lead',
      ),
    ),
    for (final (i, g) in groups.indexed) part(g['id'] as String, 2 + i, g),
  ],
  'machines': <Object>[],
  'starts': <Object>[],
  'progress': <Object>[],
  'derived': derived,
};

/// A change read: what changed since the cursor it was asked with.
Map<String, dynamic> changes({
  required String cursor,
  List<Map<String, dynamic>> groups = const [],
  Map<String, dynamic> derived = const {},
  int lastChangedAt = 100,
}) => {
  'format': 2,
  'reload': false,
  'cursor': cursor,
  'epoch': 1,
  'lastChangedAt': lastChangedAt,
  'head': null,
  'members': <Object>[],
  'agents': <Object>[],
  'groups': groups,
  'machines': <Object>[],
  'starts': <Object>[],
  'progress': <Object>[],
  'derived': derived,
};

/// The backend as a test scripts it: each path answers from [routes] (the longest prefix that matches, query
/// included), and every call is remembered.
class FakeSwarm {
  final routes =
      <String, FutureOr<Object?> Function(Map<String, dynamic>? body)>{};
  final calls = <({String method, String path, Map<String, dynamic>? body})>[];

  List<String> get paths => [for (final call in calls) call.path];

  /// The bodies of every command sent, in order.
  List<Map<String, dynamic>> get commands => [
    for (final call in calls)
      if (call.method == 'POST' && call.path.endsWith('/commands'))
        call.body!['command'] as Map<String, dynamic>,
  ];

  SwarmRequest get request => (method, path, {body}) async {
    calls.add((method: method, path: path, body: body));
    String? best;
    for (final route in routes.keys) {
      if (path.startsWith(route) &&
          (best == null || route.length > best.length)) {
        best = route;
      }
    }
    if (best == null) {
      throw SuperTabFailure('NOT_FOUND', 'No route for $path', statusCode: 404);
    }
    return routes[best]!(body);
  };
}

/// Lets queued microtasks and zero timers run.
Future<void> settle() async {
  for (var i = 0; i < 20; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}
