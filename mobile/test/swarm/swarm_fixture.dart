import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/swarm/swarm_home_cache.dart';
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
  String id = tab,
  String name = 'Phone Swarm',
  String ownerId = me,
  List<Map<String, dynamic>>? projects,
}) => {
  'version': 1,
  'id': id,
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

/// [owner]'s Buddy chat in [project] as the backend sends it (backend read/views.ts `groupView`): its owner named
/// instead of an audience.
Map<String, dynamic> buddyChatData(
  String id, {
  String owner = me,
  List<String> agentIds = const [],
  int lastMessageSequence = 0,
}) => {
  ...groupData(
    id,
    title: "$owner's Buddy",
    agentIds: agentIds,
    lastMessageSequence: lastMessageSequence,
  ),
  'kind': 'buddy',
  'buddyOwnerId': owner,
};

/// [owner]'s Buddy in [project]: an agent with no role, only its person.
Map<String, dynamic> buddyData(
  String id, {
  String owner = me,
  String? displayName,
  String machineId = 'mac-1',
  String engine = 'claude',
}) => {
  ...agent(
    id,
    name: "$owner's Buddy",
    displayName: displayName,
    machineId: machineId,
  ),
  'configuration': {'engine': engine, 'model': 'opus', 'effort': 'high'},
  'buddyOf': {'personId': owner, 'generation': 'gen-$owner'},
};

/// A Buddy's start for [chatId] as the backend keeps it: under way with neither a harness nor an [error].
Map<String, dynamic> buddyStartData(
  String id, {
  required String chatId,
  String owner = me,
  String machineId = 'mac-1',
  String engine = 'claude',
  String? harnessId,
  String? error,
}) => {
  'id': id,
  'request': {
    'conversationId': chatId,
    'machineId': machineId,
    'engine': engine,
    'name': "$owner's Buddy",
    'buddyOf': {'personId': owner, 'generation': 'gen-$owner'},
  },
  'harnessId': harnessId,
  'error': error,
};

/// A first load of a Swarm with one project, its Lead's conversation and [groups] besides.
Map<String, dynamic> firstLoad({
  String tabId = tab,
  String cursor = 'c1',
  Map<String, dynamic>? head,
  List<Map<String, dynamic>> groups = const [],
  List<Map<String, dynamic>>? agents,
  List<Map<String, dynamic>> machines = const [],
  List<Map<String, dynamic>> starts = const [],
  Map<String, dynamic> derived = const {},
  int lastChangedAt = 100,
}) => {
  'format': 2,
  'tabId': tabId,
  'cursor': cursor,
  'epoch': 1,
  'lastChangedAt': lastChangedAt,
  'githubApp': false,
  'head': part('head', 1, head ?? headData(id: tabId)),
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
  'machines': [for (final m in machines) part(m['machineId'] as String, 1, m)],
  'starts': [for (final s in starts) part(s['id'] as String, 1, s)],
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

/// The Keychain item the kept Home is sealed under, held in memory; [refuses]
/// as a locked or broken Keychain does.
class MemorySwarmHomeKey implements SwarmHomeKey {
  String? value;
  bool refuses = false;

  @override
  Future<String?> read() async => refuses ? throw StateError('locked') : value;

  @override
  Future<void> write(String next) async {
    if (refuses) throw StateError('locked');
    value = next;
  }

  @override
  Future<void> delete() async {
    if (refuses) throw StateError('locked');
    value = null;
  }
}

/// A kept Home in a folder of its own, gone after the test.
SwarmHomeCache memoryHomeCache() {
  final dir = Directory.systemTemp.createTempSync('swarm-home');
  addTearDown(() => dir.deleteSync(recursive: true));
  return SwarmHomeCache(
    key: MemorySwarmHomeKey(),
    file: File('${dir.path}/home.bin'),
  );
}

/// Waits, in real time, until [done] holds: at most a few seconds.
Future<void> until(bool Function() done) async {
  for (var i = 0; i < 500 && !done(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  if (!done()) throw StateError('never happened');
}

/// A leaderboard read's answer as the backend sends it
/// (`backend/src/superTabs/leaderboard/contract.ts`), built by hand.
Map<String, dynamic> scoreData(
  String personId, {
  required int points,
  required int rank,
  String? medal,
  int shipped = 0,
  int? medianAskToShipMs,
  int unblocked = 0,
  int unblockedMs = 0,
  int? medianAnswerMs,
  int lentMachines = 0,
  int lentMs = 0,
  int streakDays = 0,
}) => {
  'personId': personId,
  'points': points,
  'rank': rank,
  'medal': medal,
  'shipped': {'count': shipped, 'medianAskToShipMs': medianAskToShipMs},
  'unblocked': {
    'count': unblocked,
    'agentMs': unblockedMs,
    'medianAnswerMs': medianAnswerMs,
  },
  'lent': {'machines': lentMachines, 'agentMs': lentMs},
  'streakDays': streakDays,
};

Map<String, dynamic> leaderboardData({
  int week = 1792454400000,
  int shipped = 19,
  List<Map<String, dynamic>>? people,
}) => {
  'projectId': 'project-1',
  'week': week,
  'goal': {
    'openRequests': 4,
    'thisWeek': {'shipped': shipped, 'points': 76, 'medianAskToShipMs': null},
    'lastWeek': {'shipped': 11, 'points': 40, 'medianAskToShipMs': null},
  },
  'people':
      people ??
      [
        scoreData(
          'diego',
          points: 28,
          rank: 1,
          medal: 'gold',
          shipped: 8,
          medianAskToShipMs: 3 * 3600000,
          unblocked: 1,
          unblockedMs: 6 * 60000,
          medianAnswerMs: 4 * 60000,
          lentMachines: 2,
          lentMs: 40 * 3600000,
          streakDays: 3,
        ),
        scoreData('ken', points: 21, rank: 2, medal: 'silver', shipped: 3),
        scoreData('dee', points: 0, rank: 4),
      ],
  'waiting': {'total': 0, 'people': <Object>[]},
};
